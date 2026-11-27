open Base

let () =
  let argv = Sys.get_argv () in
  let repo = argv.(1) in
  let kind = argv.(2) in
  let count = if Array.length argv > 3 then Int.of_string argv.(3) else 20 in
  let max_fibers =
    if Array.length argv > 4 then Int.of_string argv.(4) else count
  in
  Eio_main.run (fun env ->
      let results = Array.create ~len:count None in
      let run i =
        let args =
          if String.equal kind "worktree" then
            [ "git"; "-C"; repo; "worktree"; "list"; "--porcelain"; "-z" ]
          else if String.equal kind "echo" then
            [ "cmd.exe"; "/d"; "/c"; "echo"; "marker" ]
          else if String.equal kind "stderr" then
            [ "cmd.exe"; "/d"; "/c"; "echo"; "warning"; "1>&2" ]
          else
            [
              "git";
              "-C";
              repo;
              "ls-remote";
              "--exit-code";
              "--refs";
              "--";
              "origin";
              "refs/heads/main";
            ]
        in
        let start = Unix.gettimeofday () in
        let code, stdout, stderr =
          Onton.Process_tree.run
            ~process_mgr:(Eio.Stdenv.process_mgr env)
            ~clock:(Eio.Stdenv.clock env)
            ~env:(Onton.Git_env.clean_env ())
            args
        in
        results.(i) <-
          Some
            (`Assoc
               [
                 ("index", `Int i);
                 ("exit_code", `Int code);
                 ( "elapsed_ms",
                   `Float ((Unix.gettimeofday () -. start) *. 1000.) );
                 ("stdout_bytes", `Int (String.length stdout));
                 ("stderr_bytes", `Int (String.length stderr));
                 ("stdout", `String stdout);
                 ("stderr", `String stderr);
               ])
      in
      Eio.Fiber.List.iter ~max_fibers run (List.init count ~f:Fn.id);
      Stdlib.print_endline
        (Yojson.Safe.to_string
           (`Assoc
              [
                ("kind", `String kind);
                ( "results",
                  `List (Array.to_list results |> List.filter_map ~f:Fn.id) );
              ])))
