import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { run } from './exec';
import { powershell } from './powershell';

export interface LaunchOutcome {
    ok: boolean;
    pid: number;
    tid: number;
    /** True when the app was held suspended at its first instruction and resumed by the stub. */
    fromBirth: boolean;
    aumid: string;
    error?: string;
}

/**
 * The environment XAML hot reload needs.
 *
 * `ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO` must be set when the process starts — there is no way
 * to turn it on later — and `EnableDebugging` is the only channel that can put a variable
 * into an AppContainer at all. Verified reaching the app from inside it.
 */
export const HOT_RELOAD_ENVIRONMENT = ['ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO=1'];

export class LaunchError extends Error {
    constructor(message: string, readonly remedy?: string) {
        super(message);
        this.name = 'LaunchError';
    }
}

/**
 * Locates uwplaunch.exe.
 *
 * Packaged alongside the extension once there is a build pipeline; until then the repo build
 * output is used, so the helper can be iterated on without a packaging step.
 */
export function findUwpLaunch(extensionRoot: string, override?: string): string | undefined {
    if (override && fs.existsSync(override)) {
        return override;
    }
    const candidates = [
        path.join(extensionRoot, 'bin', 'uwplaunch.exe'),
        path.join(extensionRoot, '..', 'src', 'UwpLaunch', 'bin', 'Release', 'net10.0-windows', 'uwplaunch.exe'),
        path.join(extensionRoot, '..', 'src', 'UwpLaunch', 'bin', 'Debug', 'net10.0-windows', 'uwplaunch.exe')
    ];
    return candidates.find((candidate) => fs.existsSync(candidate));
}

interface LaunchOptions {
    uwpLaunchPath: string;
    packageFullName: string;
    aumid: string;
    /** KEY=VALUE pairs. Any non-empty value forces the resume stub; see below. */
    environment?: string[];
    /**
     * Hold the app suspended at its first instruction until the stub is told to resume, so a
     * debugger can attach before any managed code runs. Without it, a breakpoint in
     * App.OnLaunched is missed rather than hit.
     */
    waitForAttach?: boolean;
}

/**
 * Starts a packaged app under debug mode.
 *
 * Note that requesting any environment variable implies the resume stub whether or not
 * `waitForAttach` is set: `EnableDebugging` rejects an environment block unless a debugger
 * command line accompanies it (E_INVALIDARG — undocumented, established by testing). So
 * "launch with hot reload enabled but no debugger" still goes through the stub.
 */
export async function launchApp(options: LaunchOptions): Promise<LaunchOutcome> {
    const args = [
        'launch',
        '--package', options.packageFullName,
        '--aumid', options.aumid
    ];
    for (const entry of options.environment ?? []) {
        args.push('--env', entry);
    }
    if (options.waitForAttach === false) {
        args.push('--no-wait');
    }

    const result = await run(options.uwpLaunchPath, args, { timeoutMs: 120_000 });
    const line = result.stdout.trim().split(/\r?\n/).pop() ?? '';

    let outcome: LaunchOutcome;
    try {
        outcome = JSON.parse(line) as LaunchOutcome;
    } catch {
        throw new LaunchError(
            `uwplaunch produced no usable output (exit ${result.exitCode}): ${result.stderr.trim() || line}`
        );
    }

    if (!outcome.ok) {
        throw new LaunchError(outcome.error ?? 'Launch failed.');
    }
    return outcome;
}

export interface SuspendedApp {
    pid: number;
    tid: number;
    aumid: string;
    /** Lets the app run. Must be called, or the app stays suspended at its first instruction. */
    resume(): void;
    /** Resolves once the launcher process has exited. */
    done: Promise<void>;
}

/**
 * Starts the app and holds it suspended at its first instruction, returning as soon as the
 * pid is known.
 *
 * This is the shape F5 needs. The gap between this resolving and `resume()` being called is
 * the only window in which a debugger can attach and still see the runtime start — attach
 * after it and a breakpoint in `App.OnLaunched` is simply missed, with nothing about the app
 * looking wrong.
 *
 * The caller owns the resume. If it never calls it the app hangs suspended, so treat this
 * like any other resource that must be released.
 */
export function launchSuspended(options: LaunchOptions): Promise<SuspendedApp> {
    const args = [
        'launch',
        '--package', options.packageFullName,
        '--aumid', options.aumid,
        '--hold'
    ];
    for (const entry of options.environment ?? []) {
        args.push('--env', entry);
    }

    return new Promise<SuspendedApp>((resolve, reject) => {
        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawn(options.uwpLaunchPath, args, { windowsHide: true });
        } catch (error) {
            reject(new LaunchError(`Could not start uwplaunch: ${String(error)}`));
            return;
        }

        let buffer = '';
        let settled = false;
        let stderr = '';

        const done = new Promise<void>((finish) => {
            child.on('close', () => {
                if (!settled) {
                    settled = true;
                    reject(new LaunchError(
                        `uwplaunch exited before reporting a suspended process. ${stderr.trim()}`
                    ));
                }
                finish();
            });
        });

        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        child.stdout.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            // The launcher prints one JSON object per line; the first carries the pid while
            // the app is still held.
            let newline = buffer.indexOf('\n');
            while (newline >= 0 && !settled) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                newline = buffer.indexOf('\n');
                if (!line) {
                    continue;
                }
                try {
                    const message = JSON.parse(line) as LaunchOutcome & { suspended?: boolean };
                    if (!message.ok) {
                        settled = true;
                        reject(new LaunchError(message.error ?? 'Launch failed.'));
                        return;
                    }
                    if (message.suspended) {
                        settled = true;
                        resolve({
                            pid: message.pid,
                            tid: message.tid,
                            aumid: message.aumid,
                            resume: () => child.stdin.write('resume\n'),
                            done
                        });
                        return;
                    }
                } catch {
                    // Not our JSON line; ignore rather than fail the launch over noise.
                }
            }
        });
    });
}

async function simple(uwpLaunchPath: string, command: string, packageFullName: string): Promise<void> {
    const result = await run(uwpLaunchPath, [command, '--package', packageFullName], { timeoutMs: 60_000 });
    if (result.exitCode !== 0) {
        throw new LaunchError(`uwplaunch ${command} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
}

/**
 * Takes the package back out of debug mode.
 *
 * Every EnableDebugging must be paired with this. A package left in debug mode stays that way
 * after the window that set it has closed — the system will not suspend it, and the user has
 * no obvious way to discover why.
 */
export const disableDebugging = (uwpLaunchPath: string, packageFullName: string): Promise<void> =>
    simple(uwpLaunchPath, 'disable-debug', packageFullName);

export const terminateApp = (uwpLaunchPath: string, packageFullName: string): Promise<void> =>
    simple(uwpLaunchPath, 'terminate', packageFullName);

/**
 * Kills one process by id.
 *
 * Session cleanup must not use the package-wide terminate. `TerminateAllProcesses` kills every
 * instance of the package, and a debug session's teardown is asynchronous — so a session
 * ending just as the next launch begins will kill the *new* app, which then surfaces as the
 * debugger reporting "No process with the specified id is currently running" about a process
 * that was alive moments earlier. Scoping the kill to the pid the session owned removes the
 * race entirely.
 */
export async function killProcess(pid: number, expectedName: string): Promise<void> {
    // Identity is checked before killing, and the process tree is deliberately NOT killed.
    //
    // A pid is only unique while its process lives. By the time a debug session tears down,
    // the app has often already exited and Windows may have recycled the number for something
    // else — so an unconditional `taskkill /PID n /T /F` can kill an unrelated process, and
    // `/T` takes its children with it. That is not hypothetical: it is a plausible cause of
    // the extension host dying mid-run with a clean exit code and no error anywhere.
    const script =
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
        `if ($p -and $p.ProcessName -eq '${expectedName.replace(/'/g, "''")}') ` +
        `{ Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue }`;
    await powershell(script, 30_000);
}

/** PLM state control, which is otherwise genuinely awkward to trigger by hand. */
export const suspendApp = (uwpLaunchPath: string, packageFullName: string): Promise<void> =>
    simple(uwpLaunchPath, 'suspend', packageFullName);

export const resumeApp = (uwpLaunchPath: string, packageFullName: string): Promise<void> =>
    simple(uwpLaunchPath, 'resume', packageFullName);
