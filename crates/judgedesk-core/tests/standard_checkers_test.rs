use judgedesk_core::checkers::*;

#[test]
fn test_c1_checker() {
    assert_eq!(
        run_standard_checker("C1", b"Hello   WORLD\n42\n", b"hello world\n42").status,
        CheckerVerdict::AC
    );
    assert_eq!(
        run_standard_checker("C1", b"hello\nworld", b"hello world").status,
        CheckerVerdict::WA
    );
}

#[test]
fn test_c2_checker() {
    assert_eq!(
        run_standard_checker("C2", b"Hello   world\n", b"Hello world").status,
        CheckerVerdict::AC
    );
    assert_eq!(
        run_standard_checker("C2", b"Hello world", b"hello world").status,
        CheckerVerdict::WA
    );
}

#[test]
fn test_c3_checker() {
    assert_eq!(
        run_standard_checker("C3", b"Hello\nWORLD 42", b"hello world\n42").status,
        CheckerVerdict::AC
    );
    assert_eq!(
        run_standard_checker("C3", b"one two", b"one three").message,
        "Wrong answer at word 2"
    );
}

#[test]
fn test_c4_checker() {
    assert_eq!(
        run_standard_checker("C4", b"Hello\nworld", b"Hello world").status,
        CheckerVerdict::AC
    );
    assert_eq!(
        run_standard_checker("C4", b"Hello", b"hello").status,
        CheckerVerdict::WA
    );
}

#[test]
fn test_c5_checker() {
    assert_eq!(
        run_standard_checker("C5", b"answer\n", b"answer\n").status,
        CheckerVerdict::AC
    );
    assert_eq!(
        run_standard_checker("C5", b"answer\n", b"answer").status,
        CheckerVerdict::WA
    );

    assert_eq!(
        run_standard_checker("C5", &[0, 255, 10], &[0, 255, 10]).status,
        CheckerVerdict::AC
    );
    let mismatch = run_standard_checker("C5", &[0, 255, 10], &[0, 254, 10]);
    assert!(mismatch.message.contains("Wrong answer at byte 2"));
    assert!(mismatch.message.contains("expected 0xFF"));
    assert!(mismatch.message.contains("found 0xFE"));
    assert!(mismatch.message.contains("00 FF 0A"));
}

#[test]
fn test_polygon_line_checkers() {
    assert_eq!(
        run_standard_checker("polygon:fcmp", b"a  b\n", b"a b\n").status,
        CheckerVerdict::WA
    );
    assert_eq!(
        run_standard_checker("polygon:lcmp", b"a  b\n", b" a b \n").status,
        CheckerVerdict::AC
    );
    assert_eq!(
        run_standard_checker("polygon:fcmp", b"answer\n", b"answer\nextra\n").status,
        CheckerVerdict::AC
    );
    assert_eq!(
        run_standard_checker("polygon:fcmp", b"answer\n\n", b"answer\n").status,
        CheckerVerdict::AC
    );
    assert_eq!(
        run_standard_checker("polygon:fcmp", b"answer\n\n\n", b"answer\n").status,
        CheckerVerdict::WA
    );
}

#[test]
fn test_polygon_integer_checkers() {
    assert_eq!(
        run_standard_checker("polygon:hcmp", b"-123", b"-123 trailing").status,
        CheckerVerdict::AC
    );
    assert_eq!(
        run_standard_checker("polygon:hcmp", b"1", b"+1").status,
        CheckerVerdict::PE
    );
    assert_eq!(
        run_standard_checker("polygon:hcmp", b"01", b"1").status,
        CheckerVerdict::FAIL
    );
    assert_eq!(
        run_standard_checker(
            "polygon:ncmp",
            b"-9223372036854775808 2",
            b"-9223372036854775808 2"
        )
        .status,
        CheckerVerdict::AC
    );
    assert_eq!(
        run_standard_checker("polygon:ncmp", b"9223372036854775808", b"0").status,
        CheckerVerdict::FAIL
    );
    assert_eq!(
        run_standard_checker("polygon:ncmp", b"1", b"1 2").status,
        CheckerVerdict::WA
    );
    assert_eq!(
        run_standard_checker("polygon:ncmp", b"1 invalid", b"1").status,
        CheckerVerdict::FAIL
    );
    assert_eq!(
        run_standard_checker("polygon:ncmp", b"1", b"1 invalid").status,
        CheckerVerdict::PE
    );
}

#[test]
fn test_polygon_yesno_checkers() {
    assert_eq!(
        run_standard_checker("polygon:yesno", b"YES", b"yes").status,
        CheckerVerdict::AC
    );
    assert_eq!(
        run_standard_checker("polygon:yesno", b"YES", b"maybe").status,
        CheckerVerdict::PE
    );
    assert_eq!(
        run_standard_checker("polygon:nyesno", b"YES no", b"yes NO").status,
        CheckerVerdict::AC
    );
    assert_eq!(
        run_standard_checker("polygon:nyesno", b"YES", b"NO").status,
        CheckerVerdict::WA
    );
}

#[test]
fn test_polygon_real_checkers() {
    assert_eq!(
        run_standard_checker("polygon:rcmp4", b"10000", b"10001").status,
        CheckerVerdict::AC
    );
    assert_eq!(
        run_standard_checker("polygon:rcmp6", b"1", b"1.00001").status,
        CheckerVerdict::WA
    );
    assert_eq!(
        run_standard_checker("polygon:rcmp9", b"nan", b"NaN").status,
        CheckerVerdict::AC
    );
    assert_eq!(
        run_standard_checker("polygon:rcmp9", b"inf", b"inf").status,
        CheckerVerdict::AC
    );
}

#[test]
fn test_polygon_token_checker() {
    assert_eq!(
        run_standard_checker("polygon:wcmp", b"a\nb c", b"a b\n c").status,
        CheckerVerdict::AC
    );
    assert_eq!(
        run_standard_checker("polygon:wcmp", b"a b", b"a b c").message,
        "Participant output contains extra tokens"
    );
}

#[derive(serde::Deserialize)]
struct CorpusFixture {
    id: String,
    checker: String,
    #[serde(rename = "expectedBase64")]
    expected_base64: String,
    #[serde(rename = "actualBase64")]
    actual_base64: String,
    #[serde(rename = "expectedVerdict")]
    expected_verdict: String,
    #[serde(rename = "expectedMessage")]
    expected_message: String,
}

#[derive(serde::Deserialize)]
struct Corpus {
    fixtures: Vec<CorpusFixture>,
}

fn decode_base64(s: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buf: u32 = 0;
    let mut bits = 0;
    for &b in s.as_bytes() {
        let val = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' => continue,
            _ => continue,
        };
        buf = (buf << 6) | (val as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    out
}

#[test]
fn test_themis_c1_c5_corpus() {
    let corpus_json = include_str!("../../../judgers/fixtures/themis-c1-c5-corpus.json");
    let corpus: Corpus = serde_json::from_str(corpus_json).expect("valid corpus json");

    for fixture in corpus.fixtures {
        let expected = decode_base64(&fixture.expected_base64);
        let actual = decode_base64(&fixture.actual_base64);
        let result = run_standard_checker(&fixture.checker, &expected, &actual);

        let expected_verdict = match fixture.expected_verdict.as_str() {
            "AC" => CheckerVerdict::AC,
            "WA" => CheckerVerdict::WA,
            "PE" => CheckerVerdict::PE,
            "FAIL" => CheckerVerdict::FAIL,
            other => panic!("Unknown verdict: {other}"),
        };

        assert_eq!(
            result.status, expected_verdict,
            "[{}] Status mismatch: expected {:?}, got {:?} (msg: {})",
            fixture.id, expected_verdict, result.status, result.message
        );
        assert_eq!(
            result.message, fixture.expected_message,
            "[{}] Message mismatch: expected \"{}\", got \"{}\"",
            fixture.id, fixture.expected_message, result.message
        );
    }
}
