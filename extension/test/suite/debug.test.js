const assert = require('assert');
const fs = require('fs');
const path = require('path');

const vscode = require('vscode');

const EXTENSION_ID = 'uwp-tools.uwp-tools';

/**
 * Observes the DAP traffic of whatever session starts.
 *
 * The VS Code API does not expose whether a breakpoint verified, or that the debuggee stopped
 * — `vscode.debug.breakpoints` carries no verification state. The protocol does, so the
 * tracker reads it off the wire: the `setBreakpoints` response says whether each breakpoint
 * bound, and a `stopped` event says the debuggee actually halted. That is the difference
 * between "the debugger attached" and "the debugger works", which is the whole question here.
 */
class Observations {
    constructor() {
        this.sessionsStarted = [];
        this.breakpointsVerified = [];
        this.stoppedEvents = [];
        this.errors = [];
        this.transcript = [];
        this.initializedCapabilities = undefined;
    }

    /**
     * A bounded transcript of the protocol traffic.
     *
     * Reading only the fields we expected produced a misleading answer once already: every
     * engine reported the same unverified breakpoint carrying VS Code's own placeholder text,
     * which is indistinguishable from a real bind failure until you can see whether the
     * adapter was ever asked to set a breakpoint at all.
     */
    record(direction, message) {
        if (this.transcript.length >= 400) {
            return;
        }
        const entry = { direction, type: message.type };
        if (message.command) entry.command = message.command;
        if (message.event) entry.event = message.event;
        if (message.type === 'response') entry.success = message.success !== false;
        if (message.command === 'setBreakpoints') {
            entry.detail = JSON.stringify(message.arguments ?? message.body ?? {}).slice(0, 400);
        }
        if (message.event === 'module') {
            entry.detail = String(message.body?.module?.name ?? '').slice(0, 120);
        }
        if (message.event === 'breakpoint') {
            entry.detail = JSON.stringify(message.body?.breakpoint ?? {}).slice(0, 300);
        }
        if (message.event === 'stopped') {
            entry.detail = JSON.stringify(message.body ?? {}).slice(0, 200);
        }
        if (message.event === 'output') {
            entry.detail = String(message.body?.output ?? '').trim().slice(0, 200);
        }
        this.transcript.push(entry);
    }

    note(message) {
        if (message.type === 'response' && message.command === 'setBreakpoints' && message.body) {
            for (const bp of message.body.breakpoints ?? []) {
                this.breakpointsVerified.push({
                    source: 'setBreakpoints response',
                    verified: bp.verified === true,
                    message: bp.message,
                    line: bp.line
                });
            }
        }
        // Verification arrives here, not in the response above. An engine attaching to a
        // running process cannot know whether a breakpoint binds until the module carrying it
        // has loaded, so the response is always "pending" and the real answer comes later as a
        // `breakpoint` event. Reading only the response reports every engine as having failed
        // to bind, including ones that went on to hit the breakpoint.
        if (message.type === 'event' && message.event === 'breakpoint' && message.body?.breakpoint) {
            const bp = message.body.breakpoint;
            this.breakpointsVerified.push({
                source: 'breakpoint event',
                verified: bp.verified === true,
                message: bp.message,
                line: bp.line
            });
        }
        if (message.type === 'response' && message.command === 'initialize' && message.body) {
            this.initializedCapabilities = Object.keys(message.body).length;
        }
        if (message.type === 'response' && message.success === false) {
            this.errors.push(`${message.command}: ${message.message ?? '(no message)'}`);
        }
        if (message.type === 'event' && message.event === 'stopped') {
            this.stoppedEvents.push(message.body?.reason ?? 'unknown');
        }
        if (message.type === 'event' && message.event === 'output' && message.body?.category === 'stderr') {
            this.errors.push(`stderr: ${String(message.body.output).trim().slice(0, 200)}`);
        }
    }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, intervalMs = 500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) {
            return true;
        }
        await delay(intervalMs);
    }
    return false;
}

suite('UWP debug handoff', () => {
    let observations;
    let trackerRegistration;
    let api;
    const startedSessions = [];
    const disposables = [];

    /** The extension's own diagnostics; an OutputChannel cannot be read back through the API. */
    function dumpExtensionLog(header) {
        const lines = api?.getLog?.() ?? [];
        console.log(`\n---------------- ${header} ----------------`);
        console.log(lines.length ? lines.join('\n') : '(extension produced no log)');
        console.log('------------------------------------------------\n');
    }

    suiteSetup(async () => {
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(extension, `Extension ${EXTENSION_ID} not found`);
        api = await extension.activate();

        observations = new Observations();
        trackerRegistration = vscode.debug.registerDebugAdapterTrackerFactory('*', {
            createDebugAdapterTracker(session) {
                return {
                    onWillReceiveMessage: (message) => observations.record('to-adapter', message),
                    onDidSendMessage: (message) => { observations.record('from-adapter', message); observations.note(message); },
                    onError: (error) => observations.errors.push(`tracker error: ${error.message}`),
                    onExit: (code, signal) =>
                        observations.errors.push(`adapter exited code=${code} signal=${signal}`)
                };
            }
        });
        disposables.push(trackerRegistration);
        disposables.push(
            vscode.debug.onDidStartDebugSession((session) => {
                startedSessions.push({ name: session.name, type: session.type });
                observations.sessionsStarted.push(session.type);
            })
        );
    });

    suiteTeardown(async () => {
        for (const d of disposables) {
            d.dispose();
        }
        try {
            await vscode.debug.stopDebugging();
        } catch {
            // Nothing running.
        }
        // Never leave a package in debug mode or an app held; both outlive this process.
        try {
            await vscode.commands.executeCommand('uwp.resumeHeld');
            await vscode.commands.executeCommand('uwp.terminate');
        } catch {
            // Best effort.
        }
    });

    test('debug engine extensions are present and can activate', async () => {
        // Reported rather than asserted: which engines exist on a machine is an input to the
        // measurement, not a property of this code.
        for (const id of ['JetBrains.resharper-code', 'ms-dotnettools.csharp', 'ms-vscode.cpptools']) {
            const extension = vscode.extensions.getExtension(id);
            if (!extension) {
                console.log(`  ${id}: not installed`);
                continue;
            }
            let state = extension.isActive ? 'already active' : 'inactive';
            if (!extension.isActive) {
                try {
                    await extension.activate();
                    state = extension.isActive ? 'activated on demand' : 'activate() returned but still inactive';
                } catch (error) {
                    state = `activation FAILED: ${error.message}`;
                }
            }
            console.log(`  ${id}: ${state}`);
        }
    });

    test('extension activates and discovers the sample project', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('uwp.debug'), 'uwp.debug command is not registered');
        assert.ok(commands.includes('uwp.doctor'), 'uwp.doctor command is not registered');
    });

    test('debugger attaches and reports whether breakpoints bind', async () => {
        const workspace = vscode.workspace.workspaceFolders?.[0];
        assert.ok(workspace, 'no workspace folder');

        // A breakpoint on the app's own startup path, so nothing has to click anything: if the
        // engine binds and the from-birth hold works, this is hit without interaction.
        const appXamlCs = vscode.Uri.file(
            path.join(workspace.uri.fsPath, 'samples', 'ClassicUwpWinUI2', 'App.xaml.cs')
        );
        const document = await vscode.workspace.openTextDocument(appXamlCs);
        const line = document
            .getText()
            .split(/\r?\n/)
            .findIndex((text) => text.includes('RecordStartup();'));
        assert.ok(line > 0, 'could not find the RecordStartup() call to break on');

        const breakpoint = new vscode.SourceBreakpoint(
            new vscode.Location(appXamlCs, new vscode.Position(line, 0))
        );
        vscode.debug.addBreakpoints([breakpoint]);

        // ReSharper registers its debug adapters only once its own backend has loaded the
        // solution, which takes appreciably longer than extension activation. Starting a
        // session before then fails with "Couldn't find a debug adapter descriptor for debug
        // type 'coreclr'", which looks like the engine is missing rather than still starting.
        const warmupMs = Number(process.env.UWP_TEST_ENGINE_WARMUP_MS ?? 60_000);
        console.log(`  waiting ${warmupMs} ms for the debug engine backend to come up...`);
        await delay(warmupMs);

        // Each engine measured separately. 'auto' alone reports only whatever it picked,
        // leaving "would the other one have worked?" unanswered — and from outside, an engine
        // that refuses to attach and one that is not registered look identical.
        // The third case is the interesting one. Attaching while the app is held at its first
        // instruction means the CLR is not loaded yet, and an ordinary managed attach has no
        // runtime to find. Measuring "attach after the app is up" separately tells us whether
        // managed debugging works at all, independently of the from-birth sequencing.
        const allCases = [
            { key: 'coreclr-held', engine: 'coreclr', holdForAttach: true, label: 'coreclr (held from birth)' },
            { key: 'coreclr-late', engine: 'coreclr', holdForAttach: false, label: 'coreclr (attach after start)' },
            { key: 'cppvsdbg-held', engine: 'cppvsdbg', holdForAttach: true, label: 'cppvsdbg (held from birth)' }
        ];

        // Each case is a full build/deploy/launch/attach, so three of them run past the ten
        // minutes a foreground command may be given. UWP_TEST_CASES narrows the run to the one
        // being investigated.
        const wanted = (process.env.UWP_TEST_CASES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const cases = wanted.length ? allCases.filter((c) => wanted.includes(c.key)) : allCases;

        const results = [];
        for (const { engine, holdForAttach, label } of cases) {
            startedSessions.length = 0;
            observations.breakpointsVerified.length = 0;
            observations.stoppedEvents.length = 0;
            observations.errors.length = 0;

            console.log(`\n>>> ${label}`);
            // noBuild after the first pass: nothing has changed, and rebuilding per case
            // triples the run for no information.
            await vscode.commands.executeCommand('uwp.debug', {
                engine,
                holdForAttach,
                noBuild: results.length > 0
            });

            const started = await waitFor(() => startedSessions.length > 0, 120_000);
            // Binding is what matters, and it can take a moment after the session starts.
            if (started) {
                await waitFor(() => observations.breakpointsVerified.some((b) => b.verified), 30_000);
            }
            const stopped = started
                ? await waitFor(() => observations.stoppedEvents.length > 0, 30_000)
                : false;

            // Written after every case, not at the end. These runs are long and have died
            // mid-suite before; a result that only exists in stdout is lost when that happens.
            const resultFile = path.join(
                vscode.workspace.workspaceFolders[0].uri.fsPath,
                'extension',
                '.vscode-test',
                'engine-results.json'
            );

            results.push({
                engine: label,
                started,
                sessions: [...startedSessions],
                verified: observations.breakpointsVerified.some((b) => b.verified),
                breakpoints: [...observations.breakpointsVerified],
                stopped,
                errors: [...observations.errors.slice(0, 5)],
                transcript: [...observations.transcript]
            });

            try {
                fs.mkdirSync(path.dirname(resultFile), { recursive: true });
                fs.writeFileSync(
                    resultFile,
                    JSON.stringify({ results, log: api?.getLog?.() ?? [] }, null, 2)
                );
            } catch (error) {
                console.log(`could not write results: ${error.message}`);
            }

            try {
                await vscode.debug.stopDebugging();
            } catch {
                // Nothing running.
            }
            await vscode.commands.executeCommand('uwp.resumeHeld');
            await vscode.commands.executeCommand('uwp.terminate');
            await delay(3000);
        }

        dumpExtensionLog('EXTENSION LOG');

        console.log('\n================ DEBUG HANDOFF RESULT ================');
        for (const r of results) {
            console.log(`engine ${r.engine}`);
            console.log(`  session started : ${r.started} ${JSON.stringify(r.sessions)}`);
            console.log(`  breakpoint bound: ${r.verified} ${JSON.stringify(r.breakpoints)}`);
            console.log(`  debuggee stopped: ${r.stopped}`);
            console.log(`  adapter errors  : ${JSON.stringify(r.errors)}`);
        }
        console.log('======================================================\n');

        // Only a total failure is an error. Which engine binds symbols inside an AppContainer
        // is the measurement; failing on it would turn a finding into a broken build.
        assert.ok(
            results.some((r) => r.started),
            'No engine started a debug session at all; the handoff itself is broken.'
        );
    });
});
