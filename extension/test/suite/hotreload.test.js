const assert = require('assert');
const fs = require('fs');
const path = require('path');

const vscode = require('vscode');

const EXTENSION_ID = 'uwp-tools.uwp-tools';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, intervalMs = 500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) {
            return true;
        }
        await delay(intervalMs);
    }
    return false;
}

/**
 * Drives XAML hot reload the way a developer does: run the app, edit a file in the editor,
 * save it, and check the running app changed.
 *
 * This exists because `hotReload.ts` only runs inside an extension host, so the headless loop
 * cannot reach it. Everything it depends on — the tap, the differ, the command channel — is
 * asserted headlessly; the part that was left to manual testing is the wiring between a save
 * event and those pieces, and that is precisely where the bugs kept being.
 */
suite('XAML hot reload, end to end', () => {
    let api;
    let xamlPath;
    let originalText;

    /** The tap's work folder, where the visual tree and command results land. */
    function workDir(packageFamilyName) {
        return path.join(
            process.env.LOCALAPPDATA,
            'Temp',
            'uwp-tools-tap',
            packageFamilyName
        );
    }

    function dumpLog(header) {
        const lines = api?.getLog?.() ?? [];
        console.log(`\n---------------- ${header} ----------------`);
        console.log(lines.length ? lines.join('\n') : '(no log)');
        console.log('--------------------------------------------------\n');
    }

    suiteSetup(async () => {
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(extension, `${EXTENSION_ID} not found`);
        api = await extension.activate();

        const workspace = vscode.workspace.workspaceFolders?.[0];
        xamlPath = path.join(workspace.uri.fsPath, 'samples', 'ClassicUwpWinUI2', 'MainPage.xaml');
        originalText = fs.readFileSync(xamlPath, 'utf8');
    });

    suiteTeardown(async () => {
        // The sample is a checked-in file; leaving a test marker in it would show up as a
        // spurious diff and, worse, become the next run's baseline.
        if (originalText !== undefined) {
            fs.writeFileSync(xamlPath, originalText, 'utf8');
        }
        try {
            await vscode.commands.executeCommand('uwp.terminate');
        } catch {
            // Best effort.
        }
    });

    test('editing and saving a XAML file updates the running app', async () => {
        // Build, deploy, launch, and attach hot reload — the same command a developer runs.
        await vscode.commands.executeCommand('uwp.run');

        const family = 'ClassicUwpWinUI2-Sample_aynwpqe9gd9q2';
        const dir = workDir(family);

        const treeReady = await waitFor(
            () => fs.existsSync(path.join(dir, 'tree.tsv')),
            180_000
        );
        if (!treeReady) {
            dumpLog('EXTENSION LOG');
        }
        assert.ok(treeReady, 'the tap never wrote a visual tree; hot reload did not attach');

        // Edit through the editor rather than on disk, so the change arrives as the same
        // onDidSaveTextDocument event a person's keystrokes would produce.
        const marker = `HOTRELOAD-${Date.now()}`;
        const document = await vscode.workspace.openTextDocument(xamlPath);
        const editor = await vscode.window.showTextDocument(document);

        const text = document.getText();
        const match = /(<TextBlock[^>]*x:Name="Title"[\s\S]*?Text=")([^"]*)(")/.exec(text);
        assert.ok(match, 'could not find the Title TextBlock to edit');
        const valueStart = document.positionAt(match.index + match[1].length);
        const valueEnd = document.positionAt(match.index + match[1].length + match[2].length);

        await editor.edit((builder) => builder.replace(new vscode.Range(valueStart, valueEnd), marker));
        const saved = await document.save();
        assert.ok(saved, 'the document did not save');

        // The apply is asynchronous; the log is the reliable signal that it ran, and the
        // results file is the proof it reached the app.
        const applied = await waitFor(async () => {
            const log = (api.getLog?.() ?? []).join('\n');
            return log.includes('applied 1/1 edit(s)') || log.includes('applied 1/');
        }, 60_000);

        dumpLog('EXTENSION LOG');

        const resultsPath = path.join(dir, 'results.tsv');
        const results = fs.existsSync(resultsPath)
            ? fs.readFileSync(resultsPath, 'utf16le').replace(/^﻿/, '')
            : '';
        console.log(`results.tsv: ${JSON.stringify(results)}`);

        assert.ok(
            applied,
            'the extension never reported applying an edit — see the log above for which step declined it'
        );
        assert.ok(
            results.includes('\tOK'),
            `the tap did not report success; results.tsv was ${JSON.stringify(results)}`
        );
    });
});
