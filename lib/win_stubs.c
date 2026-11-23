/* Process-liveness helpers with native Windows implementations.
 *
 * On POSIX, [Unix.kill pid 0] answers "does this PID exist?". Windows has no
 * signals and OCaml raises [Invalid_argument] for [Unix.kill], so liveness and
 * hard termination are answered through the Win32 process API instead. */

#define CAML_NAME_SPACE
#include <caml/mlvalues.h>
#include <caml/memory.h>
#include <caml/fail.h>

#ifdef _WIN32

#include <windows.h>

typedef struct onton_job_entry {
  DWORD pid;
  HANDLE job;
  struct onton_job_entry *next;
} onton_job_entry;

static onton_job_entry *onton_jobs = NULL;

static HANDLE make_kill_job(void) {
  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (job == NULL) return NULL;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                               &limits, sizeof(limits))) {
    CloseHandle(job);
    return NULL;
  }
  return job;
}

static onton_job_entry *find_job(DWORD pid) {
  for (onton_job_entry *entry = onton_jobs; entry != NULL; entry = entry->next)
    if (entry->pid == pid) return entry;
  return NULL;
}

CAMLprim value caml_onton_attach_job(value v_pid) {
  CAMLparam1(v_pid);
  DWORD pid = (DWORD)Int_val(v_pid);
  HANDLE process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE |
                                   PROCESS_QUERY_LIMITED_INFORMATION,
                               FALSE, pid);
  if (process == NULL) CAMLreturn(Val_false);
  HANDLE job = make_kill_job();
  if (job == NULL || !AssignProcessToJobObject(job, process)) {
    if (job != NULL) CloseHandle(job);
    CloseHandle(process);
    CAMLreturn(Val_false);
  }
  CloseHandle(process);
  onton_job_entry *entry = (onton_job_entry *)malloc(sizeof(*entry));
  if (entry == NULL) {
    TerminateJobObject(job, 1);
    CloseHandle(job);
    CAMLreturn(Val_false);
  }
  entry->pid = pid;
  entry->job = job;
  entry->next = onton_jobs;
  onton_jobs = entry;
  CAMLreturn(Val_true);
}

CAMLprim value caml_onton_terminate_job(value v_pid) {
  CAMLparam1(v_pid);
  onton_job_entry *entry = find_job((DWORD)Int_val(v_pid));
  if (entry != NULL) (void)TerminateJobObject(entry->job, 1);
  CAMLreturn(Val_unit);
}

CAMLprim value caml_onton_close_job(value v_pid) {
  CAMLparam1(v_pid);
  DWORD pid = (DWORD)Int_val(v_pid);
  onton_job_entry **cursor = &onton_jobs;
  while (*cursor != NULL && (*cursor)->pid != pid) cursor = &(*cursor)->next;
  if (*cursor != NULL) {
    onton_job_entry *entry = *cursor;
    *cursor = entry->next;
    CloseHandle(entry->job);
    free(entry);
  }
  CAMLreturn(Val_unit);
}

CAMLprim value caml_onton_process_alive(value v_pid) {
  CAMLparam1(v_pid);
  DWORD pid = (DWORD)Int_val(v_pid);
  if (pid == 0) CAMLreturn(Val_false);
  HANDLE h = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                         pid);
  if (h == NULL) CAMLreturn(Val_false);
  DWORD code = 0;
  BOOL ok = GetExitCodeProcess(h, &code);
  BOOL alive = ok && code == STILL_ACTIVE;
  CloseHandle(h);
  CAMLreturn(Val_bool(alive));
}

CAMLprim value caml_onton_terminate_process(value v_pid) {
  CAMLparam1(v_pid);
  DWORD pid = (DWORD)Int_val(v_pid);
  if (pid != 0) {
    HANDLE h = OpenProcess(PROCESS_TERMINATE, FALSE, pid);
    if (h != NULL) {
      TerminateProcess(h, 1);
      CloseHandle(h);
    }
  }
  CAMLreturn(Val_unit);
}

CAMLprim value caml_onton_parent_alive(value v_pid) {
  CAMLparam1(v_pid);
  DWORD pid = (DWORD)Int_val(v_pid);
  if (pid == 0) CAMLreturn(Val_false);
  HANDLE h = OpenProcess(SYNCHRONIZE, FALSE, pid);
  if (h == NULL) CAMLreturn(Val_false);
  DWORD result = WaitForSingleObject(h, 0);
  CloseHandle(h);
  CAMLreturn(Val_bool(result == WAIT_TIMEOUT));
}

#else

#include <errno.h>
#include <signal.h>
#include <sys/types.h>

CAMLprim value caml_onton_process_alive(value v_pid) {
  CAMLparam1(v_pid);
  pid_t pid = (pid_t)Int_val(v_pid);
  if (pid <= 0) CAMLreturn(Val_false);
  if (kill(pid, 0) == 0) CAMLreturn(Val_true);
  CAMLreturn(Val_bool(errno == EPERM));
}

CAMLprim value caml_onton_terminate_process(value v_pid) {
  CAMLparam1(v_pid);
  pid_t pid = (pid_t)Int_val(v_pid);
  if (pid > 0) (void)kill(pid, SIGTERM);
  CAMLreturn(Val_unit);
}

CAMLprim value caml_onton_parent_alive(value v_pid) {
  CAMLparam1(v_pid);
  pid_t pid = (pid_t)Int_val(v_pid);
  if (pid <= 0) CAMLreturn(Val_false);
  if (kill(pid, 0) == 0) CAMLreturn(Val_true);
  CAMLreturn(Val_bool(errno == EPERM));
}

#endif
