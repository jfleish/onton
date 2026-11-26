[CmdletBinding()]
param(
  [string]$RepoRoot,
  [string]$ExpectedVersion = "dev",
  [string]$RuntimeDll,
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) }
$started = Get-Date
$root = (Resolve-Path $RepoRoot).Path
$out = Join-Path $PSScriptRoot 'run-output'
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force -Path $out | Out-Null
$stage = Join-Path $out 'stage\bin'
$extract = Join-Path $out 'fresh-extract'
New-Item -ItemType Directory -Force -Path $stage,$extract | Out-Null
$timings = [ordered]@{}
$results = [ordered]@{}
function Measure-Step([string]$Name, [scriptblock]$Action) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try { & $Action; $results[$Name] = 'pass' }
  catch { $results[$Name] = 'fail: ' + $_.Exception.Message }
  finally { $sw.Stop(); $timings[$Name] = [math]::Round($sw.Elapsed.TotalSeconds, 3) }
}
function Run-Capture([string]$File, [AllowEmptyCollection()][string[]]$Arguments, [string]$Stdout, [string]$Stderr) {
  $argumentList = @($Arguments | Where-Object { $null -ne $_ })
  Push-Location $root
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $File @argumentList 1> $Stdout 2> $Stderr
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
    Pop-Location
  }
}
Measure-Step 'build' {
  if ($SkipBuild) { throw 'skipped by -SkipBuild (native build was attempted separately; see README)' }
  $buildOut = Join-Path $out 'build.stdout.log'; $buildErr = Join-Path $out 'build.stderr.log'
  $dune = Join-Path $root '_opam\bin\dune.exe'
  if (!(Test-Path $dune)) { throw "dune executable missing: $dune" }
  $code = Run-Capture $dune @('build','bin/main.exe','bin/coordinator.exe','bin/worker.exe','bin/setsid_exec/main.exe') $buildOut $buildErr
  if ($code -ne 0) { throw "dune build exit $code; see $buildErr" }
}
if ([string]::IsNullOrWhiteSpace($RuntimeDll)) {
  $gcc = Get-Command x86_64-w64-mingw32-gcc.exe -ErrorAction SilentlyContinue
  if ($gcc) {
    $cygwinRoot = Split-Path (Split-Path $gcc.Source -Parent) -Parent
    $found = Get-ChildItem -Path $cygwinRoot -Recurse -File -Filter libgmp-10.dll -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $RuntimeDll = $found.FullName }
  }
}
if ([string]::IsNullOrWhiteSpace($RuntimeDll) -or !(Test-Path $RuntimeDll)) { throw 'Required runtime DLL not found; pass -RuntimeDll libgmp-10.dll' }
$files = @(
  @{ Source='_build\default\bin\main.exe'; Dest='onton.exe' },
  @{ Source='_build\default\bin\worker.exe'; Dest='onton-worker.exe' },
  @{ Source='_build\default\bin\coordinator.exe'; Dest='onton-coordinator.exe' },
  @{ Source='_build\default\bin\setsid_exec\main.exe'; Dest='onton-setsid-exec.exe' }
)
Measure-Step 'stage-binaries' {
  foreach ($f in $files) {
    $src = Join-Path $root $f.Source; if (!(Test-Path $src)) { throw "missing $src" }
    Copy-Item $src (Join-Path $stage $f.Dest)
  }
  Copy-Item $RuntimeDll (Join-Path $stage 'libgmp-10.dll')
  $pi = Join-Path $stage 'share\onton\pi-onton'; New-Item -ItemType Directory -Force $pi | Out-Null
  foreach ($name in @('index.ts','protocol.ts','files.ts')) { Copy-Item (Join-Path $root "pi-onton\src\$name") (Join-Path $pi $name) }
}
$zip = Join-Path $out 'onton-x86_64-pc-windows-gnu.zip'
Measure-Step 'package' {
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
  if (!(Test-Path $zip)) { throw 'ZIP was not created' }
}
Measure-Step 'extract-fresh' { Expand-Archive -Path $zip -DestinationPath $extract -Force }
$bin = Join-Path $extract 'onton.exe'
Measure-Step 'version' {
  $stdout = Join-Path $out 'version.stdout.log'; $stderr = Join-Path $out 'version.stderr.log'
  $code = Run-Capture $bin @('--version') (Join-Path $out 'version.stdout.log') $stderr
  $raw = if (Test-Path $stdout) { Get-Content $stdout -Raw } else { '' }
  $actual = if ($null -eq $raw) { '' } else { $raw.Trim() }
  if ($code -ne 0 -or $actual -ne $ExpectedVersion) { throw "version: exit=$code output='$actual' expected='$ExpectedVersion'" }
}
Measure-Step 'setsid' {
  $code = Run-Capture (Join-Path $extract 'onton-setsid-exec.exe') @('cmd.exe','/c','exit','0') (Join-Path $out 'setsid.stdout.log') (Join-Path $out 'setsid.stderr.log')
  if ($code -ne 0) { throw "setsid exit $code" }
}
Measure-Step 'worker-usage' {
  $code = Run-Capture (Join-Path $extract 'onton-worker.exe') @() (Join-Path $out 'worker.stdout.log') (Join-Path $out 'worker.stderr.log')
  $usage = Get-Content (Join-Path $out 'worker.stderr.log') -Raw
  if ($code -ne 2 -or $usage -notmatch 'Usage: onton-worker') { throw "worker usage: exit=$code" }
}
Measure-Step 'coordinator-usage' {
  $code = Run-Capture (Join-Path $extract 'onton-coordinator.exe') @() (Join-Path $out 'coordinator.stdout.log') (Join-Path $out 'coordinator.stderr.log')
  $usage = Get-Content (Join-Path $out 'coordinator.stderr.log') -Raw
  if ($code -ne 2 -or $usage -notmatch 'Usage: onton-coordinator') { throw "coordinator usage: exit=$code" }
}
Measure-Step 'pi-files' {
  $expected = @('index.ts','protocol.ts','files.ts') | ForEach-Object { "share/onton/pi-onton/$_" }
  $actual = Get-ChildItem (Join-Path $extract 'share\onton\pi-onton') -File | ForEach-Object { "share/onton/pi-onton/$($_.Name)" }
  if ((Compare-Object ($expected | Sort-Object) ($actual | Sort-Object))) { throw "Pi file set mismatch" }
}
$deps = Join-Path $out 'runtime-dependencies.txt'
$duneVersion = & (Join-Path $root '_opam\bin\dune.exe') --version 2>$null
@("PowerShell=$($PSVersionTable.PSVersion)", "OS=$([Environment]::OSVersion.VersionString)", "Dune=$duneVersion") | Set-Content $deps
foreach ($tool in @('dumpbin','where.exe')) { $cmd = Get-Command $tool -ErrorAction SilentlyContinue; $source = if ($null -eq $cmd) { 'unavailable' } else { $cmd.Source }; Add-Content $deps "$tool=$source" }
Add-Content $deps 'Note: dumpbin output is recorded only when Visual Studio Developer PowerShell exposes dumpbin.'
$manifest = [ordered]@{ started=$started.ToString('o'); finished=(Get-Date).ToString('o'); repo=$root; expectedVersion=$ExpectedVersion; zip=$zip; zipSha256=(Get-FileHash $zip -Algorithm SHA256).Hash; zipBytes=(Get-Item $zip).Length; results=$results; timingsSeconds=$timings; contents=(Get-ChildItem $extract -File -Recurse | ForEach-Object { $_.FullName.Substring($extract.Length+1).Replace('\','/') }) }
$manifest | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $out 'manifest.json')
$results.GetEnumerator() | ForEach-Object { "{0}: {1}" -f $_.Key,$_.Value } | Set-Content (Join-Path $out 'result.txt')
Write-Host "Validation complete: $out"
