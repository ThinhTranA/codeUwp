// Collects everything needed to diagnose a problem into one file.
//
// Filing a useful report otherwise means knowing which of several logs matter and where they
// live. This gathers them, so a report is "run this, attach the file" — which is also what
// lets someone else's AI assistant collect the right things without being told.
//
//   npm run diagnostics
//
// The output contains file paths, which include a user name. Read it before attaching it to a
// public issue.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const out = [];
const section = (title) => out.push('', '='.repeat(72), title, '='.repeat(72));
// Variadic: callers spread whole files into this, and a single-parameter version silently
// keeps only the first line — which looks like a truncated log rather than a bug here.
const line = (...text) => out.push(...(text.length ? text : ['']));

function safe(label, fn) {
    try {
        const value = fn();
        line(value === undefined || value === '' ? `${label}: (nothing)` : String(value).trimEnd());
    } catch (error) {
        line(`${label}: FAILED — ${error.message}`);
    }
}

function powershell(script) {
    return execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', timeout: 60_000, windowsHide: true }
    );
}

section('UWP Tools diagnostics');
line(`generated   ${new Date().toISOString()}`);
line(`os          ${os.platform()} ${os.release()} ${os.arch()}`);
line(`node        ${process.version}`);

let version = '(unknown)';
try {
    version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
} catch { /* reported below as unknown */ }
line(`extension   ${version}`);

section('Prerequisites (the doctor)');
try {
    const { runDoctor, summarise } = require('../out/core/doctor');
    runDoctor().then((checks) => {
        for (const check of checks) {
            const mark = check.status === 'ok' ? '[ ok ]' : check.status === 'warning' ? '[warn]' : '[MISS]';
            line(`${mark} ${check.name}: ${check.detail}`);
            if (check.remedy) {
                line(`       fix: ${check.remedy}`);
            }
        }
        line(summarise(checks));
        finish();
    }).catch((error) => {
        line(`doctor failed: ${error.message}`);
        finish();
    });
} catch (error) {
    line(`doctor unavailable (is the extension compiled?): ${error.message}`);
    finish();
}

function finish() {
    section('Debug engines installed');
    safe('extensions', () =>
        powershell(
            "Get-ChildItem \"$env:USERPROFILE\\.vscode\\extensions\" -Directory -ErrorAction SilentlyContinue | " +
            "Where-Object { $_.Name -match 'resharper|dotnettools|cpptools' } | " +
            'Select-Object -ExpandProperty Name'
        )
    );

    section('Extension log');
    // The most valuable single artefact: it names which step declined a hot reload edit, and
    // carries the environment header and per-stage timings.
    const logFile = path.join(
        process.env.LOCALAPPDATA ?? process.env.TEMP ?? '.',
        'Temp',
        'uwp-tools',
        'extension.log'
    );
    line(`path: ${logFile}`);
    try {
        const log = fs.readFileSync(logFile, 'utf8').split(/\r?\n/);
        // Tail only: these accumulate across sessions and the recent run is what matters.
        line(...log.slice(-400));
    } catch (error) {
        line(`(could not read: ${error.message})`);
        line('Run the extension once — "UWP: Build, Deploy and Run" — and try again.');
    }

    section('XAML tap state');
    const tapRoot = path.join(
        process.env.LOCALAPPDATA ?? process.env.TEMP ?? '.',
        'Temp',
        'uwp-tools-tap'
    );
    try {
        for (const family of fs.readdirSync(tapRoot)) {
            const dir = path.join(tapRoot, family);
            line(`package: ${family}`);
            for (const file of fs.readdirSync(dir)) {
                const stat = fs.statSync(path.join(dir, file));
                line(`  ${file.padEnd(20)} ${String(stat.size).padStart(8)} bytes  ${stat.mtime.toISOString()}`);
            }
            // The report says whether the tap loaded and which interfaces it got; the tree's
            // element count is what tells you whether edits had anything to aim at.
            try {
                const report = fs.readFileSync(path.join(dir, 'tap-report.txt'), 'utf16le').replace(/^﻿/, '');
                line('  --- tap-report.txt ---');
                line(...report.split(/\r?\n/).map((l) => `  ${l}`));
            } catch { /* absent is itself informative, and the listing above shows it */ }
            try {
                const tree = fs.readFileSync(path.join(dir, 'tree.tsv'), 'utf16le').replace(/^﻿/, '');
                const rows = tree.split(/\r?\n/).filter(Boolean);
                line(`  visual tree: ${Math.max(rows.length - 1, 0)} element(s)`);
            } catch { /* as above */ }
        }
    } catch (error) {
        line(`(no tap working directory: ${error.message})`);
    }

    const target = path.join(process.cwd(), 'uwp-tools-diagnostics.txt');
    fs.writeFileSync(target, out.join('\n') + '\n', 'utf8');
    console.log(out.join('\n'));
    console.log('');
    console.log(`Written to ${target}`);
    console.log('Attach that file to the issue. It contains file paths, which include your');
    console.log('user name — read it first if the repository is public.');
}
