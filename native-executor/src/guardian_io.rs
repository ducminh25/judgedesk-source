use crate::guardian_protocol::{
    authenticate_frame, AuthenticatedFrame, FrameIdentity, MAX_GUARDIAN_FRAME_BYTES,
};
use serde::de::DeserializeOwned;
use std::io::{self, Read};

// Include interrupted reads in the budget so a signal storm cannot monopolize
// the caller's event loop. A frame's total bytes are bounded independently.
const MAX_READ_OPERATIONS_PER_RECEIVE: usize = 64;

#[derive(Debug)]
pub(crate) enum FrameRead<T> {
    Pending,
    Frame(T),
    Eof,
}

#[derive(Default)]
pub(crate) struct FrameReader {
    header: [u8; 4],
    header_offset: usize,
    payload: Vec<u8>,
    payload_offset: usize,
}

impl FrameReader {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Reads at most one authenticated frame without consuming the next byte.
    ///
    /// The caller must configure nonblocking reads or a finite read timeout.
    /// `Pending` preserves all progress; any error terminates the stream.
    pub(crate) fn receive<R, T>(
        &mut self,
        reader: &mut R,
        identity: &FrameIdentity,
    ) -> io::Result<FrameRead<T>>
    where
        R: Read,
        T: DeserializeOwned + AuthenticatedFrame,
    {
        for _ in 0..MAX_READ_OPERATIONS_PER_RECEIVE {
            let reading_header = self.header_offset < self.header.len();
            let result = if reading_header {
                reader.read(&mut self.header[self.header_offset..])
            } else {
                reader.read(&mut self.payload[self.payload_offset..])
            };
            match result {
                Ok(0) if self.header_offset == 0 => return Ok(FrameRead::Eof),
                Ok(0) => {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        if reading_header {
                            "truncated guardian frame header"
                        } else {
                            "truncated guardian frame payload"
                        },
                    ));
                }
                Ok(amount) if reading_header => {
                    self.header_offset += amount;
                    if self.header_offset == self.header.len() {
                        let length = u32::from_le_bytes(self.header) as usize;
                        if length == 0 || length > MAX_GUARDIAN_FRAME_BYTES {
                            return Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                "invalid guardian frame length",
                            ));
                        }
                        self.payload.resize(length, 0);
                    }
                }
                Ok(amount) => {
                    self.payload_offset += amount;
                    if self.payload_offset == self.payload.len() {
                        let frame: T = serde_json::from_slice(&self.payload)
                            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
                        authenticate_frame(&frame, identity)?;
                        self.header_offset = 0;
                        self.payload_offset = 0;
                        self.payload.clear();
                        return Ok(FrameRead::Frame(frame));
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    return Ok(FrameRead::Pending);
                }
                Err(error) => return Err(error),
            }
        }
        Ok(FrameRead::Pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guardian_protocol::{
        write_frame, CleanupCause, GuardianCommand, ProcessIdentity, MAX_GUARDIAN_FRAME_BYTES,
    };
    use std::collections::VecDeque;
    use std::io::Cursor;

    const MAX_READ_CALLS: usize = 64;

    #[test]
    fn resumes_every_header_split_after_would_block_or_timeout() {
        let identity = identity();
        let bytes = encoded_cancel(&identity);
        for error_kind in [io::ErrorKind::WouldBlock, io::ErrorKind::TimedOut] {
            for split in 1..4 {
                let mut input = interrupted_at(&bytes, split, error_kind);
                let mut reader = FrameReader::new();

                assert!(matches!(
                    reader.receive::<_, GuardianCommand>(&mut input, &identity),
                    Ok(FrameRead::Pending)
                ));
                assert_eq!(input.bytes_read, split);
                assert_cancel(
                    reader
                        .receive(&mut input, &identity)
                        .expect("resumed header"),
                    &identity,
                );
                assert_eq!(input.bytes_read, bytes.len());
            }
        }
    }

    #[test]
    fn resumes_every_payload_split_after_would_block_or_timeout() {
        let identity = identity();
        let bytes = encoded_cancel(&identity);
        for error_kind in [io::ErrorKind::WouldBlock, io::ErrorKind::TimedOut] {
            for split in 4..bytes.len() {
                let mut input = interrupted_at(&bytes, split, error_kind);
                let mut reader = FrameReader::default();

                assert!(matches!(
                    reader.receive::<_, GuardianCommand>(&mut input, &identity),
                    Ok(FrameRead::Pending)
                ));
                assert_eq!(input.bytes_read, split);
                assert_cancel(
                    reader
                        .receive(&mut input, &identity)
                        .expect("resumed payload"),
                    &identity,
                );
                assert_eq!(input.bytes_read, bytes.len());
            }
        }
    }

    #[test]
    fn an_empty_frame_boundary_can_wait_and_then_reach_eof() {
        let identity = identity();
        for error_kind in [io::ErrorKind::WouldBlock, io::ErrorKind::TimedOut] {
            let mut input = StepReader::new(vec![Step::Error(error_kind)]);
            let mut reader = FrameReader::new();
            assert!(matches!(
                reader.receive::<_, GuardianCommand>(&mut input, &identity),
                Ok(FrameRead::Pending)
            ));
            assert!(matches!(
                reader.receive::<_, GuardianCommand>(&mut input, &identity),
                Ok(FrameRead::Eof)
            ));
        }
    }

    #[test]
    fn eof_is_accepted_only_at_an_empty_frame_boundary() {
        let identity = identity();
        let bytes = encoded_cancel(&identity);
        let mut reader = FrameReader::new();
        let mut input = Cursor::new(bytes.clone());
        assert_cancel(
            reader.receive(&mut input, &identity).expect("frame"),
            &identity,
        );
        assert!(matches!(
            reader.receive::<_, GuardianCommand>(&mut input, &identity),
            Ok(FrameRead::Eof)
        ));

        for length in 1..bytes.len() {
            let mut reader = FrameReader::new();
            let mut input = Cursor::new(&bytes[..length]);
            assert_eq!(
                reader
                    .receive::<_, GuardianCommand>(&mut input, &identity)
                    .expect_err("truncated frame")
                    .kind(),
                io::ErrorKind::UnexpectedEof,
                "prefix length {length}"
            );
        }
    }

    #[test]
    fn partial_frame_eof_remains_invalid_after_a_pending_read() {
        let identity = identity();
        let bytes = encoded_cancel(&identity);
        for error_kind in [io::ErrorKind::WouldBlock, io::ErrorKind::TimedOut] {
            for length in [1, 4, bytes.len() - 1] {
                let mut reader = FrameReader::new();
                let mut input = StepReader::new(vec![
                    Step::Bytes(bytes[..length].to_vec()),
                    Step::Error(error_kind),
                ]);
                assert!(matches!(
                    reader.receive::<_, GuardianCommand>(&mut input, &identity),
                    Ok(FrameRead::Pending)
                ));
                assert_eq!(
                    reader
                        .receive::<_, GuardianCommand>(&mut input, &identity)
                        .expect_err("partial frame cannot become EOF")
                        .kind(),
                    io::ErrorKind::UnexpectedEof
                );
            }
        }
    }

    #[test]
    fn rejects_zero_and_oversized_lengths_before_reading_payload() {
        let identity = identity();
        for length in [0_u32, (MAX_GUARDIAN_FRAME_BYTES + 1) as u32, u32::MAX] {
            let mut bytes = length.to_le_bytes().to_vec();
            bytes.extend_from_slice(&[0xDD; 8]);
            let mut input = Cursor::new(bytes);
            let mut reader = FrameReader::new();
            assert_eq!(
                reader
                    .receive::<_, GuardianCommand>(&mut input, &identity)
                    .expect_err("invalid length")
                    .kind(),
                io::ErrorKind::InvalidData
            );
            assert_eq!(input.position(), 4);
        }
    }

    #[test]
    fn accepts_the_maximum_frame_length() {
        let identity = identity();
        let mut bytes = encoded_cancel(&identity);
        bytes[..4].copy_from_slice(&(MAX_GUARDIAN_FRAME_BYTES as u32).to_le_bytes());
        bytes.resize(MAX_GUARDIAN_FRAME_BYTES + 4, b' ');
        let mut input = Cursor::new(bytes);
        let mut reader = FrameReader::new();
        assert_cancel(
            reader
                .receive(&mut input, &identity)
                .expect("maximum frame"),
            &identity,
        );
        assert_eq!(input.position(), (MAX_GUARDIAN_FRAME_BYTES + 4) as u64);
    }

    #[test]
    fn authenticates_every_identity_field_before_returning_a_frame() {
        let expected = identity();
        let mut wrong_protocol = expected.clone();
        wrong_protocol.protocol = "JUDGEDESK_RUN_GUARDIAN/1".into();
        let mut wrong_token = expected.clone();
        wrong_token.token = "33".repeat(32);
        let mut wrong_generation = expected.clone();
        wrong_generation.generation = "44".repeat(32);
        let mut wrong_run_id = expected.clone();
        wrong_run_id.run_id = "other-run".into();

        for actual in [wrong_protocol, wrong_token, wrong_generation, wrong_run_id] {
            let mut input = Cursor::new(encoded_cancel(&actual));
            let mut reader = FrameReader::new();
            assert_eq!(
                reader
                    .receive::<_, GuardianCommand>(&mut input, &expected)
                    .expect_err("mismatched frame identity")
                    .kind(),
                io::ErrorKind::PermissionDenied
            );
        }
    }

    #[test]
    fn rejects_authenticated_frames_with_invalid_payloads() {
        let identity = identity();
        let invalid_anchor = ProcessIdentity {
            pid: 10,
            pgid: 11,
            start_abstime: 123,
        };
        let mut bytes = Vec::new();
        write_frame(
            &mut bytes,
            &GuardianCommand::commit(&identity, invalid_anchor),
        )
        .expect("encode invalid payload");
        let mut input = Cursor::new(bytes);
        let mut reader = FrameReader::new();
        assert_eq!(
            reader
                .receive::<_, GuardianCommand>(&mut input, &identity)
                .expect_err("invalid process-group anchor")
                .kind(),
            io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn rejects_malformed_json_and_propagates_read_errors() {
        let identity = identity();
        let mut reader = FrameReader::new();
        let mut input = Cursor::new([1, 0, 0, 0, b'{']);
        assert_eq!(
            reader
                .receive::<_, GuardianCommand>(&mut input, &identity)
                .expect_err("malformed JSON")
                .kind(),
            io::ErrorKind::InvalidData
        );

        let mut reader = FrameReader::new();
        let mut input = StepReader::new(vec![Step::Error(io::ErrorKind::ConnectionReset)]);
        assert_eq!(
            reader
                .receive::<_, GuardianCommand>(&mut input, &identity)
                .expect_err("connection reset")
                .kind(),
            io::ErrorKind::ConnectionReset
        );
    }

    #[test]
    fn stops_before_a_descriptor_marker_and_the_next_frame() {
        let identity = identity();
        let first = encoded_cancel(&identity);
        let second = encoded_cancel(&identity);
        let mut bytes = first.clone();
        bytes.push(0xDD);
        bytes.extend_from_slice(&second);
        let mut input = Cursor::new(bytes);
        let mut reader = FrameReader::new();

        assert_cancel(
            reader.receive(&mut input, &identity).expect("frame"),
            &identity,
        );
        assert_eq!(input.position(), first.len() as u64);
        let mut marker = [0_u8; 1];
        input
            .read_exact(&mut marker)
            .expect("untouched descriptor marker");
        assert_eq!(marker, [0xDD]);
        assert_cancel(
            reader.receive(&mut input, &identity).expect("next frame"),
            &identity,
        );
        assert_eq!(input.position(), (first.len() + second.len() + 1) as u64);
    }

    #[test]
    fn retries_interrupted_reads_in_header_and_payload() {
        let identity = identity();
        let bytes = encoded_cancel(&identity);
        let mut input = StepReader::new(vec![
            Step::Error(io::ErrorKind::Interrupted),
            Step::Bytes(bytes[..2].to_vec()),
            Step::Error(io::ErrorKind::Interrupted),
            Step::Bytes(bytes[2..5].to_vec()),
            Step::Error(io::ErrorKind::Interrupted),
            Step::Bytes(bytes[5..].to_vec()),
        ]);
        let mut reader = FrameReader::new();

        assert_cancel(
            reader
                .receive(&mut input, &identity)
                .expect("retried reads"),
            &identity,
        );
        assert_eq!(input.bytes_read, bytes.len());
        assert!(input.read_calls >= 6);
    }

    #[test]
    fn yields_with_partial_progress_under_many_short_reads() {
        let identity = identity();
        let bytes = encoded_cancel(&identity);
        assert!(bytes.len() > MAX_READ_CALLS);
        let mut input =
            StepReader::new(bytes.iter().map(|byte| Step::Bytes(vec![*byte])).collect());
        let mut reader = FrameReader::new();

        assert!(matches!(
            reader.receive::<_, GuardianCommand>(&mut input, &identity),
            Ok(FrameRead::Pending)
        ));
        assert!(input.bytes_read > 0 && input.bytes_read < bytes.len());
        assert!(input.read_calls <= MAX_READ_CALLS);
        for _ in 0..bytes.len() {
            let calls_before = input.read_calls;
            let outcome = reader
                .receive(&mut input, &identity)
                .expect("incremental read");
            assert!(input.read_calls - calls_before <= MAX_READ_CALLS);
            match outcome {
                FrameRead::Pending => continue,
                FrameRead::Frame(command) => {
                    assert_cancel(FrameRead::Frame(command), &identity);
                    assert_eq!(input.bytes_read, bytes.len());
                    return;
                }
                FrameRead::Eof => panic!("frame was lost between read budgets"),
            }
        }
        panic!("bounded reads never completed the frame");
    }

    #[test]
    fn persistent_interruptions_cannot_spin_forever() {
        struct InterruptedReader {
            calls: usize,
        }
        impl Read for InterruptedReader {
            fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
                self.calls += 1;
                assert!(self.calls <= MAX_READ_CALLS, "receive did not yield");
                Err(io::Error::from(io::ErrorKind::Interrupted))
            }
        }

        let identity = identity();
        let mut input = InterruptedReader { calls: 0 };
        let mut reader = FrameReader::new();
        assert!(matches!(
            reader.receive::<_, GuardianCommand>(&mut input, &identity),
            Ok(FrameRead::Pending)
        ));
        assert!(input.calls > 0);
    }

    fn identity() -> FrameIdentity {
        FrameIdentity::new("11".repeat(32), "22".repeat(32), "frame-reader-run".into())
            .expect("valid identity")
    }

    fn encoded_cancel(identity: &FrameIdentity) -> Vec<u8> {
        let mut bytes = Vec::new();
        write_frame(
            &mut bytes,
            &GuardianCommand::cancel(identity, CleanupCause::Cancelled),
        )
        .expect("encode guardian command");
        bytes
    }

    fn assert_cancel(outcome: FrameRead<GuardianCommand>, identity: &FrameIdentity) {
        let FrameRead::Frame(command) = outcome else {
            panic!("expected a complete guardian command, got {outcome:?}");
        };
        assert!(matches!(
            command,
            GuardianCommand::Cancel {
                cause: CleanupCause::Cancelled,
                ..
            }
        ));
        assert_eq!(command.protocol(), identity.protocol);
        assert_eq!(command.token(), identity.token);
        assert_eq!(command.generation(), identity.generation);
        assert_eq!(command.run_id(), identity.run_id);
    }

    fn interrupted_at(bytes: &[u8], split: usize, error_kind: io::ErrorKind) -> StepReader {
        StepReader::new(vec![
            Step::Bytes(bytes[..split].to_vec()),
            Step::Error(error_kind),
            Step::Bytes(bytes[split..].to_vec()),
        ])
    }

    enum Step {
        Bytes(Vec<u8>),
        Error(io::ErrorKind),
    }

    struct StepReader {
        steps: VecDeque<Step>,
        read_calls: usize,
        bytes_read: usize,
    }

    impl StepReader {
        fn new(steps: Vec<Step>) -> Self {
            Self {
                steps: steps.into(),
                read_calls: 0,
                bytes_read: 0,
            }
        }
    }

    impl Read for StepReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.read_calls += 1;
            match self.steps.front_mut() {
                Some(Step::Bytes(bytes)) => {
                    let amount = buffer.len().min(bytes.len());
                    buffer[..amount].copy_from_slice(&bytes[..amount]);
                    bytes.drain(..amount);
                    self.bytes_read += amount;
                    if bytes.is_empty() {
                        self.steps.pop_front();
                    }
                    Ok(amount)
                }
                Some(Step::Error(kind)) => {
                    let kind = *kind;
                    self.steps.pop_front();
                    Err(io::Error::from(kind))
                }
                None => Ok(0),
            }
        }
    }
}
