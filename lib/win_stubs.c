/* Process-liveness helpers with native Windows implementations.
 *
 * On POSIX, [Unix.kill pid 0] answers "does this PID exist?". Windows has no
 * signals and OCaml raises [Invalid_argument] for [Unix.kill], so liveness and
 * hard termination are answered through the Win32 process API instead. */

#define CAML_NAME_SPACE
#include <caml/mlvalues.h>
#include <caml/memory.h>
#include <caml/fail.h>
#include <caml/alloc.h>

#ifdef _WIN32

#include <windows.h>
#include <io.h>
#include <stdlib.h>
#include <string.h>

CAMLprim value caml_onton_set_nonblock(value v_fd) {
  CAMLparam1(v_fd);
  intptr_t raw = _get_osfhandle(Int_val(v_fd));
  if (raw == -1) CAMLreturn(Val_false);
  DWORD mode = PIPE_NOWAIT;
  CAMLreturn(Val_bool(
      SetNamedPipeHandleState((HANDLE)raw, &mode, NULL, NULL)));
}

typedef struct onton_pipe_write {
  HANDLE handle;
  const char *data;
  DWORD length;
  DWORD written;
  BOOL ok;
  DWORD error;
} onton_pipe_write;

static DWORD WINAPI onton_pipe_write_thread(LPVOID raw) {
  onton_pipe_write *write = (onton_pipe_write *)raw;
  write->ok = WriteFile(write->handle, write->data, write->length,
                        &write->written, NULL);
  write->error = write->ok ? ERROR_SUCCESS : GetLastError();
  return 0;
}

CAMLprim value caml_onton_write_pipe_timeout(value v_fd, value v_data,
                                             value v_offset, value v_length,
                                             value v_timeout_ms) {
  CAMLparam5(v_fd, v_data, v_offset, v_length, v_timeout_ms);
  intptr_t raw = _get_osfhandle(Int_val(v_fd));
  int offset = Int_val(v_offset);
  int length = Int_val(v_length);
  DWORD timeout_ms = (DWORD)Int_val(v_timeout_ms);
  if (raw == -1 || offset < 0 || length < 0
      || (size_t)offset + (size_t)length > caml_string_length(v_data))
    CAMLreturn(Val_int(-2));
  if (length == 0) CAMLreturn(Val_int(0));

  char *copy = (char *)malloc((size_t)length);
  if (copy == NULL) CAMLreturn(Val_int(-2));
  memcpy(copy, String_val(v_data) + offset, (size_t)length);
  onton_pipe_write write = {(HANDLE)raw, copy, (DWORD)length, 0, FALSE,
                            ERROR_SUCCESS};
  HANDLE thread = CreateThread(NULL, 0, onton_pipe_write_thread, &write, 0,
                               NULL);
  if (thread == NULL) {
    free(copy);
    CAMLreturn(Val_int(-2));
  }

  caml_enter_blocking_section();
  DWORD wait = WaitForSingleObject(thread, timeout_ms);
  if (wait == WAIT_TIMEOUT) {
    (void)CancelSynchronousIo(thread);
    (void)WaitForSingleObject(thread, INFINITE);
  }
  caml_leave_blocking_section();

  int result = wait == WAIT_TIMEOUT ? -1
             : (write.ok ? (int)write.written : -2);
  CloseHandle(thread);
  free(copy);
  CAMLreturn(Val_int(result));
}

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

CAMLprim value caml_onton_set_nonblock(value v_fd) {
  CAMLparam1(v_fd);
  (void)v_fd;
  CAMLreturn(Val_false);
}

CAMLprim value caml_onton_write_pipe_timeout(value v_fd, value v_data,
                                             value v_offset, value v_length,
                                             value v_timeout_ms) {
  CAMLparam5(v_fd, v_data, v_offset, v_length, v_timeout_ms);
  (void)v_fd;
  (void)v_data;
  (void)v_offset;
  (void)v_length;
  (void)v_timeout_ms;
  CAMLreturn(Val_int(-2));
}

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

/* [Unix.getpid] and [Unix.create_process] do not yield OS process ids on
 * Windows: the former is not usable with OpenProcess by other processes and
 * the latter returns the child's process HANDLE. These stubs translate both
 * to real PIDs; on POSIX they are the identity. */
#ifdef _WIN32
CAMLprim value caml_onton_os_pid(value unit) {
  CAMLparam1(unit);
  CAMLreturn(Val_long((long)GetCurrentProcessId()));
}

CAMLprim value caml_onton_pid_of_spawned(value v_handle) {
  CAMLparam1(v_handle);
  DWORD pid = GetProcessId((HANDLE)Long_val(v_handle));
  CAMLreturn(Val_long((long)pid));
}

CAMLprim value caml_onton_random_bytes(value v_len) {
  CAMLparam1(v_len);
  CAMLlocal1(result);
  intnat len = Long_val(v_len);
  if (len < 0) caml_invalid_argument("Host.random_bytes");
  result = caml_alloc_string((mlsize_t)len);
  HMODULE library = LoadLibraryW(L"advapi32.dll");
  if (library == NULL) caml_failwith("Host.random_bytes: LoadLibrary failed");
  typedef BOOLEAN (APIENTRY *rtl_gen_random_fn)(PVOID, ULONG);
  rtl_gen_random_fn generate = (rtl_gen_random_fn)GetProcAddress(library, "SystemFunction036");
  if (generate == NULL || !generate((PVOID)Bytes_val(result), (ULONG)len)) {
    FreeLibrary(library);
    caml_failwith("Host.random_bytes: system RNG failed");
  }
  FreeLibrary(library);
  CAMLreturn(result);
}
#else
#include <unistd.h>

CAMLprim value caml_onton_os_pid(value unit) {
  (void)unit;
  return Val_long((long)getpid());
}

CAMLprim value caml_onton_pid_of_spawned(value v_handle) { return v_handle; }

CAMLprim value caml_onton_random_bytes(value v_len) {
  (void)v_len;
  caml_failwith("Host.random_bytes: Windows RNG used on POSIX");
}
#endif
