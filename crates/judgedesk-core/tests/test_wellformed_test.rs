use judgedesk_core::discovery::test_wellformed::{
    validate_configured_test_inputs, validate_test_input_file,
};
use std::fs;

mod common;

#[test]
fn validates_bytes_without_rewriting_and_handles_chunk_boundaries() {
    let environment = common::OwnedTestEnvironment::new();
    let input = environment.root().join("input.inp");
    for valid in [
        b"1 2\n".as_slice(),
        b"1 2\r\n",
        b"a\n\nb\n",
        b"\xff\xfe\x7f\n",
    ] {
        fs::write(&input, valid).unwrap();
        assert!(environment
            .with_isolated_roots(|| validate_test_input_file(&input))
            .unwrap()
            .is_empty());
        assert_eq!(fs::read(&input).unwrap(), valid);
    }
    for (bytes, code, line, column) in [
        (b"".as_slice(), "empty", 1, 1),
        (b"a", "missing_eol", 1, 2),
        (b" a\n", "edge_space", 1, 1),
        (b"a \n", "edge_space", 1, 2),
        (b"a  b\n", "consecutive_spaces", 1, 3),
        (b"a\tb\n", "control_character", 1, 2),
        (b"a\rb\n", "control_character", 1, 2),
        (b"\na\n", "edge_empty_line", 1, 1),
        (b"a\n\n", "edge_empty_line", 2, 1),
    ] {
        fs::write(&input, bytes).unwrap();
        let issues = validate_test_input_file(&input).unwrap();
        assert!(
            issues
                .iter()
                .any(|i| i.code == code && i.line == line && i.column == column),
            "{issues:?}"
        );
        assert_eq!(fs::read(&input).unwrap(), bytes);
    }
    let mut bytes = vec![b'a'; 65535];
    bytes.extend_from_slice(b"\r\n");
    fs::write(&input, &bytes).unwrap();
    assert!(validate_test_input_file(&input).unwrap().is_empty());
}

#[test]
fn judge_validation_is_opt_in_and_fails_closed_on_invalid_or_unreadable_inputs() {
    let environment = common::OwnedTestEnvironment::new();
    let problem = environment.root().join("sum");
    fs::create_dir_all(&problem).unwrap();
    fs::write(problem.join("1.inp"), b" a\n").unwrap();
    fs::write(problem.join("1.out"), b"a\n").unwrap();
    let config = serde_json::json!({ "testWellFormed": true });
    assert!(validate_configured_test_inputs(&problem, None).is_ok());
    assert!(validate_configured_test_inputs(&problem, Some(&config))
        .unwrap_err()
        .contains("1/1.inp:1:1"));
    assert!(validate_configured_test_inputs(&problem.join("missing"), Some(&config)).is_err());
    fs::write(problem.join("1.inp"), b"a\n").unwrap();
    assert!(validate_configured_test_inputs(&problem, Some(&config)).is_ok());
}
