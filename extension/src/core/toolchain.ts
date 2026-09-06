import * as fs from 'fs';
import * as path from 'path';

import { run } from './exec';

/** The component group that means "this install can build UWP". */
export const UWP_COMPONENT = 'Microsoft.VisualStudio.ComponentGroup.UWP.Support';
/** The C++/WinRT half, needed for .vcxproj UWP projects only. */
export const UWP_VC_COMPONENT = 'Microsoft.VisualStudio.ComponentGroup.UWP.VC';

export interface VsInstall {
    installationPath: string;
    installationVersion: string;
    displayName: string;
    msbuildPath: string;
    hasUwp: boolean;
    hasUwpVc: boolean;
}

function vswherePath(): string {
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    return path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
}

interface VsWhereRecord {
    installationPath: string;
    installationVersion: string;
    displayName?: string;
}

async function query(args: string[]): Promise<VsWhereRecord[]> {
    const exe = vswherePath();
    if (!fs.existsSync(exe)) {
        return [];
    }
    const result = await run(exe, args);
    if (result.exitCode !== 0 || !result.stdout.trim()) {
        return [];
    }
    try {
        return JSON.parse(result.stdout) as VsWhereRecord[];
    } catch {
        return [];
    }
}

/**
 * Every Visual Studio install, annotated with whether it can actually build UWP.
 *
 * Asking vswhere for "-latest" alone is the wrong question: a machine can carry a newer VS
 * without the UWP workload alongside an older one that has it, and picking by version then
 * starts a build that fails deep inside the XAML targets with nothing pointing at the cause.
 */
export async function findVsInstalls(): Promise<VsInstall[]> {
    const all = await query(['-all', '-prerelease', '-products', '*', '-format', 'json']);
    const withUwp = new Set(
        (await query(['-all', '-prerelease', '-products', '*', '-requires', UWP_COMPONENT, '-format', 'json']))
            .map((r) => r.installationPath)
    );
    const withUwpVc = new Set(
        (await query(['-all', '-prerelease', '-products', '*', '-requires', UWP_VC_COMPONENT, '-format', 'json']))
            .map((r) => r.installationPath)
    );

    return all
        .map((record) => ({
            installationPath: record.installationPath,
            installationVersion: record.installationVersion,
            displayName: record.displayName ?? path.basename(record.installationPath),
            msbuildPath: path.join(record.installationPath, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe'),
            hasUwp: withUwp.has(record.installationPath),
            hasUwpVc: withUwpVc.has(record.installationPath)
        }))
        .filter((install) => fs.existsSync(install.msbuildPath));
}

/**
 * The MSBuild to build UWP with: the newest install that has the UWP workload. Returns
 * undefined rather than falling back to a UWP-less MSBuild, because that fallback only
 * converts a clear "workload missing" into an obscure build error.
 */
export async function findMsBuild(
    override?: string,
    requireVc = false
): Promise<VsInstall | undefined> {
    if (override && fs.existsSync(override)) {
        return {
            installationPath: path.dirname(override),
            installationVersion: 'override',
            displayName: 'Configured MSBuild',
            msbuildPath: override,
            hasUwp: true,
            hasUwpVc: true
        };
    }

    const installs = await findVsInstalls();
    const usable = installs
        .filter((install) => install.hasUwp && (!requireVc || install.hasUwpVc))
        .sort((a, b) => compareVersions(b.installationVersion, a.installationVersion));
    return usable[0];
}

function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
    const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
}

export interface WindowsSdk {
    root: string;
    versions: string[];
    makeAppx?: string;
    signTool?: string;
    winAppDeployCmd?: string;
}

export function findWindowsSdk(): WindowsSdk | undefined {
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const root = path.join(programFilesX86, 'Windows Kits', '10');
    const binRoot = path.join(root, 'bin');
    if (!fs.existsSync(binRoot)) {
        return undefined;
    }

    const versions = fs
        .readdirSync(binRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^10\.\d+\.\d+\.\d+$/.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => compareVersions(b, a));

    const tool = (name: string): string | undefined => {
        for (const version of versions) {
            const candidate = path.join(binRoot, version, 'x64', name);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        return undefined;
    };

    return {
        root,
        versions,
        makeAppx: tool('makeappx.exe'),
        signTool: tool('signtool.exe'),
        winAppDeployCmd: tool('WinAppDeployCmd.exe')
    };
}

/**
 * Debugging Tools for Windows, which ships with the standalone Windows SDK installer rather
 * than the VS installer.
 *
 * Probing for the `Debuggers` folder is not good enough and was got wrong once already: the
 * folder exists on a machine that has only `dbghelp.dll` and `dbgcore.dll` from some other
 * component, with no `cdb.exe` or `plmdebug.exe` in it. Look for the executables.
 */
export function findDebuggingTools(): { cdb?: string; plmdebug?: string; windbg?: string } {
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const dir = path.join(programFilesX86, 'Windows Kits', '10', 'Debuggers', 'x64');
    const at = (name: string): string | undefined => {
        const candidate = path.join(dir, name);
        return fs.existsSync(candidate) ? candidate : undefined;
    };
    return { cdb: at('cdb.exe'), plmdebug: at('plmdebug.exe'), windbg: at('windbg.exe') };
}

export function findDotnet(): string | undefined {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const candidate = path.join(programFiles, 'dotnet', 'dotnet.exe');
    return fs.existsSync(candidate) ? candidate : undefined;
}
