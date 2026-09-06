// Follows the extension's log file.
//
// The extension writes here as well as to its OutputChannel, because a channel is visible only
// inside the window that produced it — which makes diagnosing someone else's run a matter of
// asking them to copy text out.
//
//   npm run log

const fs = require('fs');
const path = require('path');

const file = path.join(
    process.env.LOCALAPPDATA ?? process.env.TEMP ?? '.',
    'Temp',
    'uwp-tools',
    'extension.log'
);

console.log(`following ${file}\n`);

let offset = 0;
try {
    const existing = fs.readFileSync(file, 'utf8');
    process.stdout.write(existing);
    offset = Buffer.byteLength(existing);
} catch {
    console.log('(no log yet — run something in the Extension Development Host)');
}

setInterval(() => {
    let size;
    try {
        size = fs.statSync(file).size;
    } catch {
        return;
    }
    // A shrunken file means the log was reset; start over rather than seeking past the end.
    if (size < offset) {
        offset = 0;
    }
    if (size > offset) {
        const stream = fs.createReadStream(file, { start: offset, end: size - 1 });
        stream.on('data', (chunk) => process.stdout.write(chunk));
        offset = size;
    }
}, 500);
