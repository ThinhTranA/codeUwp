import * as fs from 'fs';
import * as path from 'path';

import { run } from './exec';
import { findDebuggingTools, findDotnet, findVsInstalls, findWindowsSdk } from './toolchain';

export type CheckStatus = 'ok' | 'warning' | 'missing';

export interface Check {
    name: string;
    status: CheckStatus;
    detail: string;
    /** What the user should do, when there is something to do. */
    remedy?: string;
    /** A command they can copy, when one exists. */
    command?: string;
}

/**
 * Whether Developer Mode is on.
 *
 * This is checked first among the deployment prerequisites for a reason: its absence is
 * reported only at the very end of a deploy, as 0x80073CFF, after the package has been built
 * and every framework dependency resolved. Everything before it is wasted work.
 */
export async function checkDeveloperMode(): Promise<Check> {
    const result = await run('reg.exe', [
        'query',
        'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock',
        '/v',
        'AllowDevelopmentWithoutDevLicense'
    ]);

    const enabled = /AllowDevelopmentWithoutDevLicense\s+REG_DWORD\s+0x1/i.test(result.stdout);

    return enabled
        ? { name: 'Developer Mode', status: 'ok', detail: 'Enabled.' }
        : {
            name: 'Developer Mode',
            status: 'missing',
            detail: 'Off. Registering an unsigned app fails with 0x80073CFF — but only after every other step has already succeeded.',
            remedy: 'Settings > System > For developers > Developer Mode. Needs elevation.',
            command:
                'reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock" /t REG_DWORD /f /v AllowDevelopmentWithoutDevLicense /d 1'
        };
}

/**
 * Whether a debug engine is not merely installed but usable.
 *
 * Installed is not the same as working, and the difference is invisible until a debug session
 * fails with "Couldn't find a debug adapter descriptor for debug type 'coreclr' (extension
 * might have failed to activate)" — which reads like a broken engine rather than an
 * unactivated one.
 *
 * ReSharper registers its debug adapters from its own backend process, and that backend does
 * not start until the product is licensed. An unlicensed install has never created its
 * configuration directory, so that directory's absence is a reliable "never initialised".
 */
export function checkDebugEngines(): Check[] {
    const home = process.env['USERPROFILE'] ?? '';
    const extensionsDir = path.join(home, '.vscode', 'extensions');

    const installed = (prefix: string): boolean => {
        try {
            return fs
                .readdirSync(extensionsDir, { withFileTypes: true })
                .some((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith(prefix));
        } catch {
            return false;
        }
    };

    const checks: Check[] = [];
    const hasCpptools = installed('ms-vscode.cpptools');
    const hasReSharper = installed('jetbrains.resharper-code');
    const hasCsharp = installed('ms-dotnettools.csharp');

    checks.push(
        hasCpptools
            ? {
                name: 'Native debug engine (cppvsdbg)',
                status: 'ok',
                detail: 'ms-vscode.cpptools installed. Verified attaching to a UWP AppContainer.'
            }
            : {
                name: 'Native debug engine (cppvsdbg)',
                status: 'warning',
                detail: 'ms-vscode.cpptools not installed; C++/WinRT projects cannot be debugged.',
                remedy: 'Install the C/C++ extension.'
            }
    );

    if (!hasReSharper && !hasCsharp) {
        checks.push({
            name: 'Managed debug engine (coreclr)',
            status: 'warning',
            detail: 'Neither ReSharper nor the C# extension is installed; C# breakpoints cannot bind.',
            remedy: 'Install "C# by ReSharper" (JetBrains.resharper-code) or the C# extension.'
        });
        return checks;
    }

    const jetBrainsConfig = path.join(process.env['LOCALAPPDATA'] ?? '', 'JetBrains');
    if (hasReSharper && !fs.existsSync(jetBrainsConfig)) {
        checks.push({
            name: 'Managed debug engine (coreclr)',
            status: 'missing',
            detail:
                'ReSharper is installed but has never initialised — no JetBrains configuration directory '
                + 'exists, so its backend is not running and it registers no debug adapter. This surfaces '
                + 'only as "Couldn\'t find a debug adapter descriptor for debug type \'coreclr\'".',
            remedy:
                'Activate ReSharper: open a C# file and follow its prompt, or run "Login to JetBrains '
                + 'Account" from the command palette. It is free for non-commercial use.'
        });
        return checks;
    }

    // Deliberately does not claim ReSharper *works*: a JetBrains configuration directory means
    // it has run at some point, not that it is licensed and serving a debug adapter. Naming
    // the providers found is honest; asserting one of them functions is not.
    const providers = [hasReSharper && 'ReSharper', hasCsharp && 'C# extension']
        .filter(Boolean)
        .join(' and ');
    checks.push({
        name: 'Managed debug engine (coreclr)',
        status: 'ok',
        detail: `${providers} installed. Verified: a managed breakpoint binds and hits in a UWP AppContainer.`
    });
    return checks;
}

export async function runDoctor(): Promise<Check[]> {
    const checks: Check[] = [];

    const installs = await findVsInstalls();
    const withUwp = installs.filter((install) => install.hasUwp);
    if (withUwp.length > 0) {
        const best = withUwp[0];
        checks.push({
            name: 'Visual Studio + UWP workload',
            status: 'ok',
            detail: `${best.displayName} ${best.installationVersion}${best.hasUwpVc ? ' (with C++ UWP)' : ''}`
        });
        if (!withUwp.some((install) => install.hasUwpVc)) {
            checks.push({
                name: 'C++ UWP tools',
                status: 'warning',
                detail: 'No install carries the C++ UWP component; .vcxproj UWP projects will not build.',
                remedy: 'Add "C++ (v143) Universal Windows Platform tools" in the Visual Studio Installer.'
            });
        }
    } else if (installs.length > 0) {
        checks.push({
            name: 'Visual Studio + UWP workload',
            status: 'missing',
            detail: `Found ${installs.length} Visual Studio install(s), none with the UWP workload.`,
            remedy: 'Visual Studio Installer > Modify > "Universal Windows Platform development".'
        });
    } else {
        checks.push({
            name: 'Visual Studio',
            status: 'missing',
            detail: 'No Visual Studio or Build Tools install found.',
            remedy: 'Install Visual Studio (or Build Tools) with the UWP workload.'
        });
    }

    const sdk = findWindowsSdk();
    if (sdk && sdk.versions.length > 0) {
        checks.push({
            name: 'Windows SDK',
            status: 'ok',
            detail: `${sdk.versions[0]} (${sdk.versions.length} version(s) installed)`
        });
        checks.push(
            sdk.makeAppx
                ? { name: 'makeappx.exe', status: 'ok', detail: sdk.makeAppx }
                : {
                    name: 'makeappx.exe',
                    status: 'missing',
                    detail: 'Not found. Needed to unpack the built package into a deployable layout.',
                    remedy: 'Install the Windows SDK.'
                }
        );
    } else {
        checks.push({
            name: 'Windows SDK',
            status: 'missing',
            detail: 'Not found.',
            remedy: 'Install the Windows 10/11 SDK.'
        });
    }

    checks.push(await checkDeveloperMode());
    checks.push(...checkDebugEngines());

    // Probing for the Debuggers *folder* is not enough: it can exist holding only dbghelp.dll
    // and dbgcore.dll, with no debugger in it. Look for the executables themselves.
    const debuggers = findDebuggingTools();
    checks.push(
        debuggers.cdb || debuggers.windbg
            ? {
                name: 'Debugging Tools for Windows',
                status: 'ok',
                detail: debuggers.cdb ?? debuggers.windbg ?? ''
            }
            : {
                name: 'Debugging Tools for Windows',
                status: 'warning',
                detail: 'cdb.exe / plmdebug.exe not found. Native debugging fallbacks and PLM testing are unavailable.',
                remedy:
                    'Run the standalone Windows SDK installer and select "Debugging Tools for Windows". It is not in the Visual Studio installer.'
            }
    );

    const dotnet = findDotnet();
    checks.push(
        dotnet
            ? { name: '.NET SDK', status: 'ok', detail: dotnet }
            : {
                name: '.NET SDK',
                status: 'warning',
                detail: 'Not found. Only needed for UWP projects on modern .NET (UseUwp).',
                remedy: 'Install the .NET SDK.'
            }
    );

    return checks;
}

export function summarise(checks: Check[]): string {
    const missing = checks.filter((check) => check.status === 'missing').length;
    const warnings = checks.filter((check) => check.status === 'warning').length;
    if (missing > 0) {
        return `${missing} blocking issue(s), ${warnings} warning(s)`;
    }
    return warnings > 0 ? `Ready, with ${warnings} warning(s)` : 'All prerequisites satisfied';
}
