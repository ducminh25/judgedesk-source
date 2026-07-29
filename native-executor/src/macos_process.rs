//! macOS process-identity and deferred-reap primitives for a trusted per-run anchor.
//!
//! A numeric PID/PGID is never authority by itself. While the trusted anchor is live, group
//! signalling additionally requires a caller-held capability tied to its authenticated protocol
//! channel. After that direct child exits, its unreaped wait status pins the PID/PGID while the
//! parent stops and kills the whole group. The anchor is reaped only after repeated bounded
//! inventories prove that no descendants remain. There is deliberately no non-child
//! guardian-death fallback and no per-PID descendant signalling path.

use crate::guardian_protocol::ProcessIdentity;
use std::io;
use std::process::ExitStatus;
use std::time::Duration;

pub const MAX_PROCESS_GROUP_MEMBERS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityVerification {
    Matches,
    Missing,
    Mismatch(ProcessIdentity),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupSignalOutcome {
    Sent,
    GroupMissing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveProcessGroupSnapshot {
    pub members: Vec<ProcessIdentity>,
    pub zombie_pids: Vec<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrainPhase {
    WaitingForAnchorExit,
    InventoryUnavailable,
    GroupSignalFailed,
    DrainingDescendants,
    FinalInventoryNonEmpty,
}

#[derive(Debug, Clone)]
pub struct DrainStall {
    pub phase: DrainPhase,
    pub elapsed: Duration,
    pub observed_members: Vec<ProcessIdentity>,
    pub detail: String,
}

#[derive(Debug, Clone, Copy)]
pub struct DrainOptions {
    pub poll_interval: Duration,
    pub stall_interval: Duration,
}

impl Default for DrainOptions {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_millis(2),
            stall_interval: Duration::from_secs(10),
        }
    }
}

impl DrainOptions {
    pub fn validate(self) -> io::Result<Self> {
        if self.poll_interval.is_zero() || self.stall_interval.is_zero() {
            Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "process drain intervals must be non-zero",
            ))
        } else {
            Ok(self)
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct AnchorRusage {
    pub user_time_us: u64,
    pub system_time_us: u64,
    pub max_rss_bytes: u64,
}

#[derive(Debug)]
pub struct ReapedAnchor {
    pub status: ExitStatus,
    pub raw_wait_status: i32,
    pub rusage: AnchorRusage,
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{
        AnchorRusage, DrainOptions, DrainPhase, DrainStall, GroupSignalOutcome,
        IdentityVerification, LiveProcessGroupSnapshot, ProcessIdentity, ReapedAnchor,
        MAX_PROCESS_GROUP_MEMBERS,
    };
    use std::io;
    use std::os::fd::{AsFd, AsRawFd, BorrowedFd, RawFd};
    use std::os::unix::process::ExitStatusExt;
    use std::process::ExitStatus;
    use std::thread;
    use std::time::{Duration, Instant};

    const PROC_PGRP_ONLY: u32 = 2;
    const NOTE_EXIT_WAITABLE_TIMEOUT: Duration = Duration::from_secs(2);
    const NOTE_EXIT_WAITABLE_POLL_INTERVAL: Duration = Duration::from_millis(1);

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum ProcListPidsOutcome {
        Bytes(usize),
        Retry,
    }

    pub fn read_process_identity(pid: i32) -> io::Result<ProcessIdentity> {
        if pid <= 1 {
            return Err(invalid("process PID must be greater than one"));
        }
        let first_start = read_start_abstime(pid)?;
        let pgid = loop {
            let pgid = unsafe { libc::getpgid(pid) };
            if pgid > 0 {
                break pgid;
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        };
        // Close the PID-reuse race between the rusage and getpgid calls.
        let second_start = read_start_abstime(pid)?;
        if first_start != second_start {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "process identity changed while it was being read",
            ));
        }
        let identity = ProcessIdentity {
            pid,
            pgid,
            start_abstime: first_start,
        };
        identity.validate()?;
        Ok(identity)
    }

    pub fn verify_process_identity(expected: &ProcessIdentity) -> io::Result<IdentityVerification> {
        expected.validate()?;
        match read_process_identity(expected.pid) {
            Ok(actual) if actual == *expected => Ok(IdentityVerification::Matches),
            Ok(actual) => Ok(IdentityVerification::Mismatch(actual)),
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => {
                Ok(IdentityVerification::Missing)
            }
            Err(error) => Err(error),
        }
    }

    pub fn inventory_process_group(pgid: i32) -> io::Result<Vec<ProcessIdentity>> {
        let pids = list_process_group_pids(pgid)?;
        let mut identities = Vec::with_capacity(pids.len());
        for pid in pids {
            identities.push(read_process_identity(pid)?);
        }
        validate_inventory(pgid, identities)
    }

    pub fn inventory_live_process_group(pgid: i32) -> io::Result<LiveProcessGroupSnapshot> {
        let pids = list_process_group_pids(pgid)?;
        let mut members = Vec::with_capacity(pids.len());
        let mut zombie_pids = Vec::new();
        for pid in pids {
            match read_live_group_member(pid, pgid)? {
                LiveGroupMember::Live(identity) => members.push(identity),
                LiveGroupMember::Zombie => zombie_pids.push(pid),
                LiveGroupMember::Vanished => {}
            }
        }
        finish_process_group_snapshot(pgid, members, zombie_pids)
    }

    fn finish_process_group_snapshot(
        pgid: i32,
        members: Vec<ProcessIdentity>,
        mut zombie_pids: Vec<i32>,
    ) -> io::Result<LiveProcessGroupSnapshot> {
        let members = validate_inventory(pgid, members)?;
        zombie_pids.sort_unstable();
        if zombie_pids.windows(2).any(|pair| pair[0] == pair[1])
            || zombie_pids
                .iter()
                .any(|pid| members.iter().any(|member| member.pid == *pid))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "live process-group inventory returned duplicate PID classifications",
            ));
        }
        Ok(LiveProcessGroupSnapshot {
            members,
            zombie_pids,
        })
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum LiveGroupMember {
        Live(ProcessIdentity),
        Zombie,
        Vanished,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum ProcessExitProbe {
        Live,
        Exited,
        Missing,
    }

    fn read_live_group_member(pid: i32, expected_pgid: i32) -> io::Result<LiveGroupMember> {
        const MAX_IDENTITY_ATTEMPTS: usize = 3;
        for _ in 0..MAX_IDENTITY_ATTEMPTS {
            match read_process_identity(pid) {
                Ok(identity) => return Ok(LiveGroupMember::Live(identity)),
                Err(error) if error.raw_os_error() == Some(libc::ESRCH) => {
                    match probe_process_exit(pid)? {
                        ProcessExitProbe::Exited => return Ok(LiveGroupMember::Zombie),
                        ProcessExitProbe::Missing => {
                            // Darwin removes zombies from live identity and EVFILT_PROC lookup
                            // before proc_listpids drops their process-group row. Confirm that
                            // exact raw PGID membership is still present, then close a possible
                            // PID-reuse race with one final identity read.
                            if !list_process_group_pids(expected_pgid)?.contains(&pid) {
                                return Ok(LiveGroupMember::Vanished);
                            }
                            match read_process_identity(pid) {
                                Ok(identity) => return Ok(LiveGroupMember::Live(identity)),
                                Err(confirm_error)
                                    if confirm_error.raw_os_error() == Some(libc::ESRCH) =>
                                {
                                    return Ok(LiveGroupMember::Zombie);
                                }
                                Err(confirm_error) => return Err(confirm_error),
                            }
                        }
                        ProcessExitProbe::Live => {
                            // The member crossed a spawn/exit boundary between the two libproc
                            // calls. Retry only within this bounded authentication window.
                            std::thread::yield_now();
                        }
                    }
                }
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "live process {pid} in group {expected_pgid} could not be identity-authenticated"
            ),
        ))
    }

    fn probe_process_exit(pid: i32) -> io::Result<ProcessExitProbe> {
        let descriptor = loop {
            let descriptor = unsafe { libc::kqueue() };
            if descriptor >= 0 {
                break descriptor;
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        };
        if let Err(error) = set_close_on_exec(descriptor) {
            unsafe {
                libc::close(descriptor);
            }
            return Err(error);
        }

        let change = libc::kevent {
            ident: pid as libc::uintptr_t,
            filter: libc::EVFILT_PROC,
            flags: libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT,
            fflags: libc::NOTE_EXIT,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        let mut event: libc::kevent = unsafe { std::mem::zeroed() };
        let timeout = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        let result = loop {
            let result = unsafe { libc::kevent(descriptor, &change, 1, &mut event, 1, &timeout) };
            if result >= 0 {
                break result;
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                unsafe {
                    libc::close(descriptor);
                }
                return if error.raw_os_error() == Some(libc::ESRCH) {
                    Ok(ProcessExitProbe::Missing)
                } else {
                    Err(error)
                };
            }
        };
        unsafe {
            libc::close(descriptor);
        }

        if result == 0 {
            return Ok(ProcessExitProbe::Live);
        }
        if event.flags & libc::EV_ERROR != 0 {
            let error_code = event.data as i32;
            return if error_code == libc::ESRCH {
                Ok(ProcessExitProbe::Missing)
            } else {
                Err(io::Error::from_raw_os_error(error_code))
            };
        }
        if event.ident != pid as libc::uintptr_t
            || event.filter != libc::EVFILT_PROC
            || event.fflags & libc::NOTE_EXIT == 0
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("kqueue returned an unexpected process-exit event for PID {pid}"),
            ));
        }
        Ok(ProcessExitProbe::Exited)
    }

    fn list_process_group_pids(pgid: i32) -> io::Result<Vec<i32>> {
        if pgid <= 1 {
            return Err(invalid("process group ID must be greater than one"));
        }
        let mut pids = [0_i32; MAX_PROCESS_GROUP_MEMBERS];
        let buffer_bytes = std::mem::size_of_val(&pids);
        let returned_bytes = loop {
            // Darwin's libproc wrapper returns zero, not -1, when the underlying syscall fails.
            // Clear errno so an empty successful inventory cannot be confused with either a
            // stale error or an actual API failure.
            unsafe {
                *libc::__error() = 0;
            }
            let returned = unsafe {
                libc::proc_listpids(
                    PROC_PGRP_ONLY,
                    pgid as u32,
                    pids.as_mut_ptr().cast(),
                    buffer_bytes as i32,
                )
            };
            let errno = unsafe { *libc::__error() };
            match decode_proc_listpids_result(returned, errno)? {
                ProcListPidsOutcome::Bytes(bytes) => break bytes,
                ProcListPidsOutcome::Retry => continue,
            }
        };
        // An exactly-full buffer gives no proof that the group was completely enumerated.
        if returned_bytes >= buffer_bytes {
            return Err(io::Error::new(
                io::ErrorKind::OutOfMemory,
                format!(
                    "process group {pgid} reached the bounded {MAX_PROCESS_GROUP_MEMBERS}-PID inventory"
                ),
            ));
        }
        if !returned_bytes.is_multiple_of(std::mem::size_of::<i32>()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "process-group inventory returned a partial PID",
            ));
        }

        let count = returned_bytes / std::mem::size_of::<i32>();
        Ok(pids[..count]
            .iter()
            .copied()
            .filter(|pid| *pid > 0)
            .collect())
    }

    fn decode_proc_listpids_result(returned: i32, errno: i32) -> io::Result<ProcListPidsOutcome> {
        if returned > 0 {
            return Ok(ProcListPidsOutcome::Bytes(returned as usize));
        }
        if returned == 0 && errno == 0 {
            return Ok(ProcListPidsOutcome::Bytes(0));
        }
        if errno == libc::EINTR {
            return Ok(ProcListPidsOutcome::Retry);
        }
        let code = if errno == 0 { libc::EIO } else { errno };
        Err(io::Error::from_raw_os_error(code))
    }

    fn snapshot_is_physically_empty(snapshot: &LiveProcessGroupSnapshot) -> bool {
        snapshot.members.is_empty() && snapshot.zombie_pids.is_empty()
    }

    fn validate_inventory(
        pgid: i32,
        mut identities: Vec<ProcessIdentity>,
    ) -> io::Result<Vec<ProcessIdentity>> {
        for identity in &identities {
            if identity.pgid != pgid {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "PID {} changed from inventoried PGID {pgid} to {}",
                        identity.pid, identity.pgid
                    ),
                ));
            }
        }
        identities.sort_unstable_by_key(|identity| identity.pid);
        if identities.windows(2).any(|pair| pair[0].pid == pair[1].pid) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "process-group inventory returned a duplicate PID",
            ));
        }
        Ok(identities)
    }

    fn require_exact_anchor_in_inventory(
        expected_anchor: &ProcessIdentity,
        members: &[ProcessIdentity],
    ) -> io::Result<()> {
        match members
            .iter()
            .find(|member| member.pid == expected_anchor.pid)
        {
            Some(actual) if actual == expected_anchor => Ok(()),
            Some(actual) => Err(identity_mismatch(expected_anchor, actual)),
            None => Err(io::Error::new(
                io::ErrorKind::NotFound,
                "live anchor is missing from its process-group inventory",
            )),
        }
    }

    fn read_verified_process_status(expected: &ProcessIdentity) -> io::Result<u32> {
        require_identity_match(expected)?;
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let expected_bytes = std::mem::size_of::<libc::proc_bsdinfo>();
        let returned_bytes = loop {
            let returned = unsafe {
                libc::proc_pidinfo(
                    expected.pid,
                    libc::PROC_PIDTBSDINFO,
                    0,
                    (&mut info as *mut libc::proc_bsdinfo).cast(),
                    expected_bytes as i32,
                )
            };
            if returned > 0 {
                break returned as usize;
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(process_status_sample_error(expected, error));
            }
        };
        if returned_bytes != expected_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "PROC_PIDTBSDINFO returned {returned_bytes} bytes, expected {expected_bytes}"
                ),
            ));
        }
        if info.pbi_pid != expected.pid as u32 || info.pbi_pgid != expected.pgid as u32 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "process status identity changed: expected {expected:?}, observed pid={} pgid={}",
                    info.pbi_pid, info.pbi_pgid
                ),
            ));
        }
        require_identity_match(expected)?;
        Ok(info.pbi_status)
    }

    fn process_status_sample_error(expected: &ProcessIdentity, error: io::Error) -> io::Error {
        if error.raw_os_error() != Some(libc::ESRCH) {
            return error;
        }
        match verify_process_identity(expected) {
            Ok(IdentityVerification::Missing) => io::Error::new(
                io::ErrorKind::NotFound,
                format!(
                    "authenticated descendant {expected:?} exited during stopped-state sampling"
                ),
            ),
            Ok(IdentityVerification::Matches) => io::Error::new(
                io::ErrorKind::WouldBlock,
                format!(
                    "PROC_PIDTBSDINFO reported ESRCH while authenticated descendant {expected:?} is still live"
                ),
            ),
            Ok(IdentityVerification::Mismatch(actual)) => identity_mismatch(expected, &actual),
            Err(verification_error) => contextual(
                verification_error,
                "recheck descendant identity after PROC_PIDTBSDINFO ESRCH",
            ),
        }
    }

    fn require_process_stopped(expected: &ProcessIdentity) -> io::Result<()> {
        let status = read_verified_process_status(expected)?;
        if status == libc::SSTOP || status == libc::SZOMB {
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                format!("descendant {expected:?} is not stopped (kernel status {status})"),
            ))
        }
    }

    fn inventory_anchored_process_group(
        watcher: &AnchorExitWatcher,
    ) -> io::Result<LiveProcessGroupSnapshot> {
        watcher.require_exit_unreaped()?;
        let expected = watcher.identity();
        let pids = list_process_group_pids(expected.pgid)?;
        let mut members = Vec::with_capacity(pids.len());
        let mut zombie_pids = Vec::new();
        for pid in pids {
            if pid == expected.pid {
                // Darwin's live-process identity APIs return ESRCH for an exited child. The
                // waitid(WNOWAIT) proof above is stronger here: this exact direct child is still
                // held unreaped, so its PID cannot have been recycled.
                members.push(expected);
            } else {
                match read_live_group_member(pid, expected.pgid)? {
                    LiveGroupMember::Live(identity) => members.push(identity),
                    LiveGroupMember::Zombie => zombie_pids.push(pid),
                    LiveGroupMember::Vanished => {}
                }
            }
        }
        // Close the inventory race before its contents can authorize an empty proof.
        watcher.require_exit_unreaped()?;
        finish_process_group_snapshot(expected.pgid, members, zombie_pids)
    }

    fn descendant_snapshot(
        anchor: &ProcessIdentity,
        mut snapshot: LiveProcessGroupSnapshot,
    ) -> LiveProcessGroupSnapshot {
        snapshot.members.retain(|member| member.pid != anchor.pid);
        snapshot.zombie_pids.retain(|pid| *pid != anchor.pid);
        snapshot
    }

    /// Proof that the caller still owns the authenticated protocol channel of a live anchor.
    ///
    /// `after_authenticated_handshake` is crate-visible on purpose: this low-level module cannot
    /// authenticate guardian frames itself. Its caller must construct the capability only after
    /// matching the protocol token, generation, run ID, and anchor process identity. Keeping the
    /// borrowed descriptor open is not a macOS pidfd and does not make signalling atomic; the
    /// direct parent must also defer reaping the anchor across each signal operation.
    #[derive(Debug)]
    pub struct LiveAnchorProtocolLiveness<'a> {
        anchor: ProcessIdentity,
        channel: BorrowedFd<'a>,
    }

    impl<'a> LiveAnchorProtocolLiveness<'a> {
        #[allow(dead_code)] // Consumed by the supervisor module in the same integration checkpoint.
        pub(crate) fn after_authenticated_handshake<T: AsFd + ?Sized>(
            anchor: ProcessIdentity,
            authenticated_channel: &'a T,
        ) -> io::Result<Self> {
            require_group_leader(&anchor)?;
            require_identity_match(&anchor)?;
            let liveness = Self {
                anchor,
                channel: authenticated_channel.as_fd(),
            };
            liveness.require_live_for(&anchor)?;
            Ok(liveness)
        }

        pub fn anchor(&self) -> ProcessIdentity {
            self.anchor
        }

        fn require_live_for(&self, expected_anchor: &ProcessIdentity) -> io::Result<()> {
            require_group_leader(expected_anchor)?;
            if self.anchor != *expected_anchor {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "live protocol capability does not belong to the expected anchor",
                ));
            }
            require_protocol_channel_live(self.channel)
        }
    }

    /// Signals a live anchor group only while the same caller also proves direct-child reap
    /// ownership. The separate watcher parameter makes it impossible for an authenticated
    /// non-parent channel alone to become numeric signalling authority.
    pub fn signal_live_anchor_group(
        expected_anchor: &ProcessIdentity,
        liveness: &LiveAnchorProtocolLiveness<'_>,
        watcher: &AnchorExitWatcher,
        signal: i32,
    ) -> io::Result<GroupSignalOutcome> {
        watcher.require_owned_unreaped(expected_anchor)?;
        liveness.require_live_for(expected_anchor)?;
        require_group_leader(expected_anchor)?;
        // Signal zero is only an existence probe and must never masquerade as a delivered
        // control signal. Darwin's kill(2) rejects every out-of-range positive value with EINVAL.
        if signal <= 0 {
            return Err(invalid("signal number is invalid"));
        }
        match verify_process_identity(expected_anchor)? {
            IdentityVerification::Matches => {}
            IdentityVerification::Missing => {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "expected live anchor no longer exists",
                ));
            }
            IdentityVerification::Mismatch(actual) => {
                return Err(identity_mismatch(expected_anchor, &actual));
            }
        }
        // A terminal whole-group signal intentionally closes the anchor protocol. Liveness is
        // therefore required immediately before the identity check and signal, not after it.
        let outcome = signal_process_group(expected_anchor.pgid, signal)?;
        watcher.require_owned_unreaped(expected_anchor)?;
        Ok(outcome)
    }

    /// Signals only the trusted live anchor. The cleanup protocol uses this for `SIGCONT` after
    /// the whole group has been frozen, leaving untrusted descendants stopped while the anchor
    /// reaps its direct target and prepares the final result. Direct-child ownership pins the
    /// PID on both sides of the syscall.
    pub fn signal_live_anchor_process(
        expected_anchor: &ProcessIdentity,
        liveness: &LiveAnchorProtocolLiveness<'_>,
        watcher: &AnchorExitWatcher,
        signal: i32,
    ) -> io::Result<()> {
        watcher.require_owned_unreaped(expected_anchor)?;
        liveness.require_live_for(expected_anchor)?;
        require_group_leader(expected_anchor)?;
        if signal <= 0 {
            return Err(invalid("signal number is invalid"));
        }
        require_identity_match(expected_anchor)?;
        loop {
            if unsafe { libc::kill(expected_anchor.pid, signal) } == 0 {
                break;
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
        watcher.require_owned_unreaped(expected_anchor)?;
        liveness.require_live_for(expected_anchor)
    }

    /// Verifies that every currently inventoried member except the trusted anchor is stopped (or
    /// already a zombie), using two equal bounded snapshots.
    ///
    /// This is the fail-closed barrier used after the controller has stopped the whole group and
    /// continued only the anchor. A missing, running, replaced, or newly appeared descendant
    /// makes the proof fail; the caller must not start direct-child cleanup from that snapshot.
    pub fn verify_live_anchor_descendants_stopped(
        expected_anchor: &ProcessIdentity,
        liveness: &LiveAnchorProtocolLiveness<'_>,
    ) -> io::Result<Vec<ProcessIdentity>> {
        liveness.require_live_for(expected_anchor)?;
        require_identity_match(expected_anchor)?;

        let first = inventory_live_process_group(expected_anchor.pgid)?;
        require_exact_anchor_in_inventory(expected_anchor, &first.members)?;
        let first_descendants = descendants(expected_anchor, &first.members);
        for descendant in &first_descendants {
            require_process_stopped(descendant)?;
        }

        let confirmation = inventory_live_process_group(expected_anchor.pgid)?;
        if confirmation != first {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                format!(
                    "process-group membership changed during stopped-state proof: first={first:?}, confirmation={confirmation:?}"
                ),
            ));
        }
        for descendant in descendants(expected_anchor, &confirmation.members) {
            require_process_stopped(&descendant)?;
        }
        liveness.require_live_for(expected_anchor)?;
        require_identity_match(expected_anchor)?;
        Ok(first_descendants)
    }

    #[derive(Debug)]
    pub struct AnchorExitWatcher {
        descriptor: RawFd,
        expected: ProcessIdentity,
        observed_exit: bool,
        reaped: bool,
    }

    impl AnchorExitWatcher {
        pub fn new(expected: ProcessIdentity) -> io::Result<Self> {
            require_group_leader(&expected)?;
            require_identity_match(&expected)?;
            let already_exited = waitid_exit_unreaped(expected.pid).map_err(|error| {
                contextual(
                    error,
                    "anchor must be a waitable direct child before watcher registration",
                )
            })?;
            let descriptor = loop {
                let descriptor = unsafe { libc::kqueue() };
                if descriptor >= 0 {
                    break descriptor;
                }
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            };
            if let Err(error) = set_close_on_exec(descriptor) {
                unsafe {
                    libc::close(descriptor);
                }
                return Err(error);
            }
            let change = libc::kevent {
                ident: expected.pid as libc::uintptr_t,
                filter: libc::EVFILT_PROC,
                flags: libc::EV_ADD | libc::EV_ENABLE | libc::EV_ONESHOT,
                fflags: libc::NOTE_EXIT,
                data: 0,
                udata: std::ptr::null_mut(),
            };
            loop {
                let result = unsafe {
                    libc::kevent(
                        descriptor,
                        &change,
                        1,
                        std::ptr::null_mut(),
                        0,
                        std::ptr::null(),
                    )
                };
                if result >= 0 {
                    break;
                }
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    unsafe {
                        libc::close(descriptor);
                    }
                    return Err(error);
                }
            }
            // Registration is not a PID handle. Re-read the start identity after EV_ADD so a
            // process replacement can never be mistaken for the expected child.
            if let Err(error) = require_identity_match(&expected) {
                unsafe {
                    libc::close(descriptor);
                }
                return Err(error);
            }
            let observed_exit = if already_exited {
                true
            } else {
                match waitid_exit_unreaped(expected.pid) {
                    Ok(observed_exit) => observed_exit,
                    Err(error) => {
                        unsafe {
                            libc::close(descriptor);
                        }
                        return Err(contextual(
                            error,
                            "anchor stopped being a waitable direct child during watcher registration",
                        ));
                    }
                }
            };
            Ok(Self {
                descriptor,
                expected,
                observed_exit,
                reaped: false,
            })
        }

        pub fn identity(&self) -> ProcessIdentity {
            self.expected
        }

        pub fn poll_exit_unreaped(&mut self) -> io::Result<bool> {
            self.wait_once(Duration::ZERO)
        }

        pub fn wait_for_exit_unreaped(
            &mut self,
            options: DrainOptions,
            mut on_stall: impl FnMut(DrainStall),
        ) -> io::Result<()> {
            let options = options.validate()?;
            let started = Instant::now();
            let mut next_stall = started + options.stall_interval;
            loop {
                if self.wait_once(options.poll_interval)? {
                    return Ok(());
                }
                if Instant::now() >= next_stall {
                    on_stall(DrainStall {
                        phase: DrainPhase::WaitingForAnchorExit,
                        elapsed: started.elapsed(),
                        observed_members: Vec::new(),
                        detail: "anchor has not exited; its direct parent still owns the watcher"
                            .into(),
                    });
                    next_stall = Instant::now() + options.stall_interval;
                }
            }
        }

        fn wait_once(&mut self, timeout: Duration) -> io::Result<bool> {
            if self.reaped {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "process-group anchor was already reaped",
                ));
            }
            if self.observed_exit || waitid_exit_unreaped(self.expected.pid)? {
                // A waitable direct child cannot have its PID reused. Its start identity was
                // verified on both sides of kqueue registration, while it was still live.
                self.observed_exit = true;
                return Ok(true);
            }

            let mut event: libc::kevent = unsafe { std::mem::zeroed() };
            let timeout = duration_timespec(timeout);
            let count = unsafe {
                libc::kevent(
                    self.descriptor,
                    std::ptr::null(),
                    0,
                    &mut event,
                    1,
                    &timeout,
                )
            };
            if count < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    return Ok(false);
                }
                return Err(error);
            }
            if count == 0 {
                return Ok(false);
            }
            if event.flags & libc::EV_ERROR != 0 {
                return Err(io::Error::from_raw_os_error(event.data as i32));
            }
            if event.ident != self.expected.pid as libc::uintptr_t
                || event.filter != libc::EVFILT_PROC
                || event.fflags & libc::NOTE_EXIT == 0
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "kqueue returned an unexpected anchor event",
                ));
            }
            // Darwin can publish EVFILT_PROC/NOTE_EXIT just before waitid(WNOWAIT) exposes the
            // child's terminal status to its direct parent. The kqueue registration authenticates
            // which PID exited, but it is not a substitute for the wait ownership proof used by
            // the deferred-reap protocol. Close only that observation race with a bounded retry;
            // ECHILD and every other waitid error still fail immediately.
            if !wait_for_condition(
                NOTE_EXIT_WAITABLE_TIMEOUT,
                NOTE_EXIT_WAITABLE_POLL_INTERVAL,
                || waitid_exit_unreaped(self.expected.pid),
            )? {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!(
                        "NOTE_EXIT child did not become waitable within {:?}",
                        NOTE_EXIT_WAITABLE_TIMEOUT
                    ),
                ));
            }
            self.observed_exit = true;
            Ok(true)
        }

        fn require_exit_unreaped(&self) -> io::Result<()> {
            if self.reaped || !self.observed_exit {
                return Err(invalid("anchor must be observed exited and unreaped"));
            }
            if !waitid_exit_unreaped(self.expected.pid)? {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "anchor is no longer a waitable unreaped direct child",
                ));
            }
            Ok(())
        }

        fn require_owned_unreaped(&self, expected: &ProcessIdentity) -> io::Result<()> {
            if self.reaped {
                return Err(invalid("anchor direct child was already reaped"));
            }
            if self.expected != *expected {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!(
                        "anchor reap pin identity mismatch: expected {expected:?}, watcher owns {:?}",
                        self.expected
                    ),
                ));
            }
            // Both false (still live) and true (exited zombie) prove that this process remains
            // the caller's waitable direct child. Either state pins its PID against reuse.
            waitid_exit_unreaped(self.expected.pid)
                .map(|_| ())
                .map_err(|error| {
                    contextual(
                        error,
                        "anchor signalling requires direct-child reap ownership",
                    )
                })
        }

        fn reap(&mut self) -> io::Result<ReapedAnchor> {
            self.require_exit_unreaped()?;
            let mut raw_status = 0_i32;
            let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
            loop {
                let waited =
                    unsafe { libc::wait4(self.expected.pid, &mut raw_status, 0, &mut usage) };
                if waited == self.expected.pid {
                    self.reaped = true;
                    return Ok(ReapedAnchor {
                        status: ExitStatus::from_raw(raw_status),
                        raw_wait_status: raw_status,
                        rusage: AnchorRusage {
                            user_time_us: timeval_us(usage.ru_utime),
                            system_time_us: timeval_us(usage.ru_stime),
                            // Darwin reports ru_maxrss in bytes.
                            max_rss_bytes: usage.ru_maxrss.max(0) as u64,
                        },
                    });
                }
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
        }
    }

    impl Drop for AnchorExitWatcher {
        fn drop(&mut self) {
            if self.descriptor >= 0 {
                unsafe {
                    libc::close(self.descriptor);
                }
                self.descriptor = -1;
            }
        }
    }

    /// Stops and kills the whole process group while an exited direct-child anchor remains
    /// unreaped, then reaps that anchor only after two bounded empty inventories.
    ///
    /// A group-signal error is terminal for this call. In particular, Darwin `EPERM` is surfaced
    /// with the exact anchored identity and current bounded inventory. The function never falls
    /// back to signalling individual descendants.
    pub fn stop_kill_anchor_group_and_reap(
        watcher: &mut AnchorExitWatcher,
        options: DrainOptions,
        mut on_stall: impl FnMut(DrainStall),
    ) -> io::Result<ReapedAnchor> {
        let options = options.validate()?;
        if !watcher
            .poll_exit_unreaped()
            .map_err(|error| contextual(error, "poll exited anchor"))?
        {
            return Err(invalid(
                "anchor must exit before deferred whole-group drain begins",
            ));
        }

        let anchor = watcher.identity();
        let started = Instant::now();
        let mut next_stall = started + options.stall_interval;
        let mut empty_observations = 0_u8;
        let mut previous_stopped_snapshot: Option<LiveProcessGroupSnapshot> = None;

        loop {
            let snapshot = match inventory_anchored_process_group(watcher) {
                Ok(snapshot) => descendant_snapshot(&anchor, snapshot),
                Err(error) => {
                    let detail = format!(
                        "anchored process-group inventory failed; anchor remains unreaped: {error}"
                    );
                    report_stall_if_due(
                        &mut next_stall,
                        started,
                        options,
                        DrainPhase::InventoryUnavailable,
                        &[],
                        &detail,
                        &mut on_stall,
                    );
                    thread::sleep(options.poll_interval);
                    continue;
                }
            };
            let members = snapshot.members.clone();

            if snapshot_is_physically_empty(&snapshot) {
                empty_observations = empty_observations.saturating_add(1);
                previous_stopped_snapshot = None;
                if empty_observations >= 2 {
                    break;
                }
                // The unreaped direct-child anchor pins both its PID and PGID, and an empty
                // group has no live member that could fork between observations. Take the
                // second independent kernel inventory immediately; the poll interval remains
                // reserved for non-empty, changing, or unavailable inventories.
                continue;
            }
            empty_observations = 0;

            if members.is_empty() {
                previous_stopped_snapshot = None;
                let detail = format!(
                    "{} zombie descendant(s) remain while no live descendant can fork; waiting for their parent/reaper without signalling an unpinned PID",
                    snapshot.zombie_pids.len()
                );
                report_stall_if_due(
                    &mut next_stall,
                    started,
                    options,
                    DrainPhase::DrainingDescendants,
                    &[],
                    &detail,
                    &mut on_stall,
                );
                thread::sleep(options.poll_interval);
                continue;
            }

            if let Err(error) = require_anchored_group_signal(watcher, libc::SIGSTOP) {
                return Err(group_signal_failure(
                    &anchor,
                    libc::SIGSTOP,
                    &members,
                    error,
                    started,
                    &mut on_stall,
                ));
            }

            let stopped_snapshot = match inventory_anchored_process_group(watcher) {
                Ok(snapshot) => descendant_snapshot(&anchor, snapshot),
                Err(error) => {
                    let detail = format!(
                        "post-SIGSTOP inventory failed; anchor remains unreaped and no per-PID fallback is permitted: {error}"
                    );
                    on_stall(DrainStall {
                        phase: DrainPhase::InventoryUnavailable,
                        elapsed: started.elapsed(),
                        observed_members: members,
                        detail: detail.clone(),
                    });
                    return Err(io::Error::new(error.kind(), detail));
                }
            };
            let stopped_members = stopped_snapshot.members.clone();

            // Two equal snapshots separated by a whole-group SIGSTOP prove that every observed
            // live descendant was present for a stop pass. Zombie membership is retained in the
            // comparison so it can never be mistaken for an empty containment proof.
            if previous_stopped_snapshot.as_ref() != Some(&stopped_snapshot) {
                previous_stopped_snapshot = Some(stopped_snapshot.clone());
                let detail = format!(
                    "whole-group SIGSTOP pass observed {} live and {} zombie descendant(s); repeating for a stable bounded inventory",
                    stopped_members.len(),
                    stopped_snapshot.zombie_pids.len()
                );
                report_stall_if_due(
                    &mut next_stall,
                    started,
                    options,
                    DrainPhase::DrainingDescendants,
                    &stopped_members,
                    &detail,
                    &mut on_stall,
                );
                thread::sleep(options.poll_interval);
                continue;
            }

            if stopped_members.is_empty() {
                previous_stopped_snapshot = None;
                thread::sleep(options.poll_interval);
                continue;
            }
            if let Err(error) = require_anchored_group_signal(watcher, libc::SIGKILL) {
                return Err(group_signal_failure(
                    &anchor,
                    libc::SIGKILL,
                    &stopped_members,
                    error,
                    started,
                    &mut on_stall,
                ));
            }
            previous_stopped_snapshot = None;
            let detail = format!(
                "sent whole-group SIGSTOP then SIGKILL with {} live and {} zombie descendant(s) inventoried",
                stopped_members.len(),
                stopped_snapshot.zombie_pids.len()
            );
            report_stall_if_due(
                &mut next_stall,
                started,
                options,
                DrainPhase::DrainingDescendants,
                &stopped_members,
                &detail,
                &mut on_stall,
            );
            thread::sleep(options.poll_interval);
        }

        let reaped = watcher
            .reap()
            .map_err(|error| contextual(error, "reap anchored supervisor"))?;
        let mut final_empty_observations = 0_u8;
        loop {
            match list_process_group_pids(anchor.pgid) {
                Ok(final_pids) if final_pids.is_empty() => {
                    final_empty_observations = final_empty_observations.saturating_add(1);
                    if final_empty_observations >= 2 {
                        return Ok(reaped);
                    }
                    // A second immediate proc_listpids call is still an independent inventory.
                    // Waiting here cannot prevent future numeric PGID reuse after this function
                    // returns, while it adds a fixed delay to every successfully drained run.
                    continue;
                }
                Ok(final_pids) => {
                    final_empty_observations = 0;
                    let detail = format!(
                        "numeric process group {} still has raw PID rows {final_pids:?} after anchor reap; no signal is authorized and the generation guard must remain held",
                        anchor.pgid,
                    );
                    report_stall_if_due(
                        &mut next_stall,
                        started,
                        options,
                        DrainPhase::FinalInventoryNonEmpty,
                        &[],
                        &detail,
                        &mut on_stall,
                    );
                }
                Err(error) => {
                    final_empty_observations = 0;
                    let detail = format!(
                        "final process-group inventory failed; the generation guard must remain held: {error}"
                    );
                    report_stall_if_due(
                        &mut next_stall,
                        started,
                        options,
                        DrainPhase::InventoryUnavailable,
                        &[],
                        &detail,
                        &mut on_stall,
                    );
                }
            }
            thread::sleep(options.poll_interval);
        }
    }

    fn signal_group_under_unreaped_anchor(
        watcher: &AnchorExitWatcher,
        signal: i32,
    ) -> io::Result<GroupSignalOutcome> {
        if signal != libc::SIGSTOP && signal != libc::SIGKILL {
            return Err(invalid(
                "deferred anchor drain only permits SIGSTOP or SIGKILL",
            ));
        }
        watcher.require_exit_unreaped()?;
        let outcome = signal_process_group(watcher.identity().pgid, signal)?;
        watcher.require_exit_unreaped()?;
        Ok(outcome)
    }

    fn require_anchored_group_signal(watcher: &AnchorExitWatcher, signal: i32) -> io::Result<()> {
        match signal_group_under_unreaped_anchor(watcher, signal)? {
            GroupSignalOutcome::Sent => Ok(()),
            GroupSignalOutcome::GroupMissing => Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!(
                    "anchored process group {} disappeared before signal {signal}",
                    watcher.identity().pgid
                ),
            )),
        }
    }

    fn signal_process_group(pgid: i32, signal: i32) -> io::Result<GroupSignalOutcome> {
        if pgid <= 1 || signal <= 0 {
            return Err(invalid("process group or signal is invalid"));
        }
        loop {
            if unsafe { libc::kill(-pgid, signal) } == 0 {
                return Ok(GroupSignalOutcome::Sent);
            }
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return if error.raw_os_error() == Some(libc::ESRCH) {
                Ok(GroupSignalOutcome::GroupMissing)
            } else {
                Err(error)
            };
        }
    }

    fn group_signal_failure(
        anchor: &ProcessIdentity,
        signal: i32,
        members: &[ProcessIdentity],
        error: io::Error,
        started: Instant,
        on_stall: &mut impl FnMut(DrainStall),
    ) -> io::Error {
        let detail = format!(
            "whole-group signal {signal} failed under unreaped anchor {anchor:?}; no per-PID fallback was attempted: {error}"
        );
        on_stall(DrainStall {
            phase: DrainPhase::GroupSignalFailed,
            elapsed: started.elapsed(),
            observed_members: members.to_vec(),
            detail: detail.clone(),
        });
        io::Error::new(error.kind(), detail)
    }

    fn require_protocol_channel_live(channel: BorrowedFd<'_>) -> io::Result<()> {
        let mut pollfd = libc::pollfd {
            fd: channel.as_raw_fd(),
            events: 0,
            revents: 0,
        };
        loop {
            let result = unsafe { libc::poll(&mut pollfd, 1, 0) };
            if result >= 0 {
                let terminal = libc::POLLERR | libc::POLLHUP | libc::POLLNVAL;
                if pollfd.revents & terminal != 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        format!(
                            "authenticated anchor protocol channel is no longer live (poll revents={:#x})",
                            pollfd.revents
                        ),
                    ));
                }
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }

    fn read_start_abstime(pid: i32) -> io::Result<u64> {
        let mut usage: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
        loop {
            let result = unsafe {
                libc::proc_pid_rusage(
                    pid,
                    libc::RUSAGE_INFO_V2,
                    (&mut usage as *mut libc::rusage_info_v2).cast(),
                )
            };
            if result == 0 {
                break;
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
        if usage.ri_proc_start_abstime == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "kernel returned a zero process start timestamp",
            ));
        }
        Ok(usage.ri_proc_start_abstime)
    }

    fn waitid_exit_unreaped(pid: i32) -> io::Result<bool> {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        loop {
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result == 0 {
                let observed_pid = unsafe { info.si_pid() };
                if observed_pid == 0 {
                    return Ok(false);
                }
                if observed_pid != pid {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("waitid returned PID {observed_pid}, expected {pid}"),
                    ));
                }
                return Ok(true);
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }

    fn wait_for_condition(
        timeout: Duration,
        poll_interval: Duration,
        mut observe: impl FnMut() -> io::Result<bool>,
    ) -> io::Result<bool> {
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| io::Error::other("condition deadline overflow"))?;
        loop {
            if observe()? {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            if poll_interval.is_zero() {
                thread::yield_now();
            } else {
                thread::sleep(poll_interval);
            }
        }
    }

    fn require_group_leader(identity: &ProcessIdentity) -> io::Result<()> {
        identity.validate()?;
        if identity.pid == identity.pgid {
            Ok(())
        } else {
            Err(invalid("expected anchor is not its process-group leader"))
        }
    }

    fn require_identity_match(expected: &ProcessIdentity) -> io::Result<()> {
        match verify_process_identity(expected)? {
            IdentityVerification::Matches => Ok(()),
            IdentityVerification::Missing => Err(io::Error::new(
                io::ErrorKind::NotFound,
                "expected process identity is missing",
            )),
            IdentityVerification::Mismatch(actual) => Err(identity_mismatch(expected, &actual)),
        }
    }

    fn descendants(anchor: &ProcessIdentity, members: &[ProcessIdentity]) -> Vec<ProcessIdentity> {
        members
            .iter()
            .copied()
            .filter(|identity| identity.pid != anchor.pid)
            .collect()
    }

    #[allow(clippy::too_many_arguments)]
    fn report_stall_if_due(
        next_stall: &mut Instant,
        started: Instant,
        options: DrainOptions,
        phase: DrainPhase,
        members: &[ProcessIdentity],
        detail: &str,
        on_stall: &mut impl FnMut(DrainStall),
    ) {
        if Instant::now() < *next_stall {
            return;
        }
        on_stall(DrainStall {
            phase,
            elapsed: started.elapsed(),
            observed_members: members.to_vec(),
            detail: detail.to_owned(),
        });
        *next_stall = Instant::now() + options.stall_interval;
    }

    fn identity_mismatch(expected: &ProcessIdentity, actual: &ProcessIdentity) -> io::Error {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("process identity mismatch: expected {expected:?}, observed {actual:?}"),
        )
    }

    fn set_close_on_exec(descriptor: RawFd) -> io::Result<()> {
        let flags = loop {
            let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
            if flags >= 0 {
                break flags;
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        };
        loop {
            if unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags | libc::FD_CLOEXEC) } >= 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }

    fn duration_timespec(duration: Duration) -> libc::timespec {
        libc::timespec {
            tv_sec: duration.as_secs().min(libc::time_t::MAX as u64) as libc::time_t,
            tv_nsec: duration.subsec_nanos() as libc::c_long,
        }
    }

    fn timeval_us(value: libc::timeval) -> u64 {
        (value.tv_sec.max(0) as u64)
            .saturating_mul(1_000_000)
            .saturating_add(value.tv_usec.max(0) as u64)
    }

    fn invalid(message: &str) -> io::Error {
        io::Error::new(io::ErrorKind::InvalidInput, message)
    }

    fn contextual(error: io::Error, context: &str) -> io::Error {
        io::Error::new(error.kind(), format!("{context}: {error}"))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::fs::File;
        use std::os::fd::FromRawFd;
        use std::os::unix::process::CommandExt;
        use std::process::Command;

        #[test]
        fn proc_listpids_zero_with_errno_is_never_an_empty_inventory() {
            assert_eq!(
                decode_proc_listpids_result(0, 0).expect("decode physical empty inventory"),
                ProcListPidsOutcome::Bytes(0)
            );
            assert_eq!(
                decode_proc_listpids_result(0, libc::EINTR).expect("decode interrupted inventory"),
                ProcListPidsOutcome::Retry
            );
            assert_eq!(
                decode_proc_listpids_result(16, libc::EACCES)
                    .expect("positive byte count is authoritative"),
                ProcListPidsOutcome::Bytes(16)
            );
            assert_eq!(
                decode_proc_listpids_result(0, libc::EACCES)
                    .expect_err("API failure must not become an empty group")
                    .raw_os_error(),
                Some(libc::EACCES)
            );
        }

        #[test]
        fn physical_empty_proof_counts_zombies_as_members() {
            let live = ProcessIdentity {
                pid: 20,
                pgid: 20,
                start_abstime: 200,
            };
            assert!(snapshot_is_physically_empty(&LiveProcessGroupSnapshot {
                members: Vec::new(),
                zombie_pids: Vec::new(),
            }));
            assert!(!snapshot_is_physically_empty(&LiveProcessGroupSnapshot {
                members: Vec::new(),
                zombie_pids: vec![21],
            }));
            assert!(!snapshot_is_physically_empty(&LiveProcessGroupSnapshot {
                members: vec![live],
                zombie_pids: Vec::new(),
            }));
        }

        #[test]
        fn note_exit_confirmation_retries_a_transient_waitid_gap() {
            let mut attempts = 0_u8;
            assert!(
                wait_for_condition(Duration::from_secs(1), Duration::ZERO, || {
                    attempts = attempts.saturating_add(1);
                    Ok(attempts >= 3)
                })
                .expect("retry waitable-exit confirmation")
            );
            assert_eq!(attempts, 3);
        }

        #[test]
        fn status_sample_esrch_is_retryable_only_after_identity_recheck() {
            let mut descendant = Command::new("/bin/sleep")
                .arg("30")
                .spawn()
                .expect("spawn status-sample descendant");
            let identity = read_process_identity(descendant.id() as i32)
                .expect("read status-sample descendant identity");

            let live_error =
                process_status_sample_error(&identity, io::Error::from_raw_os_error(libc::ESRCH));
            assert_eq!(live_error.kind(), io::ErrorKind::WouldBlock);
            assert!(
                live_error.to_string().contains("still live"),
                "{live_error}"
            );

            descendant.kill().expect("kill status-sample descendant");
            descendant.wait().expect("reap status-sample descendant");
            let missing_error =
                process_status_sample_error(&identity, io::Error::from_raw_os_error(libc::ESRCH));
            assert_eq!(missing_error.kind(), io::ErrorKind::NotFound);
            assert!(
                missing_error.to_string().contains("exited"),
                "{missing_error}"
            );

            let unrelated =
                process_status_sample_error(&identity, io::Error::from_raw_os_error(libc::EACCES));
            assert_eq!(unrelated.raw_os_error(), Some(libc::EACCES));
        }

        #[test]
        fn identity_mismatch_never_signals_the_live_sentinel_group() {
            let mut sentinel = Command::new("/bin/sleep")
                .arg("30")
                .process_group(0)
                .spawn()
                .expect("spawn sentinel group");
            let identity =
                read_process_identity(sentinel.id() as i32).expect("read sentinel identity");
            assert_eq!(identity.pid, identity.pgid);
            let stale = ProcessIdentity {
                start_abstime: identity.start_abstime.saturating_add(1),
                ..identity
            };
            let watcher = AnchorExitWatcher::new(identity).expect("watch sentinel direct child");
            let protocol = pipe_pair();
            // SAFETY: the test transfers ownership of this descriptor into `File` exactly once.
            let protocol_read = unsafe { File::from_raw_fd(protocol.read) };
            let liveness =
                LiveAnchorProtocolLiveness::after_authenticated_handshake(identity, &protocol_read)
                    .expect("create authenticated live-anchor capability");
            let error = signal_live_anchor_group(&stale, &liveness, &watcher, libc::SIGKILL)
                .expect_err("stale identity must not signal the group");
            assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
            assert!(
                sentinel.try_wait().expect("poll sentinel").is_none(),
                "identity mismatch signalled the sentinel"
            );
            close_fd(protocol.write);
            sentinel.kill().expect("kill sentinel");
            sentinel.wait().expect("reap sentinel");
        }

        #[test]
        fn live_inventory_classifies_an_unreaped_zombie() {
            let anchor_pid = unsafe { libc::fork() };
            assert!(
                anchor_pid >= 0,
                "fork zombie inventory anchor: {}",
                io::Error::last_os_error()
            );
            if anchor_pid == 0 {
                if unsafe { libc::setpgid(0, 0) } != 0 {
                    unsafe { libc::_exit(101) };
                }
                let descendant_pid = unsafe { libc::fork() };
                if descendant_pid < 0 {
                    unsafe { libc::_exit(102) };
                }
                if descendant_pid == 0 {
                    unsafe {
                        libc::pause();
                        libc::_exit(103);
                    }
                }
                if unsafe { libc::kill(descendant_pid, libc::SIGKILL) } != 0 {
                    unsafe { libc::_exit(104) };
                }

                let deadline = Instant::now() + Duration::from_secs(1);
                loop {
                    match inventory_live_process_group(unsafe { libc::getpid() }) {
                        Ok(snapshot)
                            if snapshot
                                .members
                                .iter()
                                .any(|member| member.pid == unsafe { libc::getpid() })
                                && snapshot.zombie_pids.contains(&descendant_pid) =>
                        {
                            break;
                        }
                        Ok(_) if Instant::now() < deadline => {
                            thread::sleep(Duration::from_millis(1));
                        }
                        _ => unsafe { libc::_exit(105) },
                    }
                }

                let mut status = 0_i32;
                if unsafe { libc::waitpid(descendant_pid, &mut status, 0) } != descendant_pid {
                    unsafe { libc::_exit(106) };
                }
                unsafe { libc::_exit(0) };
            }

            let mut status = 0_i32;
            assert_eq!(
                unsafe { libc::waitpid(anchor_pid, &mut status, 0) },
                anchor_pid
            );
            let status = ExitStatus::from_raw(status);
            assert!(
                status.success(),
                "zombie inventory harness failed with {status:?}"
            );
        }

        #[test]
        fn anchored_drain_kills_live_parent_while_retaining_zombie_membership() {
            let ready = pipe_pair();
            let go = pipe_pair();
            let report = pipe_pair();
            let anchor_pid = unsafe { libc::fork() };
            assert!(
                anchor_pid >= 0,
                "fork zombie-drain anchor: {}",
                io::Error::last_os_error()
            );
            if anchor_pid == 0 {
                child_close_fd(ready.read);
                child_close_fd(go.write);
                child_close_fd(report.read);
                if unsafe { libc::setpgid(0, 0) } != 0 {
                    unsafe { libc::_exit(121) };
                }
                child_write_exact(ready.write, &[1], 122);
                let mut command = [0_u8; 1];
                child_read_exact(go.read, &mut command, 123);
                child_close_fd(ready.write);
                child_close_fd(go.read);

                let descendant_pid = unsafe { libc::fork() };
                if descendant_pid < 0 {
                    unsafe { libc::_exit(124) };
                }
                if descendant_pid == 0 {
                    let zombie_pid = unsafe { libc::fork() };
                    if zombie_pid < 0 {
                        unsafe { libc::_exit(125) };
                    }
                    if zombie_pid == 0 {
                        unsafe { libc::_exit(0) };
                    }

                    let mut zombie_observed = false;
                    for _ in 0..1_000 {
                        match waitid_exit_unreaped(zombie_pid) {
                            Ok(true) => {
                                zombie_observed = true;
                                break;
                            }
                            Ok(false) => {
                                let delay = libc::timespec {
                                    tv_sec: 0,
                                    tv_nsec: 1_000_000,
                                };
                                unsafe {
                                    libc::nanosleep(&delay, std::ptr::null_mut());
                                }
                            }
                            Err(_) => unsafe { libc::_exit(126) },
                        }
                    }
                    if !zombie_observed {
                        unsafe { libc::_exit(127) };
                    }

                    let mut identities = [0_u8; std::mem::size_of::<i32>() * 2];
                    let own_pid = unsafe { libc::getpid() };
                    identities[..std::mem::size_of::<i32>()]
                        .copy_from_slice(&own_pid.to_ne_bytes());
                    identities[std::mem::size_of::<i32>()..]
                        .copy_from_slice(&zombie_pid.to_ne_bytes());
                    child_write_exact(report.write, &identities, 128);
                    child_close_fd(report.write);
                    unsafe {
                        libc::pause();
                        libc::_exit(129);
                    }
                }
                child_close_fd(report.write);
                unsafe { libc::_exit(31) };
            }

            close_fd(ready.write);
            close_fd(go.read);
            close_fd(report.write);
            let mut ready_byte = [0_u8; 1];
            read_exact(ready.read, &mut ready_byte);
            close_fd(ready.read);

            let identity =
                read_process_identity(anchor_pid).expect("read zombie-drain anchor identity");
            let mut cleanup = TestAnchorCleanup::new(identity);
            let mut watcher = AnchorExitWatcher::new(identity).expect("watch zombie-drain anchor");
            write_exact(go.write, &[1]);
            close_fd(go.write);

            let mut reported = [0_u8; std::mem::size_of::<i32>() * 2];
            read_exact(report.read, &mut reported);
            close_fd(report.read);
            let descendant_pid = i32::from_ne_bytes(
                reported[..std::mem::size_of::<i32>()]
                    .try_into()
                    .expect("descendant PID bytes"),
            );
            let zombie_pid = i32::from_ne_bytes(
                reported[std::mem::size_of::<i32>()..]
                    .try_into()
                    .expect("zombie PID bytes"),
            );

            watcher
                .wait_for_exit_unreaped(
                    DrainOptions {
                        poll_interval: Duration::from_millis(1),
                        stall_interval: Duration::from_millis(100),
                    },
                    |_| {},
                )
                .expect("observe zombie-drain anchor exit");
            let before = inventory_anchored_process_group(&watcher)
                .expect("inventory group containing a live parent and zombie child");
            assert!(
                before
                    .members
                    .iter()
                    .any(|member| member.pid == descendant_pid),
                "live descendant missing from anchored inventory: {before:?}"
            );
            assert!(
                before.zombie_pids.contains(&zombie_pid),
                "zombie descendant missing from anchored inventory: {before:?}"
            );

            let reaped = stop_kill_anchor_group_and_reap(
                &mut watcher,
                DrainOptions {
                    poll_interval: Duration::from_millis(1),
                    stall_interval: Duration::from_millis(100),
                },
                |_| {},
            )
            .expect("drain live descendant despite retained zombie membership");
            cleanup.disarm_after_reap();
            assert_eq!(reaped.status.code(), Some(31));
            assert!(
                inventory_process_group(identity.pgid)
                    .expect("final zombie-drain inventory")
                    .is_empty(),
                "zombie-drain group was not empty after proof"
            );
        }

        #[test]
        fn stopped_descendant_proof_allows_only_the_anchor_to_resume() {
            let ready = pipe_pair();
            let exit_command = pipe_pair();
            let protocol = pipe_pair();
            let anchor_pid = unsafe { libc::fork() };
            assert!(
                anchor_pid >= 0,
                "fork proof anchor: {}",
                io::Error::last_os_error()
            );
            if anchor_pid == 0 {
                child_close_fd(ready.read);
                child_close_fd(exit_command.write);
                child_close_fd(protocol.read);
                if unsafe { libc::setpgid(0, 0) } != 0 {
                    unsafe { libc::_exit(111) };
                }
                let descendant_pid = unsafe { libc::fork() };
                if descendant_pid < 0 {
                    unsafe { libc::_exit(112) };
                }
                if descendant_pid == 0 {
                    child_close_fd(ready.write);
                    child_close_fd(exit_command.read);
                    child_close_fd(protocol.write);
                    let delay = libc::timespec {
                        tv_sec: 30,
                        tv_nsec: 0,
                    };
                    unsafe {
                        libc::nanosleep(&delay, std::ptr::null_mut());
                        libc::_exit(0);
                    }
                }
                child_write_exact(ready.write, &descendant_pid.to_ne_bytes(), 113);
                child_close_fd(ready.write);
                let mut command = [0_u8; 1];
                child_read_exact(exit_command.read, &mut command, 114);
                child_close_fd(exit_command.read);
                child_close_fd(protocol.write);
                unsafe { libc::_exit(24) };
            }

            close_fd(ready.write);
            close_fd(exit_command.read);
            close_fd(protocol.write);
            let mut descendant_pid = [0_u8; std::mem::size_of::<i32>()];
            read_exact(ready.read, &mut descendant_pid);
            close_fd(ready.read);
            let descendant_pid = i32::from_ne_bytes(descendant_pid);

            let identity = read_process_identity(anchor_pid).expect("read proof anchor identity");
            let mut cleanup = TestAnchorCleanup::new(identity);
            let mut watcher = AnchorExitWatcher::new(identity).expect("watch proof anchor");
            // SAFETY: the test transfers this descriptor into `File` exactly once.
            let protocol_read = unsafe { File::from_raw_fd(protocol.read) };
            let liveness =
                LiveAnchorProtocolLiveness::after_authenticated_handshake(identity, &protocol_read)
                    .expect("create proof liveness capability");

            let running_error = verify_live_anchor_descendants_stopped(&identity, &liveness)
                .expect_err("running descendant must not satisfy the STOP proof");
            assert_eq!(running_error.kind(), io::ErrorKind::WouldBlock);
            assert_eq!(
                signal_live_anchor_group(&identity, &liveness, &watcher, libc::SIGSTOP)
                    .expect("stop proof group"),
                GroupSignalOutcome::Sent
            );

            let stopped = wait_for_stopped_descendants(&identity, &liveness);
            assert!(
                stopped.iter().any(|member| member.pid == descendant_pid),
                "stopped proof omitted the descendant: {stopped:?}"
            );
            signal_live_anchor_process(&identity, &liveness, &watcher, libc::SIGCONT)
                .expect("continue only the trusted anchor");
            write_exact(exit_command.write, &[1]);
            close_fd(exit_command.write);

            watcher
                .wait_for_exit_unreaped(
                    DrainOptions {
                        poll_interval: Duration::from_millis(1),
                        stall_interval: Duration::from_millis(100),
                    },
                    |stall| eprintln!("proof watcher diagnostic: {stall:?}"),
                )
                .expect("observe proof anchor exit");
            let reaped = stop_kill_anchor_group_and_reap(
                &mut watcher,
                DrainOptions {
                    poll_interval: Duration::from_millis(1),
                    stall_interval: Duration::from_millis(100),
                },
                |stall| eprintln!("proof drain diagnostic: {stall:?}"),
            )
            .expect("drain proof group");
            cleanup.disarm_after_reap();
            assert_eq!(reaped.status.code(), Some(24));
        }

        #[test]
        fn unreaped_anchor_whole_group_stop_kill_is_stable_across_20_runs() {
            for iteration in 0..20 {
                run_unreaped_anchor_regression(iteration);
            }
        }

        fn wait_for_stopped_descendants(
            identity: &ProcessIdentity,
            liveness: &LiveAnchorProtocolLiveness<'_>,
        ) -> Vec<ProcessIdentity> {
            let started = Instant::now();
            loop {
                match verify_live_anchor_descendants_stopped(identity, liveness) {
                    Ok(descendants) => return descendants,
                    Err(error)
                        if error.kind() == io::ErrorKind::WouldBlock
                            || error.kind() == io::ErrorKind::NotFound
                            || error.kind() == io::ErrorKind::InvalidData =>
                    {
                        assert!(
                            started.elapsed() < Duration::from_secs(2),
                            "stopped proof did not stabilize: {error}"
                        );
                        thread::sleep(Duration::from_millis(1));
                    }
                    Err(error) => panic!("stopped proof failed: {error}"),
                }
            }
        }

        fn run_unreaped_anchor_regression(iteration: usize) {
            let ready = pipe_pair();
            let go = pipe_pair();
            let descendant = pipe_pair();
            let anchor_pid = unsafe { libc::fork() };
            assert!(
                anchor_pid >= 0,
                "iteration {iteration}: fork anchor: {}",
                io::Error::last_os_error()
            );
            if anchor_pid == 0 {
                child_close_fd(ready.read);
                child_close_fd(go.write);
                child_close_fd(descendant.read);
                if unsafe { libc::setpgid(0, 0) } != 0 {
                    unsafe { libc::_exit(101) };
                }
                child_write_exact(ready.write, &[1], 102);
                let mut command = [0_u8; 1];
                child_read_exact(go.read, &mut command, 103);
                child_close_fd(ready.write);
                child_close_fd(go.read);

                let descendant_pid = unsafe { libc::fork() };
                if descendant_pid < 0 {
                    unsafe { libc::_exit(104) };
                }
                if descendant_pid == 0 {
                    let pid = unsafe { libc::getpid() }.to_ne_bytes();
                    child_write_exact(descendant.write, &pid, 105);
                    child_close_fd(descendant.write);
                    let delay = libc::timespec {
                        tv_sec: 30,
                        tv_nsec: 0,
                    };
                    unsafe {
                        libc::nanosleep(&delay, std::ptr::null_mut());
                        libc::_exit(0);
                    }
                }
                child_close_fd(descendant.write);
                unsafe { libc::_exit(23) };
            }

            close_fd(ready.write);
            close_fd(go.read);
            close_fd(descendant.write);
            let mut ready_byte = [0_u8; 1];
            read_exact(ready.read, &mut ready_byte);
            close_fd(ready.read);

            let identity = read_process_identity(anchor_pid)
                .unwrap_or_else(|error| panic!("iteration {iteration}: read anchor: {error}"));
            assert_eq!(identity.pid, identity.pgid);
            let mut cleanup = TestAnchorCleanup::new(identity);
            let mut watcher = AnchorExitWatcher::new(identity)
                .unwrap_or_else(|error| panic!("iteration {iteration}: watch anchor: {error}"));

            write_exact(go.write, &[1]);
            close_fd(go.write);
            let mut descendant_pid = [0_u8; std::mem::size_of::<i32>()];
            read_exact(descendant.read, &mut descendant_pid);
            close_fd(descendant.read);
            let descendant_pid = i32::from_ne_bytes(descendant_pid);

            watcher
                .wait_for_exit_unreaped(
                    DrainOptions {
                        poll_interval: Duration::from_millis(1),
                        stall_interval: Duration::from_millis(100),
                    },
                    |stall| eprintln!("iteration {iteration}: wait diagnostic: {stall:?}"),
                )
                .unwrap_or_else(|error| {
                    panic!("iteration {iteration}: observe unreaped anchor: {error}")
                });
            let before = inventory_anchored_process_group(&watcher)
                .unwrap_or_else(|error| panic!("iteration {iteration}: inventory: {error}"));
            assert!(
                before
                    .members
                    .iter()
                    .any(|member| member.pid == descendant_pid),
                "iteration {iteration}: live descendant missing before whole-group drain: {before:?}"
            );

            let mut diagnostics = Vec::new();
            let reaped = stop_kill_anchor_group_and_reap(
                &mut watcher,
                DrainOptions {
                    poll_interval: Duration::from_millis(1),
                    stall_interval: Duration::from_millis(100),
                },
                |stall| diagnostics.push(stall),
            )
            .unwrap_or_else(|error| {
                panic!(
                    "iteration {iteration}: whole-group drain failed closed: {error}; diagnostics={diagnostics:#?}"
                )
            });
            cleanup.disarm_after_reap();

            assert_eq!(
                reaped.status.code(),
                Some(23),
                "iteration {iteration}: wrong anchor status"
            );
            assert!(
                inventory_process_group(identity.pgid)
                    .unwrap_or_else(|error| {
                        panic!("iteration {iteration}: final inventory: {error}")
                    })
                    .is_empty(),
                "iteration {iteration}: group not empty after successful drain"
            );
        }

        #[derive(Debug)]
        struct PipePair {
            read: i32,
            write: i32,
        }

        fn pipe_pair() -> PipePair {
            let mut descriptors = [-1_i32; 2];
            assert_eq!(unsafe { libc::pipe(descriptors.as_mut_ptr()) }, 0);
            PipePair {
                read: descriptors[0],
                write: descriptors[1],
            }
        }

        fn write_exact(descriptor: i32, bytes: &[u8]) {
            let mut offset = 0;
            while offset < bytes.len() {
                let written = unsafe {
                    libc::write(
                        descriptor,
                        bytes[offset..].as_ptr().cast(),
                        bytes.len() - offset,
                    )
                };
                if written > 0 {
                    offset += written as usize;
                    continue;
                }
                assert_ne!(written, 0, "write pipe made no progress");
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    panic!("write pipe: {error}");
                }
            }
        }

        fn read_exact(descriptor: i32, bytes: &mut [u8]) {
            let mut offset = 0;
            while offset < bytes.len() {
                let read = unsafe {
                    libc::read(
                        descriptor,
                        bytes[offset..].as_mut_ptr().cast(),
                        bytes.len() - offset,
                    )
                };
                if read > 0 {
                    offset += read as usize;
                    continue;
                }
                assert_ne!(read, 0, "unexpected pipe EOF after {offset} byte(s)");
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    panic!("read pipe: {error}");
                }
            }
        }

        fn child_write_exact(descriptor: i32, bytes: &[u8], failure_status: i32) {
            let mut offset = 0;
            while offset < bytes.len() {
                let written = unsafe {
                    libc::write(
                        descriptor,
                        bytes[offset..].as_ptr().cast(),
                        bytes.len() - offset,
                    )
                };
                if written > 0 {
                    offset += written as usize;
                } else if written == 0
                    || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted
                {
                    unsafe { libc::_exit(failure_status) };
                }
            }
        }

        fn child_read_exact(descriptor: i32, bytes: &mut [u8], failure_status: i32) {
            let mut offset = 0;
            while offset < bytes.len() {
                let read = unsafe {
                    libc::read(
                        descriptor,
                        bytes[offset..].as_mut_ptr().cast(),
                        bytes.len() - offset,
                    )
                };
                if read > 0 {
                    offset += read as usize;
                } else if read == 0
                    || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted
                {
                    unsafe { libc::_exit(failure_status) };
                }
            }
        }

        fn close_fd(descriptor: i32) {
            unsafe {
                libc::close(descriptor);
            }
        }

        fn child_close_fd(descriptor: i32) {
            unsafe {
                libc::close(descriptor);
            }
        }

        struct TestAnchorCleanup {
            identity: Option<ProcessIdentity>,
        }

        impl TestAnchorCleanup {
            fn new(identity: ProcessIdentity) -> Self {
                Self {
                    identity: Some(identity),
                }
            }

            fn disarm_after_reap(&mut self) {
                self.identity = None;
            }
        }

        impl Drop for TestAnchorCleanup {
            fn drop(&mut self) {
                let Some(identity) = self.identity.take() else {
                    return;
                };
                // This cleanup never verifies then signals a free numeric PGID. A successful
                // waitid probe proves that the anchor is still this process's direct child; if it
                // exits concurrently, it remains an unreaped zombie and its PID cannot be reused.
                if waitid_exit_unreaped(identity.pid).is_ok() {
                    loop {
                        if unsafe { libc::kill(-identity.pgid, libc::SIGKILL) } == 0 {
                            break;
                        }
                        let error = io::Error::last_os_error();
                        if error.kind() != io::ErrorKind::Interrupted {
                            break;
                        }
                    }
                }
                loop {
                    if unsafe { libc::waitpid(identity.pid, std::ptr::null_mut(), 0) }
                        == identity.pid
                    {
                        break;
                    }
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::Interrupted {
                        break;
                    }
                }
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::{
        DrainOptions, DrainStall, GroupSignalOutcome, IdentityVerification,
        LiveProcessGroupSnapshot, ProcessIdentity, ReapedAnchor,
    };
    use std::io;
    use std::marker::PhantomData;

    fn unsupported() -> io::Error {
        io::Error::new(
            io::ErrorKind::Unsupported,
            "macOS process guardian primitives are unavailable on this platform",
        )
    }

    pub fn read_process_identity(_pid: i32) -> io::Result<ProcessIdentity> {
        Err(unsupported())
    }

    pub fn verify_process_identity(
        _expected: &ProcessIdentity,
    ) -> io::Result<IdentityVerification> {
        Err(unsupported())
    }

    pub fn inventory_process_group(_pgid: i32) -> io::Result<Vec<ProcessIdentity>> {
        Err(unsupported())
    }

    pub fn inventory_live_process_group(_pgid: i32) -> io::Result<LiveProcessGroupSnapshot> {
        Err(unsupported())
    }

    #[derive(Debug)]
    pub struct LiveAnchorProtocolLiveness<'a>(PhantomData<&'a ()>);

    pub fn signal_live_anchor_group(
        _expected_anchor: &ProcessIdentity,
        _liveness: &LiveAnchorProtocolLiveness<'_>,
        _watcher: &AnchorExitWatcher,
        _signal: i32,
    ) -> io::Result<GroupSignalOutcome> {
        Err(unsupported())
    }

    pub fn signal_live_anchor_process(
        _expected_anchor: &ProcessIdentity,
        _liveness: &LiveAnchorProtocolLiveness<'_>,
        _watcher: &AnchorExitWatcher,
        _signal: i32,
    ) -> io::Result<()> {
        Err(unsupported())
    }

    pub fn verify_live_anchor_descendants_stopped(
        _expected_anchor: &ProcessIdentity,
        _liveness: &LiveAnchorProtocolLiveness<'_>,
    ) -> io::Result<Vec<ProcessIdentity>> {
        Err(unsupported())
    }

    #[derive(Debug)]
    pub struct AnchorExitWatcher;

    impl AnchorExitWatcher {
        pub fn new(_expected: ProcessIdentity) -> io::Result<Self> {
            Err(unsupported())
        }

        pub fn identity(&self) -> ProcessIdentity {
            unreachable!("macOS process watcher cannot exist on this platform")
        }

        pub fn poll_exit_unreaped(&mut self) -> io::Result<bool> {
            Err(unsupported())
        }

        pub fn wait_for_exit_unreaped(
            &mut self,
            _options: DrainOptions,
            _on_stall: impl FnMut(DrainStall),
        ) -> io::Result<()> {
            Err(unsupported())
        }
    }

    pub fn stop_kill_anchor_group_and_reap(
        _watcher: &mut AnchorExitWatcher,
        _options: DrainOptions,
        _on_stall: impl FnMut(DrainStall),
    ) -> io::Result<ReapedAnchor> {
        Err(unsupported())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn non_macos_identity_lookup_is_explicitly_unsupported() {
            let error = read_process_identity(1).expect_err("non-macOS lookup must fail");
            assert_eq!(error.kind(), io::ErrorKind::Unsupported);
        }
    }
}

pub use imp::{
    inventory_live_process_group, inventory_process_group, read_process_identity,
    signal_live_anchor_group, signal_live_anchor_process, stop_kill_anchor_group_and_reap,
    verify_live_anchor_descendants_stopped, verify_process_identity, AnchorExitWatcher,
    LiveAnchorProtocolLiveness,
};
