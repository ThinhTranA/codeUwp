---
name: uwp-crash-triage
description: Diagnose a UWP app that registers successfully but dies on startup, or fails to deploy. Use when the e2e loop reports "app is running - never appeared", when a packaged app exits immediately, or on any 0x8007xxxx deployment HRESULT. UWP startup failures give up nothing by inspection, so follow this order rather than guessing.
---

# UWP crash and deploy triage

A UWP app that dies on startup is unusually opaque: Windows Error Reporting records only
`0xe0434352` ("unhandled exception") with an empty stack, the WER report folder needs
elevation to read, and if the failure is before managed code the app's own logging never
runs. Guessing is expensive. Work the list in order — it is ordered by cost, and the first
two catch most cases.

## 1. Is the layout real? (catches most startup crashes)

**The most common cause, and the least obvious.** `msbuild -t:Build` does **not** produce a
registrable layout. It leaves an `AppxManifest.xml` in `bin\<plat>\<cfg>\` that looks like
one and that `Add-AppxPackage -Register` accepts without complaint — then the app dies during
CLR startup, because the real package has a different *shape*.

Check the registered install location for these:

```powershell
$p = Get-AppxPackage -Name <IdentityName>
$p.InstallLocation
Get-ChildItem $p.InstallLocation
```

A correct layout has an **`entrypoint\`** folder containing the executable, a
**`WinMetadata\`** folder, and (Debug) **`ucrtbased.dll`**. If those are missing, the
registration points at build output, not a package. Fix: let the build produce its `.msix`
and `makeappx unpack` it, which is what `core/deploy.ts` does.

## 2. Is a stale registration winning?

`Add-AppxPackage -Register` **silently does nothing** when a package of the same identity and
version is already registered from a *different* layout — and reports success. This is the
"I deployed Debug but Release keeps running" trap.

```powershell
Get-AppxPackage -Name <IdentityName> | Select-Object PackageFullName, InstallLocation
```

If `InstallLocation` is not the layout you just built, unregister and re-register.

## 3. What runtime did it load?

For a process that starts and survives long enough to inspect:

```powershell
$proc = Get-Process -Name <ExeName>
$proc.Modules | Where-Object { $_.ModuleName -match 'coreclr|mrt100' } | Select ModuleName, FileName
```

- `CoreCLR.dll` → a Debug build; managed debugging is possible.
- `mrt100_app.dll` → a **Release** (.NET Native) build. If you meant to deploy Debug, the
  registration is pointing somewhere else — go back to step 2.

## 4. Get the exception from inside the app

Only works if the failure is *after* managed code starts. The sample already has this wired
in `App.xaml.cs`: an `UnhandledException` handler plus try/catch around
`InitializeComponent()` and `OnLaunched`, writing to the app's own LocalState — the one
channel that always works from an AppContainer.

```powershell
Get-Content "$env:LOCALAPPDATA\Packages\<PackageFamilyName>\LocalState\crash.txt"
```

**No file and no LocalState folder means the crash was before managed code** — go back to
step 1, it is almost always the layout.

## 5. Event log

Confirms the shape of the failure, rarely the cause:

```powershell
Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddMinutes(-5)} -MaxEvents 20 |
  Where-Object { $_.Message -match '<AppName>' } | Select-Object TimeCreated, Id, Message | Format-List
```

`0xe0434352` is a CLR exception; `0xe06d7363` is a C++ exception, typical of a XAML startup
failure. Neither carries a usable stack.

## 6. Native debugger — last resort, and currently unavailable

`cdb.exe` / `plmdebug.exe` are **not installed on this machine** (the `Windows Kits\10\Debuggers`
folder exists but holds only `dbghelp.dll`/`dbgcore.dll`). Installing them means the
standalone Windows SDK installer's optional features, not the VS installer. Do not send
someone down this path before steps 1–4.

## Deployment HRESULTs

| Code | Means | Do |
| --- | --- | --- |
| `0x80073CFF` | Developer Mode off | Settings > System > For developers. Surfaces only *after* everything else succeeded |
| `0x80073CF3` | Missing framework dependency | Install everything in `AppPackages\...\Dependencies\<platform>\`. Only ONE is named per attempt |
| `0x80073D06` | Higher version already installed | **This is success.** Continue |
| `0x80073D02` | Resources in use | Stop the running app first, *before* installing dependencies |

## Bisecting a XAML failure

If the layout is right and it still dies before managed code, suspect markup. Remove the
WinUI 2 pieces first — `XamlControlsResources` from `App.xaml` and any `muxc:` control — then
rebuild and redeploy. That splits "the package is wrong" from "the markup is wrong" in one
step.
