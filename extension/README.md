# UWP Tools for VS Code

Build, deploy, debug and XAML-hot-reload UWP apps from VS Code.

Press F5: the app builds, deploys and starts under a debugger that hits breakpoints from
`OnLaunched` onward. Edit a XAML file, save, and the change appears in the running app without
a restart.

This extension deliberately provides **no** C#/XAML language services. Use ReSharper or the C#
extension for those. What it owns is the Windows app-model plumbing nothing else implements:
appx packaging, package registration, launch-under-debugger, and XAML hot reload.

## Commands

| Command | What it does |
| --- | --- |
| **UWP: Check Prerequisites (Doctor)** | Verifies everything needed, with a fix for each problem |
| **UWP: Build, Deploy and Run** | Builds, deploys and starts the app with hot reload attached |
| **UWP: Build, Deploy and Debug** | The same, under a debugger, held from the first instruction |
| **UWP: Refresh XAML Hot Reload** | Re-reads the visual tree after the app has navigated |
| **UWP: Terminate Running App** | Stops it |

F5 works too: add a `uwp` configuration to `launch.json`, or pick **UWP: Launch** from the Run
and Debug dropdown.

## Requirements

Run **UWP: Check Prerequisites** first — it reports each of these and how to fix it.

- **Visual Studio with the UWP workload.** Build Tools is enough; the workload is not optional.
- **Developer Mode.** Without it, deployment fails at the very last step with `0x80073CFF`.
- **A debug engine**, for debugging: ReSharper or the C# extension for C#, the C/C++ extension
  for C++/WinRT. Any installed engine is used; none is bundled.

Nothing else. `uwplaunch.exe` ships self-contained, so no .NET runtime is required.

## The one thing that will catch you out

Classic UWP projects set `<DebugType>full</DebugType>` for Debug by default. That emits a
**Windows PDB**, and the .NET debugger reads only **portable** PDBs — so it attaches
perfectly, loads every module, and binds no breakpoints, with one line in the debug console as
the only clue.

Set `<DebugType>portable</DebugType>` in the Debug configuration. The extension detects this
and warns before building.

## What XAML hot reload covers

Property changes on existing elements, applied to the live visual tree. Adding or removing
elements, and retyping one, need a rebuild — the extension says so rather than applying a
partial change.

Only **Debug** configurations can be debugged at all: Release uses the .NET Native toolchain,
which no managed debugger can attach to.

## Reporting a problem

Run this and attach the file it writes:

```powershell
cd extension
npm run diagnostics
```

It produces `uwp-tools-diagnostics.txt` containing everything needed to work out what
happened, so a report is one file rather than a conversation. **It contains file paths, which
include your user name — read it before attaching it to a public issue.**

If you cannot run it, the single most useful artefact is the log:
`%LOCALAPPDATA%\Temp\uwp-tools\extension.log`.

Please also say **what you did** (which command, or F5), **what you expected**, and **what
happened instead**. "Hot reload did nothing" and "hot reload applied the wrong value" have
completely different causes.

### What the diagnostics file contains, and what to look at

| Section | What it answers |
| --- | --- |
| Prerequisites | Whether the machine can build, deploy and debug at all. A `[MISS]` here is usually the whole story. |
| Debug engines installed | Whether anything can bind a breakpoint. None installed means no debugging, by design — nothing is bundled. |
| Extension log | The sequence of what happened, with per-stage timings and, for hot reload, **which step declined an edit and why**. |
| XAML tap state | Whether the tap loaded into the app and how many elements the live tree has. |

Two things in there are worth understanding, because they look alarming and are not:

The tap report's `elements` count is the tree **at injection**, which is routinely small — the
diagnostics endpoint appears early in XAML startup, before the app has built its page. The
`visual tree:` line below it is the current count. `elements = 2` alongside
`visual tree: 36 element(s)` is healthy; the tap republishes as the tree grows.

A hot reload edit that is *skipped* is logged with a reason, and several reasons are correct
behaviour rather than faults — a file that is not part of the app, content matching the
baseline, or a structural change that needs a rebuild. The log distinguishes these from real
failures.

## Diagnostics while working

`npm run log` follows the extension log live, which is easier than watching the Output panel
while also using the editor.
