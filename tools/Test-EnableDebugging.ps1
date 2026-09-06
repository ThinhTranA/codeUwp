<#
.SYNOPSIS
    Works out what IPackageDebugSettings::EnableDebugging will actually accept as an
    environment block.

.DESCRIPTION
    The documented signature is

        HRESULT EnableDebugging(LPCWSTR packageFullName, LPCWSTR debuggerCommandLine,
                                PZZWSTR environment)

    with both trailing arguments optional. In practice a null environment succeeds and a
    seemingly well-formed one returns E_INVALIDARG, so the constraint is undocumented. This
    matters because EnableDebugging is the ONLY way to get an environment variable into an
    AppContainer, and XAML hot reload requires ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO=1 to be
    set at process start.

    Each variant is tried in isolation and paired with DisableDebugging, so the package is
    never left in debug mode.
#>
[CmdletBinding()]
param(
    [string] $PackageName = "ClassicUwpWinUI2-Sample"
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class DebugSettingsProbe
{
    static readonly Guid Clsid = new Guid("B1AEC16F-2383-4852-B0E9-8F0B1DC66B4D");

    [ComImport, Guid("F27C3930-8029-4AD1-94E3-3DBA417810C1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPackageDebugSettings
    {
        [PreserveSig]
        int EnableDebugging(
            [MarshalAs(UnmanagedType.LPWStr)] string packageFullName,
            [MarshalAs(UnmanagedType.LPWStr)] string debuggerCommandLine,
            IntPtr environment);
        [PreserveSig]
        int DisableDebugging([MarshalAs(UnmanagedType.LPWStr)] string packageFullName);
    }

    static IPackageDebugSettings Create()
    {
        Type t = Type.GetTypeFromCLSID(Clsid, true);
        return (IPackageDebugSettings)Activator.CreateInstance(t);
    }

    /// <summary>
    /// Builds the block verbatim from the caller's string so a variant can test an exact
    /// terminator arrangement. Nulls are written as they appear in the input.
    /// </summary>
    public static int Try(string packageFullName, string debuggerCommandLine, string environmentBlock)
    {
        // nullDebugger is a separate flag rather than "debuggerCommandLine == null" because
        // PowerShell binds $null to a [string] parameter as the empty string, and an empty
        // command line is NOT the same argument as a null one -- conflating them produced a
        // wrong answer here once already.
        return Invoke(packageFullName, debuggerCommandLine, false, environmentBlock, false);
    }

    public static int TryNullDebugger(string packageFullName, string environmentBlock, bool nullEnvironment)
    {
        return Invoke(packageFullName, null, true, environmentBlock, nullEnvironment);
    }

    static int Invoke(string packageFullName, string debuggerCommandLine, bool nullDebugger,
                      string environmentBlock, bool nullEnvironment)
    {
        IntPtr env = IntPtr.Zero;
        try
        {
            if (!nullEnvironment && environmentBlock != null)
            {
                env = Marshal.StringToHGlobalUni(environmentBlock);
            }
            string debugger = nullDebugger ? null : debuggerCommandLine;
            IPackageDebugSettings settings = Create();
            int hr = settings.EnableDebugging(packageFullName, debugger, env);
            if (hr == 0)
            {
                settings.DisableDebugging(packageFullName);
            }
            return hr;
        }
        finally
        {
            if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
        }
    }
}
"@ -Language CSharp

$pkg = Get-AppxPackage -Name $PackageName | Select-Object -First 1
if (-not $pkg) { throw "Package '$PackageName' is not registered. Deploy it first." }
$pfn = $pkg.PackageFullName
Write-Output "package: $pfn"
Write-Output ""

$nul = [char]0
$stub = "C:\Windows\System32\cmd.exe /c rem"

function Show([string] $name, [int] $hr) {
    $verdict = if ($hr -eq 0) { "OK        " } else { ("0x{0:X8}" -f $hr) }
    $desc = if ($hr -eq 0) { "" }
            elseif ($hr -eq -2147024809) { "  (E_INVALIDARG)" }
            elseif ($hr -eq -2147024891) { "  (E_ACCESSDENIED)" }
            else { "" }
    Write-Output ("{0}  {1}{2}" -f $verdict, $name, $desc)
}

Write-Output "--- true null debugger command line (C# null, not PowerShell `$null) ---"
Show "null debugger, null env"                     ([DebugSettingsProbe]::TryNullDebugger($pfn, $null, $true))
Show "null debugger, single pair double-null"      ([DebugSettingsProbe]::TryNullDebugger($pfn, "A=1$nul$nul", $false))
Show "null debugger, two pairs double-null"        ([DebugSettingsProbe]::TryNullDebugger($pfn, "A=1${nul}B=2$nul$nul", $false))
Show "null debugger, single-null terminated"       ([DebugSettingsProbe]::TryNullDebugger($pfn, "A=1$nul", $false))
Show "null debugger, no terminator"                ([DebugSettingsProbe]::TryNullDebugger($pfn, "A=1", $false))
Show "null debugger, hot-reload var double-null"   ([DebugSettingsProbe]::TryNullDebugger($pfn, "ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO=1$nul$nul", $false))

Write-Output ""
Write-Output "--- empty-string debugger command line ---"
Show "empty debugger, null env"                    ([DebugSettingsProbe]::Try($pfn, "", $null))

Write-Output ""
Write-Output "--- real debugger command line ---"
Show "debugger, null env"                          ([DebugSettingsProbe]::Try($pfn, $stub, $null))
Show "debugger, hot-reload var double-null"        ([DebugSettingsProbe]::Try($pfn, $stub, "ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO=1$nul$nul"))
