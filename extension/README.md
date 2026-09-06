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

## Diagnostics

The extension logs to its **UWP Tools** output channel and to
`%LOCALAPPDATA%\Temp\uwp-tools\extension.log`. When hot reload declines an edit it says which
step declined it and why, so that log is usually enough to explain any behaviour.
