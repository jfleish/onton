# Windows release validation

This is a local, non-publishing check for the Windows job in `.github/workflows/release.yml`. It builds the four release executables, stages the exact workflow ZIP payload, extracts it into a newly-created directory, and checks version, setsid, worker/coordinator usage, and the three Pi files.

Run from the repository checkout:

```powershell
# Full validation (builds the four binaries first)
powershell -ExecutionPolicy Bypass -File .\phase6c-results\release-validation\validate-release.ps1

# If native execution/build is blocked, package existing _build outputs and retain evidence
powershell -ExecutionPolicy Bypass -File .\phase6c-results\release-validation\validate-release.ps1 -SkipBuild -RuntimeDll C:\path\to\libgmp-10.dll
```

For a detached run with persistent logs, use a managed PowerShell job, for example:

```powershell
Start-Job -Name onton-release-validation -ScriptBlock {
  Set-Location C:\Users\josep\onton-windows
  powershell -NoProfile -ExecutionPolicy Bypass -File .\phase6c-results\release-validation\validate-release.ps1 *>&1 |
    Tee-Object .\phase6c-results\release-validation\detached-validation.log
}
```

The script does not edit production files, publish, push, or require a release tag. The local checkout's `bin/version.ml` is `dev`, so the default expected version is `dev`; pass `-ExpectedVersion vX.Y.Z` only when the checkout was intentionally prepared with that version. Results are written below `run-output/` (ignored/local evidence): `manifest.json`, `result.txt`, build logs, extracted ZIP, and dependency notes.

The release workflow packages the MinGW `libgmp-10.dll` beside the `.exe` files with `Compress-Archive`; this validator mirrors that layout and records the ZIP SHA-256 and timings. `dumpbin` dependency detail is recorded when available from a Visual Studio Developer PowerShell; otherwise the dependency finding is explicitly noted as unavailable.
