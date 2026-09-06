<#
.SYNOPSIS
    Build, lay out and register a classic UWP app for the inner loop. Prototype of what the
    extension's deploy step will do.

.DESCRIPTION
    The non-obvious part is the layout. `msbuild -t:Build` does NOT produce a registrable
    package layout: it leaves an intermediate `AppxManifest.xml` in the output folder that
    looks like one and registers without complaint, but the app then dies during CLR startup
    with 0xe0434352 and no managed stack, because the real package has a different shape --
    an `entrypoint\` folder holding the actual executable, a `WinMetadata\` folder, and
    `ucrtbased.dll` for Debug builds. None of that exists in `bin\<plat>\<cfg>`.

    The `_CreatePackageLayout` target that would emit `bin\<plat>\<cfg>\AppX` is gated on
    conditions only the VS project system satisfies, so the reliable CLI route is to let the
    build produce the .msix it already knows how to produce, and unpack that into a folder.
    Unpacking is fast (it is a zip) and the result is a genuine loose layout: registered
    once, the app runs directly out of it, so later iterations only need the files refreshed
    and the app restarted -- no re-registration, no signing, no packaging.

.NOTES
    Prerequisites, all of which fail late and unhelpfully if missing:
      - Developer Mode  (else 0x80073CFF, and only after every other check has passed)
      - The framework packages under AppPackages\<name>_Test\Dependencies\<arch>\
      - VS with the UWP workload

.EXAMPLE
    .\Deploy-Uwp.ps1 -Project ..\samples\ClassicUwpWinUI2\ClassicUwpWinUI2.csproj -Launch
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $Project,
    [string] $Configuration = "Debug",
    [string] $Platform = "x64",
    [switch] $Launch,
    [switch] $SkipBuild
)

$ErrorActionPreference = "Stop"

function Find-MSBuild {
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) { throw "vswhere.exe not found; is Visual Studio installed?" }
    # The UWP workload is what matters, not the newest install: a VS without it will happily
    # start a build and then fail deep inside the XAML targets.
    $path = & $vswhere -latest -products * -requires Microsoft.VisualStudio.ComponentGroup.UWP.Support -property installationPath
    if (-not $path) { throw "No Visual Studio install with the UWP workload. Install 'Universal Windows Platform development'." }
    $msbuild = Join-Path $path "MSBuild\Current\Bin\MSBuild.exe"
    if (-not (Test-Path $msbuild)) { throw "MSBuild not found at $msbuild" }
    return $msbuild
}

function Assert-DeveloperMode {
    $key = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock"
    $on = (Test-Path $key) -and ((Get-ItemProperty $key -ErrorAction SilentlyContinue).AllowDevelopmentWithoutDevLicense -eq 1)
    if (-not $on) {
        throw "Developer Mode is off. Settings > System > For developers > Developer Mode. Without it registration fails with 0x80073CFF, but only after every other step has succeeded."
    }
}

$Project = (Resolve-Path $Project).Path
$projDir = Split-Path $Project -Parent
$projName = [System.IO.Path]::GetFileNameWithoutExtension($Project)

Assert-DeveloperMode
$msbuild = Find-MSBuild
Write-Host "msbuild: $msbuild" -ForegroundColor DarkGray

if (-not $SkipBuild) {
    Write-Host "==> build $Configuration|$Platform" -ForegroundColor Cyan
    & $msbuild $Project -t:Build `
        -p:Configuration=$Configuration -p:Platform=$Platform `
        -p:AppxBundle=Never -p:UapAppxPackageBuildMode=SideloadOnly `
        -p:AppxPackageSigningEnabled=false -v:m -nologo
    if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE." }
}

# The build writes the package under AppPackages\<name>_<ver>_<plat>_<cfg>_Test\.
$pkgRoot = Join-Path $projDir "AppPackages"
$msix = Get-ChildItem $pkgRoot -Recurse -Include "*.msix", "*.appx" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "_${Platform}_${Configuration}" } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $msix) { throw "No package found under $pkgRoot for ${Platform}|${Configuration}." }
Write-Host "package: $($msix.Name)" -ForegroundColor DarkGray

# Install every framework the build staged. Doing it up front matters: registration reports
# only ONE missing dependency per attempt, so reacting to errors costs a round trip each.
$deps = Join-Path $msix.Directory.FullName "Dependencies\$Platform"
if (Test-Path $deps) {
    Write-Host "==> framework dependencies" -ForegroundColor Cyan
    foreach ($dep in Get-ChildItem $deps -Filter "*.appx") {
        try {
            Add-AppxPackage -Path $dep.FullName -ErrorAction Stop
            Write-Host "    installed $($dep.Name)" -ForegroundColor DarkGray
        }
        catch {
            # 0x80073D06 = a higher version is already installed. That is satisfied, not failed;
            # treating it as an error would break on every up-to-date machine.
            if ($_.Exception.Message -match "0x80073D06") {
                Write-Host "    already newer: $($dep.Name)" -ForegroundColor DarkGray
            }
            else { throw }
        }
    }
}

$layout = Join-Path $projDir "bin\$Platform\$Configuration\Layout"
$makeappx = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter "makeappx.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\x64\\" } | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $makeappx) { throw "makeappx.exe not found in the Windows SDK." }

Write-Host "==> unpack to $layout" -ForegroundColor Cyan
if (Test-Path $layout) { [System.IO.Directory]::Delete($layout, $true) }
& $makeappx.FullName unpack /p $msix.FullName /d $layout /o | Out-Null
if ($LASTEXITCODE -ne 0) { throw "makeappx unpack failed with exit code $LASTEXITCODE." }

$manifest = Join-Path $layout "AppxManifest.xml"
$identity = ([xml](Get-Content $manifest)).Package.Identity.Name
$appId = ([xml](Get-Content $manifest)).Package.Applications.Application.Id

# Add-AppxPackage -Register silently does nothing when a package of the same identity and
# version is already registered from a DIFFERENT layout. That is the "I deployed Debug but
# Release keeps running" trap, and it reports success -- so unregister rather than trust it.
$existing = Get-AppxPackage -Name $identity -ErrorAction SilentlyContinue
if ($existing -and $existing.InstallLocation -ne $layout) {
    Write-Host "==> unregistering stale registration at $($existing.InstallLocation)" -ForegroundColor Yellow
    $existing | Remove-AppxPackage
}

Write-Host "==> register" -ForegroundColor Cyan
Add-AppxPackage -Register $manifest
$pkg = Get-AppxPackage -Name $identity
Write-Host "    $($pkg.PackageFullName)" -ForegroundColor Green

if ($Launch) {
    $aumid = "$($pkg.PackageFamilyName)!$appId"
    Write-Host "==> launch $aumid" -ForegroundColor Cyan
    Start-Process "explorer.exe" "shell:AppsFolder\$aumid"
}

[pscustomobject]@{
    PackageFullName   = $pkg.PackageFullName
    PackageFamilyName = $pkg.PackageFamilyName
    Aumid             = "$($pkg.PackageFamilyName)!$appId"
    Layout            = $layout
}
