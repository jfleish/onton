(* @archlint.module exempt
   @archlint.exempt-reason effect-boundary *)

(* Host-platform helpers. Everything here reads the process environment or
   the platform name; decision logic that consumes these values lives in the
   calling handler. Windows names its per-user directories differently from
   the XDG layout, so callers must not build paths from [HOME] directly. *)

open Base

let is_windows = String.equal Stdlib.Sys.os_type "Win32"
let exe name = if is_windows then name ^ ".exe" else name

external process_alive : int -> bool = "caml_onton_process_alive"
external terminate_process : int -> unit = "caml_onton_terminate_process"
external attach_job : int -> bool = "caml_onton_attach_job"
external terminate_job : int -> unit = "caml_onton_terminate_job"
external close_job : int -> unit = "caml_onton_close_job"

(** Hard-stop [pid]. POSIX sends SIGTERM so the target can clean up; Windows
    terminates it, which also tears down any Job Object it owns. *)
let stop_process pid = if pid > 0 then try terminate_process pid with _ -> ()

let nonempty = function
  | Some value when not (String.is_empty value) -> Some value
  | Some _ | None -> None

let getenv_nonempty name = nonempty (Stdlib.Sys.getenv_opt name)

(** The user's home directory. On Windows [HOME] is usually absent outside POSIX
    shells, so fall back to [USERPROFILE] and then [HOMEDRIVE] + [HOMEPATH]. *)
let home_dir () =
  match getenv_nonempty "HOME" with
  | Some home -> Some home
  | None -> (
      match getenv_nonempty "USERPROFILE" with
      | Some home -> Some home
      | None -> (
          match (getenv_nonempty "HOMEDRIVE", getenv_nonempty "HOMEPATH") with
          | Some drive, Some rest -> Some (drive ^ rest)
          | _ -> None))

let home_dir_or_cwd () = Option.value (home_dir ()) ~default:"."
let null_device = if is_windows then "NUL" else "/dev/null"

(** [Unix.set_nonblock] only accepts sockets on Windows. Pipes are polled with
    [Unix.select], and a Windows pipe read after readability returns the
    available bytes, so failing to switch the handle is harmless. *)
let set_nonblock fd = try Unix.set_nonblock fd with Unix.Unix_error _ -> ()

(** Base directory for onton's durable state. Windows uses
    [%LOCALAPPDATA%\\onton]; POSIX keeps the XDG layout. *)
let data_dir () =
  match getenv_nonempty "ONTON_DATA_DIR" with
  | Some dir -> dir
  | None -> (
      match getenv_nonempty "XDG_DATA_HOME" with
      | Some xdg -> Stdlib.Filename.concat xdg "onton"
      | None -> (
          match (is_windows, getenv_nonempty "LOCALAPPDATA") with
          | true, Some local -> Stdlib.Filename.concat local "onton"
          | _ ->
              Stdlib.Filename.concat
                (Stdlib.Filename.concat (home_dir_or_cwd ()) ".local/share")
                "onton"))

(** Whether [path] is a directory only the current user can access. Windows does
    not expose POSIX owner/mode bits through [Unix.stat]; the directory inherits
    the (user-private) ACL of its parent under [%LOCALAPPDATA%], so only the
    directory-kind check is meaningful there. *)
let owner_only_dir_ok path =
  let stat = Unix.lstat path in
  Poly.equal stat.Unix.st_kind Unix.S_DIR
  &&
  if is_windows then true
  else stat.Unix.st_uid = Unix.geteuid () && stat.Unix.st_perm land 0o077 = 0

(** Base directory for user configuration. Windows uses [%APPDATA%\\onton];
    POSIX keeps the XDG layout. *)
let windows_command args =
  if not is_windows then args
  else
    match args with
    | [] -> []
    | command :: rest -> (
        let candidates =
          if
            String.is_suffix command ~suffix:".cmd"
            || String.is_suffix command ~suffix:".bat"
            || String.is_suffix command ~suffix:".exe"
          then [ command ]
          else [ command ^ ".exe"; command ^ ".cmd"; command ^ ".bat"; command ]
        in
        let path_dirs =
          match getenv_nonempty "PATH" with
          | None -> []
          | Some path -> String.split path ~on:';'
        in
        let found =
          List.find_map candidates ~f:(fun candidate ->
              if String.contains candidate '\\' || String.contains candidate '/'
              then
                if Stdlib.Sys.file_exists candidate then Some candidate
                else None
              else
                List.find_map path_dirs ~f:(fun dir ->
                    let path = Stdlib.Filename.concat dir candidate in
                    if Stdlib.Sys.file_exists path then Some path else None))
        in
        match found with
        | Some path
          when String.is_suffix path ~suffix:".cmd"
               || String.is_suffix path ~suffix:".bat" ->
            "cmd.exe" :: "/d" :: "/s" :: "/c" :: path :: rest
        | Some path -> path :: rest
        | None -> args)

let config_dir () =
  match getenv_nonempty "ONTON_CONFIG_DIR" with
  | Some dir -> dir
  | None -> (
      match getenv_nonempty "XDG_CONFIG_HOME" with
      | Some xdg -> Stdlib.Filename.concat xdg "onton"
      | None -> (
          match (is_windows, getenv_nonempty "APPDATA") with
          | true, Some appdata -> Stdlib.Filename.concat appdata "onton"
          | _ ->
              Stdlib.Filename.concat
                (Stdlib.Filename.concat (home_dir_or_cwd ()) ".config")
                "onton"))
