// Exercises the parts of the extension that do not need a VS Code host: toolchain
// discovery, MSBuild evaluation, project classification, and the doctor checks. Run it
// against the repo root to see what the extension would see.
//
//   node scripts/smoke.js [workspaceRoot]

const path = require('path');

const { findMsBuild, findWindowsSdk, findDebuggingTools } = require('../out/core/toolchain');
const { discoverProjects } = require('../out/core/projects');
const { runDoctor, summarise } = require('../out/core/doctor');

async function main() {
    const root = path.resolve(process.argv[2] ?? path.join(__dirname, '..', '..'));
    console.log(`workspace: ${root}\n`);

    console.log('--- doctor ---');
    const checks = await runDoctor();
    for (const check of checks) {
        const mark = check.status === 'ok' ? '[ ok ]' : check.status === 'warning' ? '[warn]' : '[MISS]';
        console.log(`${mark} ${check.name}: ${check.detail}`);
        if (check.remedy) console.log(`       fix: ${check.remedy}`);
    }
    console.log(summarise(checks));

    console.log('\n--- toolchain ---');
    const install = await findMsBuild();
    console.log(`msbuild: ${install ? install.msbuildPath : '(none with UWP workload)'}`);
    if (install) console.log(`         ${install.displayName} ${install.installationVersion} uwp=${install.hasUwp} vc=${install.hasUwpVc}`);
    const sdk = findWindowsSdk();
    console.log(`sdk    : ${sdk ? sdk.versions[0] : '(none)'}  makeappx=${sdk && sdk.makeAppx ? 'yes' : 'no'}`);
    console.log(`dbgtool: ${JSON.stringify(findDebuggingTools())}`);

    if (!install) {
        console.log('\nNo UWP-capable MSBuild; skipping project discovery.');
        return;
    }

    console.log('\n--- projects (Debug|x64) ---');
    const started = Date.now();
    const projects = await discoverProjects(install.msbuildPath, [root], 'Debug', 'x64');
    console.log(`discovered ${projects.length} in ${Date.now() - started} ms\n`);
    for (const project of projects) {
        console.log(`name          : ${project.name}`);
        console.log(`flavour       : ${project.flavour}`);
        console.log(`platform ver  : ${project.targetPlatformMinVersion} -> ${project.targetPlatformVersion}`);
        console.log(`output        : ${project.outputPath}`);
        console.log(`manifest      : ${project.appxManifestPath}`);
        console.log(`managed debug : ${project.supportsManagedDebugging}`);
        console.log(`note          : ${project.debuggingNote}`);
        console.log('');
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
