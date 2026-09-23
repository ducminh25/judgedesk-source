use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CheckerVerdict {
    AC,
    WA,
    PE,
    FAIL,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StandardCheckerResult {
    pub status: CheckerVerdict,
    pub message: String,
}

pub fn is_standard_checker(checker: &str) -> bool {
    matches!(checker, "C1" | "C2" | "C3" | "C4" | "C5")
}

pub fn is_polygon_checker(checker: &str) -> bool {
    matches!(
        checker,
        "polygon:fcmp"
            | "polygon:lcmp"
            | "polygon:hcmp"
            | "polygon:ncmp"
            | "polygon:nyesno"
            | "polygon:rcmp4"
            | "polygon:rcmp6"
            | "polygon:rcmp9"
            | "polygon:wcmp"
            | "polygon:yesno"
    )
}

pub fn is_built_in_checker(checker: &str) -> bool {
    is_standard_checker(checker) || is_polygon_checker(checker)
}

pub fn run_standard_checker(
    checker_type: &str,
    expected_output: &[u8],
    actual_output: &[u8],
) -> StandardCheckerResult {
    if checker_type == "C5" {
        return compare_binary(expected_output, actual_output);
    }
    if checker_type == "C1" {
        return compare_themis_by_line(expected_output, actual_output, true);
    }
    if checker_type == "C2" {
        return compare_themis_by_line(expected_output, actual_output, false);
    }
    if checker_type == "C3" {
        return compare_themis_words(expected_output, actual_output, true);
    }
    if checker_type == "C4" {
        return compare_themis_words(expected_output, actual_output, false);
    }

    let expected = String::from_utf8_lossy(expected_output);
    let actual = String::from_utf8_lossy(actual_output);

    match checker_type {
        "polygon:fcmp" => compare_polygon_lines(&expected, &actual, false),
        "polygon:lcmp" => compare_polygon_lines(&expected, &actual, true),
        "polygon:hcmp" => compare_huge_integer(&expected, &actual),
        "polygon:ncmp" => compare_int64_sequence(&expected, &actual),
        "polygon:nyesno" => compare_yes_no_sequence(&expected, &actual),
        "polygon:rcmp4" => compare_real_sequence(&expected, &actual, 1e-4, 5),
        "polygon:rcmp6" => compare_real_sequence(&expected, &actual, 1e-6, 7),
        "polygon:rcmp9" => compare_real_sequence(&expected, &actual, 1e-9, 10),
        "polygon:wcmp" => compare_token_sequence(&expected, &actual),
        "polygon:yesno" => compare_single_yes_no(&expected, &actual),
        _ => StandardCheckerResult {
            status: CheckerVerdict::FAIL,
            message: format!("Unknown built-in checker: {checker_type}"),
        },
    }
}

#[inline]
fn fold_ascii_byte(b: u8) -> u8 {
    if b.is_ascii_uppercase() {
        b + 0x20
    } else {
        b
    }
}

fn words_equal(a: &[u8], b: &[u8], ignore_case: bool) -> bool {
    if a.len() != b.len() {
        return false;
    }
    if ignore_case {
        a.iter()
            .zip(b.iter())
            .all(|(&ba, &bb)| fold_ascii_byte(ba) == fold_ascii_byte(bb))
    } else {
        a == b
    }
}

fn parse_themis_lines(buf: &[u8]) -> Vec<Vec<&[u8]>> {
    if buf.is_empty() {
        return Vec::new();
    }

    let mut lines = Vec::new();
    let mut current_words = Vec::new();
    let mut word_start: Option<usize> = None;
    let mut i = 0;
    let mut had_eol_at_end = false;

    while i < buf.len() {
        let b = buf[i];
        if b == 0x0D || b == 0x0A {
            if let Some(start) = word_start.take() {
                current_words.push(&buf[start..i]);
            }
            lines.push(std::mem::take(&mut current_words));
            had_eol_at_end = true;
            if b == 0x0D && i + 1 < buf.len() && buf[i + 1] == 0x0A {
                i += 2;
            } else {
                i += 1;
            }
        } else if b == 0x20 || b == 0x09 {
            if let Some(start) = word_start.take() {
                current_words.push(&buf[start..i]);
            }
            had_eol_at_end = false;
            i += 1;
        } else {
            if word_start.is_none() {
                word_start = Some(i);
            }
            had_eol_at_end = false;
            i += 1;
        }
    }

    if let Some(start) = word_start {
        current_words.push(&buf[start..buf.len()]);
    }
    if !had_eol_at_end || !current_words.is_empty() {
        lines.push(current_words);
    }

    lines
}

fn trim_themis_trailing_blank_lines(lines: &mut Vec<Vec<&[u8]>>) {
    while let Some(last) = lines.last() {
        if last.is_empty() {
            lines.pop();
        } else {
            break;
        }
    }
}

fn compare_themis_by_line(
    expected_output: &[u8],
    actual_output: &[u8],
    ignore_case: bool,
) -> StandardCheckerResult {
    let mut expected_lines = parse_themis_lines(expected_output);
    let mut actual_lines = parse_themis_lines(actual_output);
    trim_themis_trailing_blank_lines(&mut expected_lines);
    trim_themis_trailing_blank_lines(&mut actual_lines);

    let line_count = expected_lines.len().max(actual_lines.len());
    for line_index in 0..line_count {
        let exp_words = expected_lines.get(line_index);
        let act_words = actual_lines.get(line_index);

        match (exp_words, act_words) {
            (Some(exp), Some(act)) => {
                if exp.len() != act.len() {
                    return StandardCheckerResult {
                        status: CheckerVerdict::WA,
                        message: format!("Wrong answer at line {}", line_index + 1),
                    };
                }
                for (ew, aw) in exp.iter().zip(act.iter()) {
                    if !words_equal(ew, aw, ignore_case) {
                        return StandardCheckerResult {
                            status: CheckerVerdict::WA,
                            message: format!("Wrong answer at line {}", line_index + 1),
                        };
                    }
                }
            }
            _ => {
                return StandardCheckerResult {
                    status: CheckerVerdict::WA,
                    message: format!("Wrong answer at line {}", line_index + 1),
                };
            }
        }
    }

    StandardCheckerResult {
        status: CheckerVerdict::AC,
        message: if expected_lines.len() == 1 {
            "single line".to_string()
        } else {
            format!("{} lines", expected_lines.len())
        },
    }
}

fn parse_themis_words(buf: &[u8]) -> Vec<&[u8]> {
    let mut words = Vec::new();
    let mut word_start: Option<usize> = None;

    for i in 0..buf.len() {
        let b = buf[i];
        if b == 0x20 || b == 0x09 || b == 0x0D || b == 0x0A {
            if let Some(start) = word_start.take() {
                words.push(&buf[start..i]);
            }
        } else if word_start.is_none() {
            word_start = Some(i);
        }
    }

    if let Some(start) = word_start {
        words.push(&buf[start..buf.len()]);
    }

    words
}

fn compare_themis_words(
    expected_output: &[u8],
    actual_output: &[u8],
    ignore_case: bool,
) -> StandardCheckerResult {
    let expected_words = parse_themis_words(expected_output);
    let actual_words = parse_themis_words(actual_output);
    let min_len = expected_words.len().min(actual_words.len());

    for word_index in 0..min_len {
        if !words_equal(
            expected_words[word_index],
            actual_words[word_index],
            ignore_case,
        ) {
            return StandardCheckerResult {
                status: CheckerVerdict::WA,
                message: format!("Wrong answer at word {}", word_index + 1),
            };
        }
    }

    if expected_words.len() != actual_words.len() {
        return StandardCheckerResult {
            status: CheckerVerdict::WA,
            message: format!(
                "Wrong answer: different number of words (expected {}, found {})",
                expected_words.len(),
                actual_words.len()
            ),
        };
    }

    StandardCheckerResult {
        status: CheckerVerdict::AC,
        message: if expected_words.len() == 1 {
            "single word".to_string()
        } else {
            format!("{} words", expected_words.len())
        },
    }
}

fn split_all_words(text: &str, ignore_case: bool) -> Vec<String> {
    text.split_whitespace()
        .map(|word| {
            if ignore_case {
                word.to_lowercase()
            } else {
                word.to_string()
            }
        })
        .collect()
}

fn hex_byte(value: u8) -> String {
    format!("{:02X}", value)
}

fn hex_preview(value: &[u8], center: usize) -> String {
    let start = center.saturating_sub(8);
    let end = (center + 9).min(value.len());
    let body = value[start..end]
        .iter()
        .map(|&b| hex_byte(b))
        .collect::<Vec<_>>()
        .join(" ");
    let max_idx = if start < end { end - 1 } else { start };
    format!(
        "[{start}..{max_idx}] {}",
        if body.is_empty() { "<empty>" } else { &body }
    )
}

fn compare_binary(expected: &[u8], actual: &[u8]) -> StandardCheckerResult {
    let length = expected.len().min(actual.len());
    for index in 0..length {
        if expected[index] != actual[index] {
            return StandardCheckerResult {
                status: CheckerVerdict::WA,
                message: format!(
                    "Wrong answer at byte {}; expected 0x{}; found 0x{}; expected preview {}; actual preview {}",
                    index + 1,
                    hex_byte(expected[index]),
                    hex_byte(actual[index]),
                    hex_preview(expected, index),
                    hex_preview(actual, index),
                ),
            };
        }
    }

    if expected.len() != actual.len() {
        return StandardCheckerResult {
            status: CheckerVerdict::WA,
            message: format!(
                "Wrong answer: different file length (expected {}, found {}); expected preview {}; actual preview {}",
                expected.len(),
                actual.len(),
                hex_preview(expected, length),
                hex_preview(actual, length),
            ),
        };
    }

    StandardCheckerResult {
        status: CheckerVerdict::AC,
        message: format!("files are identical ({} bytes)", expected.len()),
    }
}

fn compress_str(value: &str) -> String {
    if value.len() > 128 {
        format!("{}...", &value[..125])
    } else {
        value.to_string()
    }
}

fn english_ending(value: usize) -> &'static str {
    let tens = value % 100;
    if (11..=13).contains(&tens) {
        return "th";
    }
    match value % 10 {
        1 => "st",
        2 => "nd",
        3 => "rd",
        _ => "th",
    }
}

fn polygon_lines(value: &str) -> Vec<String> {
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    if normalized.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<String> = normalized.split('\n').map(|s| s.to_string()).collect();
    if normalized.ends_with('\n') {
        lines.pop();
    }
    if let Some(last) = lines.last() {
        if last.is_empty() {
            lines.pop();
        }
    }
    lines
}

fn compare_polygon_lines(expected: &str, actual: &str, tokenized: bool) -> StandardCheckerResult {
    let expected_lines = polygon_lines(expected);
    let actual_lines = polygon_lines(actual);
    let mut last_actual = String::new();

    for (index, expected_line) in expected_lines.iter().enumerate() {
        let actual_line = actual_lines.get(index);
        last_actual = actual_line.cloned().unwrap_or_default();
        let equal = if let Some(act) = actual_line {
            if tokenized {
                split_all_words(expected_line, false) == split_all_words(act, false)
            } else {
                expected_line == act
            }
        } else {
            false
        };

        if !equal {
            return StandardCheckerResult {
                status: CheckerVerdict::WA,
                message: format!(
                    "{}{} lines differ - expected: '{}', found: '{}'",
                    index + 1,
                    english_ending(index + 1),
                    compress_str(expected_line),
                    compress_str(&last_actual)
                ),
            };
        }
    }

    StandardCheckerResult {
        status: CheckerVerdict::AC,
        message: if expected_lines.len() == 1 {
            format!("single line: '{}'", compress_str(&last_actual))
        } else {
            format!("{} lines", expected_lines.len())
        },
    }
}

fn normalize_huge_integer(value: &str) -> Option<String> {
    if value == "0" {
        return Some("0".to_string());
    }
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (is_neg, digits) = if let Some(stripped) = trimmed.strip_prefix('-') {
        (true, stripped)
    } else {
        (false, trimmed)
    };
    if digits.is_empty() || digits.starts_with('0') || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if is_neg {
        Some(format!("-{digits}"))
    } else {
        Some(digits.to_string())
    }
}

fn compare_huge_integer(expected: &str, actual: &str) -> StandardCheckerResult {
    let expected_tokens = split_all_words(expected, false);
    let expected_token = expected_tokens.first().map(|s| s.as_str()).unwrap_or("");
    let actual_tokens = split_all_words(actual, false);
    let actual_token = actual_tokens.first().map(|s| s.as_str()).unwrap_or("");

    let normalized_expected = normalize_huge_integer(expected_token);
    let normalized_actual = normalize_huge_integer(actual_token);

    let Some(norm_exp) = normalized_expected else {
        return StandardCheckerResult {
            status: CheckerVerdict::FAIL,
            message: format!("{} is not a valid integer", compress_str(expected_token)),
        };
    };

    if expected_tokens.len() != 1 {
        return StandardCheckerResult {
            status: CheckerVerdict::FAIL,
            message: "expected exactly one token in the answer file".to_string(),
        };
    }

    let Some(norm_act) = normalized_actual else {
        return StandardCheckerResult {
            status: CheckerVerdict::PE,
            message: format!("{} is not a valid integer", compress_str(actual_token)),
        };
    };

    if norm_exp == norm_act {
        StandardCheckerResult {
            status: CheckerVerdict::AC,
            message: format!("answer is '{}'", compress_str(&norm_exp)),
        }
    } else {
        StandardCheckerResult {
            status: CheckerVerdict::WA,
            message: format!(
                "expected '{}', found '{}'",
                compress_str(&norm_exp),
                compress_str(&norm_act)
            ),
        }
    }
}

fn compare_int64_sequence(expected: &str, actual: &str) -> StandardCheckerResult {
    let expected_tokens = split_all_words(expected, false);
    let actual_tokens = split_all_words(actual, false);
    let common_length = expected_tokens.len().min(actual_tokens.len());
    let mut first_values = Vec::new();

    for index in 0..common_length {
        let expected_value = expected_tokens[index].parse::<i64>().ok();
        let actual_value = actual_tokens[index].parse::<i64>().ok();

        let Some(exp_v) = expected_value else {
            return StandardCheckerResult {
                status: CheckerVerdict::FAIL,
                message: format!("Invalid int64 in answer at token {}", index + 1),
            };
        };
        let Some(act_v) = actual_value else {
            return StandardCheckerResult {
                status: CheckerVerdict::PE,
                message: format!("Invalid int64 in output at token {}", index + 1),
            };
        };

        if exp_v != act_v {
            return StandardCheckerResult {
                status: CheckerVerdict::WA,
                message: format!(
                    "{}{} numbers differ - expected: '{exp_v}', found: '{act_v}'",
                    index + 1,
                    english_ending(index + 1)
                ),
            };
        }
        if index < 5 {
            first_values.push(exp_v.to_string());
        }
    }

    for (index, token) in expected_tokens.iter().enumerate().skip(common_length) {
        if token.parse::<i64>().is_err() {
            return StandardCheckerResult {
                status: CheckerVerdict::FAIL,
                message: format!("Invalid int64 in answer at token {}", index + 1),
            };
        }
    }
    for (index, token) in actual_tokens.iter().enumerate().skip(common_length) {
        if token.parse::<i64>().is_err() {
            return StandardCheckerResult {
                status: CheckerVerdict::PE,
                message: format!("Invalid int64 in output at token {}", index + 1),
            };
        }
    }

    if expected_tokens.len() > actual_tokens.len() {
        return StandardCheckerResult {
            status: CheckerVerdict::WA,
            message: format!(
                "Answer contains longer sequence [length = {}], but output contains {} elements",
                expected_tokens.len(),
                actual_tokens.len()
            ),
        };
    }
    if actual_tokens.len() > expected_tokens.len() {
        return StandardCheckerResult {
            status: CheckerVerdict::WA,
            message: format!(
                "Output contains longer sequence [length = {}], but answer contains {} elements",
                actual_tokens.len(),
                expected_tokens.len()
            ),
        };
    }

    StandardCheckerResult {
        status: CheckerVerdict::AC,
        message: if expected_tokens.len() <= 5 {
            format!(
                "{0} number(s): \"{1}\"",
                expected_tokens.len(),
                first_values.join(" ")
            )
        } else {
            format!("{} numbers", expected_tokens.len())
        },
    }
}

fn is_yes_no(value: &str) -> bool {
    value.eq_ignore_ascii_case("YES") || value.eq_ignore_ascii_case("NO")
}

fn compare_yes_no_sequence(expected: &str, actual: &str) -> StandardCheckerResult {
    let expected_tokens = split_all_words(expected, false);
    let actual_tokens = split_all_words(actual, false);
    let common_length = expected_tokens.len().min(actual_tokens.len());
    let mut yes_count = 0;
    let mut no_count = 0;

    for index in 0..common_length {
        let expected_token = &expected_tokens[index];
        let actual_token = &actual_tokens[index];

        if !is_yes_no(expected_token) {
            return StandardCheckerResult {
                status: CheckerVerdict::FAIL,
                message: format!(
                    "YES or NO expected in answer, but {} found [{}{} token]",
                    compress_str(expected_token),
                    index + 1,
                    english_ending(index + 1)
                ),
            };
        }
        if !is_yes_no(actual_token) {
            return StandardCheckerResult {
                status: CheckerVerdict::PE,
                message: format!(
                    "YES or NO expected, but {} found [{}{} token]",
                    compress_str(actual_token),
                    index + 1,
                    english_ending(index + 1)
                ),
            };
        }

        let exp_upper = expected_token.to_ascii_uppercase();
        let act_upper = actual_token.to_ascii_uppercase();

        if act_upper == "YES" {
            yes_count += 1;
        } else {
            no_count += 1;
        }

        if exp_upper != act_upper {
            return StandardCheckerResult {
                status: CheckerVerdict::WA,
                message: format!(
                    "expected {exp_upper}, found {act_upper} [{}{} token]",
                    index + 1,
                    english_ending(index + 1)
                ),
            };
        }
    }

    if expected_tokens.len() != actual_tokens.len() {
        let output_longer = actual_tokens.len() > expected_tokens.len();
        return StandardCheckerResult {
            status: CheckerVerdict::WA,
            message: if output_longer {
                format!(
                    "Output contains longer sequence [length = {}], but answer contains {} elements",
                    actual_tokens.len(),
                    expected_tokens.len()
                )
            } else {
                format!(
                    "Answer contains longer sequence [length = {}], but output contains {} elements",
                    expected_tokens.len(),
                    actual_tokens.len()
                )
            },
        };
    }

    if expected_tokens.is_empty() {
        return StandardCheckerResult {
            status: CheckerVerdict::AC,
            message: "Empty output".to_string(),
        };
    }
    if expected_tokens.len() == 1 {
        return StandardCheckerResult {
            status: CheckerVerdict::AC,
            message: actual_tokens[0].to_ascii_uppercase(),
        };
    }

    StandardCheckerResult {
        status: CheckerVerdict::AC,
        message: format!(
            "{} token(s): yes count is {yes_count}, no count is {no_count}",
            expected_tokens.len()
        ),
    }
}

fn compare_single_yes_no(expected: &str, actual: &str) -> StandardCheckerResult {
    let expected_token = split_all_words(expected, false)
        .first()
        .cloned()
        .unwrap_or_default();
    let actual_token = split_all_words(actual, false)
        .first()
        .cloned()
        .unwrap_or_default();

    if !is_yes_no(&expected_token) {
        return StandardCheckerResult {
            status: CheckerVerdict::FAIL,
            message: format!(
                "YES or NO expected in answer, but {} found",
                compress_str(&expected_token)
            ),
        };
    }
    if !is_yes_no(&actual_token) {
        return StandardCheckerResult {
            status: CheckerVerdict::PE,
            message: format!(
                "YES or NO expected, but {} found",
                compress_str(&actual_token)
            ),
        };
    }

    let exp_upper = expected_token.to_ascii_uppercase();
    let act_upper = actual_token.to_ascii_uppercase();

    if exp_upper != act_upper {
        StandardCheckerResult {
            status: CheckerVerdict::WA,
            message: format!("expected {exp_upper}, found {act_upper}"),
        }
    } else {
        StandardCheckerResult {
            status: CheckerVerdict::AC,
            message: format!("answer is {exp_upper}"),
        }
    }
}

fn parse_testlib_double(value: &str) -> Option<f64> {
    let lower = value.to_lowercase();
    if lower == "nan" {
        return Some(f64::NAN);
    }
    if lower == "inf" || lower == "+inf" || lower == "infinity" || lower == "+infinity" {
        return Some(f64::INFINITY);
    }
    if lower == "-inf" || lower == "-infinity" {
        return Some(f64::NEG_INFINITY);
    }
    value.parse::<f64>().ok()
}

fn double_compare(expected: f64, actual: f64, mut epsilon: f64) -> bool {
    epsilon += 1e-15;
    if expected.is_nan() {
        return actual.is_nan();
    }
    if !expected.is_finite() {
        return expected == actual;
    }
    if !actual.is_finite() {
        return false;
    }
    let diff = (expected - actual).abs();
    diff <= epsilon || diff <= expected.abs() * epsilon
}

fn double_delta(expected: f64, actual: f64) -> f64 {
    let diff = (expected - actual).abs();
    if expected.abs() > 1e-9 {
        diff.min(diff / expected.abs())
    } else {
        diff
    }
}

fn compare_real_sequence(
    expected: &str,
    actual: &str,
    epsilon: f64,
    digits: usize,
) -> StandardCheckerResult {
    let expected_tokens = split_all_words(expected, false);
    let actual_tokens = split_all_words(actual, false);
    let mut last_expected = 0.0;
    let mut last_actual = 0.0;

    for (index, exp_token) in expected_tokens.iter().enumerate() {
        let Some(exp_val) = parse_testlib_double(exp_token) else {
            return StandardCheckerResult {
                status: CheckerVerdict::FAIL,
                message: format!("Invalid real number in answer at token {}", index + 1),
            };
        };
        let act_token = actual_tokens.get(index);
        let Some(act_token_str) = act_token else {
            return StandardCheckerResult {
                status: CheckerVerdict::PE,
                message: format!("Invalid real number in output at token {}", index + 1),
            };
        };
        let Some(act_val) = parse_testlib_double(act_token_str) else {
            return StandardCheckerResult {
                status: CheckerVerdict::PE,
                message: format!("Invalid real number in output at token {}", index + 1),
            };
        };

        last_expected = exp_val;
        last_actual = act_val;

        if !double_compare(exp_val, act_val, epsilon) {
            return StandardCheckerResult {
                status: CheckerVerdict::WA,
                message: format!(
                    "{}{} numbers differ - expected: '{:.prec$}', found: '{:.prec$}', error = '{:.prec$}'",
                    index + 1,
                    english_ending(index + 1),
                    exp_val,
                    act_val,
                    double_delta(exp_val, act_val),
                    prec = digits
                ),
            };
        }
    }

    StandardCheckerResult {
        status: CheckerVerdict::AC,
        message: if expected_tokens.len() == 1 {
            format!(
                "found '{:.prec$}', expected '{:.prec$}', error '{:.prec$}'",
                last_actual,
                last_expected,
                double_delta(last_expected, last_actual),
                prec = digits
            )
        } else {
            format!("{} numbers", expected_tokens.len())
        },
    }
}

fn compare_token_sequence(expected: &str, actual: &str) -> StandardCheckerResult {
    let expected_tokens = split_all_words(expected, false);
    let actual_tokens = split_all_words(actual, false);
    let common_length = expected_tokens.len().min(actual_tokens.len());

    for index in 0..common_length {
        if expected_tokens[index] != actual_tokens[index] {
            return StandardCheckerResult {
                status: CheckerVerdict::WA,
                message: format!(
                    "{}{} words differ - expected: '{}', found: '{}'",
                    index + 1,
                    english_ending(index + 1),
                    compress_str(&expected_tokens[index]),
                    compress_str(&actual_tokens[index])
                ),
            };
        }
    }

    if actual_tokens.len() > expected_tokens.len() {
        return StandardCheckerResult {
            status: CheckerVerdict::WA,
            message: "Participant output contains extra tokens".to_string(),
        };
    }
    if expected_tokens.len() > actual_tokens.len() {
        return StandardCheckerResult {
            status: CheckerVerdict::WA,
            message: "Unexpected EOF in the participants output".to_string(),
        };
    }

    StandardCheckerResult {
        status: CheckerVerdict::AC,
        message: if expected_tokens.len() == 1 {
            format!("\"{}\"", compress_str(&expected_tokens[0]))
        } else {
            format!("{} tokens", expected_tokens.len())
        },
    }
}
