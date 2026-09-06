using System.IO.Pipes;

namespace UwpLaunch;

/// <summary>
/// The half of the launch that the system starts.
///
/// A packaged app cannot be created suspended by its launcher the way a plain executable can:
/// only the shell's activation may start it. So the package is put into debug mode with THIS
/// executable registered as its debugger, and the system then creates the app suspended and
/// runs <c>uwplaunch --resume-stub --pipe &lt;name&gt; -p &lt;pid&gt; -tid &lt;tid&gt;</c>
/// instead of the app.
///
/// The stub reports those ids to the waiting launcher, waits for it to say it is ready, and
/// only then resumes the app's main thread. That ordering is the whole point: it is what lets
/// a debugger attach before the first line of managed code, so a breakpoint in App.OnLaunched
/// is hit rather than missed.
///
/// If the launcher never answers, the app is resumed anyway. A missing or crashed host should
/// degrade to a normal run, never leave a process suspended forever.
/// </summary>
internal static class ResumeStub
{
    public const string ModeFlag = "--resume-stub";

    static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(20);
    static readonly TimeSpan ReplyTimeout = TimeSpan.FromSeconds(20);

    public static int Run(string[] args)
    {
        var pipeName = Args.Value(args, "--pipe");
        var processId = Args.Int(args, "-p");
        var threadId = Args.Int(args, "-tid");

        try
        {
            if (pipeName is null || processId is null || threadId is null)
            {
                // Nothing to coordinate with. Let the app run rather than stranding it.
                Interop.ResumeThreadById(threadId ?? 0);
                return 2;
            }
            return Coordinate(pipeName, processId.Value, threadId.Value) ? 0 : 3;
        }
        catch
        {
            if (threadId is not null)
            {
                Interop.ResumeThreadById(threadId.Value);
            }
            return 1;
        }
    }

    static bool Coordinate(string pipeName, int processId, int threadId)
    {
        using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut);
        try
        {
            pipe.Connect((int)ConnectTimeout.TotalMilliseconds);
        }
        catch (TimeoutException)
        {
            return Interop.ResumeThreadById(threadId);
        }

        using var reader = new StreamReader(pipe);
        using var writer = new StreamWriter(pipe) { AutoFlush = true };

        writer.WriteLine($"{processId} {threadId}");

        var reply = reader.ReadLineAsync();
        if (!reply.Wait(ReplyTimeout))
        {
            // The launcher went away mid-handshake. Resuming is strictly better than leaving
            // the user with an app that never appears and no way to tell why.
            return Interop.ResumeThreadById(threadId);
        }

        return Interop.ResumeThreadById(threadId);
    }
}

internal static class Args
{
    public static string? Value(string[] args, string name)
    {
        var index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    public static int? Int(string[] args, string name) =>
        int.TryParse(Value(args, name), out var value) ? value : null;
}
