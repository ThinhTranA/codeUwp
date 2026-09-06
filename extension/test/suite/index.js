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

    const suiteDir = __dirname;
    for (const file of fs.readdirSync(suiteDir)) {
        if (file.endsWith('.test.js')) {
            mocha.addFile(path.join(suiteDir, file));
        }
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
