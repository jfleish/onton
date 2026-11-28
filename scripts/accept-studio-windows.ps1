[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$Project,
  [Parameter(Mandatory = $true)][string]$Gameplan,
  [string]$Results = (Join-Path $PWD 'studio-acceptance-results')
)
$ErrorActionPreference = 'Stop'
$checks = [System.Collections.Generic.List[object]]::new()
$installRoot = Join-Path $env:TEMP "onton-studio-accept-$PID"
$userData = Join-Path $installRoot 'user-data'
$port = 9471
function Check([string]$Name, [string]$Status, [string]$Detail) { $checks.Add([ordered]@{ name = $Name; status = $Status; detail = $Detail }) }
function HashTree([string]$Path) { @(Get-ChildItem -LiteralPath $Path -Recurse -File | ForEach-Object { $h = Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256; "$($h.Hash) $($_.FullName.Substring($Path.Length))" } | Sort-Object) -join "`n" }
function Cdp([string]$Expression) {
  $target = $null
  for ($attempt = 0; $attempt -lt 30 -and -not $target; $attempt++) { try { $targets = @(Invoke-RestMethod "http://127.0.0.1:$port/json"); $target = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1 } catch {} if (-not $target) { Start-Sleep -Milliseconds 500 } }
  if (-not $target) { throw 'Chrome DevTools page target was not exposed' }
  $ws = [System.Net.WebSockets.ClientWebSocket]::new()
  $ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
  try {
    $payload = @{ id = 1; method = 'Runtime.evaluate'; params = @{ expression = $Expression; awaitPromise = $true; returnByValue = $true } } | ConvertTo-Json -Compress -Depth 8
    $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $ws.SendAsync([ArraySegment[byte]]::new($bytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    $buffer = New-Object byte[] 65536; $received = [Text.StringBuilder]::new()
    do { $part = $ws.ReceiveAsync([ArraySegment[byte]]::new($buffer), [Threading.CancellationToken]::None).GetAwaiter().GetResult(); [void]$received.Append([Text.Encoding]::UTF8.GetString($buffer, 0, $part.Count)) } while (-not $part.EndOfMessage)
    $response = $received.ToString() | ConvertFrom-Json
    if ($response.error) { throw ($response.error.message) }
    return $response.result.result.value
  } finally { $ws.Dispose() }
}
$before = HashTree $Project
if ($env:ONTON_STUDIO_CLEAN_MACHINE -eq '1') { Check 'clean-machine-isolation' 'PASS' 'Caller explicitly marked this environment as isolated' } else { Check 'clean-machine-isolation' 'SKIP' 'No isolated-machine attestation was provided; development-host results are not VM acceptance' }
try {
  if (-not (Test-Path -LiteralPath $Installer)) { throw "Installer not found: $Installer" }
  Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $userData | Out-Null
  $install = Start-Process -FilePath (Resolve-Path $Installer) -ArgumentList "/S", "/D=$installRoot" -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "Installer exited $($install.ExitCode)" }
  Check 'installer' 'PASS' "Installed to $installRoot"
  $app = Join-Path $installRoot 'Onton Studio.exe'
  $native = Join-Path $installRoot 'resources\native\win32-x64'
  foreach ($name in @('onton.exe','onton-coordinator.exe','onton-worker.exe','onton-setsid-exec.exe','libgmp-10.dll')) {
    if (Test-Path (Join-Path $native $name)) { Check "native:$name" 'PASS' 'Bundled resource present' } else { Check "native:$name" 'FAIL' 'Bundled resource missing' }
  }
  $env:ONTON_STUDIO_ENABLE_REAL = '0'; $env:ONTON_STUDIO_PROJECT = (Resolve-Path $Project).Path; Remove-Item Env:ONTON_STUDIO_ONTON -ErrorAction SilentlyContinue
  $proc = Start-Process -FilePath $app -ArgumentList "--user-data-dir=$userData", "--remote-debugging-port=$port" -PassThru
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) { try { if (Invoke-RestMethod "http://127.0.0.1:$port/json" -ErrorAction Stop) { break } } catch {} Start-Sleep -Milliseconds 500 }
  $snapshot = Cdp 'window.ontonStudio.getSnapshot()'
  if ($snapshot.dependencies.git -is [bool] -and $snapshot.dependencies.codex -is [bool] -and $snapshot.dependencies.codexAuthenticated -is [bool]) { Check 'dependency-detection' 'PASS' ($snapshot.dependencies | ConvertTo-Json -Compress) } else { Check 'dependency-detection' 'FAIL' 'Dependency status was not returned' }
  $plan = (Resolve-Path $Gameplan).Path.Replace('\','\\').Replace("'", "''")
  $validated = Cdp "window.ontonStudio.validateGameplan('$plan')"
  if (-not $validated.error -and $validated.tasks.Count -gt 0) { Check 'canonical-gameplan-validation' 'PASS' "$($validated.tasks.Count) tasks" } else { Check 'canonical-gameplan-validation' 'FAIL' ([string]$validated.error) }
  if (Test-Path (Join-Path $native 'onton.exe')) { Check 'packaged-engine-launch' 'PASS' 'Studio main process used packaged resource path' }
  else { Check 'packaged-engine-launch' 'FAIL' 'Packaged resource path unavailable' }
} catch { Check 'acceptance-execution' 'FAIL' $_.Exception.Message }
finally {
  Get-Process | Where-Object { $_.Path -eq $app } | Stop-Process -Force -ErrorAction SilentlyContinue
  $uninstaller = Join-Path $installRoot 'Uninstall Onton Studio.exe'
  if (Test-Path $uninstaller) { $u = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru; if ($u.ExitCode -eq 0) { Check 'uninstall' 'PASS' 'Silent uninstaller completed' } else { Check 'uninstall' 'FAIL' "Uninstaller exited $($u.ExitCode)" } } else { Check 'uninstall' 'SKIP' 'Uninstaller not found' }
  $after = HashTree $Project
  if ($before -eq $after) { Check 'repository-preservation' 'PASS' 'Repository SHA-256 inventory unchanged' } else { Check 'repository-preservation' 'FAIL' 'Repository content changed' }
  Remove-Item Env:ONTON_STUDIO_ENABLE_REAL -ErrorAction SilentlyContinue; Remove-Item Env:ONTON_STUDIO_PROJECT -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $Results | Out-Null
  $checks | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Results 'results.json') -Encoding utf8
  $checks | Format-Table -AutoSize | Out-File (Join-Path $Results 'results.txt')
  Write-Output ($checks | ConvertTo-Json -Depth 8)
}
