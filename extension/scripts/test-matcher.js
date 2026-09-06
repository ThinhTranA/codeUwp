// Validates the problem-matcher regexes in package.json against real MSBuild output.
//
// Problem matchers fail silently -- a regex that does not match produces no diagnostics and
// no error, which looks exactly like a clean build. So they get tested against captured
// output rather than eyeballed.
//
//   node scripts/test-matcher.js <capturedBuildOutput.txt>

const fs = require('fs');
const path = require('path');

const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
);

const matchers = manifest.contributes.problemMatchers.map((m) => ({
    name: m.name,
    regexp: new RegExp(m.pattern.regexp),
    pattern: m.pattern
}));

const SAMPLES = [
    // Captured from a real UWP build (VS 2026, MSBuild 18.9).
    "d:\\dev\\codeUwp\\samples\\ClassicUwpWinUI2\\MainPage.xaml.cs(32,18): error CS1061: 'MainPage' does not contain a definition for 'NoSuchMethod' [d:\\dev\\codeUwp\\samples\\ClassicUwpWinUI2\\ClassicUwpWinUI2.csproj]",
    "d:\\a\\b\\MainPage.xaml.cs(10,5): warning CS0219: The variable 'unusedLocal' is assigned but its value is never used [d:\\a\\b\\p.csproj]",
    // XAML compiler errors carry no column.
    "d:\\a\\b\\MainPage.xaml(14): error XamlCompiler0001: Object reference not set [d:\\a\\b\\p.csproj]",
    // cl.exe, for C++/WinRT projects.
    "d:\\a\\b\\pch.cpp(3,10): error C1083: Cannot open include file: 'nope.h' [d:\\a\\b\\p.vcxproj]",
    // A project-level error with no line at all.
    "d:\\a\\b\\p.csproj : error MSB4057: The target \"Deploy\" does not exist in the project.",
    // Multi-core build output prefixes each line with a node id.
    "  3>d:\\a\\b\\App.xaml.cs(7,1): error CS1002: ; expected [d:\\a\\b\\p.csproj]"
];

const extra = process.argv[2];
if (extra && fs.existsSync(extra)) {
    for (const line of fs.readFileSync(extra, 'utf8').split(/\r?\n/)) {
        if (/:\s*(error|warning)\s+[A-Za-z]+\d+/.test(line)) {
            SAMPLES.push(line);
        }
    }
}

let failures = 0;
for (const sample of SAMPLES) {
    const hit = matchers.find((m) => m.regexp.test(sample));
    if (!hit) {
        failures++;
        console.log(`NO MATCH: ${sample.slice(0, 120)}`);
        continue;
    }
    const groups = sample.match(hit.regexp);
    const field = (name) =>
        hit.pattern[name] !== undefined ? groups[hit.pattern[name]] : '-';
    console.log(`[${hit.name}] ${field('severity')} ${field('code')}`);
    console.log(`    file=${field('file')} line=${field('line')} col=${field('column')}`);
    console.log(`    msg=${String(field('message')).slice(0, 90)}`);
}

console.log(`\n${SAMPLES.length - failures}/${SAMPLES.length} matched`);
process.exit(failures === 0 ? 0 : 1);
