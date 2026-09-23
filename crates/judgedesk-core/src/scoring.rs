use crate::rational::{add_rational, parse_rational_f64, parse_rational_value, Rational};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestCaseRun {
    pub name: String,
    pub status: String,
    pub score: serde_json::Value,
    #[serde(rename = "executionTime", default)]
    pub execution_time: Option<u64>,
    #[serde(rename = "peakMemory", alias = "memoryUsedKb", default)]
    pub peak_memory: Option<u64>,
    #[serde(rename = "checkerMessage", alias = "message", default)]
    pub checker_message: Option<String>,
    #[serde(rename = "expectedOutputPreview", default)]
    pub expected_output_preview: Option<String>,
    #[serde(rename = "actualOutputPreview", default)]
    pub actual_output_preview: Option<String>,
    #[serde(rename = "errorDetail", default)]
    pub error_detail: Option<String>,
}

impl Default for TestCaseRun {
    fn default() -> Self {
        Self {
            name: String::new(),
            status: String::new(),
            score: serde_json::json!(0),
            execution_time: None,
            peak_memory: None,
            checker_message: None,
            expected_output_preview: None,
            actual_output_preview: None,
            error_detail: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PolygonTestConfig {
    pub group: Option<String>,
    pub points: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PolygonGroupConfig {
    #[serde(default)]
    pub dependencies: Vec<String>,
    pub policy: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PolygonScoringConfig {
    #[serde(rename = "enableGroups", default)]
    pub enable_groups: bool,
    #[serde(default)]
    pub groups: HashMap<String, PolygonGroupConfig>,
    #[serde(default)]
    pub tests: HashMap<String, PolygonTestConfig>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProblemScoringConfig {
    #[serde(rename = "polygonConfig")]
    pub polygon_config: Option<PolygonScoringConfig>,
    #[serde(rename = "totalScore")]
    pub total_score: Option<serde_json::Value>,
    #[serde(rename = "defaultScore")]
    pub default_score: Option<serde_json::Value>,
    #[serde(rename = "testScores")]
    pub test_scores: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProblemSummary {
    pub total: usize,
    pub passed: usize,
    pub score: f64,
    #[serde(rename = "maxScore")]
    pub max_score: f64,
    pub status: String,
}

pub fn calculate_problem_summary(
    compile_status: &str,
    test_cases: &mut [TestCaseRun],
    test_directories: &[String],
    config: &ProblemScoringConfig,
) -> ProblemSummary {
    apply_group_scoring(test_cases, config.polygon_config.as_ref());

    let passed = test_cases.iter().filter(|t| t.status == "AC").count();
    let score_rat = test_cases.iter().fold(Rational::ZERO, |total, test| {
        add_rational(total, parse_rational_value(&test.score))
    });
    let mut score = score_rat.to_f64();
    let status = calculate_problem_status(compile_status, test_cases);
    let polygon_config = config.polygon_config.as_ref();

    let has_configured_polygon_points = test_directories.iter().any(|dir| {
        polygon_config
            .and_then(|p| p.tests.get(dir))
            .and_then(|t| t.points.as_ref())
            .is_some()
    });

    let max_score_rat = if polygon_config.is_some_and(|p| p.enable_groups) {
        if let Some(p) = polygon_config {
            p.tests.values().fold(Rational::ZERO, |total, test| {
                if let Some(pts) = &test.points {
                    add_rational(total, parse_rational_value(pts))
                } else {
                    total
                }
            })
        } else {
            Rational::ZERO
        }
    } else if let Some(ts) = &config.total_score {
        if !ts.is_null() && !matches!(ts, serde_json::Value::String(s) if s.trim().is_empty()) {
            parse_rational_value(ts)
        } else {
            compute_default_max_score(
                test_cases.len(),
                test_directories,
                config,
                polygon_config,
                has_configured_polygon_points,
            )
        }
    } else {
        compute_default_max_score(
            test_cases.len(),
            test_directories,
            config,
            polygon_config,
            has_configured_polygon_points,
        )
    };

    score = round_display_score(score);
    let max_score = round_display_score(max_score_rat.to_f64());

    ProblemSummary {
        total: test_cases.len(),
        passed,
        score,
        max_score,
        status,
    }
}

fn compute_default_max_score(
    test_cases_len: usize,
    test_directories: &[String],
    config: &ProblemScoringConfig,
    polygon_config: Option<&PolygonScoringConfig>,
    has_configured_polygon_points: bool,
) -> Rational {
    if has_configured_polygon_points {
        test_directories
            .iter()
            .fold(Rational::ZERO, |total, test_dir| {
                let pts = polygon_config
                    .and_then(|p| p.tests.get(test_dir))
                    .and_then(|t| t.points.as_ref());
                if let Some(pts_val) = pts {
                    add_rational(total, parse_rational_value(pts_val))
                } else {
                    total
                }
            })
    } else if test_cases_len > 0 {
        test_directories
            .iter()
            .fold(Rational::ZERO, |total, test_dir| {
                let configured = config.test_scores.as_ref().and_then(|m| m.get(test_dir));
                let test_score = if let Some(score_val) = configured {
                    if !score_val.is_null()
                        && !matches!(score_val, serde_json::Value::String(s) if s.trim().is_empty())
                    {
                        parse_rational_value(score_val)
                    } else {
                        default_or_one(config.default_score.as_ref())
                    }
                } else {
                    default_or_one(config.default_score.as_ref())
                };
                add_rational(total, test_score)
            })
    } else {
        Rational::ZERO
    }
}

fn default_or_one(default_score: Option<&serde_json::Value>) -> Rational {
    if let Some(val) = default_score {
        if !val.is_null() && !matches!(val, serde_json::Value::String(s) if s.trim().is_empty()) {
            return parse_rational_value(val);
        }
    }
    Rational::ONE
}

fn apply_group_scoring(
    test_cases: &mut [TestCaseRun],
    polygon_config: Option<&PolygonScoringConfig>,
) {
    let Some(poly) = polygon_config else {
        return;
    };
    if !poly.enable_groups || poly.groups.is_empty() || test_cases.is_empty() {
        return;
    }

    struct GroupResult<'a> {
        all_accepted: bool,
        test_indices: Vec<usize>,
        config: &'a PolygonGroupConfig,
    }

    let mut group_results: HashMap<String, GroupResult> = HashMap::new();

    for (group_name, group_cfg) in &poly.groups {
        let mut test_indices = Vec::new();
        let mut all_ac = true;
        let mut count = 0;

        for (idx, test) in test_cases.iter().enumerate() {
            if let Some(t_cfg) = poly.tests.get(&test.name) {
                if t_cfg.group.as_deref() == Some(group_name) {
                    test_indices.push(idx);
                    count += 1;
                    if test.status != "AC" {
                        all_ac = false;
                    }
                }
            }
        }

        group_results.insert(
            group_name.clone(),
            GroupResult {
                all_accepted: count > 0 && all_ac,
                test_indices,
                config: group_cfg,
            },
        );
    }

    for group_result in group_results.values() {
        let deps_passed = group_result
            .config
            .dependencies
            .iter()
            .all(|dep| group_results.get(dep).is_none_or(|r| r.all_accepted));

        for &test_idx in &group_result.test_indices {
            let policy_complete = group_result.config.policy.as_deref() == Some("COMPLETE_GROUP");
            if !deps_passed || (policy_complete && !group_result.all_accepted) {
                test_cases[test_idx].score = serde_json::json!(0);
            }
        }
    }
}

fn calculate_problem_status(compile_status: &str, test_cases: &[TestCaseRun]) -> String {
    if compile_status == "CE" {
        return "CE".to_string();
    }
    if test_cases.is_empty() {
        return "AC".to_string();
    }

    let failed: Vec<&TestCaseRun> = test_cases.iter().filter(|t| t.status != "AC").collect();
    if failed.len() == test_cases.len() {
        return failed[0].status.clone();
    }
    if !failed.is_empty() {
        return "PARTIAL".to_string();
    }
    "AC".to_string()
}

fn round_display_score(score: f64) -> f64 {
    parse_rational_f64(score).to_f64()
}
