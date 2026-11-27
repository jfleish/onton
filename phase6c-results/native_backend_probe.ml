let () =
  Eio_main.run @@ fun env ->
  let process_mgr = Eio.Stdenv.process_mgr env in
  let clock = Eio.Stdenv.clock env in
  let timed_out =
    match
      Eio.Time.with_timeout clock 0.25 (fun () ->
          Ok
            (Onton.Process_tree.run ~process_mgr ~clock ~env:(Unix.environment ())
               [ "cmd.exe"; "/d"; "/c"; "ping"; "-n"; "10"; "127.0.0.1" ]))
    with
    | Ok _ -> false
    | Error `Timeout -> true
  in
  let code, _, _ =
    Onton.Process_tree.run ~process_mgr ~clock ~env:(Unix.environment ())
      [ "cmd.exe"; "/d"; "/c"; "exit"; "7" ]
  in
  Printf.printf "timed_out=%b failure_code=%d\n%!" timed_out code
