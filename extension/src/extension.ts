import * as path from 'path';
import * as vscode from 'vscode';

import { deploy, DeployError, launch, terminate, type DeployResult } from './core/deploy';
import { runDoctor, summarise, type Check } from './core/doctor';
import { discoverProjects, UwpFlavour, type UwpProject } from './core/projects';
import { findMsBuild } from './core/toolchain';
import { UwpDebugConfigurationProvider } from './debug';
import { UwpTaskProvider, type UwpTaskDefinition } from './tasks';

let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;

/**
 * Everything also written to the output channel, kept so the integration suite can read it.
 *
 * An OutputChannel is write-only through the API, so a test running inside the extension host
 * has no way to see why something failed. Without this, an integration failure reports only
 * "no debug session started" and the actual reason stays invisible.
 */
const logBuffer: string[] = [];

function log(message: string): void {
    logBuffer.push(message);
    if (logBuffer.length > 2000) {
        logBuffer.shift();
    }
    output.appendLine(message);
}

let msbuildPath: string | undefined;
let projects: UwpProject[] = [];
let activeProject: UwpProject | undefined;
let lastDeploy: DeployResult | undefined;
let debugProvider: UwpDebugConfigurationProvider;

export interface UwpToolsApi {
    /** The output channel's contents, for the integration suite. Not a public API. */
    getLog(): string[];
}

export async function activate(context: vscode.ExtensionContext): Promise<UwpToolsApi> {
    output = vscode.window.createOutputChannel('UWP Tools');
    context.subscriptions.push(output);

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.command = 'uwp.selectProject';
    context.subscriptions.push(statusBar);

    context.subscriptions.push(
        vscode.tasks.registerTaskProvider(
            UwpTaskProvider.type,
            new UwpTaskProvider(
                () => activeProject,
                () => msbuildPath
            )
        )
    );

    debugProvider = new UwpDebugConfigurationProvider(
        context.extensionPath,
        (requested) => (requested ? findProject(requested) : activeProject),
        buildProject,
        log,
        () => output.show(true)
    );
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('uwp', debugProvider),
        // Also registered as a Dynamic provider, so "UWP: Launch" appears in the Run and Debug
        // dropdown in a workspace that has no launch.json at all. Requiring one is a poor first
        // experience, and worse in an Extension Development Host, which restores its own last
        // opened folder rather than the one it was pointed at.
        vscode.debug.registerDebugConfigurationProvider(
            'uwp',
            debugProvider,
            vscode.DebugConfigurationProviderTriggerKind.Dynamic
        ),
        vscode.debug.onDidStartDebugSession((session) => debugProvider.onSessionStarted(session)),
        vscode.debug.onDidTerminateDebugSession((session) => void debugProvider.endSession(session)),
        { dispose: () => void debugProvider.dispose() }
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('uwp.doctor', showDoctor),
        vscode.commands.registerCommand('uwp.selectProject', selectProject),
        vscode.commands.registerCommand('uwp.selectConfiguration', selectConfiguration),
        vscode.commands.registerCommand('uwp.showProjectInfo', showProjectInfo),
        vscode.commands.registerCommand('uwp.build', () => runTask('build')),
        vscode.commands.registerCommand('uwp.rebuild', () => runTask('rebuild')),
        vscode.commands.registerCommand('uwp.clean', () => runTask('clean')),
        vscode.commands.registerCommand('uwp.deploy', () => runDeploy(false)),
        vscode.commands.registerCommand('uwp.run', () => runDeploy(true)),
        vscode.commands.registerCommand('uwp.debug', startDebugging),
        vscode.commands.registerCommand('uwp.resumeHeld', () => {
            const released = debugProvider.resumeHeld();
            void vscode.window.showInformationMessage(
                released > 0
                    ? `Resumed ${released} app(s) that were held waiting for a debugger.`
                    : 'No apps are currently held.'
            );
        }),
        vscode.commands.registerCommand('uwp.terminate', runTerminate)
    );

    await refresh();

    // Exported for the integration suite; not intended as an API for other extensions.
    return { getLog: (): string[] => [...logBuffer] };
}

export function deactivate(): void {
    // Nothing to unwind yet. Once the extension starts calling EnableDebugging, its paired
    // DisableDebugging belongs here as well as on debug-session end — a package left in debug
    // mode outlives the window that put it there.
}

async function refresh(): Promise<void> {
    const config = vscode.workspace.getConfiguration('uwp');
    const configuration = config.get<string>('configuration', 'Debug');
    const platform = config.get<string>('platform', 'x64');

    const install = await findMsBuild(config.get<string>('msbuildPath') || undefined);
    msbuildPath = install?.msbuildPath;

    if (!msbuildPath) {
        statusBar.text = '$(warning) UWP: no MSBuild';
        statusBar.tooltip = 'No Visual Studio install with the UWP workload was found. Run "UWP: Check Prerequisites".';
        statusBar.command = 'uwp.doctor';
        statusBar.show();
        log('No Visual Studio install with the UWP workload found.');
        return;
    }

    log(`MSBuild: ${msbuildPath} (${install?.displayName} ${install?.installationVersion})`);

    const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    if (roots.length === 0) {
        statusBar.hide();
        return;
    }

    projects = await discoverProjects(msbuildPath, roots, configuration, platform);
    log(`Discovered ${projects.length} UWP project(s).`);
    for (const project of projects) {
        log(`  ${project.name} [${project.flavour}] ${project.projectPath}`);
    }

    // Keep the current selection if it survived the refresh; otherwise fall back to the first.
    activeProject =
        projects.find((project) => project.projectPath === activeProject?.projectPath) ?? projects[0];
    updateStatusBar();
}

function updateStatusBar(): void {
    if (!activeProject) {
        statusBar.hide();
        return;
    }
    statusBar.command = 'uwp.selectProject';
    statusBar.text = `$(package) ${activeProject.name} | ${activeProject.configuration}|${activeProject.platform}`;
    statusBar.tooltip = new vscode.MarkdownString(
        [
            `**${activeProject.name}**`,
            '',
            `Flavour: \`${activeProject.flavour}\``,
            `Target: \`${activeProject.targetPlatformMinVersion ?? '?'}\` – \`${activeProject.targetPlatformVersion ?? '?'}\``,
            '',
            activeProject.debuggingNote
        ].join('\n')
    );
    statusBar.show();
}

async function selectProject(): Promise<void> {
    if (projects.length === 0) {
        const pick = await vscode.window.showInformationMessage(
            'No UWP projects found in this workspace.',
            'Check Prerequisites',
            'Rescan'
        );
        if (pick === 'Check Prerequisites') {
            await showDoctor();
        } else if (pick === 'Rescan') {
            await refresh();
        }
        return;
    }

    const picked = await vscode.window.showQuickPick(
        projects.map((project) => ({
            label: project.name,
            description: describeFlavour(project.flavour),
            detail: project.projectPath,
            project
        })),
        { placeHolder: 'Select the active UWP project' }
    );
    if (picked) {
        activeProject = picked.project;
        updateStatusBar();
    }
}

function describeFlavour(flavour: UwpFlavour): string {
    switch (flavour) {
        case UwpFlavour.LegacyManaged:
            return 'Classic UWP (C#, CoreCLR in Debug)';
        case UwpFlavour.ModernManaged:
            return 'UWP on modern .NET (Native AOT)';
        case UwpFlavour.NativeCpp:
            return 'C++/WinRT';
        default:
            return '';
    }
}

async function selectConfiguration(): Promise<void> {
    const configuration = await vscode.window.showQuickPick(['Debug', 'Release'], {
        placeHolder: 'Configuration'
    });
    if (!configuration) {
        return;
    }
    // UWP has no AnyCPU; offering it would only produce a confusing build failure.
    const platform = await vscode.window.showQuickPick(['x64', 'x86', 'ARM64'], {
        placeHolder: 'Platform'
    });
    if (!platform) {
        return;
    }

    const config = vscode.workspace.getConfiguration('uwp');
    await config.update('configuration', configuration, vscode.ConfigurationTarget.Workspace);
    await config.update('platform', platform, vscode.ConfigurationTarget.Workspace);
    await refresh();
}

async function runTask(task: UwpTaskDefinition['task']): Promise<void> {
    if (!activeProject) {
        await selectProject();
        if (!activeProject) {
            return;
        }
    }
    const all = await vscode.tasks.fetchTasks({ type: UwpTaskProvider.type });
    const match = all.find((candidate) => (candidate.definition as UwpTaskDefinition).task === task);
    if (match) {
        await vscode.tasks.executeTask(match);
    } else {
        void vscode.window.showErrorMessage(`Could not resolve the UWP ${task} task.`);
    }
}

/**
 * Waits for a build task to finish and reports whether it succeeded. `executeTask` resolves
 * when the task has *started*, not when it has finished, so deploying straight after it
 * deploys the previous build's output — silently, and only sometimes, which is the worst
 * shape a bug can take.
 */
function runTaskToCompletion(task: vscode.Task): Promise<boolean> {
    return new Promise((resolve) => {
        const started = vscode.tasks.onDidStartTaskProcess((event) => {
            if (event.execution.task !== task) {
                return;
            }
            const ended = vscode.tasks.onDidEndTaskProcess((end) => {
                if (end.execution.task !== task) {
                    return;
                }
                ended.dispose();
                started.dispose();
                resolve(end.exitCode === 0);
            });
        });
        void vscode.tasks.executeTask(task);
    });
}

/**
 * Finds a discovered project by path.
 *
 * Paths are normalised before comparison because a `launch.json` written by hand — or by our
 * own snippet — uses forward slashes after `${workspaceFolder}` substitution, while discovery
 * stores Windows separators. Comparing the raw strings fails, and the resulting "no UWP
 * project found" points at discovery rather than at the separator that actually caused it.
 */
function findProject(requested: string): UwpProject | undefined {
    const wanted = path.resolve(requested).toLowerCase();
    return projects.find((project) => path.resolve(project.projectPath).toLowerCase() === wanted);
}

/** Runs the build task for a project and reports whether it succeeded. */
async function buildProject(project: UwpProject): Promise<boolean> {
    const tasks = await vscode.tasks.fetchTasks({ type: UwpTaskProvider.type });
    const build = tasks.find((task) => (task.definition as UwpTaskDefinition).task === 'build');
    if (!build) {
        return false;
    }
    void project;
    return runTaskToCompletion(build);
}

async function runDeploy(alsoLaunch: boolean): Promise<void> {
    if (!activeProject) {
        await selectProject();
        if (!activeProject) {
            return;
        }
    }
    const project = activeProject;

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `UWP: ${project.name}`, cancellable: false },
        async (progress) => {
            try {
                progress.report({ message: 'building' });
                const tasks = await vscode.tasks.fetchTasks({ type: UwpTaskProvider.type });
                const build = tasks.find((t) => (t.definition as UwpTaskDefinition).task === 'build');
                if (!build) {
                    throw new DeployError('Could not resolve the UWP build task.');
                }
                if (!(await runTaskToCompletion(build))) {
                    throw new DeployError('Build failed. See the terminal for details.');
                }

                progress.report({ message: 'deploying' });
                const report = (message: string): void => {
                    log(message);
                    progress.report({ message });
                };
                lastDeploy = await deploy(project, report);
                log(`registered ${lastDeploy.packageFullName}`);

                if (alsoLaunch) {
                    progress.report({ message: 'launching' });
                    await launch(lastDeploy.aumid);
                    log(`launched ${lastDeploy.aumid}`);
                }
            } catch (error) {
                const deployError = error instanceof DeployError ? error : undefined;
                const message = error instanceof Error ? error.message : String(error);
                log(`FAILED: ${message}`);
                if (deployError?.remedy) {
                    log(`  fix: ${deployError.remedy}`);
                }
                const pick = await vscode.window.showErrorMessage(message, 'Show Output');
                if (pick === 'Show Output') {
                    output.show(true);
                }
            }
        }
    );
}

/**
 * Starts a debug session without needing a launch.json.
 *
 * Discoverable from the command palette, which matters because the whole flow is otherwise
 * gated on a file the user may not have — and in an Extension Development Host, on a workspace
 * folder VS Code may have chosen for itself.
 */
async function startDebugging(options?: {
    engine?: 'auto' | 'cppvsdbg' | 'coreclr' | 'none';
    noBuild?: boolean;
    holdForAttach?: boolean;
}): Promise<void> {
    if (!activeProject) {
        await selectProject();
        if (!activeProject) {
            return;
        }
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    try {
        // Prepare first, then start the engine's own configuration. Going through a `uwp`
        // session and rewriting its type mid-resolve works in principle but fails opaquely
        // when the target engine's provider rejects the result.
        const resolved = await debugProvider.prepareSession({
            type: 'uwp',
            request: 'launch',
            name: `UWP: ${activeProject.name}`,
            project: activeProject.projectPath,
            configuration: activeProject.configuration,
            platform: activeProject.platform,
            // Overridable so a caller can force an engine; used by the integration suite to
            // measure each one separately rather than only whatever 'auto' picks.
            engine: options?.engine ?? 'auto',
            noBuild: options?.noBuild ?? false,
            holdForAttach: options?.holdForAttach ?? true
        });

        const started = await vscode.debug.startDebugging(folder, resolved);
        if (!started) {
            log(
                `debug: VS Code refused to start the ${resolved.type} session. `
                + `Is the extension providing '${resolved.type}' installed and enabled?`
            );
            output.show(true);
            void vscode.window.showErrorMessage(
                `VS Code refused to start the ${resolved.type} debug session. See the UWP Tools output.`
            );
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`debug: ${message}`);
        output.show(true);
        void vscode.window.showErrorMessage(`UWP debug: ${message}`);
    }
}

async function runTerminate(): Promise<void> {
    if (!lastDeploy) {
        void vscode.window.showInformationMessage('Nothing deployed from this window yet.');
        return;
    }
    await terminate(lastDeploy.packageFullName);
    log(`terminated ${lastDeploy.packageFullName}`);
}

function showProjectInfo(): void {
    if (!activeProject) {
        void vscode.window.showInformationMessage('No active UWP project.');
        return;
    }
    output.clear();
    log(`Project        : ${activeProject.name}`);
    log(`Path           : ${activeProject.projectPath}`);
    log(`Flavour        : ${activeProject.flavour}`);
    log(`Configuration  : ${activeProject.configuration}|${activeProject.platform}`);
    log(`Platform ver   : ${activeProject.targetPlatformMinVersion} - ${activeProject.targetPlatformVersion}`);
    log(`Output         : ${activeProject.outputPath ?? '(unknown)'}`);
    log(`Manifest       : ${activeProject.appxManifestPath ?? '(none)'}`);
    log(`Managed debug  : ${activeProject.supportsManagedDebugging ? 'yes' : 'no'}`);
    log(`                 ${activeProject.debuggingNote}`);
    output.show(true);
}

async function showDoctor(): Promise<void> {
    output.clear();
    output.show(true);
    log('UWP prerequisites');
    log('='.repeat(60));

    const checks = await runDoctor();
    for (const check of checks) {
        log(`${icon(check)} ${check.name}: ${check.detail}`);
        if (check.remedy) {
            log(`    fix: ${check.remedy}`);
        }
        if (check.command) {
            log(`    run: ${check.command}`);
        }
    }

    log('='.repeat(60));
    log(summarise(checks));

    const blocking = checks.filter((check) => check.status === 'missing');
    if (blocking.length > 0) {
        const copyable = blocking.find((check) => check.command);
        const actions = copyable ? ['Copy Fix Command'] : [];
        const pick = await vscode.window.showWarningMessage(
            `UWP prerequisites: ${summarise(checks)}.`,
            ...actions
        );
        if (pick === 'Copy Fix Command' && copyable?.command) {
            await vscode.env.clipboard.writeText(copyable.command);
            void vscode.window.showInformationMessage('Command copied. Run it in an elevated terminal.');
        }
    }
}

function icon(check: Check): string {
    switch (check.status) {
        case 'ok':
            return '[ ok ]';
        case 'warning':
            return '[warn]';
        default:
            return '[MISS]';
    }
}
