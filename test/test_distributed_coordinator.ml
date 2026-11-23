(* @archlint.module test
   @archlint.domain distributed-coordinator *)
open Onton_core

[@@@warning "-4-40-42"]

let binary name fallback =
  match Sys.getenv_opt name with
  | Some path -> Unix.realpath path
  | None -> (
      match Sys.getenv_opt fallback with
      | Some path -> Unix.realpath path
      | None -> failwith ("missing " ^ fallback))

let python_exe () =
  let candidates =
    if String.equal Stdlib.Sys.os_type "Win32" then [ "python"; "python3"; "py" ]
    else [ "python3"; "python" ]
  in
  let rec find = function
    | [] -> "python3"
    | cmd :: rest -> (
        let probe =
          if String.equal Stdlib.Sys.os_type "Win32" then
            Printf.sprintf "where %s >NUL 2>NUL" cmd
          else Printf.sprintf "command -v %s >/dev/null 2>&1" cmd
        in
        match Stdlib.Sys.command probe with
        | 0 -> cmd
        | _ -> find rest)
  in
  find candidates

let () =
  if String.equal Stdlib.Sys.os_type "Win32" then (
    print_endline
      "SKIP: distributed coordinator process fixture requires Unix domain sockets")
  else
  let supervisor =
    match Sys.getenv_opt "ONTON_SETSID_EXEC_BINARY" with
    | Some _ as value -> value
    | None -> Sys.getenv_opt "ONTON_SETSID_EXEC"
  in
  Option.iter
    (fun path -> Unix.putenv "ONTON_SETSID_EXEC" (Unix.realpath path))
    supervisor;
  let coordinator =
    binary "ONTON_COORDINATOR_BINARY" "ONTON_COORDINATOR_BINARY_DEFAULT"
  in
  let worker = binary "ONTON_WORKER_BINARY" "ONTON_WORKER_BINARY_DEFAULT" in
  let python = python_exe () in
  let template : Pr_state.t =
    {
      pr_number = Some (Types.Pr_number.of_int 1);
      status = Open;
      is_draft = false;
      merge_state = Mergeable;
      merge_ready = true;
      merge_ready_divergence = None;
      review_decision = Some "APPROVED";
      check_status = Passing;
      ci_checks = [];
      ci_checks_truncated = false;
      comments = [];
      unresolved_comment_count = 0;
      findings = [];
      node_id = Some "fixture";
      merge_queue_required = false;
      merge_queue_entry = None;
      native_stack = false;
      head_branch = None;
      base_oid = None;
      head_oid = None;
      merge_commit_sha = None;
      base_branch = None;
      is_fork = false;
    }
  in
  let path = Filename.temp_file "onton-pr-template-" ".json" in
  Fun.protect
    ~finally:(fun () -> Sys.remove path)
    (fun () ->
      Out_channel.with_open_bin path (fun out ->
          output_string out
            (Yojson.Safe.to_string (Pr_state.yojson_of_t template)));
      let argv =
        [|
          python;
          "distributed_coordinator_fixture.py";
          "--test";
          coordinator;
          worker;
          path;
        |]
      in
      let pid =
        Unix.create_process_env python argv
          (Onton_test_support.Git_env.clean_env ())
          Unix.stdin Unix.stdout Unix.stderr
      in
      match snd (Unix.waitpid [] pid) with
      | Unix.WEXITED 0 -> ()
      | _ -> failwith "distributed process smoke failed")
