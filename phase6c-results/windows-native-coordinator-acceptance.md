# Windows coordinator/control acceptance

## Root cause

Windows streaming attachments were previously created with Unix pipes and `Unix.create_process_env`; the fixture relay also attempted to use Windows-incompatible selector polling on process pipes. Both paths could close the coordinator stream and produce `Host_lost("host disconnected")`.

The transport fix uses the existing native `CreateProcessW` backend with explicit bidirectional stdin/stdout/stderr handles and Job Object cleanup. Unix behavior remains unchanged.

## Windows control transport

The coordinator control endpoint now uses an authenticated loopback TCP listener on Windows while retaining Unix-domain sockets on Unix:

- endpoint metadata is written to the requested control path
- metadata contains loopback host, ephemeral port, and a per-process random token
- each connection must send the token as the first newline-delimited frame
- the existing JSONL request/response protocol follows the token frame
- invalid tokens receive `unauthorized`
- endpoint metadata is removed on shutdown
- no unauthenticated TCP listener is exposed

## Acceptance result

`windows-control-e2e-final.log` passes against the real built coordinator, worker, native supervisor, disposable Git repositories/worktrees, and fixture backend.

Verified:

- two concurrent workers remain connected
- authenticated control connection
- invalid token rejection
- JSONL framing
- guidance deduplication
- cancellation request delivery
- coordinator/process cleanup
- previous Windows native-pipe worker acceptance remains covered by `windows-coordinator-e2e-fixed-final.log`

No external forge, push, merge, or non-temporary repository was touched.

## Studio gate

Studio real execution is guarded by `ONTON_STUDIO_ENABLE_REAL=1`, remains disabled by default, and uses the main-process-only child-process boundary. Approvals and forge mutations remain disabled in the renderer.
