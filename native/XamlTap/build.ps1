<#
.SYNOPSIS
    Builds the XAML Diagnostics tap DLL.

.DESCRIPTION
    A direct cl.exe invocation rather than a .vcxproj: this is one translation unit with no
    project system worth carrying, and it keeps the build callable from npm without MSBuild
    in the way.

    Architecture is not cosmetic. The tap is loaded into the target app's process, so it must
    match the TARGET's architecture -- an x64 tap for an x64 app, even when the host doing the
    injecting is something else.
#>
[CmdletBinding()]
param(
    [ValidateSet("x64", "x86", "arm64")]
    [string] $Platform = "x64",
    [string] $Configuration = "Release"
)

$ErrorActionPreference = "Stop"

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) { throw "No Visual Studio install with the C++ toolset was found." }

$vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvarsall.bat"
if (-not (Test-Path $vcvars)) { throw "vcvarsall.bat not found at $vcvars" }

$here = $PSScriptRoot
$outDir = Join-Path $here "bin\$Platform"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$optimisation = if ($Configuration -eq "Debug") { "/Od /Zi" } else { "/O2" }

# vcvarsall must run in the same shell as cl.exe, so the whole thing goes through cmd. The
# INCLUDE and LIB it sets up are what pull in xamlOM.h and the SDK import libraries.
$command = @"
call "$vcvars" $Platform >nul 2>&1
if errorlevel 1 exit /b 1
REM C++20, not 17: C++/WinRT async (IAsyncAction::get) needs coroutines, and under
REM /std:c++17 that resolves to <experimental/coroutine>, which now hard-errors.
cl.exe /nologo /LD /EHsc /std:c++20 /W4 /DUNICODE /D_UNICODE $optimisation ^
  /Fo"$outDir\\" /Fd"$outDir\\" ^
  "$here\XamlTap.cpp" ^
  /link /DEF:"$here\XamlTap.def" /OUT:"$outDir\XamlTap.dll" ^
  /IMPLIB:"$outDir\XamlTap.lib" ^
  ole32.lib oleaut32.lib runtimeobject.lib
"@

$script = Join-Path $env:TEMP "build-xamltap-$Platform.cmd"
Set-Content -Path $script -Value $command -Encoding ascii

& cmd.exe /c $script
if ($LASTEXITCODE -ne 0) { throw "cl.exe failed with exit code $LASTEXITCODE." }

$dll = Join-Path $outDir "XamlTap.dll"
if (-not (Test-Path $dll)) { throw "Build reported success but produced no DLL." }
Write-Host "built $dll" -ForegroundColor Green
Get-Item $dll | Select-Object Name, Length, LastWriteTime
