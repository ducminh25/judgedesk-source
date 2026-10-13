use std::ffi::c_void;
use std::io;
use std::ptr::null;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{ERROR_ILLEGAL_DLL_RELOCATION, HANDLE, WAIT_OBJECT_0};
use windows_sys::Win32::System::JobObjects::TerminateJobObject;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, WaitForSingleObject, BELOW_NORMAL_PRIORITY_CLASS, CREATE_NO_WINDOW,
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT,
    PROCESS_INFORMATION, STARTUPINFOEXW,
};

/// # Safety
/// Strings and the environment block must be NUL-terminated, and all handles,
/// security capabilities and attributes referenced by `startup` must remain live.
pub(super) unsafe fn create_process(
    application: &[u16],
    command_line: &mut [u16],
    environment: &mut [u16],
    current_directory: &[u16],
    startup: &STARTUPINFOEXW,
    process: &mut PROCESS_INFORMATION,
) -> i32 {
    #[cfg(test)]
    if let Some(error) = test_fault::next_error() {
        // SAFETY: SetLastError writes only this thread's Win32 error slot.
        unsafe { windows_sys::Win32::Foundation::SetLastError(error) };
        return 0;
    }
    // SAFETY: the caller keeps all buffers, attributes and referenced OS resources
    // live for this synchronous call. Children remain suspended in their Job.
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_SUSPENDED
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_NO_WINDOW
                | BELOW_NORMAL_PRIORITY_CLASS
                | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_mut_ptr() as *const c_void,
            current_directory.as_ptr(),
            &startup.StartupInfo,
            process,
        )
    };
    #[cfg(test)]
    if created != 0 {
        test_fault::retain_process(process.hProcess);
    }
    created
}

pub(super) fn failure_diagnostic(error_code: u32) -> String {
    let error = io::Error::from_raw_os_error(error_code as i32);
    if error_code == ERROR_ILLEGAL_DLL_RELOCATION {
        format!("launch sandboxed process: Windows error 623 (ERROR_ILLEGAL_DLL_RELOCATION): {error}. Launch rejected; no retry with weaker isolation. Use a compatible toolchain or rebuild the executable")
    } else {
        format!("launch sandboxed process: {error}")
    }
}

pub(super) fn drain_suspended_child(job: HANDLE, process: HANDLE) {
    let deadline = Instant::now() + Duration::from_secs(20);
    // SAFETY: this run exclusively owns the Job and its still-suspended child.
    let terminated = unsafe { TerminateJobObject(job, super::LIMIT_EXIT_CODE) };
    // SAFETY: the caller retains the exact child handle throughout this wait.
    let waited = unsafe { WaitForSingleObject(process, 20_000) };
    if terminated == 0
        || waited != WAIT_OBJECT_0
        || !super::wait_for_job_empty(job, deadline.saturating_duration_since(Instant::now()))
    {
        // Never acknowledge an uncertain teardown or admit another run after it.
        // Exiting closes every kill-on-close Job; the sidecar detects executor loss.
        eprintln!("interactive launch failed and suspended-child cleanup could not be verified; executor stopping fail-closed");
        std::process::exit(1);
    }
}

// No environment variable, IPC field or production build can enable this hook.
#[cfg(test)]
pub(super) mod test_fault {
    use super::super::OwnedHandle;
    use std::cell::{Cell, RefCell};

    #[derive(Clone, Copy)]
    struct Fault {
        attempts: u32,
        fail_at: u32,
        error: u32,
    }

    thread_local! {
        static FAULT: Cell<Option<Fault>> = const { Cell::new(None) };
        static CREATED: RefCell<Vec<OwnedHandle>> = const { RefCell::new(Vec::new()) };
    }

    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            FAULT.with(|fault| fault.set(None));
            CREATED.with(|handles| handles.borrow_mut().clear());
        }
    }

    pub(super) fn next_error() -> Option<u32> {
        FAULT.with(|slot| {
            let mut fault = slot.get()?;
            fault.attempts += 1;
            slot.set(Some(fault));
            if fault.attempts < fault.fail_at {
                None
            } else if fault.attempts == fault.fail_at {
                Some(fault.error)
            } else {
                Some(windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED)
            }
        })
    }

    pub(super) fn retain_process(process: windows_sys::Win32::Foundation::HANDLE) {
        if !FAULT.with(|slot| slot.get().is_some()) {
            return;
        }
        let mut retained = std::ptr::null_mut();
        // SAFETY: the newly-created child and current-process handles are live.
        // The duplicate is owned exclusively by this test scope and closed by RAII.
        let copied = unsafe {
            windows_sys::Win32::Foundation::DuplicateHandle(
                windows_sys::Win32::System::Threading::GetCurrentProcess(),
                process,
                windows_sys::Win32::System::Threading::GetCurrentProcess(),
                &mut retained,
                0,
                0,
                windows_sys::Win32::Foundation::DUPLICATE_SAME_ACCESS,
            )
        };
        assert_ne!(copied, 0, "retain test child identity");
        CREATED.with(|handles| handles.borrow_mut().push(OwnedHandle(retained)));
    }

    pub(in super::super) fn inject<T>(
        fail_at: u32,
        error: u32,
        run: impl FnOnce() -> T,
    ) -> (T, u32, Vec<OwnedHandle>) {
        FAULT.with(|slot| {
            assert!(slot.get().is_none(), "launch fault scopes cannot nest");
            slot.set(Some(Fault {
                attempts: 0,
                fail_at,
                error,
            }));
        });
        let reset = Reset;
        let result = run();
        let attempts = FAULT.with(|slot| slot.get().expect("fault scope remains active").attempts);
        let children = CREATED.with(|handles| std::mem::take(&mut *handles.borrow_mut()));
        drop(reset);
        (result, attempts, children)
    }
}
