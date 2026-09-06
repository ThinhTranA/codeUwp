// Launches a real VS Code with the extension loaded and runs the integration suite inside it.
//
// This exists because one seam cannot be covered by the headless loop: the debug handoff. The
// engine must be started by VS Code, through vscode.debug.startDebugging, from the user's own
// installation -- Microsoft's debug engines are licensed for use with Microsoft-provided
// tooling only, so driving vsdbg from a script is not an option even to test compatibility.
// Running the test inside the extension host uses exactly the path the product uses.
//
//   node test/runTest.js

const path = require('path');
const os = require('os');
const fs = require('fs');

const { runTests } = require('@vscode/test-electron');

/**
 * Removes the VS Code host environment we may have inherited.
 *
 * Running this from inside VS Code's own integrated terminal or extension host leaves
 * `ELECTRON_RUN_AS_NODE=1` in the environment. The VS Code we launch inherits it, starts as
 * plain Node instead of as an editor, and dies trying to `require` the workspace path
 * ("Cannot find module D:\dev\codeUwp"). The VSCODE_* variables cause subtler confusion for
 * the same reason — VSCODE_IPC_HOOK in particular points the new instance at the running one.
 */
function scrubHostEnvironment() {
    const removed = [];
    for (const name of Object.keys(process.env)) {
        if (name === 'ELECTRON_RUN_AS_NODE' || name.startsWith('VSCODE_')) {
            delete process.env[name];
            removed.push(name);
        }
    }
    if (removed.length > 0) {
        console.log(`scrubbed inherited env: ${removed.join(', ')}`);
    }
}

async function main() {
    scrubHostEnvironment();

    const extensionDevelopmentPath = path.resolve(__dirname, '..');
    const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');
    const workspace = path.resolve(__dirname, '..', '..');

    // VS Code is downloaded and cached by test-electron rather than reusing the local install.
    // Pointing `vscodeExecutablePath` at an installed Code.exe makes it launch Electron in
    // node mode, which then tries to `require` the workspace path and dies with
    // "Cannot find module D:\dev\codeUwp". The download is one-time and cached under
    // .vscode-test/.
    //
    // Crucially this costs us nothing here: the extensions directory below is the real one, so
    // ReSharper and cpptools are loaded by the downloaded build just the same. What is being
    // measured is which debug engines are installed, not which VS Code binary hosts them.
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uwp-tools-vscode-'));
    const extensionsDir = path.join(os.homedir(), '.vscode', 'extensions');

    console.log(`workspace   : ${workspace}`);
    console.log(`extensions  : ${extensionsDir}`);

    const exitCode = await runTests({
        extensionDevelopmentPath,
        extensionTestsPath,
        // Flags use the `--name=value` form deliberately. Passed as separate array entries,
        // VS Code's CLI parsing consumed the following token as the flag's value and then
        // treated the workspace path as a module to load ("Cannot find module D:\dev\codeUwp").
        launchArgs: [
            workspace,
            `--extensions-dir=${extensionsDir}`,
            `--user-data-dir=${userDataDir}`,
            // Untrusted workspaces disable task and debug execution, which would fail the
            // suite for a reason that has nothing to do with the code under test.
            '--disable-workspace-trust',
            '--skip-welcome',
            '--skip-release-notes',
            // Everything unrelated to the measurement is disabled: they slow startup and, in
            // PlatformIO's case, flood stdout badly enough to bury the results. The debug
            // engines and this extension are all that matter here.
            '--disable-extension=platformio.platformio-ide',
            '--disable-extension=vscodevim.vim',
            '--disable-extension=anthropic.claude-code'
        ]
    });

    process.exit(exitCode);
}

main().catch((error) => {
    console.error('Failed to run integration tests:', error);
    process.exit(1);
});
