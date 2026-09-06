namespace UwpLaunch;

/// <summary>
/// The app-model helper the extension shells out to. All COM lives here rather than in the
/// extension host: binding IPackageDebugSettings from Node would mean a native module tracked
/// against Electron ABI changes, for no gain over a process boundary and a line of JSON.
///
/// Every command prints one JSON object on stdout, so the caller never parses prose.
/// </summary>
internal static class Program
{
    static int Main(string[] args)
    {
        // The system launches this executable as the app's debugger, so stub mode must be
        // recognised before anything else and must not depend on any other argument.
        if (args.Contains(ResumeStub.ModeFlag))
        {
            return ResumeStub.Run(args);
        }

        if (args.Length == 0)
        {
            Usage();
            return 64;
        }

        try
        {
            return Dispatch(args);
        }
        catch (Exception error)
        {
            Launcher.WriteJson(new { ok = false, error = error.Message });
            return 1;
        }
    }

    static int Dispatch(string[] args)
    {
        var command = args[0];
        var packageFullName = Args.Value(args, "--package");
        var aumid = Args.Value(args, "--aumid");

        switch (command)
        {
            case "launch":
            {
                Require(packageFullName, "--package");
                Require(aumid, "--aumid");

                var environment = args
                    .Select((value, index) => (value, index))
                    .Where(pair => pair.value == "--env" && pair.index + 1 < args.Length)
                    .Select(pair => args[pair.index + 1])
                    .ToList();

                // Requested by default: it is what makes a breakpoint in App.OnLaunched land,
                // and it costs nothing when no debugger is waiting.
                var waitForAttach = !args.Contains("--no-wait");

                // --hold is what makes F5 possible. Without it the app is resumed as soon as
                // the stub reports in, which is microseconds -- far too early for a debugger
                // to have attached. With it, the pid is published while the app is still
                // suspended at its first instruction and the caller decides when to resume,
                // by writing a line to stdin.
                var hold = args.Contains("--hold");

                using var launcher = new Launcher();
                Action<int, int>? onSuspended = null;
                if (hold)
                {
                    onSuspended = (pid, tid) =>
                    {
                        Launcher.WriteJson(new { ok = true, pid, tid, suspended = true, aumid });
                        Console.Out.Flush();

                        // Waits for the caller to say go, but not forever. Closing stdin ends
                        // the read, which covers a caller that exits cleanly; a caller that
                        // dies badly — an extension host crash, say — leaves the pipe open,
                        // and an unbounded wait would strand this process holding both the
                        // suspended app and a lock on this executable.
                        var read = Task.Run(() => Console.ReadLine());
                        if (!read.Wait(TimeSpan.FromMinutes(2)))
                        {
                            Console.Error.WriteLine(
                                "No resume within 2 minutes; resuming anyway so the app is not left suspended.");
                        }
                    };
                }

                var outcome = launcher.Launch(packageFullName!, aumid!, environment, waitForAttach, onSuspended);
                Launcher.WriteJson(new
                {
                    ok = true,
                    pid = outcome.ProcessId,
                    tid = outcome.ThreadId,
                    fromBirth = outcome.FromBirth,
                    suspended = false,
                    aumid = outcome.Aumid
                });
                return 0;
            }

            case "inject":
            {
                var pid = Args.Int(args, "--pid")
                    ?? throw new ArgumentException("--pid is required.");
                var tap = Args.Value(args, "--tap")
                    ?? throw new ArgumentException("--tap is required.");
                var clsidText = Args.Value(args, "--clsid")
                    ?? throw new ArgumentException("--clsid is required.");
                var data = Args.Value(args, "--data") ?? string.Empty;

                if (!Guid.TryParse(clsidText, out var clsid))
                {
                    throw new ArgumentException($"--clsid is not a GUID: {clsidText}");
                }

                var tapPath = Path.GetFullPath(tap);
                var tapDirectory = Path.GetDirectoryName(tapPath)!;

                // Grant before injecting, not after: the framework loads the DLL from inside
                // the sandbox, so an ungranted directory fails at load with an error that
                // points at the DLL rather than at its permissions.
                Injector.GrantAppContainerAccess(tapDirectory);
                if (data.Length > 0 && Directory.Exists(data))
                {
                    Injector.GrantAppContainerAccess(data);
                }

                Injector.Inject(pid, tapPath, clsid, data);
                Launcher.WriteJson(new { ok = true, pid, tap = tapPath, clsid = clsid.ToString() });
                return 0;
            }

            case "enable-debug":
            {
                Require(packageFullName, "--package");
                Interop.EnableDebugging(packageFullName!);
                Launcher.WriteJson(new { ok = true });
                return 0;
            }

            case "disable-debug":
            {
                Require(packageFullName, "--package");
                Interop.DisableDebugging(packageFullName!);
                Launcher.WriteJson(new { ok = true });
                return 0;
            }

            case "terminate":
            {
                Require(packageFullName, "--package");
                Interop.TerminateAllProcesses(packageFullName!);
                Launcher.WriteJson(new { ok = true });
                return 0;
            }

            // Suspend and resume drive the PLM states by hand. Testing an app's suspend and
            // resume handlers is genuinely awkward without this, and it is nearly free here.
            case "suspend":
            {
                Require(packageFullName, "--package");
                Interop.Suspend(packageFullName!);
                Launcher.WriteJson(new { ok = true });
                return 0;
            }

            case "resume":
            {
                Require(packageFullName, "--package");
                Interop.Resume(packageFullName!);
                Launcher.WriteJson(new { ok = true });
                return 0;
            }

            default:
                Usage();
                return 64;
        }
    }

    static void Require(string? value, string name)
    {
        if (string.IsNullOrEmpty(value))
        {
            throw new ArgumentException($"{name} is required.");
        }
    }

    static void Usage()
    {
        Console.Error.WriteLine(
            """
            uwplaunch <command> [options]

              launch         --package <pfn> --aumid <aumid> [--env KEY=VALUE ...]
                             [--no-wait] [--hold]
              inject         --pid <pid> --tap <dll> --clsid <guid> [--data <string>]
              enable-debug   --package <pfn>
              disable-debug  --package <pfn>
              terminate      --package <pfn>
              suspend        --package <pfn>
              resume         --package <pfn>

            Every enable-debug must be paired with a disable-debug: a package left in debug
            mode stays that way after the process that set it has gone.

            With --hold, a JSON line carrying the pid is printed while the app is still
            suspended at its first instruction, and the app is resumed when the caller writes
            any line to stdin. That gap is the only moment a debugger can attach and still see
            the runtime start.

            Note: an --env block is only accepted alongside a debugger command line, so
            'launch' registers the resume stub whenever environment variables are requested,
            regardless of --no-wait.
            """);
    }
}
