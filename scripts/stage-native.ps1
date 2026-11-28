param(
  [string]$Output = (Join-Path $PSScriptRoot '..\packaging\native\win32-x64'),
  [string]$RuntimeDll = $env:ONTON_RUNTIME_DLL
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$out = [IO.Path]::GetFullPath($Output)
Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $out | Out-Null
$files = @{
  'onton.exe' = (Join-Path $root '_build\default\bin\main.exe')
  'onton-coordinator.exe' = (Join-Path $root '_build\default\bin\coordinator.exe')
  'onton-worker.exe' = (Join-Path $root '_build\default\bin\worker.exe')
  'onton-setsid-exec.exe' = (Join-Path $root '_build\default\bin\setsid_exec\main.exe')
}
foreach ($name in $files.Keys) {
  if (-not (Test-Path -LiteralPath $files[$name])) { throw "Missing native executable: $($files[$name]). Run opam exec -- dune build bin/main.exe bin/coordinator.exe bin/worker.exe bin/setsid_exec/main.exe." }
  Copy-Item -LiteralPath $files[$name] -Destination (Join-Path $out $name)
}
if (-not $RuntimeDll) {
  $candidates = @(
    (Join-Path ${env:ProgramFiles} 'Git\mingw64\bin\libgmp-10.dll'),
    (Join-Path ${env:ProgramFiles} 'PostgreSQL\18\bin\libgmp-10.dll')
  )
  $RuntimeDll = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $RuntimeDll -or -not (Test-Path -LiteralPath $RuntimeDll)) { throw 'Missing libgmp-10.dll. Pass -RuntimeDll PATH or install the MinGW runtime used by the OCaml build.' }
Copy-Item -LiteralPath $RuntimeDll -Destination (Join-Path $out 'libgmp-10.dll')
$manifest = Get-ChildItem -LiteralPath $out -File | Sort-Object Name | ForEach-Object {
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
  [ordered]@{ name = $_.Name; bytes = $_.Length; sha256 = $hash }
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $out 'manifest.json') -Encoding utf8
Write-Output "Staged $($manifest.Count) native files in $out"
