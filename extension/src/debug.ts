import * as vscode from 'vscode';

import { deploy, type DeployResult } from './core/deploy';
import {
    disableDebugging,
    findUwpLaunch,
    HOT_RELOAD_ENVIRONMENT,
    launchSuspended,
    killProcess,
    type SuspendedApp
} from './core/launcher';
import { UwpFlavour, type UwpProject } from './core/projects';

export interface UwpDebugConfiguration extends vscode.DebugConfiguration {
    type: 'uwp';
    request: 'launch';
    project?: string;
    configuration?: string;
    platform?: string;
    /** `auto` picks from the project flavour and what is installed. */
    engine?: 'auto' | 'cppvsdbg' | 'coreclr' | 'none';
    /** Skip the build, e.g. when iterating on deployment. */
    noBuild?: boolean;
    /** Extra KEY=VALUE pairs for the app process. */
    env?: string[];
    /**
     * Hold the app at its first instruction until the engine has attached. Default true.
     *
     * Set false to let the app start normally and attach to it once it is running. That loses
     * any breakpoint in startup, but a managed engine performing an ordinary attach needs the
     * CLR to already be loaded — at the first instruction there is no runtime in the process
     * for it to find.
     */
    holdForAttach?: boolean;
}

/**
 * Debug engines this can hand off to, and which extensions provide them.
 *
 * A debug *type* can come from more than one extension — `coreclr` is contributed by both
 * ReSharper and the Microsoft C# extension — so this maps a type to every known provider
 * rather than to one. Assuming a single provider is what made `auto` fall back to a native
 * engine on a machine that had ReSharper installed and working.
 */
const ENGINES: Record<string, { providers: string[]; label: string }> = {
    cppvsdbg: {
        providers: ['ms-vscode.cpptools'],
        label: 'C++ (Windows)'
    },
    coreclr: {
        // ReSharper first: it is the pairing this extension is designed around.
        providers: ['JetBrains.resharper-code', 'ms-dotnettools.csharp'],
        label: 'C# (.NET)'
    }
};

/** The extension providing a debug type, or undefined when nothing does. */
function providerOf(engine: string): string | undefined {
    return ENGINES[engine]?.providers.find(
        (id) => vscode.extensions.getExtension(id) !== undefined
    );
}

/**
 * Makes sure the extension providing a debug type is actually running.
 *
 * Being installed is not enough. A debug adapter is registered during its extension's
 * activation, and activation is lazy — normally triggered by VS Code's own
 * `onDebugResolve:<type>` event, which does not fire when a session is started
 * programmatically with an already-resolved configuration. The result is
 * "Couldn't find a debug adapter descriptor for debug type 'coreclr' (extension might have
 * failed to activate)", which reads like the engine is broken rather than merely asleep.
 */
async function ensureEngineActivated(engine: string, log: (message: string) => void): Promise<void> {
    // Every installed provider, not just the preferred one. Two extensions can contribute the
    // same debug type, and being installed does not mean being able to serve it — ReSharper
    // contributes `coreclr` but registers nothing until it is licensed and its backend runs.
    // Activating only the preferred provider would leave a working second one asleep and fail
    // for a reason that looks like the debug type does not exist.
    for (const id of ENGINES[engine]?.providers ?? []) {
        const extension = vscode.extensions.getExtension(id);
        if (!extension) {
            continue;
        }
        if (extension.isActive) {
            log(`debug: ${id} already active`);
            continue;
        }
        log(`debug: activating ${id} for debug type '${engine}'`);
        try {
            await extension.activate();
            log(`debug: ${id} activated`);
        } catch (error) {
            log(`debug: ${id} failed to activate: ${String(error)}`);
        }
    }
}

function isInstalled(engine: string): boolean {
    return providerOf(engine) !== undefined;
}

/**
 * Picks a debug engine for a project.
 *
 * Deliberately prefers an engine that is actually installed over the theoretically better
 * one: handing off to a debug type nothing provides fails with "configured debug type is not
 * supported", which reads like a bug in this extension.
 */
export function chooseEngine(project: UwpProject, requested: UwpDebugConfiguration['engine']): string {
    if (requested && requested !== 'auto') {
        return requested;
    }
    // Managed debugging only exists for classic UWP in Debug, where the app runs on CoreCLR.
    // Everything else is native: modern UWP is Native AOT, C++/WinRT obviously so, and a
    // Release classic build is .NET Native, which ICorDebug cannot attach to at all.
    if (project.flavour === UwpFlavour.LegacyManaged && project.supportsManagedDebugging) {
        if (isInstalled('coreclr')) {
            return 'coreclr';
        }
    }
    return isInstalled('cppvsdbg') ? 'cppvsdbg' : 'none';
}

interface PendingLaunch {
    deployResult: DeployResult;
    suspended: SuspendedApp;
    uwpLaunchPath: string;
    resumed: boolean;
    watchdog: NodeJS.Timeout;
}

/**
 * Turns an F5 into build → deploy → launch-suspended → attach → resume.
 *
 * The `uwp` configuration is *rewritten* into the chosen engine's attach configuration and
 * returned, so VS Code runs a single session with a real adapter. An earlier version called
 * `vscode.debug.startDebugging` from inside this callback and cancelled its own session; VS
 * Code does not support starting a session from within a resolve, and the visible result was
 * a session that terminated the instant F5 was pressed.
 *
 * Microsoft's debug engines are never invoked directly. Returning a configuration lets VS Code
 * start the engine from the user's own installation, which is the only licensed way to use it.
 */
export class UwpDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    /**
     * Keyed by process id, not session name.
     *
     * Debug adapters rename their session freely — ReSharper reports an attach as something of
     * its own choosing — so matching on the name silently fails to find the launch, the app is
     * never resumed, and it sits suspended looking like it hung on startup. The pid is in the
     * configuration we handed the engine, so it survives any renaming.
     */
    private readonly pending = new Map<number, PendingLaunch>();

    constructor(
        private readonly extensionRoot: string,
        private readonly resolveProject: (path?: string) => UwpProject | undefined,
        private readonly build: (project: UwpProject) => Promise<boolean>,
        private readonly log: (message: string) => void,
        private readonly showLog: () => void,
        /**
         * Called once the app is attached and running, so XAML hot reload can attach too.
         *
         * F5 is the flow developers actually use; leaving hot reload wired only to the
         * non-debug run made it look broken to anyone who pressed F5 and then edited a file.
         */
        private readonly onLaunched?: (
            project: UwpProject,
            deployResult: DeployResult,
            pid: number
        ) => Promise<void>
    ) { }

    provideDebugConfigurations(): vscode.DebugConfiguration[] {
        return [
            {
                type: 'uwp',
                request: 'launch',
                name: 'UWP: Launch',
                engine: 'auto'
            } satisfies UwpDebugConfiguration
        ];
    }

    async resolveDebugConfigurationWithSubstitutedVariables(
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration
    ): Promise<vscode.DebugConfiguration | undefined | null> {
        const uwpConfig = config as UwpDebugConfiguration;

        // An empty launch.json gives an untyped config; send the user to a real one rather
        // than failing halfway through a deploy.
        if (!uwpConfig.type) {
            return null;
        }

        try {
            return await this.prepare(uwpConfig);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.log(`ERROR: ${message}`);
            this.showLog();
            void vscode.window.showErrorMessage(`UWP debug: ${message}`);
            // undefined cancels silently; the message above is what the user acts on.
            return undefined;
        }
    }

    /**
     * Does the whole launch and returns the engine configuration to start.
     *
     * Public so the `uwp.debug` command can call it and then start the engine session
     * directly, rather than going through a `uwp` session whose type gets rewritten. Rewriting
     * the type inside a resolve is supported but fragile — the new type's own provider chain
     * runs afterwards and can reject the configuration, which surfaces only as
     * `startDebugging` returning false with nothing explaining why.
     */
    async prepareSession(config: UwpDebugConfiguration): Promise<vscode.DebugConfiguration> {
        return this.prepare(config);
    }

    private async prepare(config: UwpDebugConfiguration): Promise<vscode.DebugConfiguration> {
        const project = this.resolveProject(config.project);
        if (!project) {
            throw new Error(
                'No UWP project found. Run "UWP: Check Prerequisites" and "UWP: Select Active Project".'
            );
        }
        this.log(`debug: project ${project.name} (${project.configuration}|${project.platform})`);

        const uwpLaunchPath = findUwpLaunch(this.extensionRoot);
        if (!uwpLaunchPath) {
            throw new Error(
                'uwplaunch.exe was not found. Build it with: dotnet build src/UwpLaunch -c Release'
            );
        }

        const engine = chooseEngine(project, config.engine);
        if (engine === 'none') {
            throw new Error(
                'No debug engine is available. Install the C/C++ extension (ms-vscode.cpptools) '
                + 'for native debugging, or a C# extension for managed debugging.'
            );
        }
        // Chosen before the build so a missing engine fails in a second rather than after a
        // full build and deploy.
        this.log(`debug: engine ${engine} (from ${providerOf(engine) ?? 'unknown'})`);

        // The symbol-format trap, warned about before anything is built. Every classic UWP
        // project defaults to a Windows PDB, which the .NET debugger cannot read, and the
        // failure mode is a debugger that attaches perfectly and binds nothing.
        if (engine === 'coreclr' && project.symbolProblem) {
            this.log(`debug: WARNING ${project.symbolProblem}`);
            void vscode.window
                .showWarningMessage(
                    'Breakpoints will not bind: this project emits a Windows PDB.',
                    'Show Details'
                )
                .then((pick) => {
                    if (pick === 'Show Details') {
                        this.showLog();
                    }
                });
        }

        // A native engine on a managed project attaches to the process but binds no C#
        // breakpoints. That looks like a broken debugger rather than the wrong one, so say it
        // plainly instead of letting the user infer it from breakpoints that never hit.
        if (engine === 'cppvsdbg' && project.flavour === UwpFlavour.LegacyManaged) {
            this.log(
                'debug: WARNING cppvsdbg is a native debugger and this is a managed (CoreCLR) app. '
                + 'It will not bind C# breakpoints. Install ReSharper or the C# extension for '
                + 'managed debugging.'
            );
            void vscode.window.showWarningMessage(
                'Debugging with cppvsdbg (native). C# breakpoints will not bind — install ReSharper '
                + 'or the C# extension for managed debugging.'
            );
        }

        if (!config.noBuild) {
            this.log('debug: building');
            if (!(await this.build(project))) {
                throw new Error('Build failed; not deploying. See the terminal.');
            }
        }

        this.log('debug: deploying');
        // The launcher is handed to deploy so it can stop a previously held instance through
        // TerminateAllProcesses; a suspended app is invisible to any path-based sweep.
        const deployResult = await deploy(
            project,
            (message) => this.log(`  ${message}`),
            uwpLaunchPath
        );

        // Hot reload needs this set at process start and there is no way to add it later.
        // Harmless when hot reload is not in use.
        const environment = [...HOT_RELOAD_ENVIRONMENT, ...(config.env ?? [])];

        // Before the app is launched and held: if the engine cannot come up, failing here
        // costs nothing, where failing after leaves an app suspended waiting for it.
        await ensureEngineActivated(engine, this.log);

        this.log('debug: launching suspended');
        const suspended = await launchSuspended({
            uwpLaunchPath,
            packageFullName: deployResult.packageFullName,
            aumid: deployResult.aumid,
            environment,
            waitForAttach: true
        });
        this.log(`debug: held at first instruction, pid ${suspended.pid}`);

        const name = config.name || `UWP: ${project.name}`;
        const hold = config.holdForAttach !== false;

        if (!hold) {
            // Let the runtime come up before the engine looks for it, at the cost of any
            // breakpoint that would have been hit during startup.
            this.log('debug: holdForAttach=false; resuming before attach');
            suspended.resume();
            await new Promise((resolve) => setTimeout(resolve, 5000));
        }

        // If the engine never starts a session -- a failed attach, a cancelled prompt -- the
        // app would stay suspended forever and look like it failed to launch. Resuming after a
        // timeout is strictly better: the user gets a running app and a message explaining
        // that it is not being debugged.
        const watchdog = setTimeout(() => {
            const entry = this.pending.get(suspended.pid);
            if (entry && !entry.resumed) {
                entry.resumed = true;
                entry.suspended.resume();
                this.log('debug: no session started within 30s; resumed without a debugger');
                void vscode.window.showWarningMessage(
                    `The ${engine} debugger did not attach. The app is running without a debugger.`
                );
            }
            // Shorter than it was: 60 seconds of a window that never appears reads as a hang,
            // and the user gives up before the safety net fires.
        }, 30_000);

        // Deliberately not awaited: injecting the tap needs the app's XAML tree to be up,
        // which cannot happen until it has been resumed, and resuming waits on this returning.
        if (this.onLaunched) {
            this.log(`debug: starting XAML hot reload for pid ${suspended.pid}`);
            void this.onLaunched(project, deployResult, suspended.pid).catch((error) =>
                this.log(`hot reload: ${String(error)}`)
            );
        } else {
            this.log('debug: no hot reload callback wired; XAML edits will not apply');
        }

        this.pending.set(suspended.pid, {
            deployResult,
            suspended,
            uwpLaunchPath,
            // Already let go above when not holding, so the session-start handler must not
            // resume a second time.
            resumed: !hold,
            watchdog
        });

        // Engine-specific and minimal. The two adapters do not share an attach schema, and
        // passing an attribute the engine does not know can make VS Code reject the whole
        // configuration — which surfaces as startDebugging silently returning false.
        const resolved: vscode.DebugConfiguration =
            engine === 'cppvsdbg'
                ? {
                    type: 'cppvsdbg',
                    request: 'attach',
                    name,
                    processId: suspended.pid,
                    // Symbols sit beside the executable in the layout; without this the engine
                    // has nowhere to look and binds nothing.
                    symbolSearchPath: deployResult.layoutDir
                }
                : {
                    type: engine,
                    request: 'attach',
                    name,
                    // vsdbg wants the pid as a string, unlike cppvsdbg.
                    processId: String(suspended.pid),
                    // The PDB sits beside the executable in the unpacked layout, which is not
                    // a path the engine would look in on its own. Without this it attaches and
                    // binds nothing, which is indistinguishable from not supporting the target.
                    symbolOptions: {
                        searchPaths: [deployResult.layoutDir],
                        searchMicrosoftSymbolServer: false
                    },
                    // The app's own code is what we want to stop in, and "just my code" can
                    // exclude assemblies it does not recognise as the user's — a packaged app
                    // being an easy thing to misjudge.
                    justMyCode: false
                };

        this.log(`debug: resolved to ${JSON.stringify(resolved)}`);
        return resolved;
    }

    /**
     * Lets the app run, once the engine has actually attached. This is the other half of the
     * from-birth guarantee: resume any earlier and a breakpoint in App.OnLaunched is missed.
     */
    onSessionStarted(session: vscode.DebugSession): void {
        const found = this.match(session);
        if (!found) {
            return;
        }
        const [pid, entry] = found;
        if (entry.resumed) {
            return;
        }
        entry.resumed = true;
        clearTimeout(entry.watchdog);
        this.log(`debug: ${session.type} session '${session.name}' started; resuming pid ${pid}`);
        entry.suspended.resume();
    }

    /**
     * Matches a started session back to the launch that is waiting on it.
     *
     * By pid from the configuration first, since that is what we put there and no adapter
     * rewrites it. Falling back to "the only thing waiting" covers an adapter that rebuilds
     * the configuration wholesale: resuming the one app we are holding is right in every case
     * where exactly one is held, and leaving it suspended is wrong in all of them.
     */
    private match(session: vscode.DebugSession): [number, PendingLaunch] | undefined {
        const configured = Number(session.configuration?.['processId']);
        if (Number.isFinite(configured) && this.pending.has(configured)) {
            return [configured, this.pending.get(configured)!];
        }

        const waiting = [...this.pending.entries()].filter(([, entry]) => !entry.resumed);
        if (waiting.length === 1) {
            this.log(
                `debug: session '${session.name}' carried no matching pid; `
                + `assuming the one launch being held (pid ${waiting[0][0]})`
            );
            return waiting[0];
        }
        return undefined;
    }

    /**
     * Undoes what the launch set up. `disableDebugging` is not optional: a package left in
     * debug mode stays that way after VS Code closes, the system stops suspending it, and
     * nothing tells the user why.
     */
    async endSession(session: vscode.DebugSession): Promise<void> {
        const found = this.match(session);
        if (!found) {
            return;
        }
        const [pid, entry] = found;
        this.pending.delete(pid);
        clearTimeout(entry.watchdog);
        if (!entry.resumed) {
            // Never attached; do not leave the process wedged.
            entry.suspended.resume();
        }
        try {
            // By pid, not by package: teardown is asynchronous, and a package-wide terminate
            // arriving late kills whatever instance is running by then — including the next
            // launch, which then fails with "No process with the specified id is currently
            // running" about a process that was alive a moment earlier.
            await killProcess(entry.suspended.pid, entry.deployResult.processName);
            await disableDebugging(entry.uwpLaunchPath, entry.deployResult.packageFullName);
            this.log(`debug: cleaned up pid ${entry.suspended.pid}`);
        } catch (error) {
            this.log(`debug: cleanup failed: ${String(error)}`);
        }
    }

    /**
     * Lets go of anything still held, without waiting for the watchdog.
     *
     * An app suspended at its first instruction shows no window and looks like a hang, so
     * there has to be a way out that is not "restart VS Code".
     */
    resumeHeld(): number {
        let released = 0;
        for (const [pid, entry] of this.pending) {
            if (!entry.resumed) {
                entry.resumed = true;
                clearTimeout(entry.watchdog);
                entry.suspended.resume();
                this.log(`debug: manually resumed pid ${pid}`);
                released++;
            }
        }
        return released;
    }

    /** Releases every launch this provider still owns, for extension shutdown. */
    async dispose(): Promise<void> {
        for (const [pid, entry] of this.pending) {
            this.pending.delete(pid);
            clearTimeout(entry.watchdog);
            if (!entry.resumed) {
                entry.suspended.resume();
            }
            try {
                await disableDebugging(entry.uwpLaunchPath, entry.deployResult.packageFullName);
            } catch {
                // Shutdown is best-effort.
            }
        }
    }
}
