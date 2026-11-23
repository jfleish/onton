#define CAML_NAME_SPACE
#include <caml/mlvalues.h>
#include <caml/fail.h>
#include <caml/memory.h>
#include <caml/alloc.h>
#include <errno.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <wchar.h>

#ifdef _WIN32

/* Windows process-tree supervision.
 *
 * Windows has no sessions or process groups that can be signalled as a unit.
 * We instead place the command in a Job Object with KILL_ON_JOB_CLOSE: if this
 * supervisor dies for any reason, every process in the tree is terminated by
 * the kernel. The supervisor itself waits on the leader and drains adopted
 * descendants through the job's process accounting. */

#include <windows.h>

static HANDLE onton_job = NULL;
static HANDLE onton_child = NULL;
static DWORD onton_child_pid = 0;

static wchar_t *u8_to_w(const char *s) {
  int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
  if (n <= 0) return NULL;
  wchar_t *w = (wchar_t *)malloc((size_t)n * sizeof(wchar_t));
  if (w == NULL) return NULL;
  MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n);
  return w;
}

typedef struct {
  wchar_t *data;
  size_t len;
  size_t cap;
} wbuf;

static int wbuf_reserve(wbuf *b, size_t extra) {
  if (b->len + extra + 1 <= b->cap) return 1;
  size_t next = b->cap ? b->cap : 256;
  while (b->len + extra + 1 > next) next *= 2;
  wchar_t *grown = (wchar_t *)realloc(b->data, next * sizeof(wchar_t));
  if (grown == NULL) return 0;
  b->data = grown;
  b->cap = next;
  return 1;
}

static void wbuf_putc(wbuf *b, wchar_t c) {
  if (wbuf_reserve(b, 1)) b->data[b->len++] = c;
}

static void wbuf_puts(wbuf *b, const wchar_t *s) {
  size_t n = wcslen(s);
  if (wbuf_reserve(b, n)) {
    memcpy(b->data + b->len, s, n * sizeof(wchar_t));
    b->len += n;
  }
}

static int arg_needs_quotes(const wchar_t *a) {
  if (*a == L'\0') return 1;
  for (; *a; a++) {
    if (*a == L' ' || *a == L'\t' || *a == L'\n' || *a == L'\v' ||
        *a == L'"') {
      return 1;
    }
  }
  return 0;
}

/* Quote one argv element using the same rules as the MSVC CRT. */
static void wbuf_put_arg(wbuf *b, const wchar_t *arg) {
  if (!arg_needs_quotes(arg)) {
    wbuf_puts(b, arg);
    return;
  }
  wbuf_putc(b, L'"');
  size_t backslashes = 0;
  const wchar_t *p = arg;
  while (*p) {
    if (*p == L'\\') {
      backslashes++;
    } else if (*p == L'"') {
      for (size_t i = 0; i < backslashes * 2 + 1; i++) wbuf_putc(b, L'\\');
      wbuf_putc(b, L'"');
      backslashes = 0;
    } else {
      for (size_t i = 0; i < backslashes; i++) wbuf_putc(b, L'\\');
      backslashes = 0;
      wbuf_putc(b, *p);
    }
    p++;
  }
  for (size_t i = 0; i < backslashes * 2; i++) wbuf_putc(b, L'\\');
  wbuf_putc(b, L'"');
}

static wchar_t *build_cmdline(value argv) {
  mlsize_t count = Wosize_val(argv);
  wbuf b = { NULL, 0, 0 };
  for (mlsize_t i = 0; i < count; i++) {
    wchar_t *arg = u8_to_w(String_val(Field(argv, i)));
    if (arg == NULL) {
      free(b.data);
      return NULL;
    }
    if (i > 0) wbuf_putc(&b, L' ');
    wbuf_put_arg(&b, arg);
    free(arg);
  }
  if (b.data == NULL) return NULL;
  wbuf_putc(&b, L'\0');
  return b.data;
}

static wchar_t *build_env(value env) {
  mlsize_t count = Wosize_val(env);
  size_t total = 0;
  wchar_t **entries = (wchar_t **)calloc(count ? count : 1, sizeof(wchar_t *));
  if (entries == NULL) return NULL;
  for (mlsize_t i = 0; i < count; i++) {
    entries[i] = u8_to_w(String_val(Field(env, i)));
    if (entries[i] == NULL) {
      for (mlsize_t j = 0; j < i; j++) free(entries[j]);
      free(entries);
      return NULL;
    }
    total += wcslen(entries[i]) + 1;
  }
  wchar_t *block = (wchar_t *)malloc((total + 1) * sizeof(wchar_t));
  if (block == NULL) {
    for (mlsize_t i = 0; i < count; i++) free(entries[i]);
    free(entries);
    return NULL;
  }
  size_t offset = 0;
  for (mlsize_t i = 0; i < count; i++) {
    size_t n = wcslen(entries[i]);
    memcpy(block + offset, entries[i], n * sizeof(wchar_t));
    offset += n;
    block[offset++] = L'\0';
    free(entries[i]);
  }
  block[offset] = L'\0';
  free(entries);
  return block;
}

CAMLprim value caml_onton_win_spawn(value v_argv, value v_env) {
  CAMLparam2(v_argv, v_env);
  wchar_t *cmdline = build_cmdline(v_argv);
  wchar_t *envblock = build_env(v_env);
  if (cmdline == NULL || envblock == NULL) {
    free(cmdline);
    free(envblock);
    caml_failwith("onton-setsid-exec: out of memory building process");
  }

  onton_job = CreateJobObjectW(NULL, NULL);
  if (onton_job == NULL) {
    free(cmdline);
    free(envblock);
    caml_failwith("onton-setsid-exec: CreateJobObject failed");
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  memset(&limits, 0, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(onton_job, JobObjectExtendedLimitInformation,
                               &limits, sizeof(limits))) {
    free(cmdline);
    free(envblock);
    caml_failwith("onton-setsid-exec: SetInformationJobObject failed");
  }

  STARTUPINFOW si;
  memset(&si, 0, sizeof(si));
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  HANDLE std_in = GetStdHandle(STD_INPUT_HANDLE);
  HANDLE std_out = GetStdHandle(STD_OUTPUT_HANDLE);
  HANDLE std_err = GetStdHandle(STD_ERROR_HANDLE);
  HANDLE child_in = INVALID_HANDLE_VALUE;
  HANDLE child_out = INVALID_HANDLE_VALUE;
  HANDLE child_err = INVALID_HANDLE_VALUE;
  if (!DuplicateHandle(GetCurrentProcess(), std_in, GetCurrentProcess(),
                       &child_in, 0, TRUE, DUPLICATE_SAME_ACCESS)
      || !DuplicateHandle(GetCurrentProcess(), std_out, GetCurrentProcess(),
                          &child_out, 0, TRUE, DUPLICATE_SAME_ACCESS)
      || !DuplicateHandle(GetCurrentProcess(), std_err, GetCurrentProcess(),
                          &child_err, 0, TRUE, DUPLICATE_SAME_ACCESS)) {
    if (child_in != INVALID_HANDLE_VALUE) CloseHandle(child_in);
    if (child_out != INVALID_HANDLE_VALUE) CloseHandle(child_out);
    if (child_err != INVALID_HANDLE_VALUE) CloseHandle(child_err);
    free(cmdline);
    free(envblock);
    caml_failwith("onton-setsid-exec: could not duplicate stdio handles");
  }
  si.hStdInput = child_in;
  si.hStdOutput = child_out;
  si.hStdError = child_err;

  PROCESS_INFORMATION pi;
  memset(&pi, 0, sizeof(pi));
  BOOL ok = CreateProcessW(NULL, cmdline, NULL, NULL, TRUE,
                           CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP |
                               CREATE_UNICODE_ENVIRONMENT,
                           envblock, NULL, &si, &pi);
  CloseHandle(child_in);
  CloseHandle(child_out);
  CloseHandle(child_err);
  free(cmdline);
  free(envblock);
  if (!ok) {
    char message[128];
    snprintf(message, sizeof(message),
             "onton-setsid-exec: CreateProcess failed (Win32 error %lu)",
             (unsigned long)GetLastError());
    caml_failwith(message);
  }
  if (!AssignProcessToJobObject(onton_job, pi.hProcess)) {
    TerminateProcess(pi.hProcess, 1);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    caml_failwith("onton-setsid-exec: AssignProcessToJobObject failed");
  }
  ResumeThread(pi.hThread);
  CloseHandle(pi.hThread);
  onton_child = pi.hProcess;
  onton_child_pid = pi.dwProcessId;
  CAMLreturn(Val_int((int)onton_child_pid));
}

CAMLprim value caml_onton_win_wait_exit(value unit) {
  CAMLparam1(unit);
  DWORD code = 1;
  if (onton_child != NULL) {
    WaitForSingleObject(onton_child, INFINITE);
    if (!GetExitCodeProcess(onton_child, &code)) code = 1;
  }
  CAMLreturn(Val_int((int)code));
}

CAMLprim value caml_onton_win_leader_exited(value unit) {
  CAMLparam1(unit);
  if (onton_child == NULL) CAMLreturn(Val_true);
  CAMLreturn(Val_bool(WaitForSingleObject(onton_child, 0) == WAIT_OBJECT_0));
}

/* Send a console break to the child's process group for a chance to clean up
 * (Git removes its lock files on the default Ctrl+Break handler). */
CAMLprim value caml_onton_win_signal_tree(value unit) {
  CAMLparam1(unit);
  if (onton_child_pid != 0)
    (void)GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, onton_child_pid);
  CAMLreturn(Val_unit);
}

CAMLprim value caml_onton_win_terminate_tree(value unit) {
  CAMLparam1(unit);
  if (onton_job != NULL) TerminateJobObject(onton_job, 1);
  CAMLreturn(Val_unit);
}

CAMLprim value caml_onton_win_attach_job(value v_pid) {
  CAMLparam1(v_pid);
  DWORD pid = (DWORD)Int_val(v_pid);
  HANDLE process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE |
                                   PROCESS_QUERY_LIMITED_INFORMATION,
                               FALSE, pid);
  if (process == NULL) CAMLreturn(Val_false);
  onton_job = CreateJobObjectW(NULL, NULL);
  if (onton_job == NULL) {
    CloseHandle(process);
    CAMLreturn(Val_false);
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  memset(&limits, 0, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(onton_job, JobObjectExtendedLimitInformation,
                                &limits, sizeof(limits))
      || !AssignProcessToJobObject(onton_job, process)) {
    CloseHandle(process);
    CloseHandle(onton_job);
    onton_job = NULL;
    CAMLreturn(Val_false);
  }
  CloseHandle(process);
  onton_child_pid = pid;
  onton_child = OpenProcess(SYNCHRONIZE | PROCESS_TERMINATE, FALSE, pid);
  CAMLreturn(Val_true);
}

CAMLprim value caml_onton_win_terminate_job(value unit) {
  CAMLparam1(unit);
  if (onton_job != NULL) TerminateJobObject(onton_job, 1);
  CAMLreturn(Val_unit);
}

CAMLprim value caml_onton_win_close_job(value unit) {
  CAMLparam1(unit);
  if (onton_child != NULL) {
    CloseHandle(onton_child);
    onton_child = NULL;
  }
  if (onton_job != NULL) {
    CloseHandle(onton_job);
    onton_job = NULL;
  }
  onton_child_pid = 0;
  CAMLreturn(Val_unit);
}

CAMLprim value caml_onton_supervisor_parent_alive(value v_pid) {
  CAMLparam1(v_pid);
  DWORD pid = (DWORD)Int_val(v_pid);
  if (pid == 0) CAMLreturn(Val_false);
  HANDLE h = OpenProcess(SYNCHRONIZE, FALSE, pid);
  if (h == NULL) CAMLreturn(Val_false);
  DWORD result = WaitForSingleObject(h, 0);
  CloseHandle(h);
  CAMLreturn(Val_bool(result == WAIT_TIMEOUT));
}

CAMLprim value caml_onton_become_subreaper(value unit) {
  CAMLparam1(unit);
  CAMLreturn(Val_unit);
}

CAMLprim value caml_onton_leader_exited(value leader) {
  CAMLparam1(leader);
  CAMLreturn(caml_onton_win_leader_exited(Val_unit));
}

CAMLprim value caml_onton_descendants_remaining(value leader, value terminate) {
  CAMLparam2(leader, terminate);
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
  memset(&info, 0, sizeof(info));
  BOOL ok = onton_job != NULL &&
            QueryInformationJobObject(onton_job,
                                      JobObjectBasicAccountingInformation,
                                      &info, sizeof(info), NULL);
  DWORD active = ok ? info.ActiveProcesses : 0;
  if (active > 0 && Bool_val(terminate)) TerminateJobObject(onton_job, 1);
  CAMLreturn(Val_bool(active > 0));
}

#else /* POSIX */

#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/prctl.h>
#include <stdio.h>
#include <signal.h>
#elif defined(__APPLE__)
#include <sys/sysctl.h>
#else
#error "Process-tree supervision requires Linux, macOS, or Windows"
#endif

CAMLprim value caml_onton_become_subreaper(value unit) {
  (void)unit;
#ifdef __linux__
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) {
    caml_failwith(strerror(errno));
  }
#endif
  return Val_unit;
}

/* Observe completion without freeing the leader PID. All group operations must
   finish before waitpid consumes it, otherwise the group ID can be recycled. */
CAMLprim value caml_onton_leader_exited(value leader) {
  siginfo_t info;
  int result;
  do {
    memset(&info, 0, sizeof(info));
    result = waitid(P_PID, Int_val(leader), &info,
                    WEXITED | WNOHANG | WNOWAIT);
  } while (result < 0 && errno == EINTR);
  if (result < 0) caml_failwith(strerror(errno));
  return Val_bool(info.si_pid != 0);
}

/* Reap adopted descendants, never the leader. On macOS these are usually
   launchd's children: ECHILD means wait for launchd, not cleanup completed. */
#ifdef __APPLE__
static int member_remaining(pid_t member) {
  int status;
  pid_t result;
  do {
    result = waitpid(member, &status, WNOHANG);
  } while (result < 0 && errno == EINTR);
  if (result == member) return 0;
  if (result == 0 || errno == ECHILD) return 1;
  return -1;
}

#endif

CAMLprim value caml_onton_descendants_remaining(value leader, value terminate) {
  pid_t pgid = Int_val(leader);
  int remaining = 0, error = 0;
#ifdef __APPLE__
  (void)terminate;
  int mib[] = { CTL_KERN, KERN_PROC, KERN_PROC_PGRP, pgid };
  struct kinfo_proc *members = NULL;
  size_t bytes;
  for (;;) {
    bytes = 0;
    if (sysctl(mib, 4, NULL, &bytes, NULL, 0) < 0) {
      error = errno;
      if (error == ESRCH || error == ENOENT) error = 0;
      break;
    }
    /* The group may grow between the sizing and reading calls. Retry ENOMEM. */
    bytes += 16 * sizeof(*members);
    members = malloc(bytes);
    if (members == NULL) { error = ENOMEM; break; }
    if (sysctl(mib, 4, members, &bytes, NULL, 0) == 0) {
      for (size_t i = 0; i < bytes / sizeof(*members); ++i) {
        pid_t member = members[i].kp_proc.p_pid;
        if (member == pgid) continue;
        int present = member_remaining(member);
        if (present < 0) { error = errno; break; }
        remaining |= present;
      }
      free(members);
      break;
    }
    error = errno;
    free(members);
    if (error == ESRCH || error == ENOENT) {
      error = 0;
      break;
    }
    if (error != ENOMEM) break;
    error = 0;
  }
#else
  /* After the leader exits, every surviving tree has a child owned by this
     subreaper at its root. Session/group changes do not change that ownership.
     This is a single-threaded supervisor: a live child remains PID-pinned until
     we reap it, so signaling after waitpid(WNOHANG) cannot target a reused PID.
     Even a reaped child requires another pass: its children may have just been
     adopted, including children created while this snapshot was read. */
  char path[96];
  snprintf(path, sizeof(path), "/proc/self/task/%ld/children", (long)getpid());
  FILE *children = fopen(path, "r");
  if (children == NULL) caml_failwith(strerror(errno));
  long number;
  int scanned;
  while ((scanned = fscanf(children, "%ld", &number)) == 1) {
    pid_t member = (pid_t)number;
    if (member == pgid) continue;
    remaining = 1;
    int status;
    pid_t result;
    do {
      result = waitpid(member, &status, WNOHANG);
    } while (result < 0 && errno == EINTR);
    if (result < 0) { error = errno; break; }
    if (result == 0 && Bool_val(terminate) && kill(member, SIGKILL) < 0
        && errno != ESRCH) { error = errno; break; }
  }
  if (error == 0 && (ferror(children) || scanned != EOF)) error = EIO;
  fclose(children);
#endif
  if (error != 0) caml_failwith(strerror(error));
  return Val_bool(remaining);
}

/* The OCaml supervisor references these names on every platform; only the
   Windows branch calls them. */
CAMLprim value caml_onton_win_spawn(value v_argv, value v_env) {
  (void)v_argv;
  (void)v_env;
  caml_failwith("onton-setsid-exec: Windows supervisor used on POSIX");
  return Val_unit;
}

CAMLprim value caml_onton_win_wait_exit(value unit) {
  (void)unit;
  caml_failwith("onton-setsid-exec: Windows supervisor used on POSIX");
  return Val_unit;
}

CAMLprim value caml_onton_win_leader_exited(value unit) {
  (void)unit;
  caml_failwith("onton-setsid-exec: Windows supervisor used on POSIX");
  return Val_unit;
}

CAMLprim value caml_onton_win_signal_tree(value unit) {
  (void)unit;
  caml_failwith("onton-setsid-exec: Windows supervisor used on POSIX");
  return Val_unit;
}

CAMLprim value caml_onton_win_terminate_tree(value unit) {
  (void)unit;
  caml_failwith("onton-setsid-exec: Windows supervisor used on POSIX");
  return Val_unit;
}

CAMLprim value caml_onton_supervisor_parent_alive(value v_pid) {
  pid_t pid = (pid_t)Int_val(v_pid);
  if (pid <= 0) return Val_false;
  if (kill(pid, 0) == 0) return Val_true;
  return Val_bool(errno == EPERM);
}

#endif /* _WIN32 */
