use crate::checkers::CheckerVerdict;

#[derive(Debug, Clone)]
pub struct CustomCheckerResult {
    pub status: CheckerVerdict,
    pub score_multiplier: f64,
    pub message: String,
}

pub fn parse_partial_score(message: &str, stdout: &str, max_score: f64) -> Option<f64> {
    for line in message.lines() {
        let l = line.to_lowercase();
        if let Some(pos) = l.find("result = ") {
            if let Ok(val) = l[pos + 9..]
                .split_whitespace()
                .next()
                .unwrap_or("")
                .parse::<f64>()
            {
                if val >= 0.0 {
                    return Some(if val <= 1.0 {
                        val
                    } else {
                        (val / max_score).min(1.0)
                    });
                }
            }
        }
        if let Some(pos) = l.find("points ") {
            if let Ok(val) = l[pos + 7..]
                .split_whitespace()
                .next()
                .unwrap_or("")
                .parse::<f64>()
            {
                if val >= 0.0 {
                    return Some(if val <= 1.0 {
                        val
                    } else {
                        (val / max_score).min(1.0)
                    });
                }
            }
        }
        if let Some(pos) = l.find("score : ") {
            if let Ok(val) = l[pos + 8..]
                .split_whitespace()
                .next()
                .unwrap_or("")
                .parse::<f64>()
            {
                if val >= 0.0 {
                    return Some(if val <= 1.0 {
                        val
                    } else {
                        (val / max_score).min(1.0)
                    });
                }
            }
        }
    }
    let lines: Vec<&str> = stdout
        .lines()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if let Some(last) = lines.last() {
        if let Ok(val) = last.parse::<f64>() {
            if val >= 0.0 {
                return Some(if val <= 1.0 {
                    val
                } else {
                    (val / max_score).min(1.0)
                });
            }
        }
    }
    None
}

pub fn parse_custom_checker_exit(
    exit_code: i32,
    message: &str,
    stdout: &str,
    max_score: f64,
) -> CustomCheckerResult {
    let trimmed_msg = if !message.trim().is_empty() {
        message.trim().to_string()
    } else {
        stdout.lines().next().unwrap_or("").trim().to_string()
    };

    match exit_code {
        0 => {
            if let Some(ratio) = parse_partial_score(message, stdout, max_score) {
                if ratio >= 1.0 {
                    CustomCheckerResult {
                        status: CheckerVerdict::AC,
                        score_multiplier: 1.0,
                        message: trimmed_msg,
                    }
                } else if ratio <= 0.0 {
                    CustomCheckerResult {
                        status: CheckerVerdict::WA,
                        score_multiplier: 0.0,
                        message: trimmed_msg,
                    }
                } else {
                    CustomCheckerResult {
                        status: CheckerVerdict::AC,
                        score_multiplier: ratio,
                        message: trimmed_msg,
                    }
                }
            } else {
                CustomCheckerResult {
                    status: CheckerVerdict::AC,
                    score_multiplier: 1.0,
                    message: trimmed_msg,
                }
            }
        }
        1 => CustomCheckerResult {
            status: CheckerVerdict::WA,
            score_multiplier: 0.0,
            message: trimmed_msg,
        },
        2 => CustomCheckerResult {
            status: CheckerVerdict::PE,
            score_multiplier: 0.0,
            message: trimmed_msg,
        },
        7 => {
            let mult = parse_partial_score(message, stdout, max_score).unwrap_or(0.0);
            CustomCheckerResult {
                status: if mult > 0.0 {
                    CheckerVerdict::AC
                } else {
                    CheckerVerdict::WA
                },
                score_multiplier: mult,
                message: trimmed_msg,
            }
        }
        _ => CustomCheckerResult {
            status: CheckerVerdict::FAIL,
            score_multiplier: 0.0,
            message: format!("Checker failed with exit code {exit_code}: {trimmed_msg}"),
        },
    }
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
    }
}
