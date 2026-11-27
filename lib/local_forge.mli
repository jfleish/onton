(* @archlint.module interface
   @archlint.domain forge *)

type error = { message : string }

val make : owner:string -> repo:string -> (module Forge.S)
