(* @archlint.module exempt
   @archlint.exempt-reason effect-boundary *)

type t = {
  input : Resource_client.stream_endpoint;
  output : Resource_client.stream_endpoint;
  mutable pending : string;
  monotonic_now : unit -> float;
}

let[@warning "-4"] configure_endpoints = function
  | Resource_client.Unix_fd input, Resource_client.Unix_fd output ->
      Host.set_nonblock input;
      Host.set_nonblock output
  | _ -> ()

let create ~mono_clock attachment =
  let input = Resource_client.input attachment
  and output = Resource_client.output attachment in
  configure_endpoints (input, output);
  {
    input;
    output;
    pending = "";
    monotonic_now =
      (fun () ->
        Int64.to_float (Mtime.to_uint64_ns (Eio.Time.Mono.now mono_clock))
        /. 1e9);
  }

let ready t =
  try
    String.contains t.pending '\n'
    ||
    match t.output with
    | Resource_client.Windows_handle handle ->
        Windows_process.available handle > 0
    | Resource_client.Unix_fd output ->
        let readable, _, _ = Unix.select [ output ] [] [] 0. in
        readable <> []
  with _ -> false

let max_frame = 1024 * 1024
let valid_timeout timeout = Float.is_finite timeout && timeout > 0.

let rec waiting t deadline reads writes =
  let remaining = deadline -. t.monotonic_now () in
  if remaining <= 0. then false
  else
    try
      let readable, writable, _ = Unix.select reads writes [] remaining in
      readable <> [] || writable <> []
    with Unix.Unix_error (Unix.EINTR, _, _) -> waiting t deadline reads writes

let read t ~timeout =
  if not (valid_timeout timeout) then Error "invalid stream timeout"
  else
    let deadline = t.monotonic_now () +. timeout in
    let bytes = Bytes.create 4096 in
    let rec frame () =
      match String.index_opt t.pending '\n' with
      | Some index ->
          let length = index + 1 in
          if length > max_frame then Error "oversized worker frame"
          else
            let result = String.sub t.pending 0 length in
            t.pending <- String.sub t.pending length (String.length t.pending - length);
            Ok result
      | None when String.length t.pending >= max_frame -> Error "oversized worker frame"
      | None ->
          let remaining = deadline -. t.monotonic_now () in
          if remaining <= 0. then Error "worker frame timed out"
          else
            let count =
              match t.output with
              | Resource_client.Windows_handle handle ->
                  Windows_process.read_timeout handle bytes
                    (Int.max 1 (Int.of_float (remaining *. 1000.)))
              | Resource_client.Unix_fd output ->
                  if not (waiting t deadline [ output ] []) then 0
                  else
                    (try Unix.read output bytes 0 (Bytes.length bytes)
                     with Unix.Unix_error ((Unix.EAGAIN | Unix.EWOULDBLOCK | Unix.EINTR), _, _) -> -1)
            in
            if count = 0 then Error "worker stream lost (not retirement)"
            else if count < 0 then frame ()
            else (t.pending <- t.pending ^ Bytes.sub_string bytes 0 count; frame ())
    in
    try frame () with _ -> Error "worker frame read failed"

let send t ~timeout frames =
  if not (valid_timeout timeout) then Error "invalid stream timeout"
  else if
    List.exists
      (fun frame ->
        String.length frame = 0
        || not (Char.equal frame.[String.length frame - 1] '\n')
        ||
        match String.index_opt frame '\n' with
        | Some index -> index <> String.length frame - 1
        | None -> true)
      frames
  then Error "each send item must be one newline-terminated frame"
  else
    let deadline = t.monotonic_now () +. timeout in
    let rec write frame offset =
      if offset = String.length frame then Ok ()
      else
        let remaining = deadline -. t.monotonic_now () in
        if remaining <= 0. then Error "worker send uncertain (timeout)"
        else
          match t.input with
          | Resource_client.Windows_handle handle ->
              (try
                 let count = Windows_process.write handle (String.sub frame offset (String.length frame - offset)) in
                 if count <= 0 then Error "worker send uncertain (closed)"
                 else write frame (offset + count)
               with _ -> Error "worker send uncertain (closed)")
          | Resource_client.Unix_fd input ->
              if not (waiting t deadline [] [ input ]) then Error "worker send uncertain (timeout)"
              else
                (try
                   match Unix.single_write_substring input frame offset (String.length frame - offset) with
                   | 0 -> Error "worker send uncertain (closed)"
                   | count -> write frame (offset + count)
                 with Unix.Unix_error ((Unix.EAGAIN | Unix.EWOULDBLOCK | Unix.EINTR), _, _) -> write frame offset)
    in
    List.fold_left (fun result frame -> match result with Ok () -> write frame 0 | Error _ as error -> error) (Ok ()) frames
