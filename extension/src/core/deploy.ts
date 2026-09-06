import * as fs from 'fs';
import * as path from 'path';

import { run } from './exec';
import { powershell, powershellJson, psQuote } from './powershell';
import type { UwpProject } from './projects';
import { findWindowsSdk } from './toolchain';

export interface DeployResult {
    packageFullName: string;
    packageFamilyName: string;
    aumid: string;
    layoutDir: string;
    /** Process name of the app, without extension. Used to confirm a pid before killing it. */
    processName: string;
}

export interface DeployProgress {
    (message: string): void;
}

export class DeployError extends Error {
    constructor(message: string, readonly remedy?: string) {
        super(message);
        this.name = 'DeployError';
    }
}

/**
 * Locates the package the build produced.
 *
 * The build writes to `AppPackages\<name>_<version>_<platform>_<config>_Test\`, so the
 * platform and configuration are matched against the folder name rather than trusting
 * whatever is newest — a machine that has built x86 and x64 has several, and picking by
 * timestamp deploys whichever was built last, not the one asked for.
 */
export function findBuiltPackage(
    project: UwpProject
): { packagePath: string; dependenciesDir: string } | undefined {
    const appPackages = path.join(path.dirname(project.projectPath), 'AppPackages');
    if (!fs.existsSync(appPackages)) {
        return undefined;
    }

    const suffix = `_${project.platform}_${project.configuration}`.toLowerCase();
    const candidates: { packagePath: string; mtime: number }[] = [];

    for (const entry of fs.readdirSync(appPackages, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.toLowerCase().includes(suffix)) {
            continue;
        }
        const dir = path.join(appPackages, entry.name);
        for (const file of fs.readdirSync(dir)) {
            if (/\.(msix|appx)$/i.test(file)) {
                candidates.push({
                    packagePath: path.join(dir, file),
                    mtime: fs.statSync(path.join(dir, file)).mtimeMs
                });
            }
        }
    }

    const best = candidates.sort((a, b) => b.mtime - a.mtime)[0];
    if (!best) {
        return undefined;
    }
    return {
        packagePath: best.packagePath,
        dependenciesDir: path.join(path.dirname(best.packagePath), 'Dependencies', project.platform)
    };
}

/** A framework the app's manifest says it needs. */
interface RequiredDependency {
    name: string;
    minVersion: string;
}

/** Reads the `<PackageDependency>` entries the built manifest declares. */
export function readRequiredDependencies(manifestPath: string): RequiredDependency[] {
    let manifest: string;
    try {
        manifest = fs.readFileSync(manifestPath, 'utf8');
    } catch {
        return [];
    }
    const dependencies: RequiredDependency[] = [];
    const pattern = /<PackageDependency\b[^>]*\sName="([^"]+)"[^>]*\sMinVersion="([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(manifest)) !== null) {
        dependencies.push({ name: match[1], minVersion: match[2] });
    }
    return dependencies;
}

/** Compares two `a.b.c.d` version strings. */
function compareVersions(a: string, b: string): number {
    const left = a.split('.').map((n) => parseInt(n, 10) || 0);
    const right = b.split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 4; i++) {
        const diff = (left[i] ?? 0) - (right[i] ?? 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
}

/**
 * Which of the app's declared dependencies the machine already satisfies.
 *
 * Keyed on the manifest's own `MinVersion` rather than on "we installed this once", so
 * upgrading a NuGet package raises the required version and the new framework is installed.
 */
async function satisfiedDependencies(
    required: RequiredDependency[],
    architecture: string
): Promise<Set<string>> {
    if (required.length === 0) {
        return new Set();
    }
    // Enumerate once and filter here. `Get-AppxPackage -Name` takes a single string, not a
    // list: passing several throws "Cannot convert System.Object[] to System.String", which
    // this code swallows as "no packages installed" and then reinstalls everything — the
    // optimisation silently doing nothing, which is exactly how it was found.
    const names = required.map((d) => `'${d.name.replace(/'/g, "''")}'`).join(',');
    const installed = await powershellJson<{ Name: string; Version: string; Architecture: string }>(
        `Get-AppxPackage | Where-Object { $_.Name -in @(${names}) } | ` +
        `Select-Object Name,Version,@{n='Architecture';e={$_.Architecture.ToString()}}`
    );

    const satisfied = new Set<string>();
    for (const dependency of required) {
        const matches = installed.filter(
            (p) =>
                p.Name === dependency.name &&
                // A framework is usable if it matches the app's architecture or is neutral.
                (p.Architecture?.toLowerCase() === architecture.toLowerCase() ||
                    p.Architecture?.toLowerCase() === 'neutral')
        );
        if (matches.some((p) => compareVersions(p.Version, dependency.minVersion) >= 0)) {
            satisfied.add(dependency.name);
        }
    }
    return satisfied;
}

export async function installDependencies(
    dependenciesDir: string,
    progress: DeployProgress,
    manifestPath?: string,
    architecture = 'x64'
): Promise<void> {
    if (!fs.existsSync(dependenciesDir)) {
        return;
    }
    const packages = fs
        .readdirSync(dependenciesDir)
        .filter((file) => /\.(appx|msix)$/i.test(file))
        .map((file) => path.join(dependenciesDir, file));

    // Installing an already-satisfied framework was the single slowest thing in a deploy:
    // roughly seven seconds of a nine-second total, on every run, reinstalling packages that
    // had not changed. These are Microsoft's runtime libraries — CoreCLR, the BCL, VCLibs,
    // WinUI. The app's own code and XAML travel in the layout, which is re-unpacked from the
    // freshly built .msix and re-registered every time, so skipping these cannot serve stale
    // application code. Only a NuGet upgrade changes them, and that raises the MinVersion the
    // manifest declares, which is what the check below compares against.
    //
    // All-or-nothing, deliberately. Mapping a file to the package inside it cannot be done
    // from its name: Microsoft.VCLibs.x64.Debug.14.00.appx contains a package called
    // Microsoft.VCLibs.140.00.Debug, so filename matching silently pairs the wrong ones.
    // Reading each package's manifest would mean unzipping five files to save five installs.
    // Checking whether the manifest's declared set is *entirely* satisfied needs one query and
    // cannot mismatch; when anything is missing, installing all of them is the rare path.
    if (manifestPath) {
        const required = readRequiredDependencies(manifestPath);
        if (required.length > 0) {
            const satisfied = await satisfiedDependencies(required, architecture);
            const missing = required.filter((d) => !satisfied.has(d.name));
            if (missing.length === 0) {
                progress(`all ${required.length} framework dependencies already satisfied; skipping`);
                return;
            }
            progress(
                `installing framework dependencies; missing: `
                + missing.map((d) => `${d.name} >= ${d.minVersion}`).join(', ')
            );
        }
    }

    // Everything, up front. Registration reports only ONE missing dependency per attempt:
    // resolve it and the next attempt names the next one, so reacting to errors costs a round
    // trip each and each round trip is a failed deploy in the user's face.
    for (const dependency of packages) {
        const result = await powershell(
            `try { Add-AppxPackage -Path ${psQuote(dependency)} -ErrorAction Stop; 'installed' } ` +
            `catch { if ($_.Exception.Message -match '0x80073D06') { 'newer' } else { throw } }`
        );
        // 0x80073D06 is "a higher version is already installed" -- satisfied, not failed.
        // Treating it as an error breaks the deploy on every up-to-date machine.
        const state = result.stdout.trim().split(/\r?\n/).pop() ?? '';
        if (result.exitCode !== 0 && state !== 'newer') {
            throw new DeployError(
                `Failed to install dependency ${path.basename(dependency)}: ${result.stderr.trim() || result.stdout.trim()}`
            );
        }
        progress(`  ${state === 'newer' ? 'already newer' : 'installed'}: ${path.basename(dependency)}`);
    }
}

/**
 * Unpacks the built package into a loose layout.
 *
 * This step is not an optimisation, it is the only reliable way to get a registrable layout
 * from the command line. `msbuild -t:Build` leaves an `AppxManifest.xml` in the output folder
 * that looks registrable and is accepted without complaint, but the app then dies during CLR
 * startup with 0xe0434352 and no managed stack, because the real package has a different
 * shape: an `entrypoint\` folder holding the executable, a `WinMetadata\` folder, and
 * `ucrtbased.dll` in Debug. The `_CreatePackageLayout` target that would emit the proper
 * `AppX` folder is gated on conditions only the VS project system satisfies, and invoking it
 * from the CLI succeeds while silently producing nothing.
 */
export async function unpackLayout(
    packagePath: string,
    layoutDir: string,
    progress: DeployProgress
): Promise<void> {
    const sdk = findWindowsSdk();
    if (!sdk?.makeAppx) {
        throw new DeployError(
            'makeappx.exe was not found.',
            'Install the Windows 10/11 SDK.'
        );
    }

    if (fs.existsSync(layoutDir)) {
        fs.rmSync(layoutDir, { recursive: true, force: true });
    }
    fs.mkdirSync(layoutDir, { recursive: true });

    progress(`unpacking to ${layoutDir}`);
    const result = await run(sdk.makeAppx, ['unpack', '/p', packagePath, '/d', layoutDir, '/o']);
    if (result.exitCode !== 0) {
        throw new DeployError(`makeappx unpack failed: ${result.stdout.trim() || result.stderr.trim()}`);
    }
}

interface RegisteredPackage {
    PackageFullName: string;
    PackageFamilyName: string;
    InstallLocation: string;
}

export async function getRegistered(identityName: string): Promise<RegisteredPackage | undefined> {
    const rows = await powershellJson<RegisteredPackage>(
        `Get-AppxPackage -Name ${psQuote(identityName)} | Select-Object PackageFullName,PackageFamilyName,InstallLocation`
    );
    return rows[0];
}

/**
 * Registers the layout, unregistering first when something else already owns the identity.
 *
 * `Add-AppxPackage -Register` silently does nothing when a package of the same identity and
 * version is already registered from a *different* layout, and reports success. That is the
 * "I deployed Debug but Release keeps running, and nothing said so" trap, so the previous
 * registration is removed rather than trusted.
 */
export async function register(
    layoutDir: string,
    progress: DeployProgress
): Promise<DeployResult> {
    const manifestPath = path.join(layoutDir, 'AppxManifest.xml');
    if (!fs.existsSync(manifestPath)) {
        throw new DeployError(`No AppxManifest.xml in ${layoutDir}.`);
    }

    const manifest = fs.readFileSync(manifestPath, 'utf8');
    const identityName = /<Identity[^>]*\sName="([^"]+)"/.exec(manifest)?.[1];
    const appId = /<Application[^>]*\sId="([^"]+)"/.exec(manifest)?.[1] ?? 'App';
    if (!identityName) {
        throw new DeployError('Could not read the package identity from the manifest.');
    }

    const existing = await getRegistered(identityName);
    if (existing && path.resolve(existing.InstallLocation) !== path.resolve(layoutDir)) {
        progress(`unregistering stale registration at ${existing.InstallLocation}`);
        await powershell(
            `Get-AppxPackage -Name ${psQuote(identityName)} | Remove-AppxPackage -ErrorAction Stop`
        );
    }

    progress('registering');
    const result = await powershell(
        `Add-AppxPackage -Register ${psQuote(manifestPath)} -ErrorAction Stop`
    );
    if (result.exitCode !== 0) {
        throw new DeployError(explainRegistrationFailure(result.stderr || result.stdout));
    }

    const registered = await getRegistered(identityName);
    if (!registered) {
        throw new DeployError('Registration reported success but the package is not registered.');
    }

    // The manifest's Executable is the app's actual process name; deriving it from the package
    // identity would be a guess, and this value is used to confirm a pid before killing it.
    const executable = /<Application[^>]*\sExecutable="([^"]+)"/.exec(manifest)?.[1] ?? '';

    return {
        packageFullName: registered.PackageFullName,
        packageFamilyName: registered.PackageFamilyName,
        aumid: `${registered.PackageFamilyName}!${appId}`,
        layoutDir,
        processName: path.basename(executable, '.exe')
    };
}

/**
 * Turns the HRESULTs this step actually produces into something worth reading. Each of these
 * cost real time to diagnose the first time; none of them says what to do on its own.
 */
function explainRegistrationFailure(message: string): string {
    if (/0x80073CFF/i.test(message)) {
        return 'Developer Mode is off (0x80073CFF). Settings > System > For developers > Developer Mode. Note this only surfaces after the package and all its dependencies have already been resolved.';
    }
    if (/0x80073CF3/i.test(message)) {
        const framework = /framework "([^"]+)"/.exec(message)?.[1];
        return `A framework dependency is missing${framework ? `: ${framework}` : ''} (0x80073CF3). It should be under AppPackages\\...\\Dependencies\\<platform>\\ — check the build produced it.`;
    }
    if (/0x80073D02/i.test(message)) {
        return 'The package is in use (0x80073D02). Close the running app and deploy again.';
    }
    return message.trim() || 'Registration failed.';
}

/** The package identity declared in the project's source manifest, before anything is built. */
export function readIdentityName(project: UwpProject): string | undefined {
    if (!project.appxManifestPath || !fs.existsSync(project.appxManifestPath)) {
        return undefined;
    }
    const manifest = fs.readFileSync(project.appxManifestPath, 'utf8');
    return /<Identity[^>]*\sName="([^"]+)"/.exec(manifest)?.[1];
}

/**
 * Stops any running instance of a package, by identity.
 *
 * Processes are matched on their install location rather than their name: a name match can
 * catch an unrelated process, and the install location is what actually proves a process
 * belongs to this package.
 */
/**
 * Stops any running instance of a package.
 *
 * Goes through `uwplaunch terminate`, which calls `IPackageDebugSettings::TerminateAllProcesses`
 * — the API built for this, addressing the package rather than its processes.
 *
 * Matching processes by executable path does not work and cannot be made to. A process
 * suspended at its first instruction, which is exactly what a debug launch leaves behind,
 * reports an empty path: measured, `Get-Process` gives a null `Path` and `Win32_Process` gives
 * a blank `ExecutablePath`, while the process is plainly there under its own name. A
 * path-based sweep therefore skips precisely the instance most in need of stopping, and the
 * next deploy fails installing framework dependencies with 0x80073D02 ("resources it modifies
 * are currently in use") naming the app rather than the cause.
 *
 * The name-based fallback exists only for callers with no launcher to hand.
 */
export async function stopRunning(identityName: string, uwpLaunchPath?: string): Promise<void> {
    if (uwpLaunchPath) {
        const packageFullName = (await getRegistered(identityName))?.PackageFullName;
        if (packageFullName) {
            const result = await run(uwpLaunchPath, ['terminate', '--package', packageFullName], {
                timeoutMs: 60_000
            });
            if (result.exitCode === 0) {
                return;
            }
        }
    }

    const manifestExecutable = identityName.replace(/[^A-Za-z0-9.]/g, '');
    await powershell(
        `Get-Process -ErrorAction SilentlyContinue | ` +
        `Where-Object { $_.ProcessName -like ${psQuote(`${manifestExecutable}*`)} } | ` +
        `Stop-Process -Force -ErrorAction SilentlyContinue`,
        60_000
    );
}

export async function deploy(
    project: UwpProject,
    progress: DeployProgress,
    uwpLaunchPath?: string
): Promise<DeployResult> {
    const built = findBuiltPackage(project);
    if (!built) {
        throw new DeployError(
            `No built package found for ${project.configuration}|${project.platform}.`,
            'Build the project first.'
        );
    }
    progress(`package: ${path.basename(built.packagePath)}`);

    // Before anything else, and specifically before installing dependencies. A running
    // instance holds its framework packages open, so installing them fails with 0x80073D02
    // ("resources it modifies are currently in use") naming the app rather than the
    // framework -- an error that reads like a problem with the app being deployed.
    const identityName = readIdentityName(project);
    if (identityName) {
        progress('stopping any running instance');
        await stopRunning(identityName, uwpLaunchPath);
    }

    // The built manifest declares exactly which frameworks the app needs and at what minimum
    // version, so it is the right thing to check against.
    await installDependencies(
        built.dependenciesDir,
        progress,
        path.join(path.dirname(project.projectPath), 'bin', project.platform, project.configuration, 'AppxManifest.xml'),
        project.platform
    );

    const layoutDir = path.join(
        path.dirname(project.projectPath),
        'bin',
        project.platform,
        project.configuration,
        'Layout'
    );
    await unpackLayout(built.packagePath, layoutDir, progress);

    return register(layoutDir, progress);
}

/** Starts the app via the shell. Debug-mode activation comes with the launcher in phase 3. */
export async function launch(aumid: string): Promise<void> {
    await powershell(
        `Start-Process 'explorer.exe' ${psQuote(`shell:AppsFolder\\${aumid}`)}`,
        30_000
    );
}

/**
 * Terminates a package's processes. Prefer passing the launcher: see `stopRunning` for why a
 * path-based sweep cannot see a suspended process.
 */
export async function terminate(packageFullName: string, uwpLaunchPath?: string): Promise<void> {
    if (uwpLaunchPath) {
        const result = await run(uwpLaunchPath, ['terminate', '--package', packageFullName], {
            timeoutMs: 60_000
        });
        if (result.exitCode === 0) {
            return;
        }
    }
    await powershell(
        `$p = Get-AppxPackage | Where-Object { $_.PackageFullName -eq ${psQuote(packageFullName)} }; ` +
        `if ($p) { Get-Process -ErrorAction SilentlyContinue | ` +
        `Where-Object { $_.Path -and $_.Path.StartsWith($p.InstallLocation) } | ` +
        `Stop-Process -Force -ErrorAction SilentlyContinue }`,
        60_000
    );
}
