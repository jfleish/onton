let () =
  Eio_main.run @@ fun _env ->
  let handles =
    Onton.Windows_process.spawn_io ~env:(Unix.environment ())
      [ "cmd.exe"; "/d"; "/c"; "set /p line=& echo %line%" ]
  in
  let output = Bytes.create 128 in
  let written = Onton.Windows_process.write (Onton.Windows_process.io_stdin handles) "probe\n" in
  let count =
    Onton.Windows_process.read_timeout (Onton.Windows_process.io_stdout handles) output 5000
  in
  let code = Onton.Windows_process.wait (Onton.Windows_process.io_process handles) in
  Printf.printf "written=%d read=%d code=%d output=%S\n%!" written count code
    (Bytes.sub_string output 0 count);
  Onton.Windows_process.close (Onton.Windows_process.io_stdin handles);
  Onton.Windows_process.close (Onton.Windows_process.io_stdout handles);
  Onton.Windows_process.close (Onton.Windows_process.io_stderr handles);
  if Int64.compare (Onton.Windows_process.io_job handles) 0L <> 0 then
    Onton.Windows_process.close (Onton.Windows_process.io_job handles);
  Onton.Windows_process.close (Onton.Windows_process.io_process handles)
