# codeUwp — UWP Tools for VS Code

A VS Code extension to build, deploy, debug and XAML-hot-reload UWP apps, so UWP work can
happen in VS Code instead of Visual Studio.

**North star:** press F5, the app builds, deploys and starts under a debugger that hits
breakpoints from `OnLaunched` onward; edit a XAML file, save, and the change appears in the
running app without a restart.

Language services are explicitly **not** in scope — ReSharper (or C# Dev Kit) owns C#
completion, refactoring and debugging. This extension owns the Windows app-model plumbing
nothing else implements: appx packaging, registration, launch-under-debugger, hot reload.

## Layout

| Path | What |
| --- | --- |
| `extension/` | The VS Code extension (TypeScript) |
| `src/UwpLaunch/` | `uwplaunch.exe` — the C# app-model helper. All COM lives here, never in the extension host |
| `native/XamlTap/` | The XAML Diagnostics provider DLL, injected into the app. C++, built by `build.ps1` |
| `extension/src/core/` | All logic, **free of any `vscode` import** so it runs headless |
| `extension/scripts/` | Test and dev-loop harnesses |
| `samples/ClassicUwpWinUI2/` | Classic UWP + WinUI 2 test app |
| `tools/` | PowerShell prototypes of things that will become extension features |
| `PLAN.md` | Implementation plan. Local-only — excluded via `.git/info/exclude`, do not commit |

## The one command

```
cd extension && npm run check
```

Compiles, runs the problem-matcher tests, then the full end-to-end loop: discover → build →
deploy → launch → verify running → terminate. Exit code 0 means the whole thing works on
this machine. Use it after any change; it is fast enough (~30s) that there is no reason not
to. See the `uwp-dev-loop` skill.

## Rules that matter here

**Keep `src/core/` free of `vscode` imports.** It is what lets the harnesses run the real
code headless. Anything needing the VS Code API goes in `extension.ts` or `tasks.ts`.

**Never hand-parse a csproj.** Real values come from imported targets, `Directory.Build.props`
and Configuration/Platform conditions. Use `core/msbuild.ts` `evaluate()`, which shells out to
MSBuild `-getProperty`/`-getItem`. Text matching is only acceptable as a cheap pre-filter for
deciding whether a file is worth evaluating (`looksLikeUwp`).

**Test problem matchers, never eyeball them.** A regex that fails to match produces no
diagnostics *and* no error — indistinguishable from a clean build. `npm test` asserts them
against captured MSBuild output.

**Comment the why, not the what.** Most of the hard-won knowledge in this repo is about
undocumented Windows behaviour. When you work one out, write it where the code depends on it.

## Toolchain on this machine

- MSBuild: VS Community 2026 (`...\18\Community\MSBuild\Current\Bin\MSBuild.exe`) — the only
  install with the UWP workload. Always discover via vswhere `-requires`, never `-latest`.
- Windows SDK 10.0.28000.0; .NET SDK 10.0.400; Node 24 LTS at `C:\Users\thinh\tools\`.
- Developer Mode: on. Required, and its absence surfaces late and confusingly.
- **Debugging Tools for Windows: not installed.** No `cdb.exe`/`plmdebug.exe`. Blocks the
  C++/WinRT debugging spike only. Comes from the standalone Windows SDK installer, not the VS
  installer. Probe for the executables — the `Debuggers` folder exists without them.

## Deployment facts that cost real time to learn

1. **`msbuild -t:Build` does not produce a registrable layout.** The `AppxManifest.xml` left
   in `bin\<plat>\<cfg>\` looks like one and registers without complaint, then the app dies
   during CLR startup with `0xe0434352`, no managed stack, nothing catchable in code. The real
   package has an `entrypoint\` folder, a `WinMetadata\` folder and `ucrtbased.dll`. Let the
   build produce its `.msix` and `makeappx unpack` it.
2. **Stop the running app before installing dependencies.** A live instance holds its
   framework packages open; installing them fails `0x80073D02` naming the *app*, which reads
   like a problem with what you are deploying.
3. **Install every dependency up front.** Registration names only one missing framework per
   attempt, so reacting to errors costs a round trip each.
4. **`0x80073D06` is success.** "A higher version is already installed" means satisfied.
   Failing on it breaks every up-to-date machine.
5. **`Add-AppxPackage -Register` silently no-ops** when the same identity+version is already
   registered from a different layout — and reports success. Unregister first.
6. **UWP has no AnyCPU.** Platform is always x86/x64/ARM64.
7. **Debug is CoreCLR, Release is .NET Native.** Only Debug can be debugged by ICorDebug at
   all; a Release UWP process loads `mrt100_app.dll` and raises no runtime-startup event.
8. **C# Edit and Continue is possible on classic UWP Debug**, and Visual Studio does it. Do
   not conclude otherwise from the runtime version: there are two mechanisms, and only one is
   unavailable. `.NET Hot Reload` (`MetadataUpdater.ApplyUpdate`) needs .NET 6+ and UWP's
   CoreCLR 2.2 ships no `MetadataUpdater`; classic EnC (Roslyn `EmitDifference` deltas applied
   through `ICorDebugModule2::ApplyChanges`) works and is what VS uses. What blocks it in VS
   Code is that `vsdbg` exposes no EnC, so delegating cannot deliver it — it would need our own
   ICorDebug engine plus a Roslyn delta pipeline. Deferred, not impossible.

## Launching and debugging

**`EnableDebugging` accepts an environment block only when a debugger command line is also
supplied.** A null debugger with any environment returns `E_INVALIDARG` regardless of
terminator format, and an empty-string command line is invalid too. Undocumented; established
by testing (`tools/Test-EnableDebugging.ps1`).

The consequence is architectural: `EnableDebugging` is the only way to get an environment
variable into an AppContainer, and XAML hot reload requires
`ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO=1` at process start — so **the resume stub is mandatory
for hot reload**, not merely a way to win the attach race.

How the launch works: register `uwplaunch.exe --resume-stub` as the package's debugger, and
the system creates the app *suspended* and runs the stub with `-p <pid> -tid <tid>` appended.
The stub reports those ids over a named pipe, waits, and resumes only when told — which is the
window in which a debugger can attach and still see the runtime start.

- The registered debugger command line is truncated around **255 characters**, silently. Keep
  `uwplaunch.exe` on a short path.
- Activating a package that already has a running instance **foregrounds the existing window
  and starts no new process**, so a from-birth launcher waits forever. Terminate first.
- Every `EnableDebugging` needs a paired `DisableDebugging`, or the package stays in debug mode
  after the window that set it has gone.
- A process suspended at its first instruction does not reliably expose `MainModule`/`Path`,
  so look it up by pid rather than by executable path.

**F5 is orchestration, not a debug adapter.** `debug.ts` is a `DebugConfigurationProvider`
that builds → deploys → launches held → calls `vscode.debug.startDebugging` with an attach
config → resumes, then cancels its own placeholder session by returning `undefined`.

**Measured, by `npm run test:vscode`:**

- **Managed debugging works.** A `coreclr` breakpoint in `App.xaml.cs` binds and is *hit* from
  birth inside a UWP AppContainer: `{"reason":"breakpoint","hitBreakpointIds":[1],"line":98}`.
  The F5 half of the north star is done.
- **`DebugType` is the trap, and it is the only one.** The classic UWP template sets `full` for
  Debug, which emits a **Windows PDB**, and vsdbg reads only **portable** PDBs. The debugger
  attaches perfectly, loads every module, and binds nothing — the sole clue is one console line
  saying the pdb "is a Windows PDB". Every existing UWP project has this default, so
  `projects.ts` evaluates `DebugType` and `debug.ts` warns before launching.
- **`cppvsdbg` also attaches** to an AppContainer, but binds no C# breakpoints: it is a native
  engine and the sample is managed. Expected, not a fault.
- **ReSharper contributes `coreclr` but never registered an adapter** — "Couldn't find a debug
  adapter descriptor" — with no JetBrains configuration directory and no backend process, i.e.
  it was never activated. The C# extension provides the same debug type and works, so
  **ReSharper is not a dependency**. `ENGINES` maps a debug type to *all* its providers and
  activates every installed one.

**Two ways to misread the protocol, both of which cost real time here:**

- A `setBreakpoints` **response** is always "pending" when attaching to a running process; the
  engine cannot know whether a breakpoint binds until the module carrying it loads.
  Verification arrives later as a **`breakpoint` event**. Reading only the response reports
  every engine as failing to bind, including ones that go on to hit the breakpoint.
- A pid is unique only while its process lives. After the app exits Windows may reuse the
  number, so killing by raw pid can kill something unrelated — confirm the process name first,
  and never use `taskkill /T`.

**Never invoke a Microsoft debug engine directly.** `vsdbg`/`cppvsdbg` are licensed for use
with Microsoft-provided tooling only. The handoff always goes through
`vscode.debug.startDebugging` so the engine runs under the user's own installation — not from
the extension, a script, or a test harness, even to check compatibility.

## XAML hot reload substrate

Proven working on classic UWP + WinUI 2: `InitializeXamlDiagnosticsEx` (exported from
Windows.UI.Xaml.dll) loads `native/XamlTap/XamlTap.dll` into the app, and the site it hands
over yields `IXamlDiagnostics`, `IVisualTreeService` **and `IVisualTreeService3`** — the last
being the one that carries `SetProperty`, `CreateInstance` and `ReplaceResource`. Asserted by
the e2e loop, so a regression fails the build.

- The endpoint name must be exactly **`VisualDiagConnection1`**, or it returns
  `ERROR_NOT_FOUND` (0x80070490) saying nothing about the name.
- The tap must match the **target's** architecture, not the injector's.
- It runs inside the AppContainer, so its directory must be granted to app containers
  (`icacls /grant *S-1-15-2-1`, the well-known SID — the name is localised). Grant **modify**,
  not read: the tap reports back by writing a file, and read-only fails at that step rather
  than at load, which is a confusing place to discover it.
- Injecting before the app's XAML tree is up also gives `ERROR_NOT_FOUND`. That is timing,
  not configuration — retry rather than reconfigure.
- `SetSite` arrives on the app's UI thread, which is the only thread XAML may be touched from.
- **`AdviseVisualTreeChange` is the enumeration mechanism**, not just a subscription: it replays
  the existing tree as `Add` notifications before returning. There is no "get the tree" call.

**Reading the tree, measured on the sample (30 elements, 8 from app markup):**

- **`SourceInfo` maps a live element back to its markup** — `ms-appx:///MainPage.xaml:45` for
  `CounterButton`. This is what `ENABLE_XAML_DIAGNOSTICS_SOURCE_INFO=1` buys, and it is what
  will let an edit in a file be aimed at an element.
- **Most of the tree is not the developer's.** Every control expands its template, so one
  `InfoBar` contributes a dozen elements from the framework's `generic.xaml`. The app's own
  markup is `ms-appx:///Page.xaml` — empty authority. A framework's is authority-qualified
  (`ms-appx://Microsoft.UI.Xaml.2.8/...`) or `ms-resource:`.
- **Names are not unique across that boundary.** The sample has two elements called `Title`:
  ours, and one inside InfoBar's template. Addressing by `x:Name` without filtering to app
  markup picks whichever came first.
