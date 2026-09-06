<#
.SYNOPSIS
    Prototype of the `uwplaunch` helper: put a package into debug mode and activate it,
    returning the pid so a debugger can attach.

.DESCRIPTION
    A UWP app cannot be started with CreateProcess -- only the shell's activation can start
    it. Two COM interfaces do the work, the same ones plmdebug.exe and Visual Studio use:

      IPackageDebugSettings::EnableDebugging   stops the system suspending or timing the app
                                               out while it sits at a breakpoint, and is the
                                               only place to inject environment variables
                                               into a packaged process.
      IApplicationActivationManager::ActivateApplication
                                               starts it and hands back the pid.

    EnableDebugging is also how ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO=1 gets set, which XAML
    hot reload requires at process start -- there is no other way to get an environment
    variable into an AppContainer.

    Every EnableDebugging must be paired with a DisableDebugging or the package is left in
    debug mode indefinitely. Use -Disable for that.

.EXAMPLE
    .\Launch-UwpDebug.ps1 -PackageFamilyName ClassicUwpWinUI2-Sample_aynwpqe9gd9q2 -AppId App
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $PackageFamilyName,
    [string] $AppId = "App",
    [string[]] $Environment = @("ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO=1"),
    [switch] $Disable
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class UwpLaunch
{
    static readonly Guid ClsidPackageDebugSettings = new Guid("B1AEC16F-2383-4852-B0E9-8F0B1DC66B4D");
    static readonly Guid ClsidApplicationActivationManager = new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C");

    [ComImport, Guid("F27C3930-8029-4AD1-94E3-3DBA417810C1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPackageDebugSettings
    {
        // Declared only as far as the methods used; the vtable order is what matters.
        void EnableDebugging(
            [MarshalAs(UnmanagedType.LPWStr)] string packageFullName,
            [MarshalAs(UnmanagedType.LPWStr)] string debuggerCommandLine,
            IntPtr environment);
        void DisableDebugging([MarshalAs(UnmanagedType.LPWStr)] string packageFullName);
        void Suspend([MarshalAs(UnmanagedType.LPWStr)] string packageFullName);
        void Resume([MarshalAs(UnmanagedType.LPWStr)] string packageFullName);
        void TerminateAllProcesses([MarshalAs(UnmanagedType.LPWStr)] string packageFullName);
    }

    [ComImport, Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IApplicationActivationManager
    {
        void ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            uint options,
            out uint processId);
    }

    static T Create<T>(Guid clsid)
    {
        Type t = Type.GetTypeFromCLSID(clsid, true);
        return (T)Activator.CreateInstance(t);
    }

    /// <summary>
    /// The environment block is "K=V\0K=V\0\0" -- embedded nulls, so it cannot be marshalled
    /// as a plain string (which would truncate at the first one).
    /// </summary>
    static IntPtr BuildEnvironment(string[] pairs)
    {
        if (pairs == null || pairs.Length == 0) return IntPtr.Zero;
        string block = string.Join("\0", pairs) + "\0\0";
        return Marshal.StringToHGlobalUni(block);
    }

    public static void EnableDebug(string packageFullName, string[] environment)
    {
        IntPtr env = BuildEnvironment(environment);
        try
        {
            Create<IPackageDebugSettings>(ClsidPackageDebugSettings)
                .EnableDebugging(packageFullName, null, env);
        }
        finally
        {
            if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
        }
    }

    // Plain method bodies rather than expression-bodied members: Windows PowerShell 5.1's
    // Add-Type compiles with a C# 5 CodeDOM provider, where "=>" on a method is a syntax error.
    public static void DisableDebug(string packageFullName)
    {
        Create<IPackageDebugSettings>(ClsidPackageDebugSettings).DisableDebugging(packageFullName);
    }

    public static void Terminate(string packageFullName)
    {
        Create<IPackageDebugSettings>(ClsidPackageDebugSettings).TerminateAllProcesses(packageFullName);
    }

    public static uint Activate(string appUserModelId)
    {
        uint pid;
        // AO_NOERRORUI (2): fail silently rather than showing the shell's own error dialog.
        Create<IApplicationActivationManager>(ClsidApplicationActivationManager)
            .ActivateApplication(appUserModelId, null, 2, out pid);
        return pid;
    }
}
"@ -Language CSharp

$pkg = Get-AppxPackage -Name ($PackageFamilyName -split "_")[0] | Select-Object -First 1
if (-not $pkg) { throw "No registered package matching '$PackageFamilyName'." }
$pfn = $pkg.PackageFullName
$aumid = "$($pkg.PackageFamilyName)!$AppId"

if ($Disable) {
    [UwpLaunch]::DisableDebug($pfn)
    Write-Output "debug mode disabled for $pfn"
    return
}

Write-Output "package full name : $pfn"
Write-Output "AUMID             : $aumid"

# An already-running instance is the trap: activation foregrounds the existing window and
# creates no new process, so a caller waiting for a fresh pid waits forever.
$existing = Get-Process | Where-Object { $_.ProcessName -eq $pkg.Name } -ErrorAction SilentlyContinue
if ($existing) { Write-Output "note: an instance is already running (pids: $($existing.Id -join ', ')) -- terminating first"; [UwpLaunch]::Terminate($pfn) }

[UwpLaunch]::EnableDebug($pfn, $Environment)
Write-Output "debug mode enabled (env: $($Environment -join '; '))"

$processId = [UwpLaunch]::Activate($aumid)
Write-Output "pid               : $processId"
Write-Output ""
Write-Output "Remember to pair this with: .\Launch-UwpDebug.ps1 -PackageFamilyName $PackageFamilyName -Disable"
