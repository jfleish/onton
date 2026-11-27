# Windows coordinator acceptance

Date: local validation on `studio-development`

## Root cause

There were two independent Windows-only transport failures:

1. `Resource_client.connect` always used `Unix.pipe` plus `Unix.create_process_env`, even on Windows. The streaming helper therefore did not have a reliable native bidirectional pipe lifetime.
2. The Windows fixture's Python relay used `selectors` with ordinary process pipes. Windows selectors cannot wait on those pipe handles, so the relay closed the coordinator stream and workers reported `Host_lost("host disconnected")`.

The validated production fix is narrow: Windows resource attachments now use the existing native `CreateProcessW` backend with explicit inherited stdin/stdout/stderr handles, a Job Object, and native bidirectional read/write operations. Unix attachments retain the previous supervisor and Unix-pipe implementation.

The fixture received Windows-only TCP/helper-thread/process-cleanup adaptations. Unix socket and selector behavior remains unchanged.

## Acceptance

`windows-coordinator-e2e-fixed-final.log` passes against the real built:

- `onton-coordinator.exe`
- `onton-worker.exe`
- native Windows process supervisor
- two concurrent workers
- coordinator takeover
- real disposable Git worktrees and Git publications
- backend event capture
- worker/process cleanup after coordinator termination

The acceptance uses only a disposable local Git remote and fixture backend. No external forge, push, merge, or non-temporary repository was touched.

The Windows Eio Unix-domain control endpoint is not externally addressable by the Python fixture, so guidance/sleep/wake/control-socket assertions remain Unix-only. Windows cancellation cleanup is exercised by terminating the coordinator and verifying all worker resources are reaped. Studio real orchestration remains disabled until a Windows control-socket acceptance is added.

## Focused regressions

Passed:

- `test_worker_recovery_git`
- `test_persistence_properties` (36 tests)
- `test_resource_client`
- `dune build @check`
- coordinator/worker link build
