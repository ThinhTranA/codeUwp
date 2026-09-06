using System.IO.Pipes;
using System.Text.Json;

namespace UwpLaunch;

internal sealed record LaunchOutcome(int ProcessId, int ThreadId, bool FromBirth, string Aumid);

/// <summary>
/// Starts a packaged app under debug mode and reports the pid, optionally holding it
/// suspended until a debugger has had a chance to attach.
/// </summary>
internal sealed class Launcher : IDisposable
{
    // The system truncates the registered debugger command line somewhere around 255
    // characters. Exceeding it does not error, it silently stores a mangled command line and
    // the stub then never runs, so this is checked rather than hoped for.
    const int MaxDebuggerCommandLine = 255;

    readonly string _pipeName = $"uwplaunch.{Environment.ProcessId}.{Random.Shared.Next():x8}";
    NamedPipeServerStream? _pipe;

    public void Dispose() => _pipe?.Dispose();

    /// <summary>
    /// Launches with the resume stub, so the app is held at its first instruction until
    /// <paramref name="onSuspended"/> has run. Falls back to a plain activation when the
    /// command line will not fit.
    /// </summary>
    public LaunchOutcome Launch(
        string packageFullName,
        string aumid,
        IReadOnlyList<string> environment,
        bool waitForAttach,
        Action<int, int>? onSuspended = null)
    {
        // Activation of a package that already has a running instance foregrounds the existing
        // window and starts no new process, so a from-birth launcher would wait forever for a
        // startup that never happens. Terminating first makes "launch" mean launch.
        try
        {
            Interop.TerminateAllProcesses(packageFullName);
        }
        catch
        {
            // Nothing running, or nothing we may terminate; either way, carry on.
        }

        var stubCommandLine = BuildStubCommandLine();
        var canUseStub = waitForAttach && stubCommandLine is not null;

        // An environment block is only accepted alongside a debugger command line (measured:
        // E_INVALIDARG otherwise). So when the caller wants environment variables -- which
        // XAML hot reload does, for ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO -- the stub is not
        // optional, it is the vehicle.
        var needStubForEnvironment = environment.Count > 0;
        var debuggerCommandLine = canUseStub || needStubForEnvironment ? stubCommandLine : null;

        if (needStubForEnvironment && debuggerCommandLine is null)
        {
            throw new InvalidOperationException(
                $"Environment variables were requested but the debugger command line would exceed "
                + $"{MaxDebuggerCommandLine} characters. Move uwplaunch.exe to a shorter path.");
        }

        Interop.EnableDebugging(packageFullName, debuggerCommandLine, environment);

        if (debuggerCommandLine is null)
        {
            return new LaunchOutcome((int)Interop.ActivateApplication(aumid), 0, false, aumid);
        }

        _pipe = new NamedPipeServerStream(
            _pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);

        // ActivateApplication does not return until the app is resumed, and the stub is what
        // resumes it -- so activation has to run off this thread or the two deadlock.
        var activation = Task.Run(() => Interop.ActivateApplication(aumid));

        if (!_pipe.WaitForConnectionAsync().Wait(TimeSpan.FromSeconds(30)))
        {
            throw new TimeoutException(
                "The resume stub never connected, so the app did not activate under the debugger. "
                + "Check that uwplaunch.exe is at the path registered as the debugger.");
        }

        using var reader = new StreamReader(_pipe, leaveOpen: true);
        using var writer = new StreamWriter(_pipe, leaveOpen: true) { AutoFlush = true };

        var line = ReadLine(reader, TimeSpan.FromSeconds(20))
            ?? throw new TimeoutException("The resume stub connected but reported no ids.");
        var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 2 || !int.TryParse(parts[0], out var pid) || !int.TryParse(parts[1], out var tid))
        {
            throw new InvalidOperationException($"The resume stub reported malformed ids: '{line}'.");
        }

        // The app is suspended at its first instruction right now. This is the only moment a
        // debugger can attach and still see the runtime start.
        onSuspended?.Invoke(pid, tid);

        writer.WriteLine("resume");
        activation.Wait(TimeSpan.FromSeconds(30));

        return new LaunchOutcome(pid, tid, true, aumid);
    }

    string? BuildStubCommandLine()
    {
        var exe = Environment.ProcessPath;
        if (string.IsNullOrEmpty(exe))
        {
            return null;
        }
        var command = $"\"{exe}\" {ResumeStub.ModeFlag} --pipe {_pipeName}";
        return command.Length <= MaxDebuggerCommandLine ? command : null;
    }

    static string? ReadLine(StreamReader reader, TimeSpan timeout)
    {
        var task = reader.ReadLineAsync();
        return task.Wait(timeout) ? task.Result : null;
    }

    public static void WriteJson(object value) =>
        Console.WriteLine(JsonSerializer.Serialize(value, new JsonSerializerOptions { WriteIndented = false }));
}
