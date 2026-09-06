---
name: uwp-dev-loop
description: Build, test and verify the UWP Tools extension and its sample app end to end. Use whenever changing anything under extension/ or samples/, when asked to "run the tests", "check it works", "verify the loop", or before reporting that a change is done. Covers the one-command harness, what each step proves, and how to read each failure.
---

# UWP dev loop

## The one command

```
cd extension && npm run check
```

Compile → problem-matcher tests → full end-to-end loop. **Exit 0 means it genuinely works on
this machine**, not that it compiled. Takes ~30s. Run it after any change to
`extension/src/` or `samples/`, and before claiming a change is done.

Node is not on the default PATH in every shell. If `npm` is not found:

```powershell
$env:Path = "$env:Path;C:\Users\thinh\tools\node-v24.20.0-win-x64"
```

## Narrower commands

| Command | Use when |
| --- | --- |
| `npm run compile` | Type-checking only; fastest feedback |
| `npm test` | Changed a problem matcher in `package.json` |
| `npm run smoke` | Changed toolchain discovery or project classification — prints what the extension would see |
| `npm run build:launcher` | Changed `src/UwpLaunch/` (C# helper) |
| `npm run build:tap` | Changed `native/XamlTap/` (C++ diagnostics provider) |
| `npm run build:native` | Both of the above |
| `npm run e2e` | Changed build/deploy/launch |
| `node scripts/e2e.js --keep` | Leave the app running so you can look at it. **Leaves the package in debug mode** — pair with `uwplaunch disable-debug --package <pfn>` |
| `node scripts/e2e.js --config Release --platform x86` | Other configurations |

## What each step proves

1. **prerequisites** — doctor finds no blocking issue. Debugging Tools is a *warning*, not
   blocking; it only gates the C++/WinRT debug spike.
2. **toolchain** — an MSBuild with the UWP workload exists (via vswhere `-requires`, never
   `-latest`; this machine has three VS installs and only one qualifies).
3. **discovery** — MSBuild `-getProperty` evaluation works and classifies the sample. Should
   be well under a second.
4. **build** — the sample compiles and produces its `.msix`.
5. **deploy** — stop running instance → install dependencies → `makeappx unpack` → register.
6. **launch** — via `uwplaunch.exe`, with the resume stub. Asserts `fromBirth=true`, which is
   the point of the stub: without it a breakpoint in `App.OnLaunched` is missed rather than
   hit, and nothing about the app looks wrong. Then confirms a process is actually running out
   of the layout directory — this is what catches a package that registers fine and then dies
   on startup.
7. **environment injection** — reads `LocalState\startup.txt`, which the app writes about
   itself, and asserts `ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO=1` arrived and the pid matches.
   **This guards the phase-4 hot-reload prerequisite**, so treat a failure here as blocking
   rather than cosmetic.
8. **XAML diagnostics tap** — injects `XamlTap.dll` into the running app and reads the report
   it writes from inside the AppContainer. Asserts `IVisualTreeService3` is reachable, which
   is what decides whether hot reload is possible at all: `SetProperty`, `CreateInstance` and
   `ReplaceResource` live on it and its ancestors.
9. **cleanup** — `disable-debug` *and* terminate, unless `--keep`.

## Reading failures

**Step 4, build fails.** Real compile error; the output names it. Note the harness prints
only the first three error lines — run MSBuild directly for the rest.

**Step 5, `0x80073D02` "resources it modifies are currently in use".** A running instance is
holding its framework packages. `deploy()` stops the app first, so if this appears, either
that step regressed or a second copy is running from another layout.

**Step 5, `0x80073CFF`.** Developer Mode is off. Only ever surfaces after everything else has
already succeeded.

**Step 5, `0x80073CF3` "framework could not be found".** Something is wrong with the
`Dependencies\<platform>\` folder the build stages. Registration names only ONE missing
framework per attempt.

**Step 6, "never appeared".** The app registered and then crashed on startup. Use the
`uwp-crash-triage` skill — do not guess, this failure mode gives up nothing by inspection.

**Step 6, "the resume stub never connected".** The registered debugger command line is
truncated around 255 characters, silently, and the stub then never runs. Check the length of
`uwplaunch.exe`'s full path.

**Step 6, `E_INVALIDARG` from EnableDebugging.** An environment block is only accepted
alongside a debugger command line. See `tools/Test-EnableDebugging.ps1`, which established
this, and re-run it if the behaviour ever seems to change.

**Step 7, variable absent.** The launch went through without the stub, so no environment was
injected. Check `fromBirth` in step 6 — if it is false, the stub path was skipped.

**Step 7, "alive but never wrote startup.txt".** The process resumed but managed code did not
run, or the resume was never delivered. Distinguish with `--keep` and look at the app.

**Step 8, `ERROR_NOT_FOUND` (0x80070490) on inject.** Either the app has not brought its XAML
tree up yet — the harness retries ten times for exactly this — or the endpoint name is wrong.
It must be `VisualDiagConnection1`.

**Step 8, `E_ACCESSDENIED` on inject.** The AppContainer cannot read the tap directory. The
grant is `icacls /grant *S-1-15-2-1:(OI)(CI)(M)` — by SID, since the name is localised, and
**modify** rather than read because the tap writes its report back.

**Step 8, `ERROR_MOD_NOT_FOUND` (0x8007007E).** Architecture mismatch: the tap must match the
*target's* architecture, not the injector's.

## Rules

- **Do not re-implement the product in the harness.** `scripts/e2e.js` drives the extension's
  own compiled `out/core/*` modules. A harness that re-implements what it tests passes while
  the product is broken. Add assertions there, not logic.
- **Keep `src/core/` free of `vscode` imports.** That is what lets the harness run the real
  code headless. Anything needing the VS Code API belongs in `extension.ts` or `tasks.ts`.
- After changing a problem matcher, add the real MSBuild line you saw to the `SAMPLES` array
  in `scripts/test-matcher.js` rather than trusting the regex by eye.

## Inside a real VS Code: `npm run test:vscode`

Two suites live in `test/suite/`, both running inside a real extension host. Narrow a run
with `UWP_TEST_SUITE` — each suite builds, deploys and launches an app, so running both is
several minutes.

```
$env:UWP_TEST_SUITE = "hotreload"   # or "debug"
npm run test:vscode
```

**`hotreload.test.js`** is the one that matters for XAML reload: it runs `uwp.run`, edits
`MainPage.xaml` *through the editor API* so the change arrives as the same
`onDidSaveTextDocument` event a person's keystrokes produce, saves, and asserts the tap
reported `OK`. It restores the file afterwards — leaving a marker in it would become the next
run's baseline.

This suite exists because `hotReload.ts` only runs inside an extension host, so the headless
loop cannot reach it. Everything it depends on is asserted headlessly; the wiring between a
save and those pieces is what this covers, and that is where every bug in the feature has
been. **Do not debug hot reload by asking a human to edit a file** — run this instead.

## The debug handoff: `npm run test:vscode`

Runs a real VS Code with the extension loaded and the suite in `test/suite/` inside its
extension host. This is the only way to cover the debug handoff, because the engine must be
started by VS Code through `vscode.debug.startDebugging` — driving `vsdbg` from a script is
not licensed, even to check compatibility.

It measures **each engine separately** (`coreclr`, then `cppvsdbg`) and prints session
started / breakpoint bound / debuggee stopped for each. Only a total failure — no engine
starting any session — fails the run: which engine binds symbols inside an AppContainer is a
measurement, and failing on it would turn a finding into a broken build.

**It takes longer than a foreground command may be allowed to run.** Each engine case is a
build, deploy, launch and attach; three cases plus warmup runs past ten minutes, and a
harness that kills the command at that point produces `exit -1` with no results and looks
exactly like a crash. Run it in the background, and read
`.vscode-test/engine-results.json` — the suite writes that after **every** case, so a run
that dies half way still leaves the results it did get.

Four things this cost time to get right, three of them environmental:

- **`ELECTRON_RUN_AS_NODE` is inherited** when running from inside VS Code's terminal or
  extension host. The launched VS Code then starts as plain Node and dies with "Cannot find
  module <workspace>". `runTest.js` scrubs it and every `VSCODE_*` variable.
- **Do not pass a local `Code.exe`** as `vscodeExecutablePath`; it triggers the same node-mode
  launch. Let test-electron download and cache its own, and point `--extensions-dir` at the
  real one so the installed engines are still loaded.
- **CLI flags need `--name=value`.** As separate array entries VS Code consumes the next token
  as the value and then treats the workspace path as a module.

The extension exports `getLog()` from `activate` purely so the suite can read its diagnostics;
an `OutputChannel` is write-only through the API, so without it a failure reports the symptom
and hides the reason.

## Verifying the extension inside VS Code

The harness covers everything except the VS Code UI and the debug handoff. For those, open
`extension/` in VS Code and press F5 — `extension/.vscode/launch.json` opens an Extension
Development Host with the repo as its workspace, so the sample and its
`.vscode/launch.json` are already there. In that window, press F5 again to exercise the
`uwp` debug type end to end.

Only worth doing for changes to `extension.ts`, `tasks.ts` or `debug.ts`; anything in
`core/` is better tested headless.

**Debug engines are never invoked directly.** The handoff goes through
`vscode.debug.startDebugging`, so the engine runs under the user's own installation.
Microsoft's `vsdbg`/`cppvsdbg` is licensed for use with Microsoft-provided tooling only —
do not spawn it from a harness, a script, or the extension, even to test compatibility.
That constraint is why the debug handoff cannot be covered by the headless loop.

## Where debugging stands

**`cppvsdbg` attaches to a UWP AppContainer** — measured, session starts, held app resumes,
cleanup runs. It binds no C# breakpoints, which is correct: it is a native engine and the
sample is managed.

**ReSharper's `coreclr` adapter does not register** in the test profile — "Couldn't find a
debug adapter descriptor" despite the extension reporting `already active`. The suite uses a
throwaway `--user-data-dir`, so ReSharper has no first-run state; this may be the profile
rather than UWP. Before concluding anything, check whether ReSharper's own
`resharper.debugger.attach.coreclr` command works in an ordinary VS Code window.

So managed UWP debugging is still unproven, and it is the last thing standing between this
and the north star's first half.
