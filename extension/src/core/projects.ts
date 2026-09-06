import * as fs from 'fs';
import * as path from 'path';

import { evaluate } from './msbuild';

/**
 * Which kind of UWP project this is. Everything downstream — how to build it, whether it can
 * be debugged at all, and which debug engine to use — branches on this, so it is resolved
 * once and carried around rather than re-derived.
 */
export enum UwpFlavour {
    /** Non-SDK csproj, TargetPlatformIdentifier=UAP. CoreCLR in Debug, .NET Native in Release. */
    LegacyManaged = 'legacy-managed',
    /** SDK-style csproj with UseUwp=true. Native AOT only, so no managed debugging. */
    ModernManaged = 'modern-managed',
    /** .vcxproj with AppContainerApplication=true. */
    NativeCpp = 'native-cpp',
    /** A project we can evaluate but that is not UWP. */
    NotUwp = 'not-uwp'
}

export interface UwpProject {
    projectPath: string;
    name: string;
    flavour: UwpFlavour;
    /** Configuration|Platform this information was evaluated under. */
    configuration: string;
    platform: string;
    targetPlatformVersion?: string;
    targetPlatformMinVersion?: string;
    outputPath?: string;
    appxManifestPath?: string;
    /** True when a Debug build runs on CoreCLR, i.e. a managed debugger can attach. */
    supportsManagedDebugging: boolean;
    /** Why debugging is or is not available, in a sentence fit to show a user. */
    debuggingNote: string;
    /** MSBuild DebugType, which decides the PDB format. See `symbolProblem`. */
    debugType?: string;
    /**
     * Set when the symbol format will stop breakpoints binding, with the explanation and fix.
     *
     * This is the single most valuable thing this extension can tell a UWP developer. The
     * classic UWP template sets `DebugType=full` for Debug, which emits a *Windows* PDB, and
     * the cross-platform .NET debugger (vsdbg, in both the C# extension and ReSharper) cannot
     * read those. The result is a debugger that attaches perfectly, loads every module, and
     * then binds nothing — with the only clue a single line in the debug console. Every
     * existing UWP project has this default, so every one of them will hit it.
     */
    symbolProblem?: string;
}

const PROPERTIES = [
    'MSBuildProjectName',
    'TargetPlatformIdentifier',
    'TargetPlatformVersion',
    'TargetPlatformMinVersion',
    'UseUwp',
    'OutputType',
    'AppContainerApplication',
    'UseDotNetNativeToolchain',
    'TargetFramework',
    'OutputPath',
    'TargetDir',
    'UsingMicrosoftNETSdk',
    'DebugType'
];

/** Finds project files under a root, skipping the directories that only ever hold output. */
export function findProjectFiles(root: string, maxDepth = 6): string[] {
    const skip = new Set(['bin', 'obj', 'node_modules', '.git', '.vs', 'AppPackages', 'packages']);
    const found: string[] = [];

    const walk = (dir: string, depth: number): void => {
        if (depth > maxDepth) {
            return;
        }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!skip.has(entry.name)) {
                    walk(full, depth + 1);
                }
            } else if (/\.(csproj|vcxproj)$/i.test(entry.name)) {
                found.push(full);
            }
        }
    };

    walk(root, 0);
    return found.sort();
}

/**
 * Cheap pre-filter so we only pay for MSBuild evaluation on plausible candidates. Text
 * matching is unreliable in general — which is the whole reason `evaluate` exists — but it is
 * fine for deciding whether a file is worth a subprocess, since a false positive costs one
 * evaluation and a false negative is impossible for any real UWP project.
 */
export function looksLikeUwp(projectPath: string): boolean {
    let text: string;
    try {
        text = fs.readFileSync(projectPath, 'utf8');
    } catch {
        return false;
    }
    return (
        /<TargetPlatformIdentifier>\s*UAP\s*</i.test(text) ||
        /<UseUwp>\s*true\s*</i.test(text) ||
        /<AppContainerApplication>\s*true\s*</i.test(text) ||
        /uap10\.0/i.test(text) ||
        fs.existsSync(path.join(path.dirname(projectPath), 'Package.appxmanifest'))
    );
}

export async function inspectProject(
    msbuildPath: string,
    projectPath: string,
    configuration: string,
    platform: string
): Promise<UwpProject | undefined> {
    const result = await evaluate({
        msbuildPath,
        projectPath,
        properties: PROPERTIES,
        items: ['AppxManifest'],
        globals: { Configuration: configuration, Platform: platform }
    });

    if (result.error) {
        return undefined;
    }

    const p = result.properties;
    const flavour = classify(projectPath, p);
    const manifestItem = result.items['AppxManifest']?.[0];
    const manifestFallback = path.join(path.dirname(projectPath), 'Package.appxmanifest');

    const { supportsManagedDebugging, debuggingNote } = describeDebugging(flavour, configuration);

    return {
        projectPath,
        name: p['MSBuildProjectName'] || path.basename(projectPath, path.extname(projectPath)),
        flavour,
        configuration,
        platform,
        targetPlatformVersion: p['TargetPlatformVersion'] || undefined,
        targetPlatformMinVersion: p['TargetPlatformMinVersion'] || undefined,
        outputPath: p['TargetDir'] || p['OutputPath'] || undefined,
        appxManifestPath:
            manifestItem?.FullPath ??
            (fs.existsSync(manifestFallback) ? manifestFallback : undefined),
        supportsManagedDebugging,
        debuggingNote,
        debugType: p['DebugType'] || undefined,
        symbolProblem: describeSymbolProblem(flavour, configuration, p['DebugType'])
    };
}

/**
 * Whether the project's symbol format will prevent managed breakpoints from binding.
 *
 * Only `portable` and `embedded` produce a PDB vsdbg can read. `full` and `pdbonly` are the
 * Windows PDB format, which it rejects — silently, apart from one console line.
 */
export function describeSymbolProblem(
    flavour: UwpFlavour,
    configuration: string,
    debugType: string | undefined
): string | undefined {
    if (flavour !== UwpFlavour.LegacyManaged || configuration.toLowerCase() !== 'debug') {
        return undefined;
    }
    const kind = (debugType ?? '').toLowerCase();
    if (kind === 'portable' || kind === 'embedded') {
        return undefined;
    }
    return (
        `DebugType is '${debugType || '(unset)'}', which produces a Windows PDB. The .NET debugger `
        + 'only reads portable PDBs, so it will attach successfully and then bind no breakpoints. '
        + 'Set <DebugType>portable</DebugType> in the Debug configuration.'
    );
}

function classify(projectPath: string, p: Record<string, string>): UwpFlavour {
    const isVcxproj = /\.vcxproj$/i.test(projectPath);
    const isUap = (p['TargetPlatformIdentifier'] ?? '').toLowerCase() === 'uap';
    const useUwp = (p['UseUwp'] ?? '').toLowerCase() === 'true';
    const appContainer = (p['AppContainerApplication'] ?? '').toLowerCase() === 'true';
    const sdkStyle = (p['UsingMicrosoftNETSdk'] ?? '').toLowerCase() === 'true';

    if (isVcxproj) {
        return appContainer ? UwpFlavour.NativeCpp : UwpFlavour.NotUwp;
    }
    if (useUwp || (sdkStyle && isUap)) {
        return UwpFlavour.ModernManaged;
    }
    if (isUap) {
        return UwpFlavour.LegacyManaged;
    }
    return UwpFlavour.NotUwp;
}

function describeDebugging(
    flavour: UwpFlavour,
    configuration: string
): { supportsManagedDebugging: boolean; debuggingNote: string } {
    const isDebug = configuration.toLowerCase() === 'debug';

    switch (flavour) {
        case UwpFlavour.LegacyManaged:
            return isDebug
                ? {
                    supportsManagedDebugging: true,
                    debuggingNote:
                        'Debug builds run on CoreCLR, so a managed debugger can attach. Verified: the process loads CoreCLR.dll from Microsoft.NET.CoreRuntime.'
                }
                : {
                    supportsManagedDebugging: false,
                    debuggingNote:
                        'Release builds use the .NET Native toolchain (mrt100). There is no CoreCLR in the process, it raises no runtime-startup event, and ICorDebug cannot debug it at all. Switch to Debug.'
                };
        case UwpFlavour.ModernManaged:
            return {
                supportsManagedDebugging: false,
                debuggingNote:
                    'UWP on modern .NET is Native AOT only, so there is no managed debugging and no C# Hot Reload. Use native debugging; XAML hot reload still applies.'
            };
        case UwpFlavour.NativeCpp:
            return {
                supportsManagedDebugging: false,
                debuggingNote: 'C++/WinRT: native debugging only.'
            };
        default:
            return { supportsManagedDebugging: false, debuggingNote: 'Not a UWP project.' };
    }
}

export async function discoverProjects(
    msbuildPath: string,
    roots: string[],
    configuration: string,
    platform: string
): Promise<UwpProject[]> {
    const candidates = roots
        .flatMap((root) => findProjectFiles(root))
        .filter((file) => looksLikeUwp(file));

    const inspected = await Promise.all(
        candidates.map((file) => inspectProject(msbuildPath, file, configuration, platform))
    );

    return inspected.filter(
        (project): project is UwpProject => project !== undefined && project.flavour !== UwpFlavour.NotUwp
    );
}
