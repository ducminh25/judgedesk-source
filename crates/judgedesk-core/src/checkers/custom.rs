use crate::checkers::CheckerVerdict;
use crate::rational::{divide_rational, parse_rational, parse_rational_f64, Rational};

#[derive(Debug, Clone)]
pub struct CustomCheckerResult {
    pub status: CheckerVerdict,
    pub score_multiplier: f64,
    pub score_multiplier_exact: Rational,
    pub message: String,
}

fn try_parse_non_negative_rational_token(raw_token: &str) -> Option<Rational> {
    let token = raw_token.trim().trim_end_matches([',', ';', ')']);
    if token.is_empty() || token.starts_with('-') {
        return None;
    }
    if let Some((num_s, den_s)) = token.split_once('/') {
        let num_clean = num_s.strip_prefix('+').unwrap_or(num_s);
        if num_clean.is_empty()
            || den_s.is_empty()
            || !num_clean.bytes().all(|b| b.is_ascii_digit())
            || !den_s.bytes().all(|b| b.is_ascii_digit())
            || den_s.bytes().all(|b| b == b'0')
        {
            return None;
        }
        return Some(parse_rational(token));
    }
    if let Ok(f) = token.parse::<f64>() {
        if f.is_finite() && f >= 0.0 {
            return Some(parse_rational(token));
        }
    }
    None
}

fn normalize_partial_ratio(val: Rational, max_score: &Rational) -> Option<Rational> {
    if val <= Rational::ONE {
        Some(val)
    } else if *max_score > Rational::ZERO {
        Some(divide_rational(val, max_score.clone()))
    } else {
        None
    }
}

pub fn parse_partial_score_rational(
    message: &str,
    stdout: &str,
    max_score: Rational,
) -> Option<Rational> {
    for line in message.lines() {
        let l = line.to_lowercase();
        for prefix in ["result = ", "points ", "score : "] {
            if let Some(pos) = l.find(prefix) {
                let candidate = l[pos + prefix.len()..]
                    .split_whitespace()
                    .next()
                    .unwrap_or("");
                if candidate.starts_with('-') {
                    return None;
                }
                if let Some(val) = try_parse_non_negative_rational_token(candidate) {
                    return normalize_partial_ratio(val, &max_score);
                }
            }
        }
    }
    let lines: Vec<&str> = stdout
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if let Some(last) = lines.last() {
        if last.starts_with('-') {
            return None;
        }
        if let Some(val) = try_parse_non_negative_rational_token(last) {
            return normalize_partial_ratio(val, &max_score);
        }
    }
    None
}

pub fn parse_partial_score(message: &str, stdout: &str, max_score: f64) -> Option<f64> {
    parse_partial_score_rational(message, stdout, parse_rational_f64(max_score)).map(|r| r.to_f64())
}

pub fn parse_custom_checker_exit_rational(
    exit_code: i32,
    message: &str,
    stdout: &str,
    max_score_rat: Rational,
) -> CustomCheckerResult {
    let trimmed_msg = if !message.trim().is_empty() {
        message.trim().to_string()
    } else {
        stdout.lines().next().unwrap_or("").trim().to_string()
    };

    match exit_code {
        0 => {
            if let Some(ratio) = parse_partial_score_rational(message, stdout, max_score_rat) {
                if ratio >= Rational::ONE {
                    CustomCheckerResult {
                        status: CheckerVerdict::AC,
                        score_multiplier: 1.0,
                        score_multiplier_exact: Rational::ONE,
                        message: trimmed_msg,
                    }
                } else if ratio <= Rational::ZERO {
                    CustomCheckerResult {
                        status: CheckerVerdict::WA,
                        score_multiplier: 0.0,
                        score_multiplier_exact: Rational::ZERO,
                        message: trimmed_msg,
                    }
                } else {
                    CustomCheckerResult {
                        status: CheckerVerdict::AC,
                        score_multiplier: ratio.to_f64(),
                        score_multiplier_exact: ratio,
                        message: trimmed_msg,
                    }
                }
            } else {
                CustomCheckerResult {
                    status: CheckerVerdict::AC,
                    score_multiplier: 1.0,
                    score_multiplier_exact: Rational::ONE,
                    message: trimmed_msg,
                }
            }
        }
        1 => CustomCheckerResult {
            status: CheckerVerdict::WA,
            score_multiplier: 0.0,
            score_multiplier_exact: Rational::ZERO,
            message: trimmed_msg,
        },
        2 => CustomCheckerResult {
            status: CheckerVerdict::PE,
            score_multiplier: 0.0,
            score_multiplier_exact: Rational::ZERO,
            message: trimmed_msg,
        },
        7 => match parse_partial_score_rational(message, stdout, max_score_rat) {
            Some(mult) if mult >= Rational::ZERO && mult <= Rational::ONE => CustomCheckerResult {
                status: if mult > Rational::ZERO {
                    CheckerVerdict::AC
                } else {
                    CheckerVerdict::WA
                },
                score_multiplier: mult.to_f64(),
                score_multiplier_exact: mult,
                message: trimmed_msg,
            },
            _ => CustomCheckerResult {
                status: CheckerVerdict::FAIL,
                score_multiplier: 0.0,
                score_multiplier_exact: Rational::ZERO,
                message: if trimmed_msg.is_empty() {
                    "Checker returned an invalid partial score.".to_string()
                } else {
                    trimmed_msg
                },
            },
        },
        _ => CustomCheckerResult {
            status: CheckerVerdict::FAIL,
            score_multiplier: 0.0,
            score_multiplier_exact: Rational::ZERO,
            message: format!("Checker failed with exit code {exit_code}: {trimmed_msg}"),
        },
    }
}

pub fn parse_custom_checker_exit(
    exit_code: i32,
    message: &str,
    stdout: &str,
    max_score: f64,
) -> CustomCheckerResult {
    parse_custom_checker_exit_rational(exit_code, message, stdout, parse_rational_f64(max_score))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_custom_checker_parsing() {
        let res = parse_custom_checker_exit(0, "ok CHECKER_SMOKE_OK", "", 10.0);
        assert_eq!(res.status, CheckerVerdict::AC);
        assert_eq!(res.score_multiplier, 1.0);

        let res_wa = parse_custom_checker_exit(1, "wrong answer expected 42", "", 10.0);
        assert_eq!(res_wa.status, CheckerVerdict::WA);
        assert_eq!(res_wa.score_multiplier, 0.0);

        let res_pe = parse_custom_checker_exit(2, "presentation error", "", 10.0);
        assert_eq!(res_pe.status, CheckerVerdict::PE);

        let res_themis_wa = parse_custom_checker_exit(0, "", "WA: mismatch\n0.00\n", 10.0);
        assert_eq!(res_themis_wa.status, CheckerVerdict::WA);

        let res_partial = parse_custom_checker_exit(7, "points 5.0", "", 10.0);
        assert_eq!(res_partial.status, CheckerVerdict::AC);
        assert_eq!(res_partial.score_multiplier, 0.5);
        assert_eq!(res_partial.score_multiplier_exact, Rational::new(1, 2));

        let res_over_max = parse_custom_checker_exit(7, "result = 20", "", 10.0);
        assert_eq!(res_over_max.status, CheckerVerdict::FAIL);
        assert_eq!(res_over_max.score_multiplier, 0.0);
        assert_eq!(res_over_max.score_multiplier_exact, Rational::ZERO);

        let res_neg = parse_custom_checker_exit(7, "points -1.0", "", 10.0);
        assert_eq!(res_neg.status, CheckerVerdict::FAIL);
        assert_eq!(res_neg.score_multiplier, 0.0);
        assert_eq!(res_neg.score_multiplier_exact, Rational::ZERO);

        let res_missing = parse_custom_checker_exit(7, "malformed partial score", "", 10.0);
        assert_eq!(res_missing.status, CheckerVerdict::FAIL);
        assert_eq!(res_missing.score_multiplier, 0.0);
        assert_eq!(res_missing.score_multiplier_exact, Rational::ZERO);
    }
}
