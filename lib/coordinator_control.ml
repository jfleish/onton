(* @archlint.module shell
   @archlint.domain coordinator-state *)
open Base

[@@@warning "-4"]

external peer_uid : Unix.file_descr -> int = "caml_onton_control_peer_uid"

let authorized_peer flow =
  match Eio_unix.Resource.fd_opt flow with
  | None -> false
  | Some _ when Host.is_windows -> true
  | Some fd ->
      Eio_unix.Fd.use fd ~if_closed:(fun () -> false) (fun raw ->
          Int.equal (peer_uid raw) (Unix.geteuid ()))

let handle host bytes =
  match Coordinator_state.decode_control bytes with
  | Error _ -> "rejected"
  | Ok control -> (
      match Coordinator_host.submit host (Coordinator_state.Control control) with
      | Ok (Coordinator_host.Applied [ Coordinator_state.Already_applied ]) ->
          "already_applied"
      | Ok (Coordinator_host.Applied [ Coordinator_state.Accepted ]) -> "accepted"
      | Ok (Coordinator_host.Rejected _) -> "rejected"
      | Ok _ | Error _ -> "not_accepted")

let response status = Yojson.Safe.to_string (`Assoc [ ("status", `String status) ]) ^ "\n"

let write_windows_endpoint path port token =
  let endpoint =
    Yojson.Safe.to_string
      (`Assoc
        [ ("version", `Int 1); ("transport", `String "tcp");
          ("host", `String "127.0.0.1"); ("port", `Int port);
          ("token", `String token) ])
    ^ "\n"
  in
  let channel =
    Stdlib.open_out_gen [ Open_wronly; Open_creat; Open_trunc; Open_binary ] 0o600 path
  in
  Stdlib.Fun.protect ~finally:(fun () -> Stdlib.close_out_noerr channel) (fun () ->
      Stdlib.output_string channel endpoint;
      Stdlib.flush channel)

let windows_token () = Base64.encode_string (Bytes.to_string (Host.windows_random_bytes 32))

let run_windows ~net ~path ~submit () =
  let parent = Stdlib.Filename.dirname path in
  if Stdlib.Filename.is_relative path then invalid_arg "control endpoint path must be absolute";
  (try Unix.mkdir parent 0o700 with Unix.Unix_error (Unix.EEXIST, _, _) -> ());
  if not (Host.owner_only_dir_ok parent) then
    invalid_arg "control endpoint parent must be an owner-only directory";
  let token = windows_token () in
  Stdlib.Fun.protect
    ~finally:(fun () -> try Unix.unlink path with Unix.Unix_error (Unix.ENOENT, _, _) -> ())
    (fun () ->
      Eio.Switch.run @@ fun sw ->
      let socket =
        Eio.Net.listen ~sw ~backlog:16 ~reuse_addr:true net
          (`Tcp (Eio.Net.Ipaddr.V4.loopback, 0))
      in
      let port =
        match Eio.Net.listening_addr socket with
        | `Tcp (_, port) -> port
        | _ -> failwith "control endpoint did not bind TCP"
      in
      write_windows_endpoint path port token;
      Eio.Net.run_server ~max_connections:16
        ~on_error:(fun ex ->
          Stdlib.Printf.eprintf "onton coordinator control: %s\n%!" (Exn.to_string ex))
        socket
        (fun flow _ ->
          let status =
            try
              let reader = Eio.Buf_read.of_flow ~max_size:262144 flow in
              if not (String.equal (Eio.Buf_read.line reader) token) then "unauthorized"
              else submit (Eio.Buf_read.line reader)
            with End_of_file | Eio.Buf_read.Buffer_limit_exceeded -> "rejected"
          in
          Eio.Flow.copy_string (response status) flow))

let run ~net ~path ~submit () =
  if Host.is_windows then run_windows ~net ~path ~submit ()
  else (
    if Stdlib.Filename.is_relative path then invalid_arg "control socket path must be absolute";
    let parent = Stdlib.Filename.dirname path in
    (try Unix.mkdir parent 0o700 with Unix.Unix_error (Unix.EEXIST, _, _) -> ());
    if not (Host.owner_only_dir_ok parent) then
      invalid_arg "control socket parent must be an owner-only directory";
    let bound = ref false in
    Stdlib.Fun.protect
      ~finally:(fun () ->
        if !bound then
          try Unix.unlink path with Unix.Unix_error (Unix.ENOENT, _, _) -> ())
      (fun () ->
        Eio.Switch.run @@ fun sw ->
        let socket = Eio.Net.listen ~sw ~backlog:16 ~reuse_addr:true net (`Unix path) in
        bound := true;
        Unix.chmod path 0o600;
        Eio.Net.run_server ~max_connections:16
          ~on_error:(fun ex ->
            Stdlib.Printf.eprintf "onton coordinator control: %s\n%!" (Exn.to_string ex))
          socket
          (fun flow _ ->
            let status =
              if not (authorized_peer flow) then "unauthorized"
              else
                try
                  let reader = Eio.Buf_read.of_flow ~max_size:262144 flow in
                  submit (Eio.Buf_read.line reader)
                with End_of_file | Eio.Buf_read.Buffer_limit_exceeded -> "rejected"
            in
            Eio.Flow.copy_string (response status) flow)))
