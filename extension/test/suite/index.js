const path = require('path');
const fs = require('fs');
const Mocha = require('mocha');

/** Entry point VS Code calls inside the extension host. */
function run() {
    const mocha = new Mocha({
        ui: 'tdd',
        color: false,
        // A full build, deploy, launch and attach. Generous on purpose: a timeout here would
        // report "the debugger did not attach" for a machine that was merely busy.
        timeout: 2_400_000,
        reporter: 'spec'
    });

    // UWP_TEST_SUITE narrows a run to one file. Each suite here builds, deploys and launches
    // a real app, so running all of them takes long enough that iterating on one is painful.
    const suiteDir = __dirname;
    const only = process.env.UWP_TEST_SUITE;
    for (const file of fs.readdirSync(suiteDir)) {
        if (!file.endsWith('.test.js')) continue;
        if (only && !file.includes(only)) continue;
        mocha.addFile(path.join(suiteDir, file));
    }

    return new Promise((resolve, reject) => {
        try {
            mocha.run((failures) => {
                if (failures > 0) {
                    reject(new Error(`${failures} test(s) failed.`));
                } else {
                    resolve();
                }
            });
        } catch (error) {
            reject(error);
        }
    });
}

module.exports = { run };
