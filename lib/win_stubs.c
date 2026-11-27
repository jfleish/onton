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
#include <caml/unixsupport.h>

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


static wchar_t *onton_utf8_to_utf16(const char *source, int length) {
  int wide_length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                        source, length, NULL, 0);
  if (wide_length <= 0) return NULL;
  wchar_t *wide = (wchar_t *)caml_stat_alloc((size_t)(wide_length + 1) * sizeof(wchar_t));
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, source, length,
                          wide, wide_length) != wide_length) {
    caml_stat_free(wide);
    return NULL;
  }
  wide[wide_length] = L'\0';
  return wide;
}

static value caml_onton_handle_value(HANDLE handle) {
  return caml_copy_int64((int64_t)(intptr_t)handle);
}

static value onton_spawn_windows_impl(value v_cwd, value v_env, value v_cmdline,
                                      int keep_stdin) {
  CAMLparam3(v_cwd, v_env, v_cmdline);
  CAMLlocal1(result);
  SECURITY_ATTRIBUTES inherited = { sizeof(SECURITY_ATTRIBUTES), NULL, TRUE };
  HANDLE stdin_read = INVALID_HANDLE_VALUE, stdin_write = INVALID_HANDLE_VALUE;
  HANDLE stdout_read = INVALID_HANDLE_VALUE, stdout_write = INVALID_HANDLE_VALUE;
  HANDLE stderr_read = INVALID_HANDLE_VALUE, stderr_write = INVALID_HANDLE_VALUE;
  HANDLE job = NULL;
  PROCESS_INFORMATION pi;
  STARTUPINFOEXW startup;
  SIZE_T attribute_size = 0;
  HANDLE child_handles[3];
  wchar_t *cmdline = NULL, *cwd = NULL, *env = NULL;
  BOOL ok = FALSE;
  BOOL attribute_initialized = FALSE;
  DWORD error = ERROR_SUCCESS;

  ZeroMemory(&pi, sizeof(pi));
  ZeroMemory(&startup, sizeof(startup));
  cmdline = onton_utf8_to_utf16(String_val(v_cmdline), caml_string_length(v_cmdline));
  env = onton_utf8_to_utf16(String_val(v_env), caml_string_length(v_env));
  if (Is_some(v_cwd)) {
    value cwd_value = Field(v_cwd, 0);
    cwd = onton_utf8_to_utf16(String_val(cwd_value), caml_string_length(cwd_value));
  }
  if (cmdline == NULL || env == NULL || (Is_some(v_cwd) && cwd == NULL)) {
    error = ERROR_INVALID_PARAMETER;
    goto cleanup;
  }

  if (!CreatePipe(&stdin_read, &stdin_write, &inherited, 0) ||
      !CreatePipe(&stdout_read, &stdout_write, &inherited, 0) ||
      !CreatePipe(&stderr_read, &stderr_write, &inherited, 0)) {
    error = GetLastError();
    goto cleanup;
  }
  /* Parent-side handles must never leak into the child. */
  if (!SetHandleInformation(stdin_write, HANDLE_FLAG_INHERIT, 0) ||
      !SetHandleInformation(stdout_read, HANDLE_FLAG_INHERIT, 0) ||
      !SetHandleInformation(stderr_read, HANDLE_FLAG_INHERIT, 0)) {
    error = GetLastError();
    goto cleanup;
  }
  if (!keep_stdin) {
    CloseHandle(stdin_write);
    stdin_write = INVALID_HANDLE_VALUE;
  }
  child_handles[0] = stdin_read;
  child_handles[1] = stdout_write;
  child_handles[2] = stderr_write;

  startup.StartupInfo.cb = sizeof(STARTUPINFOEXW);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = stdin_read;
  startup.StartupInfo.hStdOutput = stdout_write;
  startup.StartupInfo.hStdError = stderr_write;
  InitializeProcThreadAttributeList(NULL, 1, 0, &attribute_size);
  startup.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)caml_stat_alloc(attribute_size);
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attribute_size)) {
    error = GetLastError();
    goto cleanup;
  }
  attribute_initialized = TRUE;
  if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0,
                                 PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                 child_handles, sizeof(child_handles), NULL, NULL)) {
    error = GetLastError();
    goto cleanup;
  }

  ok = CreateProcessW(NULL, cmdline, NULL, NULL, TRUE,
                      EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT |
                        CREATE_NO_WINDOW,
                      env, cwd, &startup.StartupInfo, &pi);
  if (!ok) {
    error = GetLastError();
    goto cleanup;
  }
  CloseHandle(pi.hThread);
  CloseHandle(stdin_read);
  CloseHandle(stdout_write);
  CloseHandle(stderr_write);
  stdin_read = stdout_write = stderr_write = INVALID_HANDLE_VALUE;

  job = CreateJobObjectW(NULL, NULL);
  if (job != NULL) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
    ZeroMemory(&limits, sizeof(limits));
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                 &limits, sizeof(limits)) ||
        !AssignProcessToJobObject(job, pi.hProcess)) {
      CloseHandle(job);
      job = NULL;
    }
  }
  result = caml_alloc_tuple(keep_stdin ? 5 : 4);
  Store_field(result, 0, caml_onton_handle_value(pi.hProcess));
  Store_field(result, 1, caml_onton_handle_value(job));
  if (keep_stdin) {
    Store_field(result, 2, caml_onton_handle_value(stdin_write));
    Store_field(result, 3, caml_onton_handle_value(stdout_read));
    Store_field(result, 4, caml_onton_handle_value(stderr_read));
  } else {
    Store_field(result, 2, caml_onton_handle_value(stdout_read));
    Store_field(result, 3, caml_onton_handle_value(stderr_read));
  }
  caml_stat_free(startup.lpAttributeList);
  caml_stat_free(cmdline);
  caml_stat_free(cwd);
  caml_stat_free(env);
  CAMLreturn(result);

cleanup:
  if (startup.lpAttributeList != NULL) {
    if (attribute_initialized) DeleteProcThreadAttributeList(startup.lpAttributeList);
    caml_stat_free(startup.lpAttributeList);
  }
  if (pi.hThread != NULL) CloseHandle(pi.hThread);
  if (pi.hProcess != NULL) CloseHandle(pi.hProcess);
  if (job != NULL) CloseHandle(job);
  if (stdin_read != INVALID_HANDLE_VALUE) CloseHandle(stdin_read);
  if (stdin_write != INVALID_HANDLE_VALUE) CloseHandle(stdin_write);
  if (stdout_read != INVALID_HANDLE_VALUE) CloseHandle(stdout_read);
  if (stdout_write != INVALID_HANDLE_VALUE) CloseHandle(stdout_write);
  if (stderr_read != INVALID_HANDLE_VALUE) CloseHandle(stderr_read);
  if (stderr_write != INVALID_HANDLE_VALUE) CloseHandle(stderr_write);
  caml_stat_free(cmdline);
  caml_stat_free(cwd);
  caml_stat_free(env);
  caml_win32_maperr(error);
  uerror("CreateProcessW", v_cmdline);
}

CAMLprim value caml_onton_spawn_windows(value v_cwd, value v_env, value v_cmdline) {
  return onton_spawn_windows_impl(v_cwd, v_env, v_cmdline, 0);
}

CAMLprim value caml_onton_spawn_windows_io(value v_cwd, value v_env, value v_cmdline) {
  return onton_spawn_windows_impl(v_cwd, v_env, v_cmdline, 1);
}

CAMLprim value caml_onton_read_windows_pipe(value v_handle, value v_bytes,
                                             value v_offset, value v_length) {
  CAMLparam4(v_handle, v_bytes, v_offset, v_length);
  HANDLE handle = (HANDLE)(intptr_t)Int64_val(v_handle);
  DWORD got = 0;
  DWORD length = (DWORD)Long_val(v_length);
  BOOL ok;
  caml_enter_blocking_section();
  ok = ReadFile(handle, Bytes_val(v_bytes) + Long_val(v_offset), length, &got, NULL);
  DWORD error = ok ? ERROR_SUCCESS : GetLastError();
  caml_leave_blocking_section();
  if (!ok && (error == ERROR_BROKEN_PIPE || error == ERROR_HANDLE_EOF)) CAMLreturn(Val_int(0));
  if (!ok) { caml_win32_maperr(error); uerror("ReadFile", Nothing); }
  CAMLreturn(Val_int((int)got));
}

CAMLprim value caml_onton_read_windows_pipe_timeout(value v_handle, value v_bytes,
                                                     value v_offset, value v_length,
                                                     value v_timeout_ms) {
  CAMLparam5(v_handle, v_bytes, v_offset, v_length, v_timeout_ms);
  HANDLE handle = (HANDLE)(intptr_t)Int64_val(v_handle);
  DWORD timeout = (DWORD)Long_val(v_timeout_ms);
  DWORD available = 0;
  DWORD got = 0;
  BOOL ok = FALSE;
  DWORD error = ERROR_SUCCESS;
  caml_enter_blocking_section();
  for (DWORD elapsed = 0; elapsed <= timeout; ++elapsed) {
    if (PeekNamedPipe(handle, NULL, 0, NULL, &available, NULL)) {
      if (available > 0) {
        ok = ReadFile(handle, Bytes_val(v_bytes) + Long_val(v_offset),
                      (DWORD)Long_val(v_length), &got, NULL);
        error = ok ? ERROR_SUCCESS : GetLastError();
        break;
      }
    } else {
      error = GetLastError();
      break;
    }
    if (elapsed < timeout) Sleep(1);
  }
  caml_leave_blocking_section();
  if (!ok && error != ERROR_SUCCESS && error != ERROR_BROKEN_PIPE && error != ERROR_HANDLE_EOF) {
    caml_win32_maperr(error); uerror("ReadFile", Nothing);
  }
  CAMLreturn(Val_int((int)got));
}

CAMLprim value caml_onton_pipe_available(value v_handle) {
  CAMLparam1(v_handle);
  HANDLE handle = (HANDLE)(intptr_t)Int64_val(v_handle);
  DWORD available = 0;
  if (!PeekNamedPipe(handle, NULL, 0, NULL, &available, NULL)) CAMLreturn(Val_int(-1));
  CAMLreturn(Val_int((int)available));
}

CAMLprim value caml_onton_write_windows_pipe(value v_handle, value v_data,
                                             value v_offset, value v_length) {
  CAMLparam4(v_handle, v_data, v_offset, v_length);
  HANDLE handle = (HANDLE)(intptr_t)Int64_val(v_handle);
  DWORD written = 0;
  BOOL ok;
  caml_enter_blocking_section();
  ok = WriteFile(handle, String_val(v_data) + Long_val(v_offset),
                 (DWORD)Long_val(v_length), &written, NULL);
  DWORD error = ok ? ERROR_SUCCESS : GetLastError();
  caml_leave_blocking_section();
  if (!ok) { caml_win32_maperr(error); uerror("WriteFile", Nothing); }
  CAMLreturn(Val_int((int)written));
}

CAMLprim value caml_onton_wait_windows_process(value v_handle) {
  CAMLparam1(v_handle);
  HANDLE handle = (HANDLE)(intptr_t)Int64_val(v_handle);
  DWORD result;
  caml_enter_blocking_section();
  result = WaitForSingleObject(handle, INFINITE);
  caml_leave_blocking_section();
  if (result != WAIT_OBJECT_0) { caml_win32_maperr(GetLastError()); uerror("WaitForSingleObject", Nothing); }
  DWORD code = 0;
  if (!GetExitCodeProcess(handle, &code)) { caml_win32_maperr(GetLastError()); uerror("GetExitCodeProcess", Nothing); }
  CAMLreturn(Val_int((int)code));
}

CAMLprim value caml_onton_terminate_windows_job(value v_handle) {
  CAMLparam1(v_handle);
  HANDLE handle = (HANDLE)(intptr_t)Int64_val(v_handle);
  if (handle != 0) (void)TerminateJobObject(handle, 1);
  CAMLreturn(Val_unit);
}

CAMLprim value caml_onton_terminate_windows_process(value v_handle) {
  CAMLparam1(v_handle);
  HANDLE handle = (HANDLE)(intptr_t)Int64_val(v_handle);
  if (handle != 0) (void)TerminateProcess(handle, 1);
  CAMLreturn(Val_unit);
}

CAMLprim value caml_onton_close_windows_handle(value v_handle) {
  CAMLparam1(v_handle);
  HANDLE handle = (HANDLE)(intptr_t)Int64_val(v_handle);
  if (handle != 0) CloseHandle(handle);
  CAMLreturn(Val_unit);
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

CAMLprim value caml_onton_spawn_windows(value v_cwd, value v_env, value v_cmdline) {
  CAMLparam3(v_cwd, v_env, v_cmdline);
  (void)v_cwd; (void)v_env; (void)v_cmdline;
  caml_failwith("Windows process backend unavailable on Unix");
}
CAMLprim value caml_onton_spawn_windows_io(value v_cwd, value v_env, value v_cmdline) {
  CAMLparam3(v_cwd, v_env, v_cmdline);
  (void)v_cwd; (void)v_env; (void)v_cmdline;
  caml_failwith("Windows process backend unavailable on Unix");
}
CAMLprim value caml_onton_read_windows_pipe(value v_handle, value v_bytes, value v_offset, value v_length) {
  CAMLparam5(v_handle, v_bytes, v_offset, v_length);
  (void)v_handle; (void)v_bytes; (void)v_offset; (void)v_length;
  caml_failwith("Windows process backend unavailable on Unix");
}
CAMLprim value caml_onton_read_windows_pipe_timeout(value v_handle, value v_bytes, value v_offset, value v_length, value v_timeout_ms) {
  CAMLparam5(v_handle, v_bytes, v_offset, v_length, v_timeout_ms);
  (void)v_handle; (void)v_bytes; (void)v_offset; (void)v_length; (void)v_timeout_ms;
  caml_failwith("Windows process backend unavailable on Unix");
}
CAMLprim value caml_onton_pipe_available(value v_handle) {
  CAMLparam1(v_handle); (void)v_handle;
  caml_failwith("Windows process backend unavailable on Unix");
}
CAMLprim value caml_onton_write_windows_pipe(value v_handle, value v_data, value v_offset, value v_length) {
  CAMLparam4(v_handle, v_data, v_offset, v_length);
  (void)v_handle; (void)v_data; (void)v_offset; (void)v_length;
  caml_failwith("Windows process backend unavailable on Unix");
}
CAMLprim value caml_onton_wait_windows_process(value v_handle) {
  CAMLparam1(v_handle); (void)v_handle; caml_failwith("Windows process backend unavailable on Unix");
}
CAMLprim value caml_onton_terminate_windows_job(value v_handle) {
  CAMLparam1(v_handle); (void)v_handle; CAMLreturn(Val_unit);
}
CAMLprim value caml_onton_terminate_windows_process(value v_handle) {
  CAMLparam1(v_handle); (void)v_handle; CAMLreturn(Val_unit);
}
CAMLprim value caml_onton_close_windows_handle(value v_handle) {
  CAMLparam1(v_handle); (void)v_handle; CAMLreturn(Val_unit);
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
