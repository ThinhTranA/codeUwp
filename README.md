# UWP Tools for VS Code

Build, deploy, debug and XAML-hot-reload UWP apps from VS Code, so UWP work can happen there
instead of in Visual Studio.

Press **F5**: the app builds, deploys and starts under a debugger that hits breakpoints from
`OnLaunched` onward. Edit a XAML file, **save**, and the change appears in the running app
without a restart.

## Install

Download the latest `.vsix` from the [**Releases page**](https://github.com/ThinhTranA/codeUwp/releases),
then:

```powershell
code --install-extension uwp-tools-0.1.0.vsix
```

Or in VS Code: **Extensions** → `…` menu → **Install from VSIX…**

There is no marketplace listing; the `.vsix` is the distribution.

## What you need

Run **UWP: Check Prerequisites (Doctor)** first — it reports each of these and how to fix it.

- **Visual Studio with the UWP workload.** Build Tools is enough. The workload is not optional.
- **Developer Mode** on. Without it, deployment fails at the very last step with `0x80073CFF`,
  after everything else has already succeeded.
- **A debug engine**, only if you want to debug: ReSharper or the C# extension for C#, the
  C/C++ extension for C++/WinRT. Whatever is installed gets used; none is bundled.

Nothing else — `uwplaunch.exe` ships self-contained, so no .NET runtime is required.

## Using it

| Command | What it does |
| --- | --- |
| **UWP: Check Prerequisites (Doctor)** | Verifies everything, with a fix for each problem |
| **UWP: Build, Deploy and Run** | Builds, deploys, starts the app with hot reload attached |
| **UWP: Build, Deploy and Debug** | The same, under a debugger, held from the first instruction |
| **UWP: Refresh XAML Hot Reload** | Re-reads the visual tree after the app has navigated |
| **UWP: Terminate Running App** | Stops it |

F5 works too — add a `uwp` configuration to `launch.json`, or pick **UWP: Launch** from the Run
and Debug dropdown.

A **🔥 XAML reload** indicator in the status bar means hot reload is attached. A ⚠ means it is
not, and its tooltip says why.

## The one thing that will catch you out

Classic UWP projects default to `<DebugType>full</DebugType>` for Debug. That emits a **Windows
PDB**, and the .NET debugger reads only **portable** PDBs — so it attaches perfectly, loads
every module, and binds no breakpoints, with a single line in the debug console as the only
clue.

```xml
<DebugType>portable</DebugType>
```

The extension detects this and warns before building. Note also that only **Debug** can be
debugged at all: Release uses the .NET Native toolchain, which no managed debugger can attach
to.

## What hot reload covers

Property changes on existing elements, applied to the live visual tree — the common case.
Adding or removing elements, and retyping one, need a rebuild; the extension says so rather
than applying a partial change that would leave the running app matching neither version.

## Reporting a problem

Run this and attach the file it writes:

```powershell
cd extension
npm run diagnostics
```

`uwp-tools-diagnostics.txt` contains the prerequisites report, the extension log and the XAML
tap state — between them enough to explain most behaviour, so a report is one file rather than
a conversation. **It contains file paths, which include your user name. Read it before
attaching to a public issue.**

If you cannot run it, the single most useful artefact is
`%LOCALAPPDATA%\Temp\uwp-tools\extension.log`.

Please also say **what you did** (which command, or F5), **what you expected**, and **what
happened instead** — "hot reload did nothing" and "hot reload applied the wrong value" have
entirely different causes.

Two things in the diagnostics look alarming and are not. The tap report's `elements` count is
the tree **at injection**, which is routinely small because the diagnostics endpoint appears
before the app has built its page; the `visual tree:` line below is the current count.
`elements = 2` beside `visual tree: 36 element(s)` is healthy. And a *skipped* hot reload edit
is logged with a reason, several of which are correct behaviour rather than faults.

## Building from source

```powershell
cd extension
npm install
npm run check        # compile, matcher tests, then the full loop: 35 assertions, ~40s
npm run devhost      # compile and open an Extension Development Host
npm run log          # follow the extension log
```

`npm run check` is the gate: exit 0 means the whole thing genuinely works on this machine —
discover, build, deploy, launch held, resume, inject the tap, apply a live XAML edit, clean up.

Two further suites run inside a real VS Code, covering the debug handoff and hot reload —
seams the headless loop cannot reach:

```powershell
$env:UWP_TEST_SUITE = "hotreload"   # or "debug"
npm run test:vscode
```

To build a package: `.\tools\Package-Extension.ps1`. To cut a release, tag it — GitHub Actions
builds the `.vsix` and attaches it:

```powershell
.\tools\New-Release.ps1 -Bump minor
git push origin v0.1.0
```

## Layout

| Path | What |
| --- | --- |
| `extension/` | The VS Code extension. `src/core/` is free of any `vscode` import so it runs headless |
| `src/UwpLaunch/` | `uwplaunch.exe` — the app-model helper. All COM lives here, never in the extension host |
| `native/XamlTap/` | The XAML Diagnostics provider injected into the running app |
| `samples/` | A classic UWP + WinUI 2 app, built to exercise the cases that break naive implementations |
| `tools/` | Build, package and release scripts |

## Scope

No C#/XAML language services — ReSharper or the C# extension own those, and effort spent there
is wasted. This owns the Windows app-model plumbing nothing else implements: appx packaging,
package registration, launch-under-debugger, and XAML hot reload.

## Known limits

- The XAML tap is **x64 only**. It loads into the target app's process and must match its
  architecture, so x86 and ARM64 apps are not covered yet.
- C++/WinRT and modern .NET UWP code paths exist but have no sample and are unverified.
- Verified on one machine so far. Toolchain discovery avoids hardcoded paths by design, but
  that is an intention rather than evidence.
