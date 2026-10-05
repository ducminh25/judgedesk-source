//! One-shot native descriptor transfer after the caller authenticates InstallStdio.
//!
//! The caller installs bounded socket read/write timeouts and serializes this transaction with
//! every other writer on the private supervisor channel. It must wait for the installation
//! acknowledgement before writing the next framed command; UnixStream has no message boundaries.

use std::fs::File;
use std::io;
use std::mem;
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::fs::FileTypeExt;
use std::os::unix::net::UnixStream;

const STDIO_MARKER: u8 = 0x53;
// Darwin's public <sys/fcntl.h> defines these commands, but libc 0.2.189 omits them.
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/fcntl.h
const F_SETNOSIGPIPE: libc::c_int = 73;
#[cfg(test)]
const F_GETNOSIGPIPE: libc::c_int = 74;

#[derive(Debug)]
pub struct TargetStdio {
    pub stdin: File,
    pub stdout: File,
}

#[derive(Debug)]
pub struct PipePair {
    pub target: TargetStdio,
    /// The coordinator writes input for this participant.
    pub input: File,
    /// The coordinator reads output produced by this participant.
    pub output: File,
}

impl PipePair {
    pub fn new() -> io::Result<Self> {
        let (stdin, input) = cloexec_pipe()?;
        let (output, stdout) = cloexec_pipe()?;
        set_nonblocking(&input)?;
        set_nonblocking(&output)?;
        // Suppress SIGPIPE only on the coordinator's writer. The target's stdout keeps the
        // ordinary pipe signal policy; no process-wide or inherited signal mask is changed.
        fcntl(input.as_raw_fd(), F_SETNOSIGPIPE, 1)?;
        Ok(Self {
            target: TargetStdio { stdin, stdout },
            input,
            output,
        })
    }
}

/// Transfers exactly one marker and two descriptors, consuming the sender's target-end copies.
///
/// The caller authenticates the installation command first, sets a write timeout, serializes
/// all writes, and waits for the supervisor's installation acknowledgement before continuing.
pub fn send_stdio(stream: &UnixStream, target: TargetStdio) -> io::Result<()> {
    validate_target_pipe(&target.stdin, libc::O_RDONLY)?;
    validate_target_pipe(&target.stdout, libc::O_WRONLY)?;
    protect_socket_from_sigpipe(stream)?;
    let descriptors = [target.stdin.as_raw_fd(), target.stdout.as_raw_fd()];
    let payload = [STDIO_MARKER];
    let mut control = [0_usize; 4];
    let mut iovec = libc::iovec {
        iov_base: payload.as_ptr().cast_mut().cast(),
        iov_len: payload.len(),
    };
    // SAFETY: Zero initialization gives an empty msghdr; valid buffers are installed below.
    let mut message: libc::msghdr = unsafe { mem::zeroed() };
    message.msg_iov = &mut iovec;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    // SAFETY: The two-descriptor payload is fixed and its ancillary space fits control.
    message.msg_controllen = unsafe { libc::CMSG_SPACE(mem::size_of_val(&descriptors) as _) };
    // SAFETY: control is aligned for cmsghdr and large enough for the fixed header/payload;
    // descriptors borrow open Files that remain owned throughout sendmsg.
    unsafe {
        let header = libc::CMSG_FIRSTHDR(&message);
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = libc::CMSG_LEN(mem::size_of_val(&descriptors) as _);
        std::ptr::copy_nonoverlapping(
            descriptors.as_ptr().cast::<u8>(),
            libc::CMSG_DATA(header),
            mem::size_of_val(&descriptors),
        );
    }
    loop {
        // SAFETY: message references live buffers and the sender still owns both descriptors.
        let sent = unsafe { libc::sendmsg(stream.as_raw_fd(), &message, 0) };
        if sent == 1 {
            // SCM_RIGHTS has installed independent receiver references. target drops here,
            // and also drops on every failure path; the coordinator keeps no target-side copy.
            return Ok(());
        }
        if sent == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "stdio transfer wrote no marker",
            ));
        }
        if sent > 0 {
            return Err(invalid("stdio transfer wrote an unexpected marker length"));
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

/// Receives one authenticated-command-following stdio transaction and owns all delivered FDs.
///
/// Read timeouts and protocol authentication belong to the caller. This function never reads a
/// framed command: it must be called only after the complete InstallStdio frame was authenticated.
pub fn receive_stdio(stream: &UnixStream) -> io::Result<TargetStdio> {
    let mut payload = [0_u8; 2];
    // Darwin externalizes the entire rights record before copying ancillary bytes out;
    // a short receive buffer can hide installed FDs rather than closing the surplus.
    // XNU UIPC_MAX_CMSG_FD is 512. Cover its complete bounded record, then reject
    // extras while owning every delivered FD.
    // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/uipc_usrreq.c
    let mut control = [0_usize; 512];
    let mut iovec = libc::iovec {
        iov_base: payload.as_mut_ptr().cast(),
        iov_len: payload.len(),
    };
    // SAFETY: Zero initialization gives an empty msghdr; valid buffers are installed below.
    let mut message: libc::msghdr = unsafe { mem::zeroed() };
    message.msg_iov = &mut iovec;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    let received = loop {
        message.msg_controllen = mem::size_of_val(&control) as _;
        message.msg_flags = 0;
        // SAFETY: recvmsg receives into writable, aligned buffers with their exact capacities.
        let received = unsafe { libc::recvmsg(stream.as_raw_fd(), &mut message, 0) };
        if received >= 0 {
            break received;
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    };

    // Adopt all rights before inspecting the marker or rejecting truncation. Returning early
    // before this pass would leak descriptors already installed by recvmsg.
    let (mut descriptors, valid_control) = receive_rights(&message, mem::size_of_val(&control));
    if received == 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "stdio transfer ended before its marker",
        ));
    }
    if received != 1 || payload[0] != STDIO_MARKER {
        return Err(invalid("stdio transfer marker is invalid"));
    }
    if message.msg_flags & (libc::MSG_CTRUNC | libc::MSG_TRUNC) != 0 || !valid_control {
        return Err(invalid(
            "stdio transfer ancillary data is invalid or truncated",
        ));
    }
    if descriptors.len() != 2 {
        return Err(invalid("stdio transfer requires exactly two descriptors"));
    }
    for file in &descriptors {
        set_cloexec(file.as_raw_fd())?;
    }
    validate_target_pipe(&descriptors[0], libc::O_RDONLY)?;
    validate_target_pipe(&descriptors[1], libc::O_WRONLY)?;
    let stdout = descriptors
        .pop()
        .ok_or_else(|| invalid("stdio stdout descriptor is missing"))?;
    let stdin = descriptors
        .pop()
        .ok_or_else(|| invalid("stdio stdin descriptor is missing"))?;
    Ok(TargetStdio { stdin, stdout })
}

fn receive_rights(message: &libc::msghdr, capacity: usize) -> (Vec<File>, bool) {
    let control_length = (message.msg_controllen as usize).min(capacity);
    let control_start = message.msg_control as usize;
    let mut valid = message.msg_controllen as usize <= capacity;
    let mut descriptors: Vec<File> = Vec::new();
    let mut rights_records = 0;
    // SAFETY: recvmsg installed an aligned control buffer; FIRSTHDR only inspects its length.
    let mut header = unsafe { libc::CMSG_FIRSTHDR(message) };
    // SAFETY: CMSG_LEN(0) is the platform's fixed ancillary header-data offset.
    let header_length = unsafe { libc::CMSG_LEN(0) } as usize;
    while !header.is_null() {
        let Some(offset) = (header as usize).checked_sub(control_start) else {
            valid = false;
            break;
        };
        if offset > control_length || control_length - offset < mem::size_of::<libc::cmsghdr>() {
            valid = false;
            break;
        }
        // SAFETY: The complete header lies inside recvmsg's bounded, aligned control buffer.
        let current = unsafe { std::ptr::read_unaligned(header) };
        let length = current.cmsg_len as usize;
        if length < header_length {
            valid = false;
            break;
        }
        let available = control_length - offset;
        let data_length = length.min(available).saturating_sub(header_length);
        if current.cmsg_level == libc::SOL_SOCKET && current.cmsg_type == libc::SCM_RIGHTS {
            rights_records += 1;
            if !data_length.is_multiple_of(mem::size_of::<RawFd>()) {
                valid = false;
            }
            // SAFETY: The checked header-data offset lies within the control buffer, and each
            // read below is bounded by the bytes actually returned by recvmsg.
            let data = unsafe { libc::CMSG_DATA(header) }.cast::<RawFd>();
            for index in 0..data_length / mem::size_of::<RawFd>() {
                // SAFETY: This FD-sized value is inside the checked SCM_RIGHTS payload.
                let descriptor = unsafe { std::ptr::read_unaligned(data.add(index)) };
                if descriptor < 0
                    || descriptors
                        .iter()
                        .any(|file| file.as_raw_fd() == descriptor)
                {
                    valid = false;
                    continue;
                }
                // SAFETY: Each nonnegative SCM_RIGHTS descriptor is a new kernel-installed
                // owned reference. The duplicate check prevents adopting a numeric FD twice.
                descriptors.push(unsafe { File::from_raw_fd(descriptor) });
            }
        } else {
            valid = false;
        }
        if length > available {
            // A truncated rights record may still contain installed FDs; those were adopted
            // above. There cannot be another complete record beyond its declared payload.
            valid = false;
            break;
        }
        // SAFETY: The current header length was checked against the control buffer. The libc
        // helper uses Darwin's alignment and returns null if a further header cannot fit.
        header = unsafe { libc::CMSG_NXTHDR(message, header) };
    }
    (descriptors, valid && rights_records == 1)
}

fn cloexec_pipe() -> io::Result<(File, File)> {
    let mut descriptors = [-1; 2];
    // SAFETY: descriptors has writable storage for the two FDs returned by pipe.
    if unsafe { libc::pipe(descriptors.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: A successful pipe call returned two distinct, newly owned descriptors. Adopting
    // both before flag setup guarantees that every following error closes the complete pipe.
    let (reader, writer) = unsafe {
        (
            File::from_raw_fd(descriptors[0]),
            File::from_raw_fd(descriptors[1]),
        )
    };
    set_cloexec(reader.as_raw_fd())?;
    set_cloexec(writer.as_raw_fd())?;
    Ok((reader, writer))
}

fn set_cloexec(descriptor: RawFd) -> io::Result<()> {
    let flags = fcntl(descriptor, libc::F_GETFD, 0)?;
    fcntl(descriptor, libc::F_SETFD, flags | libc::FD_CLOEXEC)?;
    Ok(())
}

fn set_nonblocking(file: &File) -> io::Result<()> {
    let flags = fcntl(file.as_raw_fd(), libc::F_GETFL, 0)?;
    fcntl(file.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK)?;
    Ok(())
}

fn validate_target_pipe(file: &File, access: libc::c_int) -> io::Result<()> {
    if !file.metadata()?.file_type().is_fifo() {
        return Err(invalid("stdio transfer descriptor is not a pipe"));
    }
    let flags = fcntl(file.as_raw_fd(), libc::F_GETFL, 0)?;
    if flags & libc::O_ACCMODE != access || flags & libc::O_NONBLOCK != 0 {
        return Err(invalid(
            "stdio transfer pipe direction or blocking policy is invalid",
        ));
    }
    Ok(())
}

fn fcntl(
    descriptor: RawFd,
    command: libc::c_int,
    argument: libc::c_int,
) -> io::Result<libc::c_int> {
    loop {
        // SAFETY: Callers own descriptor; all supported commands take an integer argument.
        let result = unsafe { libc::fcntl(descriptor, command, argument) };
        if result >= 0 {
            return Ok(result);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn protect_socket_from_sigpipe(stream: &UnixStream) -> io::Result<()> {
    let enabled: libc::c_int = 1;
    // SAFETY: SO_NOSIGPIPE applies only to this socket and the integer option buffer is valid.
    if unsafe {
        libc::setsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_NOSIGPIPE,
            (&enabled as *const libc::c_int).cast(),
            mem::size_of_val(&enabled) as _,
        )
    } == 0
    {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::{receive_stdio, send_stdio, PipePair, F_GETNOSIGPIPE};
    use std::fs::{self, File, OpenOptions};
    use std::io::{self, Read, Write};
    use std::mem;
    use std::os::fd::{AsRawFd, FromRawFd, RawFd};
    use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt};
    use std::os::unix::net::UnixStream;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;

    const EXPECTED_MARKER: u8 = 0x53;
    static NEXT_TEST_FILE: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn native_pipes_are_cloexec_with_blocking_target_and_nonblocking_coordinator_ends() {
        let pipes = PipePair::new().expect("create native interactive pipes");
        for (file, access, nonblocking) in [
            (&pipes.target.stdin, libc::O_RDONLY, false),
            (&pipes.target.stdout, libc::O_WRONLY, false),
            (&pipes.input, libc::O_WRONLY, true),
            (&pipes.output, libc::O_RDONLY, true),
        ] {
            assert!(file.metadata().expect("inspect pipe").file_type().is_fifo());
            let status = descriptor_status(file.as_raw_fd());
            assert_eq!(status & libc::O_ACCMODE, access);
            assert_eq!(status & libc::O_NONBLOCK != 0, nonblocking);
            // SAFETY: F_GETFD reads flags from an open descriptor owned by this test.
            let descriptor_flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) };
            assert!(descriptor_flags >= 0);
            assert_ne!(descriptor_flags & libc::FD_CLOEXEC, 0);
        }
        // SAFETY: F_GETNOSIGPIPE reads the per-descriptor Darwin pipe-writer policy.
        assert_eq!(
            unsafe { libc::fcntl(pipes.input.as_raw_fd(), F_GETNOSIGPIPE) },
            1
        );
    }

    #[test]
    fn transferred_stdio_carries_bytes_in_both_directions_and_remains_cloexec() {
        let (sender, receiver) = timed_stream_pair();
        let mut pipes = PipePair::new().expect("create native interactive pipes");
        send_stdio(&sender, pipes.target).expect("transfer target stdio");
        let mut target = receive_stdio(&receiver).expect("receive target stdio");
        for file in [&target.stdin, &target.stdout] {
            // SAFETY: F_GETFD and F_GETFL only inspect an open descriptor.
            let descriptor_flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) };
            assert!(descriptor_flags >= 0);
            assert_ne!(descriptor_flags & libc::FD_CLOEXEC, 0);
            assert_eq!(descriptor_status(file.as_raw_fd()) & libc::O_NONBLOCK, 0);
        }
        pipes
            .input
            .write_all(b"question\n")
            .expect("coordinator writes input");
        let mut input = [0_u8; 9];
        target
            .stdin
            .read_exact(&mut input)
            .expect("target reads input");
        assert_eq!(&input, b"question\n");
        target
            .stdout
            .write_all(b"answer\n")
            .expect("target writes output");
        let mut output = [0_u8; 7];
        pipes
            .output
            .read_exact(&mut output)
            .expect("coordinator reads output");
        assert_eq!(&output, b"answer\n");
    }

    #[test]
    fn sender_wire_contains_exactly_one_marker_and_two_ordered_pipe_descriptors() {
        let (sender, receiver) = timed_stream_pair();
        let mut pipes = PipePair::new().expect("create native interactive pipes");
        send_stdio(&sender, pipes.target).expect("transfer target stdio");
        let (payload, descriptors) = raw_receive(&receiver);
        assert_eq!(payload, [EXPECTED_MARKER]);
        assert_eq!(descriptors.len(), 2);
        assert_eq!(
            descriptor_status(descriptors[0].as_raw_fd()) & libc::O_ACCMODE,
            libc::O_RDONLY
        );
        assert_eq!(
            descriptor_status(descriptors[1].as_raw_fd()) & libc::O_ACCMODE,
            libc::O_WRONLY
        );
        assert!(descriptors.iter().all(|file| file
            .metadata()
            .expect("inspect received pipe")
            .file_type()
            .is_fifo()));
        drop(descriptors);
        assert_eof(&mut pipes.output);
        assert_broken_pipe(&mut pipes.input);
    }

    #[test]
    fn send_failure_closes_consumed_target_ends_without_terminating_the_process() {
        let (sender, receiver) = timed_stream_pair();
        let mut pipes = PipePair::new().expect("create native interactive pipes");
        drop(receiver);
        assert!(send_stdio(&sender, pipes.target).is_err());
        assert_eof(&mut pipes.output);
        assert_broken_pipe(&mut pipes.input);
    }

    #[test]
    fn receiver_rejects_eof_before_a_transaction() {
        let (sender, receiver) = timed_stream_pair();
        drop(sender);
        assert_eq!(
            receive_stdio(&receiver)
                .expect_err("EOF cannot install stdio")
                .kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn receiver_obeys_the_callers_read_timeout() {
        let (_sender, receiver) = timed_stream_pair();
        let error = receive_stdio(&receiver).expect_err("idle channel must time out");
        assert!(matches!(
            error.kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
        ));
    }

    #[test]
    fn receiver_rejects_a_wrong_marker_and_closes_both_delivered_pipe_ends() {
        let (sender, receiver) = timed_stream_pair();
        let pipes = PipePair::new().expect("create native interactive pipes");
        raw_send(
            &sender,
            &[EXPECTED_MARKER ^ 0xff],
            &[
                pipes.target.stdin.as_raw_fd(),
                pipes.target.stdout.as_raw_fd(),
            ],
        );
        assert!(receive_stdio(&receiver).is_err());
        assert_target_copies_closed(pipes);
    }

    #[test]
    fn receiver_rejects_a_marker_without_any_descriptors() {
        let (sender, receiver) = timed_stream_pair();
        raw_send(&sender, &[EXPECTED_MARKER], &[]);
        assert!(receive_stdio(&receiver).is_err());
    }

    #[test]
    fn receiver_rejects_more_than_one_marker_byte() {
        let (sender, receiver) = timed_stream_pair();
        let pipes = PipePair::new().expect("create native interactive pipes");
        raw_send(
            &sender,
            &[EXPECTED_MARKER, EXPECTED_MARKER],
            &[
                pipes.target.stdin.as_raw_fd(),
                pipes.target.stdout.as_raw_fd(),
            ],
        );
        assert!(receive_stdio(&receiver).is_err());
        assert_target_copies_closed(pipes);
    }

    #[test]
    fn receiver_rejects_an_extra_descriptor_and_closes_every_delivered_end() {
        let (sender, receiver) = timed_stream_pair();
        let pipes = PipePair::new().expect("create native interactive pipes");
        let mut extra = PipePair::new().expect("create extra pipe");
        raw_send(
            &sender,
            &[EXPECTED_MARKER],
            &[
                pipes.target.stdin.as_raw_fd(),
                pipes.target.stdout.as_raw_fd(),
                extra.target.stdout.as_raw_fd(),
            ],
        );
        assert!(receive_stdio(&receiver).is_err());
        assert_target_copies_closed(pipes);
        drop(extra.target);
        assert_eof(&mut extra.output);
        assert_broken_pipe(&mut extra.input);
    }

    #[test]
    fn receiver_rejects_truncated_ancillary_data_and_closes_delivered_pipe_copies() {
        let (sender, receiver) = timed_stream_pair();
        let pipes = PipePair::new().expect("create native interactive pipes");
        let descriptors: Vec<_> = (0..64)
            .map(|index| {
                if index % 2 == 0 {
                    pipes.target.stdin.as_raw_fd()
                } else {
                    pipes.target.stdout.as_raw_fd()
                }
            })
            .collect();
        raw_send(&sender, &[EXPECTED_MARKER], &descriptors);
        assert!(receive_stdio(&receiver).is_err());
        assert_target_copies_closed(pipes);
    }

    #[test]
    fn receiver_rejects_extra_rights_records_and_leaves_no_regular_file_descriptor() {
        let (sender, receiver) = timed_stream_pair();
        let pipes = PipePair::new().expect("create native interactive pipes");
        let regular = TestFile::new();
        let before = descriptor_census(&regular.file);
        // Darwin requires a single SCM_RIGHTS record whose length equals the control
        // mbuf length; multiple records are refused before any right can be delivered.
        // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/uipc_usrreq.c
        let error = raw_send_records(
            &sender,
            &[EXPECTED_MARKER],
            &[
                &[
                    pipes.target.stdin.as_raw_fd(),
                    pipes.target.stdout.as_raw_fd(),
                ],
                &[regular.file.as_raw_fd()],
            ],
        )
        .expect_err("Darwin must reject a surplus rights record at send time");
        assert_eq!(error.raw_os_error(), Some(libc::EINVAL));
        assert!(matches!(
            receive_stdio(&receiver)
                .expect_err("no rejected rights may be queued")
                .kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
        ));
        assert_eq!(
            descriptor_census(&regular.file),
            before,
            "rejected extra rights record leaked a descriptor"
        );
        assert_target_copies_closed(pipes);
    }

    #[test]
    fn receiver_rejects_a_regular_file_and_closes_its_received_descriptor() {
        let (sender, receiver) = timed_stream_pair();
        let pipes = PipePair::new().expect("create native interactive pipes");
        let regular = TestFile::new();
        let before = descriptor_census(&regular.file);
        raw_send(
            &sender,
            &[EXPECTED_MARKER],
            &[pipes.target.stdin.as_raw_fd(), regular.file.as_raw_fd()],
        );
        assert!(receive_stdio(&receiver).is_err());
        assert_eq!(
            descriptor_census(&regular.file),
            before,
            "rejected regular file leaked a descriptor"
        );
        assert_target_copies_closed(pipes);
    }

    #[test]
    fn receiver_rejects_reversed_pipe_access_directions() {
        let (sender, receiver) = timed_stream_pair();
        let pipes = PipePair::new().expect("create native interactive pipes");
        raw_send(
            &sender,
            &[EXPECTED_MARKER],
            &[
                pipes.target.stdout.as_raw_fd(),
                pipes.target.stdin.as_raw_fd(),
            ],
        );
        assert!(receive_stdio(&receiver).is_err());
        assert_target_copies_closed(pipes);
    }

    fn timed_stream_pair() -> (UnixStream, UnixStream) {
        let pair = UnixStream::pair().expect("create private UnixStream pair");
        for stream in [&pair.0, &pair.1] {
            stream
                .set_read_timeout(Some(Duration::from_millis(250)))
                .expect("bound receiver timeout");
            stream
                .set_write_timeout(Some(Duration::from_millis(250)))
                .expect("bound sender timeout");
            let enabled: libc::c_int = 1;
            // SAFETY: SO_NOSIGPIPE applies only to this owned socket; enabled points to a valid int.
            assert_eq!(
                unsafe {
                    libc::setsockopt(
                        stream.as_raw_fd(),
                        libc::SOL_SOCKET,
                        libc::SO_NOSIGPIPE,
                        (&enabled as *const libc::c_int).cast(),
                        mem::size_of_val(&enabled) as _,
                    )
                },
                0
            );
        }
        pair
    }

    fn descriptor_status(descriptor: RawFd) -> libc::c_int {
        // SAFETY: Test callers hold the supplied descriptor open.
        let status = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
        assert!(
            status >= 0,
            "inspect descriptor status: {}",
            io::Error::last_os_error()
        );
        status
    }

    fn assert_target_copies_closed(mut pipes: PipePair) {
        drop(pipes.target);
        assert_eof(&mut pipes.output);
        assert_broken_pipe(&mut pipes.input);
    }

    fn assert_eof(reader: &mut File) {
        let mut byte = [0_u8; 1];
        // Parallel containment tests fork before exec and briefly inherit these test
        // descriptors. Require EOF within the bounded drain window; a leaked writer
        // in this process remains open and still fails the assertion.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            match reader.read(&mut byte) {
                Ok(count) => {
                    assert_eq!(count, 0, "pipe must have reached EOF");
                    break;
                }
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(2))
                }
                Err(error) => panic!("no leaked writer may keep the pipe open: {error}"),
            }
        }
    }

    fn assert_broken_pipe(writer: &mut File) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            match writer.write(b"x") {
                Err(error) if error.kind() == io::ErrorKind::BrokenPipe => break,
                Ok(_) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(2))
                }
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(2))
                }
                outcome => panic!("no leaked reader may keep the pipe open: {outcome:?}"),
            }
        }
    }

    fn raw_send(stream: &UnixStream, payload: &[u8], descriptors: &[RawFd]) {
        if descriptors.is_empty() {
            raw_send_records(stream, payload, &[]).expect("send test payload without rights");
        } else {
            raw_send_records(stream, payload, &[descriptors]).expect("send test rights record");
        }
    }

    fn raw_send_records(
        stream: &UnixStream,
        payload: &[u8],
        records: &[&[RawFd]],
    ) -> io::Result<()> {
        let lengths: Vec<_> = records
            .iter()
            .map(|record| {
                // SAFETY: This computes the ancillary space for a bounded test-owned descriptor list.
                unsafe { libc::CMSG_SPACE(mem::size_of_val(*record) as _) as usize }
            })
            .collect();
        let control_length: usize = lengths.iter().sum();
        let word_count = control_length.div_ceil(mem::size_of::<usize>());
        let mut control = vec![0_usize; word_count];
        let mut iovec = libc::iovec {
            iov_base: payload.as_ptr().cast_mut().cast(),
            iov_len: payload.len(),
        };
        // SAFETY: Zero initialization gives an empty msghdr; valid buffers are installed below.
        let mut message: libc::msghdr = unsafe { mem::zeroed() };
        message.msg_iov = &mut iovec;
        message.msg_iovlen = 1;
        if control_length != 0 {
            message.msg_control = control.as_mut_ptr().cast();
            message.msg_controllen = control_length as _;
        }
        let mut offset = 0;
        for (record, length) in records.iter().zip(lengths) {
            // SAFETY: Each offset is CMSG_SPACE-aligned and inside the initialized control buffer.
            unsafe {
                let header = control
                    .as_mut_ptr()
                    .cast::<u8>()
                    .add(offset)
                    .cast::<libc::cmsghdr>();
                (*header).cmsg_level = libc::SOL_SOCKET;
                (*header).cmsg_type = libc::SCM_RIGHTS;
                (*header).cmsg_len = libc::CMSG_LEN(mem::size_of_val(*record) as _) as _;
                std::ptr::copy_nonoverlapping(
                    record.as_ptr().cast::<u8>(),
                    libc::CMSG_DATA(header),
                    mem::size_of_val(*record),
                );
            }
            offset += length;
        }
        // SAFETY: message points to live payload/control buffers; borrowed FDs remain open.
        let sent = unsafe { libc::sendmsg(stream.as_raw_fd(), &message, 0) };
        if sent < 0 {
            return Err(io::Error::last_os_error());
        }
        if sent != payload.len() as isize {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "test transaction was partially sent",
            ));
        }
        Ok(())
    }

    fn raw_receive(stream: &UnixStream) -> (Vec<u8>, Vec<File>) {
        let mut payload = [0_u8; 2];
        let mut control = [0_usize; 16];
        let mut iovec = libc::iovec {
            iov_base: payload.as_mut_ptr().cast(),
            iov_len: payload.len(),
        };
        // SAFETY: Zero initialization gives an empty msghdr; valid buffers are installed below.
        let mut message: libc::msghdr = unsafe { mem::zeroed() };
        message.msg_iov = &mut iovec;
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = mem::size_of_val(&control) as _;
        // SAFETY: All receive buffers are writable and remain live through recvmsg.
        let received = unsafe { libc::recvmsg(stream.as_raw_fd(), &mut message, 0) };
        assert!(
            received > 0,
            "receive sender wire: {}",
            io::Error::last_os_error()
        );
        assert_eq!(message.msg_flags & libc::MSG_CTRUNC, 0);
        // SAFETY: recvmsg populated a bounded control buffer, and the header is checked before use.
        let header = unsafe { libc::CMSG_FIRSTHDR(&message) };
        assert!(!header.is_null());
        // SAFETY: The received first header is present and lies within the control buffer.
        unsafe {
            assert_eq!((*header).cmsg_level, libc::SOL_SOCKET);
            assert_eq!((*header).cmsg_type, libc::SCM_RIGHTS);
            assert_eq!(
                (*header).cmsg_len as usize,
                libc::CMSG_LEN((2 * mem::size_of::<RawFd>()) as _) as usize
            );
            assert!(libc::CMSG_NXTHDR(&message, header).is_null());
            let data = libc::CMSG_DATA(header).cast::<RawFd>();
            let descriptors = (0..2)
                .map(|index| File::from_raw_fd(std::ptr::read_unaligned(data.add(index))))
                .collect();
            (payload[..received as usize].to_vec(), descriptors)
        }
    }

    fn descriptor_census(file: &File) -> usize {
        let expected = file.metadata().expect("inspect census file identity");
        // SAFETY: getdtablesize reads this process's descriptor-table limit.
        let scan_limit = unsafe { libc::getdtablesize() };
        assert!(scan_limit > 0);
        let mut count = 0;
        for descriptor in 0..scan_limit {
            // SAFETY: fstat only writes the supplied stat buffer, including for closed descriptors.
            let mut status: libc::stat = unsafe { mem::zeroed() };
            // SAFETY: status is valid writable storage; fstat never closes or changes the FD.
            if unsafe { libc::fstat(descriptor, &mut status) } == 0
                && status.st_dev as u64 == expected.dev()
                && status.st_ino as u64 == expected.ino()
            {
                count += 1;
            }
        }
        count
    }

    struct TestFile {
        file: File,
        path: PathBuf,
    }

    impl TestFile {
        fn new() -> Self {
            let suffix = NEXT_TEST_FILE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "judgedesk-stdio-test-{}-{suffix}",
                std::process::id()
            ));
            let file = OpenOptions::new()
                .create_new(true)
                .read(true)
                .write(true)
                .mode(0o600)
                .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
                .open(&path)
                .expect("create exclusive descriptor-census file");
            Self { file, path }
        }
    }

    impl Drop for TestFile {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }
}
