# Windows coordinator acceptance

Date: local validation on `studio-development`

## Attempt

The existing `test/distributed_coordinator_fixture.py` was exercised against the real built `onton-coordinator.exe`, `onton-worker.exe`, and the real Windows process supervisor. The fixture was first run unchanged and failed before coordinator startup because it hard-codes Unix `/tmp` paths and Unix-domain socket server classes.

A disposable, uncommitted portability experiment replaced those assumptions with temporary Windows paths, TCP localhost transport, `.cmd` Python helpers, Windows process termination, and a threaded stdio relay. It reached the real coordinator and launched worker resources, but the workers terminated with `Onton.Worker.Host_lost("host disconnected")`; no backend start events or Git publications were accepted. The experiment was discarded and did not alter production code or the committed Unix fixture.

The last failure is recorded in `windows-coordinator-e2e-attempt-9.log`. The coordinator was run with `ONTON_SETSID_EXEC` pointing at the built Windows supervisor and with a disposable local Git remote. No external forge, push, merge, or repository outside the temporary directory was touched.

## Blocker

The fixture transport is not yet a validated Windows equivalent. The coordinator's resource-helper stream loses the worker protocol connection under the Windows helper relay, producing `worker send uncertain (closed)` and worker `Host_lost`. Until that transport is isolated and fixed, real coordinator-to-worker-to-Codex acceptance is **not passed**.

## Safe conclusion

Studio real execution remains disabled. The existing local adapter, project discovery, gameplan parsing, persisted local lifecycle, and simulated cancellation remain the only enabled execution path.
