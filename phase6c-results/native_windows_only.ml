let read_all handle =
  let buffer = Buffer.create 64 in
  let chunk = Bytes.create 256 in
  let rec loop () =
    let n = Onton.Windows_process.read handle chunk in
    if n > 0 then (Buffer.add_string buffer (Bytes.sub_string chunk 0 n); loop ())
  in
  loop ();
  Buffer.contents buffer

let () =
  let count = if Array.length Sys.argv > 1 then int_of_string Sys.argv.(1) else 20 in
  Eio_main.run @@ fun _env ->
  Eio.Switch.run @@ fun sw ->
  let results = Array.make count None in
  Eio.Fiber.List.iter
    (fun i ->
      let handles =
        Onton.Windows_process.spawn ~env:(Unix.environment ())
          [ "cmd.exe"; "/d"; "/c"; "echo"; "native-backend" ]
      in
      let output = Eio.Fiber.fork_promise ~sw (fun () -> read_all (Onton.Windows_process.stdout handles)) in
      let error = Eio.Fiber.fork_promise ~sw (fun () -> read_all (Onton.Windows_process.stderr handles)) in
      let code = Onton.Windows_process.wait (Onton.Windows_process.process handles) in
      let output = Eio.Promise.await_exn output in
      let error = Eio.Promise.await_exn error in
      results.(i) <- Some (code, output, error);
      Onton.Windows_process.close (Onton.Windows_process.stdout handles);
      Onton.Windows_process.close (Onton.Windows_process.stderr handles);
      if Int64.compare (Onton.Windows_process.job handles) 0L <> 0 then
        Onton.Windows_process.close (Onton.Windows_process.job handles);
      Onton.Windows_process.close (Onton.Windows_process.process handles))
    (List.init count (fun i -> i));
  let empty = Array.fold_left (fun n -> function Some (_, "", _) -> n + 1 | _ -> n) 0 results in
  Printf.printf "count=%d empty_stdout=%d\n%!" count empty
