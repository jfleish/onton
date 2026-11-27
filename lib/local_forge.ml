(* @archlint.module implementation
   @archlint.domain forge *)

open Base

type error = { message : string }
type local_error = error

let make ~owner ~repo:_ =
  let unsupported operation =
    Error { message = "local forge does not support " ^ operation }
  in
  let module Local : Forge.S with type error = local_error = struct
    type error = local_error

    let name = "local"
    let owner = owner
    let show_error error = error.message
    let poll_error error = Poll_outcome.Transport_failed { msg = error.message }
    let is_duplicate_change_error _ = false
    let is_permanent_error _ = true
    let is_merge_queue_required_error _ = false
    let supports_reviews = false
    let supports_pull_request_changes = false
    let supports_branch_changes = true

    type merge_result =
      | Merge_succeeded
      | Merge_queued of string
      | Merge_unconfirmed

    type enqueue_result =
      | Enqueued of Pr_state.merge_queue_entry
      | Already_enqueued of Pr_state.merge_queue_entry

    let change_url _ = None
    let branch_state ?known_state:_ _ = unsupported "branch observations"
    let pr_state _ = unsupported "pull-request observations"

    let merge_queue_removal_checks ~pr_number:_ =
      unsupported "merge-queue observations"

    let check_failure_details ~check:_ = unsupported "CI failure details"
    let rerun_failed_jobs_for_check ~check:_ = unsupported "CI reruns"

    let list_prs ~branch:_ ?base:_ ~state:_ () =
      unsupported "pull-request listing"

    let update_pr_body ~pr_number:_ ~body:_ = unsupported "pull-request updates"

    let reply_to_review_comment ~pr_number:_ ~comment_id:_ ~body:_ =
      unsupported "review replies"

    let resolve_review_thread ~thread_id:_ = unsupported "review thread updates"
    let viewer_login () = None

    let create_pull_request ~title:_ ~head:_ ~base:_ ~body:_ ~draft:_ =
      unsupported "pull-request creation"

    let update_pr_base ~pr_number:_ ~base:_ =
      unsupported "pull-request base updates"

    let request_review ~pr_number:_ ~team_slug:_ = unsupported "review requests"
    let set_draft ~pr_number:_ ~draft:_ = unsupported "draft updates"
    let merge_pr ~pr_number:_ = unsupported "merges"
    let enqueue_pr ~pr_number:_ = unsupported "merge queues"
    let dequeue_pr ~pr_number:_ = unsupported "merge queues"
    let check_repo_access () = Ok ()
  end in
  (module Local : Forge.S)
