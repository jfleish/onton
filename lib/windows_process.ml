(** Native Windows process capture. This module is only called from the Windows
    branch of [Process_tree]; Unix keeps the existing Eio implementation. *)

external spawn_raw :
  string option -> string -> string -> int64 * int64 * int64 * int64
  = "caml_onton_spawn_windows"

external read_pipe_raw : int64 -> bytes -> int -> int -> int
  = "caml_onton_read_windows_pipe"

external wait_raw : int64 -> int = "caml_onton_wait_windows_process"
external terminate_raw : int64 -> unit = "caml_onton_terminate_windows_job"

external terminate_process_raw : int64 -> unit
  = "caml_onton_terminate_windows_process"

external close_raw : int64 -> unit = "caml_onton_close_windows_handle"

let quote_arg arg =
  if
    arg = ""
    || String.exists
         (function ' ' | '\t' | '\n' | '\011' | '"' -> true | _ -> false)
         arg
  then Filename.quote arg
  else arg

let command_line args = String.concat " " (List.map quote_arg args)

let env_block env =
  Array.iter
    (fun entry ->
      if entry = "" || String.contains entry '\000' then
        invalid_arg "Windows process environment contains an invalid entry")
    env;
  String.concat "\000" (Array.to_list env) ^ "\000\000"

type handles = { process : int64; job : int64; stdout : int64; stderr : int64 }

let spawn ?cwd ~env args =
  let cwd = Option.map Eio.Path.native_exn cwd in
  let process, job, stdout, stderr =
    spawn_raw cwd (env_block env) (command_line args)
  in
  { process; job; stdout; stderr }

let read handle bytes =
  Eio_unix.run_in_systhread (fun () ->
      read_pipe_raw handle bytes 0 (Bytes.length bytes))

let wait handle = Eio_unix.run_in_systhread (fun () -> wait_raw handle)

let terminate handle =
  Eio_unix.run_in_systhread (fun () -> terminate_raw handle)

let terminate_process handle =
  Eio_unix.run_in_systhread (fun () -> terminate_process_raw handle)

let close handle = Eio_unix.run_in_systhread (fun () -> close_raw handle)
let process t = t.process
let job t = t.job
let stdout t = t.stdout
let stderr t = t.stderr
