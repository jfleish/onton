(* @archlint.module test
   @archlint.domain session-meta *)

(** Tests for [Onton.Project_lock]: per-project advisory lock using
    [Unix.lockf]. Verifies contention, stale reclamation, release, and
    re-acquire semantics without spinning up Eio. *)

open Onton

let ( // ) = Filename.concat

let mktempdir prefix =
  let base = Filename.get_temp_dir_name () in
  let rec loop n =
    let dir = base // Printf.sprintf "%s-%d-%d" prefix (Unix.getpid ()) n in
    try
      Unix.mkdir dir 0o755;
      dir
    with Unix.Unix_error (Unix.EEXIST, _, _) -> loop (n + 1)
  in
  loop 0

let rm_rf = Host.rm_rf
let fail_if cond msg = if cond then failwith msg

let must_ok = function
  | Ok v -> v
  | Error (Project_lock.Held_by { pid; _ }) ->
      failwith (Printf.sprintf "expected Ok, got Held_by pid=%d" pid)
  | Error (Project_lock.Io_error s) ->
      failwith (Printf.sprintf "expected Ok, got Io_error %s" s)

let must_held_by = function
  | Error (Project_lock.Held_by { pid; _ }) -> pid
  | Ok _ -> failwith "expected Held_by, got Ok"
  | Error (Project_lock.Io_error s) ->
      failwith (Printf.sprintf "expected Held_by, got Io_error %s" s)

let on_stale_noop _pid = ()

let test_happy_path () =
  let dir = mktempdir "onton-lock-happy" in
  Fun.protect
    ~finally:(fun () -> rm_rf dir)
    (fun () ->
      let lock =
        must_ok (Project_lock.acquire ~project_dir:dir ~on_stale:on_stale_noop)
      in
      let path = dir // "onton.lock" in
      fail_if (not (Sys.file_exists path)) "lock file not created";
      let ic = open_in path in
      let content = In_channel.input_all ic in
      close_in ic;
      let pid = int_of_string (String.trim content) in
      fail_if
        (pid <> Host.os_pid ())
        (Printf.sprintf "PID mismatch: %d vs %d" pid (Host.os_pid ()));
      Project_lock.release lock)

let test_release_is_idempotent () =
  let dir = mktempdir "onton-lock-release" in
  Fun.protect
    ~finally:(fun () -> rm_rf dir)
    (fun () ->
      let lock =
        must_ok (Project_lock.acquire ~project_dir:dir ~on_stale:on_stale_noop)
      in
      Project_lock.release lock;
      Project_lock.release lock;
      (* After release, re-acquisition must succeed. *)
      let lock2 =
        must_ok (Project_lock.acquire ~project_dir:dir ~on_stale:on_stale_noop)
      in
      Project_lock.release lock2)

let holder_mode () =
  if Array.length Sys.argv = 3 && String.equal Sys.argv.(1) "--lock-holder" then (
    let dir = Sys.argv.(2) in
    let lock =
      must_ok (Project_lock.acquire ~project_dir:dir ~on_stale:on_stale_noop)
    in
    close_out (open_out (dir // "ready"));
    while not (Sys.file_exists (dir // "stop")) do
      ignore (Unix.select [] [] [] 0.01)
    done;
    Project_lock.release lock;
    true)
  else false

let spawn_holder dir =
  let argv = [| Sys.executable_name; "--lock-holder"; dir |] in
  let child =
    Unix.create_process Sys.executable_name argv Unix.stdin Unix.stdout
      Unix.stderr
  in
  let rec wait_ready attempts =
    if Sys.file_exists (dir // "ready") then ()
    else if attempts = 0 then failwith "lock holder did not become ready"
    else (
      ignore (Unix.select [] [] [] 0.01);
      wait_ready (attempts - 1))
  in
  wait_ready 500;
  child

let stop_holder dir child =
  close_out (open_out (dir // "stop"));
  ignore (Unix.waitpid [] child)

let test_contention_windows () =
  let dir = mktempdir "onton-lock-contention" in
  Fun.protect
    ~finally:(fun () -> rm_rf dir)
    (fun () ->
      let child = spawn_holder dir in
      let held_pid =
        must_held_by
          (Project_lock.acquire ~project_dir:dir ~on_stale:on_stale_noop)
      in
      fail_if
        (held_pid <> Host.spawned_pid child)
        (Printf.sprintf "held-by pid mismatch: %d vs child %d" held_pid
           (Host.spawned_pid child));
      stop_holder dir child;
      let lock =
        must_ok (Project_lock.acquire ~project_dir:dir ~on_stale:on_stale_noop)
      in
      Project_lock.release lock)

(** Fork a child that acquires the lock and pauses. The child signals readiness
    over a pipe *after* [acquire] has finished its ftruncate+write, so the
    parent never observes the file mid-write. Then the parent attempts to
    acquire and must see [Held_by child_pid]. *)
let test_contention_posix () =
  let dir = mktempdir "onton-lock-contention" in
  Fun.protect
    ~finally:(fun () -> rm_rf dir)
    (fun () ->
      (* Pipe A: child → parent "ready". Pipe B: parent → child "resume". *)
      let ready_r, ready_w = Unix.pipe () in
      let resume_r, resume_w = Unix.pipe () in
      match Unix.fork () with
      | 0 ->
          Unix.close ready_r;
          Unix.close resume_w;
          let lock =
            match
              Project_lock.acquire ~project_dir:dir ~on_stale:on_stale_noop
            with
            | Ok l -> l
            | Error _ -> exit 2
          in
          (* Signal readiness *after* acquire's ftruncate+write is done. *)
          let _ = Unix.write ready_w (Bytes.create 1) 0 1 in
          Unix.close ready_w;
          (* Block until parent closes [resume_w] (EOF on read). *)
          let buf = Bytes.create 1 in
          (try ignore (Unix.read resume_r buf 0 1) with _ -> ());
          Project_lock.release lock;
          exit 0
      | child_pid ->
          Unix.close ready_w;
          Unix.close resume_r;
          (* Deterministic wait: blocks until child writes one byte. *)
          let buf = Bytes.create 1 in
          let _ = Unix.read ready_r buf 0 1 in
          Unix.close ready_r;
          let held_pid =
            must_held_by
              (Project_lock.acquire ~project_dir:dir ~on_stale:on_stale_noop)
          in
          fail_if (held_pid <> child_pid)
            (Printf.sprintf "held-by pid mismatch: %d vs child %d" held_pid
               child_pid);
          (* Release child. *)
          Unix.close resume_w;
          let _, _ = Unix.waitpid [] child_pid in
          (* Now the parent can acquire. *)
          let lock =
            must_ok
              (Project_lock.acquire ~project_dir:dir ~on_stale:on_stale_noop)
          in
          Project_lock.release lock)

(** Crash recovery: if the previous holder died (SIGKILL), the kernel releases
    its F_TLOCK automatically — so a fresh [acquire] just succeeds. This
    verifies the practical "onton crashed, user restarts" case. The explicit
    stale-PID path in [project_lock.ml] is a defensive safety net for rarer
    cases (FD inherited across fork, dying holder with FDs still open
    elsewhere); those are difficult to reach from userspace and aren't tested.
*)
let test_crash_recovery_posix () =
  let dir = mktempdir "onton-lock-crash" in
  Fun.protect
    ~finally:(fun () -> rm_rf dir)
    (fun () ->
      let ready_r, ready_w = Unix.pipe () in
      match Unix.fork () with
      | 0 ->
          Unix.close ready_r;
          let _ =
            match
              Project_lock.acquire ~project_dir:dir ~on_stale:on_stale_noop
            with
            | Ok l -> l
            | Error _ -> exit 2
          in
          let _ = Unix.write ready_w (Bytes.create 1) 0 1 in
          Unix.close ready_w;
          (* Hang until parent kills us; never release. *)
          let rec spin () =
            ignore (Unix.select [] [] [] 10.0);
            spin ()
          in
          spin ()
      | child_pid ->
          Unix.close ready_w;
          let buf = Bytes.create 1 in
          let _ = Unix.read ready_r buf 0 1 in
          Unix.close ready_r;
          (* Simulate crash: SIGKILL. Kernel releases the lock when the FD
             is auto-closed on process death. *)
          Unix.kill child_pid Sys.sigkill;
          let _, _ = Unix.waitpid [] child_pid in
          let lock =
            must_ok
              (Project_lock.acquire ~project_dir:dir ~on_stale:on_stale_noop)
          in
          Project_lock.release lock)

let test_crash_recovery_windows () =
  let dir = mktempdir "onton-lock-crash" in
  Fun.protect
    ~finally:(fun () -> rm_rf dir)
    (fun () ->
      let child = spawn_holder dir in
      Host.stop_process (Host.spawned_pid child);
      ignore (Unix.waitpid [] child);
      let lock =
        must_ok (Project_lock.acquire ~project_dir:dir ~on_stale:on_stale_noop)
      in
      Project_lock.release lock)

let () =
  if not (holder_mode ()) then (
    test_happy_path ();
    test_release_is_idempotent ();
    if Host.is_windows then (
      test_contention_windows ();
      test_crash_recovery_windows ())
    else (
      test_contention_posix ();
      test_crash_recovery_posix ());
    print_endline "test_project_lock: OK")
