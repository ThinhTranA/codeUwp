using System.Runtime.InteropServices;

namespace UwpLaunch;

/// <summary>
/// The shell COM surface for starting and debugging a packaged app: the same interfaces
/// plmdebug.exe and Visual Studio use, declared only as far as the methods needed here.
/// Vtable order is what matters, so no method may be omitted before one that is used.
/// </summary>
internal static class Interop
{
    static readonly Guid ClsidPackageDebugSettings = new("B1AEC16F-2383-4852-B0E9-8F0B1DC66B4D");
    static readonly Guid ClsidApplicationActivationManager = new("45BA127D-10A8-46EA-8AB7-56EA9078943C");

    [ComImport, Guid("F27C3930-8029-4AD1-94E3-3DBA417810C1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPackageDebugSettings
    {
        [PreserveSig]
        int EnableDebugging(
            [MarshalAs(UnmanagedType.LPWStr)] string packageFullName,
            [MarshalAs(UnmanagedType.LPWStr)] string? debuggerCommandLine,
            IntPtr environment);
        [PreserveSig] int DisableDebugging([MarshalAs(UnmanagedType.LPWStr)] string packageFullName);
        [PreserveSig] int Suspend([MarshalAs(UnmanagedType.LPWStr)] string packageFullName);
        [PreserveSig] int Resume([MarshalAs(UnmanagedType.LPWStr)] string packageFullName);
        [PreserveSig] int TerminateAllProcesses([MarshalAs(UnmanagedType.LPWStr)] string packageFullName);
    }

    [ComImport, Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IApplicationActivationManager
    {
        [PreserveSig]
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string? arguments,
            uint options,
            out uint processId);
    }

    static T Create<T>(Guid clsid)
    {
        var type = Type.GetTypeFromCLSID(clsid, throwOnError: true)
            ?? throw new InvalidOperationException($"No COM class registered for {clsid}.");
        return (T)(Activator.CreateInstance(type)
            ?? throw new InvalidOperationException($"Could not create {clsid}."));
    }

    static void Check(int hr, string what)
    {
        if (hr != 0)
        {
            throw new InvalidOperationException($"{what} failed with 0x{hr:X8}.{Explain(hr)}");
        }
    }

    static string Explain(int hr) => hr switch
    {
        unchecked((int)0x80070057) =>
            " E_INVALIDARG. Measured: EnableDebugging accepts an environment block ONLY when a "
            + "debugger command line is also supplied, and rejects an empty-string command line. "
            + "Pass a real debugger command line, or no environment.",
        unchecked((int)0x80070005) => " E_ACCESSDENIED.",
        _ => string.Empty
    };

    /// <summary>
    /// Puts a package into debug mode: the system stops suspending it and stops applying
    /// activation timeouts, so it can sit at a breakpoint without being killed.
    /// </summary>
    /// <param name="debuggerCommandLine">
    /// When set, the system launches THIS instead of the app, appending <c>-p &lt;pid&gt;
    /// -tid &lt;tid&gt;</c>, and creates the app suspended. Required if <paramref
    /// name="environment"/> is to be accepted at all.
    /// </param>
    /// <param name="environment">
    /// <c>KEY=VALUE</c> pairs. The only way to get an environment variable into an
    /// AppContainer, and therefore the only way to set ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO
    /// for XAML hot reload.
    /// </param>
    public static void EnableDebugging(
        string packageFullName,
        string? debuggerCommandLine = null,
        IReadOnlyList<string>? environment = null)
    {
        if (environment is { Count: > 0 } && string.IsNullOrEmpty(debuggerCommandLine))
        {
            throw new ArgumentException(
                "An environment block requires a debugger command line; EnableDebugging returns "
                + "E_INVALIDARG otherwise. This is undocumented and was established by testing.");
        }

        var block = IntPtr.Zero;
        try
        {
            if (environment is { Count: > 0 })
            {
                // PZZWSTR: KEY=VALUE, each null-terminated, the whole block null-terminated again.
                block = Marshal.StringToHGlobalUni(string.Join('\0', environment) + "\0\0");
            }
            Check(
                Create<IPackageDebugSettings>(ClsidPackageDebugSettings)
                    .EnableDebugging(packageFullName, debuggerCommandLine, block),
                "EnableDebugging");
        }
        finally
        {
            if (block != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(block);
            }
        }
    }

    public static void DisableDebugging(string packageFullName) =>
        Check(
            Create<IPackageDebugSettings>(ClsidPackageDebugSettings).DisableDebugging(packageFullName),
            "DisableDebugging");

    public static void TerminateAllProcesses(string packageFullName) =>
        Check(
            Create<IPackageDebugSettings>(ClsidPackageDebugSettings).TerminateAllProcesses(packageFullName),
            "TerminateAllProcesses");

    public static void Suspend(string packageFullName) =>
        Check(Create<IPackageDebugSettings>(ClsidPackageDebugSettings).Suspend(packageFullName), "Suspend");

    public static void Resume(string packageFullName) =>
        Check(Create<IPackageDebugSettings>(ClsidPackageDebugSettings).Resume(packageFullName), "Resume");

    /// <summary>
    /// Starts the app. With a debugger command line registered this does not return until the
    /// app is resumed, so callers that also own the resume must not call it on the thread they
    /// intend to resume from.
    /// </summary>
    public static uint ActivateApplication(string appUserModelId, string? arguments = null)
    {
        const uint AoNoErrorUi = 2;
        Check(
            Create<IApplicationActivationManager>(ClsidApplicationActivationManager)
                .ActivateApplication(appUserModelId, arguments, AoNoErrorUi, out var processId),
            "ActivateApplication");
        return processId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenThread(uint desiredAccess, bool inheritHandle, uint threadId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool CloseHandle(IntPtr handle);

    public static bool ResumeThreadById(int threadId)
    {
        const uint ThreadSuspendResume = 0x0002;
        var handle = OpenThread(ThreadSuspendResume, false, (uint)threadId);
        if (handle == IntPtr.Zero)
        {
            return false;
        }
        try
        {
            return ResumeThread(handle) != uint.MaxValue;
        }
        finally
        {
            CloseHandle(handle);
        }
    }
}
