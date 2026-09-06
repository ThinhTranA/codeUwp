using System.Diagnostics;
using System.Runtime.InteropServices;

namespace UwpLaunch;

/// <summary>
/// Loads a XAML Diagnostics provider ("tap") into a running app.
///
/// <para>
/// <c>InitializeXamlDiagnosticsEx</c> is exported from Windows.UI.Xaml.dll — the same
/// Windows.UI.Xaml.dll the app has already loaded from System32 — and asks the XAML framework
/// in the target process to load a DLL, create a coclass from it, and hand that object the
/// live diagnostics session. It is the documented foundation the Visual Studio XAML tooling is
/// built on.
/// </para>
/// </summary>
internal static class Injector
{
    /// <summary>
    /// The well-known endpoint name. Anything else returns ERROR_NOT_FOUND (0x80070490), and
    /// the error says nothing about the name being the reason.
    /// </summary>
    const string EndpointName = "VisualDiagConnection1";

    [DllImport("Windows.UI.Xaml.dll", CharSet = CharSet.Unicode, ExactSpelling = true, PreserveSig = true)]
    static extern int InitializeXamlDiagnosticsEx(
        [MarshalAs(UnmanagedType.LPWStr)] string endPointName,
        uint pid,
        [MarshalAs(UnmanagedType.LPWStr)] string wszDllXamlDiagnostics,
        [MarshalAs(UnmanagedType.LPWStr)] string wszTapDllName,
        Guid tapClsid,
        [MarshalAs(UnmanagedType.LPWStr)] string wszInitializationData);

    /// <summary>
    /// Grants app containers access to a directory.
    ///
    /// <para>
    /// The tap runs inside the target's AppContainer, which can read neither Program Files nor
    /// an arbitrary developer directory. Both the DLL it loads and any file it writes have to
    /// live somewhere the sandbox has been granted. Modify rather than read: the tap reports
    /// back by writing a file, and read-only access fails at that step rather than at load,
    /// which is a confusing place to discover it.
    /// </para>
    /// </summary>
    public static void GrantAppContainerAccess(string directory)
    {
        // S-1-15-2-1 is ALL APPLICATION PACKAGES, by SID rather than by name because the name
        // is localised and the well-known SID is not.
        var process = Process.Start(new ProcessStartInfo
        {
            FileName = "icacls.exe",
            Arguments = $"\"{directory}\" /grant *S-1-15-2-1:(OI)(CI)(M) /T /Q",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        }) ?? throw new InvalidOperationException("Could not start icacls.exe.");

        process.WaitForExit(30_000);
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"Granting app-container access to '{directory}' failed: {process.StandardError.ReadToEnd().Trim()}");
        }
    }

    public static void Inject(int processId, string tapDllPath, Guid tapClsid, string initializationData)
    {
        if (!File.Exists(tapDllPath))
        {
            throw new FileNotFoundException($"Tap DLL not found: {tapDllPath}");
        }

        // The tap is loaded into the target, so it must match the TARGET's architecture, not
        // this process's. They are the same here only because this helper is built to match.
        var hr = InitializeXamlDiagnosticsEx(
            EndpointName,
            (uint)processId,
            "Windows.UI.Xaml.dll",
            tapDllPath,
            tapClsid,
            initializationData);

        if (hr != 0)
        {
            throw new InvalidOperationException(
                $"InitializeXamlDiagnosticsEx failed with 0x{hr:X8}.{Explain(hr)}");
        }
    }

    static string Explain(int hr) => hr switch
    {
        unchecked((int)0x80070490) =>
            " ERROR_NOT_FOUND: the diagnostics endpoint is not there. Either the app has not "
            + "brought up its XAML tree yet, or the endpoint name is wrong (it must be "
            + $"'{EndpointName}').",
        unchecked((int)0x80070005) =>
            " E_ACCESSDENIED: the app container cannot read the tap DLL. Grant its directory to "
            + "ALL APPLICATION PACKAGES.",
        unchecked((int)0x8007007E) =>
            " ERROR_MOD_NOT_FOUND: the tap DLL could not be loaded, usually an architecture "
            + "mismatch with the target or a missing dependency.",
        _ => string.Empty
    };
}
