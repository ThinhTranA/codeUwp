// End-to-end dev loop: discover -> build -> deploy -> launch -> verify -> terminate.
//
// This drives the extension's OWN compiled modules (out/core/*), not a parallel
// reimplementation in PowerShell. That is the point: a harness that re-implements the thing
// it is testing passes while the product is broken. The only logic here is orchestration and
// assertions.
//
//   node scripts/e2e.js [--project <path>] [--config Debug] [--platform x64] [--keep]
//
// Exit code 0 means the whole loop worked on this machine.

const fs = require('fs');
const path = require('path');

const { run } = require('../out/core/exec');
const { findMsBuild } = require('../out/core/toolchain');
const { discoverProjects } = require('../out/core/projects');
const { deploy, terminate } = require('../out/core/deploy');
const { powershellJson } = require('../out/core/powershell');
const { runDoctor } = require('../out/core/doctor');
const {
    findUwpLaunch,
    launchSuspended,
    disableDebugging,
    HOT_RELOAD_ENVIRONMENT
} = require('../out/core/launcher');
const { findTapDll, stageTap, injectTap, readTapReport, readVisualTree, elementPath, isApplicationMarkup, sendCommands } = require('../out/core/tap');
const { parseXamlElements, diffXaml, resolveEdits } = require('../out/core/hotreload');

function arg(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const KEEP = process.argv.includes('--keep');

const steps = [];
function record(name, ok, detail) {
    steps.push({ name, ok, detail });
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
    if (!ok) {
        throw new Error(`${name}: ${detail ?? 'failed'}`);
    }
}

async function processesFor(layoutDir) {
    // Matching on the install location rather than the process name: a name match would also
    // find an unrelated process, and the layout path is what actually proves the thing
    // running is the thing just deployed.
    return powershellJson(
        `Get-Process -ErrorAction SilentlyContinue | ` +
        `Where-Object { $_.Path -and $_.Path.StartsWith('${layoutDir.replace(/'/g, "''")}') } | ` +
        `Select-Object Id,ProcessName,Responding`
    );
}

async function processById(pid) {
    // Asked by pid rather than by path: a process suspended at its first instruction does not
    // reliably expose MainModule/Path yet, so a path-based lookup reports it as absent when it
    // is very much there.
    const rows = await powershellJson(
        `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object Id,ProcessName`
    );
    return rows[0];
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    const configuration = arg('config', 'Debug');
    const platform = arg('platform', 'x64');
    const root = path.resolve(__dirname, '..', '..');

    console.log(`UWP end-to-end loop  (${configuration}|${platform})`);
    console.log('='.repeat(64));

    console.log('\n[1] prerequisites');
    const checks = await runDoctor();
    const blocking = checks.filter((c) => c.status === 'missing');
    record(
        'no blocking prerequisites',
        blocking.length === 0,
        blocking.length ? blocking.map((c) => `${c.name}: ${c.remedy ?? c.detail}`).join('; ') : undefined
    );

    console.log('\n[2] toolchain');
    const install = await findMsBuild();
    record('MSBuild with UWP workload', Boolean(install), install ? install.msbuildPath : 'none found');

    console.log('\n[3] discovery');
    const started = Date.now();
    const projects = await discoverProjects(install.msbuildPath, [root], configuration, platform);
    record('found at least one UWP project', projects.length > 0, `${projects.length} in ${Date.now() - started} ms`);

    const wanted = arg('project');
    const project = wanted
        ? projects.find((p) => p.projectPath.toLowerCase().includes(wanted.toLowerCase()))
        : projects[0];
    record('selected a project', Boolean(project), project ? `${project.name} [${project.flavour}]` : wanted);

    console.log('\n[4] build');
    const buildStarted = Date.now();
    const build = await run(install.msbuildPath, [
        project.projectPath,
        '-t:Build',
        `-p:Configuration=${configuration}`,
        `-p:Platform=${platform}`,
        '-p:AppxBundle=Never',
        '-p:UapAppxPackageBuildMode=SideloadOnly',
        '-p:AppxPackageSigningEnabled=false',
        '-v:m',
        '-nologo'
    ], { timeoutMs: 900_000 });
    record(
        'build succeeded',
        build.exitCode === 0,
        build.exitCode === 0
            ? `${Date.now() - buildStarted} ms`
            : build.stdout.split(/\r?\n/).filter((l) => /error/i.test(l)).slice(0, 3).join(' | ')
    );

    // Found before deploy, because deploy needs it to stop a previously held instance:
    // a suspended process reports no executable path, so no path-based sweep can see it.
    const uwpLaunch = findUwpLaunch(path.join(__dirname, '..'));
    record(
        'uwplaunch.exe found',
        Boolean(uwpLaunch),
        uwpLaunch ?? 'build it: dotnet build src/UwpLaunch -c Release'
    );

    console.log('\n[5] deploy');
    const result = await deploy(project, (m) => console.log(`        ${m}`), uwpLaunch);
    record('registered', Boolean(result.packageFullName), result.packageFullName);

    console.log('\n[6] launch');
    // Anything already running would make "is it up?" answer yes without proving the launch.
    if ((await processesFor(result.layoutDir)).length > 0) {
        await terminate(result.packageFullName, uwpLaunch);
        await delay(1500);
    }

    // The app writes this as its first act in OnLaunched, so its absence is a reliable
    // signal that managed code has not run yet.
    const startupLog = path.join(
        process.env.LOCALAPPDATA,
        'Packages',
        result.packageFamilyName,
        'LocalState',
        'startup.txt'
    );
    fs.rmSync(startupLog, { force: true });

    const suspended = await launchSuspended({
        uwpLaunchPath: uwpLaunch,
        packageFullName: result.packageFullName,
        aumid: result.aumid,
        environment: [...HOT_RELOAD_ENVIRONMENT, 'UWP_TOOLS_MARKER=e2e'],
        waitForAttach: true
    });
    record('launched suspended', suspended.pid > 0, `pid ${suspended.pid}, tid ${suspended.tid}`);

    // The assertion that F5 actually rests on. The process exists but has not run a single
    // instruction, which is the only window in which a debugger can attach and still see the
    // runtime start. If this fails, breakpoints in App.OnLaunched will be silently missed.
    // Long enough that an unheld app would certainly have reached OnLaunched by now, so the
    // startup.txt assertion below is meaningful rather than a race.
    await delay(2000);
    const held = await processById(suspended.pid);
    record('process exists while held', Boolean(held), held ? held.ProcessName : `pid ${suspended.pid} gone`);
    record(
        'no managed code has run yet',
        !fs.existsSync(startupLog),
        fs.existsSync(startupLog) ? 'startup.txt already written -- the app was NOT held' : ''
    );

    console.log('\n[7] resume and verify environment injection');
    suspended.resume();

    // Measured at roughly 250 ms on an idle machine, but this is startup of a XAML app on a
    // machine that has just finished a build and two native compiles, so the window is
    // deliberately far wider than the expected time. A tight bound here produces failures that
    // say "the app did not run" when the app ran fine, which is worse than a slow test.
    let startup = '';
    for (let attempt = 0; attempt < 60 && !startup; attempt++) {
        await delay(500);
        try {
            startup = fs.readFileSync(startupLog, 'utf8');
        } catch {
            startup = '';
        }
    }
    if (!startup) {
        // Say which of the two failures this was: a process that died, or one that never ran.
        const alive = await processById(suspended.pid);
        record(
            'app ran after resume',
            false,
            alive
                ? `pid ${suspended.pid} is alive but never wrote ${startupLog} -- resume may not have been delivered`
                : `pid ${suspended.pid} is gone -- the app crashed on startup, see LocalState\\crash.txt`
        );
    }
    record('app ran after resume', Boolean(startup), '');

    const diag = /XAML_DIAG_SOURCE\s*=\s*(\S+)/.exec(startup);
    record(
        'ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO reached the AppContainer',
        diag?.[1] === '1',
        `value=${diag?.[1] ?? '(absent)'}`
    );
    const reportedPid = /pid\s*=\s*(\d+)/.exec(startup);
    record(
        'launcher pid matches the process',
        Number(reportedPid?.[1]) === suspended.pid,
        `launcher=${suspended.pid} app=${reportedPid?.[1]}`
    );

    console.log('\n[8] XAML diagnostics tap (the hot-reload substrate)');
    const tapDll = findTapDll(path.join(__dirname, '..'));
    record(
        'XamlTap.dll found',
        Boolean(tapDll),
        tapDll ?? 'build it: native/XamlTap/build.ps1'
    );

    const workDir = stageTap(tapDll, result.packageFamilyName);

    // Injecting before the app has its XAML tree up fails with ERROR_NOT_FOUND (0x80070490):
    // the diagnostics endpoint does not exist yet. That is timing, not configuration, so retry.
    let injected = false;
    let lastError = '';
    for (let attempt = 0; attempt < 10 && !injected; attempt++) {
        try {
            await injectTap(uwpLaunch, suspended.pid, workDir);
            injected = true;
        } catch (error) {
            lastError = error.message;
            await delay(1000);
        }
    }
    record('tap injected', injected, injected ? `pid ${suspended.pid}` : lastError);

    let report;
    for (let attempt = 0; attempt < 10 && !report; attempt++) {
        await delay(500);
        report = readTapReport(workDir);
    }
    record('tap loaded inside the AppContainer', Boolean(report?.loaded), report ? '' : 'no report written');
    record('tap pid matches the app', report?.pid === suspended.pid, `tap=${report?.pid} app=${suspended.pid}`);
    record('IXamlDiagnostics available', report?.hasXamlDiagnostics === true, '');
    record('IVisualTreeService available', report?.hasVisualTreeService === true, '');
    // The one that decides whether hot reload is possible at all: SetProperty, CreateInstance
    // and ReplaceResource live on IVisualTreeService3 and its ancestors.
    record('IVisualTreeService3 available', report?.hasVisualTreeService3 === true, '');

    const tree = readVisualTree(workDir);
    record('visual tree snapshot written', Array.isArray(tree) && tree.length > 0, `${tree?.length ?? 0} elements`);

    // The sample's own named elements. Finding them proves the snapshot is the real tree and
    // not, say, only the diagnostics layer or a partially-built one.
    const named = new Map((tree ?? []).filter((n) => n.name).map((n) => [n.name, n]));
    for (const expected of ['Title', 'CounterButton', 'CounterText']) {
        record(`found x:Name="${expected}"`, named.has(expected), named.get(expected)?.type ?? 'missing');
    }

    // Source info is what lets an edit in a .xaml file be aimed at a live element. Without it
    // the tree is readable but not editable from markup, so this guards the next phase.
    const appElements = (tree ?? []).filter(isApplicationMarkup);
    record(
        'app elements traced to their own markup',
        appElements.length > 0,
        `${appElements.length} of ${tree.length} from ms-appx:///`
    );

    // Specific lines, not just "some source info". A wrong-but-present mapping would pass a
    // vaguer assertion and then aim every edit at the wrong element.
    const button = named.get('CounterButton');
    record(
        'CounterButton maps to its markup line',
        button?.sourceFile === 'ms-appx:///MainPage.xaml' && button.sourceLine > 0,
        `${button?.sourceFile}:${button?.sourceLine}`
    );

    // The tree contains control-template internals too, and they reuse ordinary names: the
    // sample ends up with two elements called `Title`, one ours and one inside InfoBar's
    // template. Addressing must not confuse them.
    const titles = (tree ?? []).filter((n) => n.name === 'Title');
    record(
        'duplicate template names are distinguishable',
        titles.length > 1 && titles.filter(isApplicationMarkup).length === 1,
        `${titles.length} named "Title", ${titles.filter(isApplicationMarkup).length} in app markup`
    );

    if (button) {
        console.log(`        CounterButton path: ${elementPath(tree, button)}`);
    }

    console.log('\n[9] XAML hot reload: edit the file, apply to the running app');

    // The real path, not a synthesised command: take the markup the app was built from, make
    // the kind of edit a developer would make, and let the differ work out what changed.
    const xamlPath = path.join(path.dirname(project.projectPath), 'MainPage.xaml');
    const baseline = fs.readFileSync(xamlPath, 'utf8');
    const marker = `Hot reloaded ${Date.now()}`;

    const titleLine = parseXamlElements(baseline).find((e) => e.attributes.get('x:Name') === 'Title');
    record('parsed the element out of the markup', Boolean(titleLine), titleLine ? `${titleLine.tag} at line ${titleLine.line}` : 'not found');

    const updated = baseline.replace(
        /(<TextBlock[^>]*x:Name="Title"[\s\S]*?Text=")([^"]*)(")/,
        `$1${marker}$3`
    );
    record('produced an edited version of the file', updated !== baseline, `Text -> "${marker}"`);

    const diff = diffXaml(baseline, updated);
    record(
        'diff reduced it to one property edit',
        diff.edits.length === 1 && diff.edits[0].property === 'Text',
        diff.unsupported ?? diff.edits.map((e) => `${e.tag}:${e.line} ${e.property}`).join(', ')
    );

    const resolved = resolveEdits(diff.edits, tree, 'MainPage.xaml');
    record(
        'edit aimed at a live element by source line',
        resolved.commands.length === 1,
        resolved.unresolved.map((u) => u.reason).join('; ') || `handle ${resolved.commands[0]?.handle}`
    );

    const title = (tree ?? []).find((n) => n.handle === resolved.commands[0]?.handle);
    const applied = await sendCommands(workDir, resolved.commands);
    record(
        'tap reported the edit applied',
        applied.length === 1 && applied[0].status === 'OK',
        applied.map((r) => `${r.property}=${r.status}`).join('; ')
    );

    // "The API returned S_OK" and "the live object holds the new value" are different claims,
    // and only the second one is hot reload. Read it back from the running app.
    const readBack = await sendCommands(workDir, [
        { op: 'GetProperty', handle: title.handle, property: 'Text' }
    ]);
    record(
        'the running app holds the new value',
        readBack[0]?.status === `VALUE=${marker}`,
        readBack[0]?.status ?? '(no answer)'
    );

    record('app still alive after the edit', Boolean(await processById(suspended.pid)), `pid ${suspended.pid}`);

    if (!KEEP) {
        console.log('\n[10] cleanup');
        // Pairing disable-debug with the launch matters: a package left in debug mode stays
        // that way after this process exits, and nothing surfaces that to the user.
        await disableDebugging(uwpLaunch, result.packageFullName);
        await terminate(result.packageFullName, uwpLaunch);
        await delay(1000);
        const after = await processesFor(result.layoutDir);
        record('terminated and debug mode cleared', after.length === 0, `${after.length} process(es) left`);
    } else {
        console.log('\n[10] cleanup skipped (--keep) -- package is still in debug mode');
    }

    console.log('\n' + '='.repeat(64));
    console.log(`${steps.filter((s) => s.ok).length}/${steps.length} steps passed`);
    console.log(`AUMID: ${result.aumid}`);
}

main().catch((error) => {
    console.log('\n' + '='.repeat(64));
    console.error(`LOOP FAILED: ${error.message}`);
    process.exit(1);
});
