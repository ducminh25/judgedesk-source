use judgedesk_core::scoring::*;
use serde_json::json;
use std::collections::HashMap;

fn test_case(name: &str, status: &str, score: serde_json::Value) -> TestCaseRun {
    TestCaseRun {
        name: name.to_string(),
        status: status.to_string(),
        score,
        execution_time: Some(1),
        peak_memory: None,
        checker_message: None,
        expected_output_preview: None,
        actual_output_preview: None,
        error_detail: None,
    }
}

#[test]
fn test_complete_group_and_dependencies_clear_scores() {
    let mut test_cases = vec![
        test_case("a1", "AC", json!(5)),
        test_case("a2", "WA", json!(0)),
        test_case("b1", "AC", json!(5)),
    ];

    let mut groups = HashMap::new();
    groups.insert(
        "A".to_string(),
        PolygonGroupConfig {
            dependencies: vec![],
            policy: Some("COMPLETE_GROUP".to_string()),
        },
    );
    groups.insert(
        "B".to_string(),
        PolygonGroupConfig {
            dependencies: vec!["A".to_string()],
            policy: None,
        },
    );

    let mut tests = HashMap::new();
    tests.insert(
        "a1".to_string(),
        PolygonTestConfig {
            group: Some("A".to_string()),
            points: Some(json!(5)),
        },
    );
    tests.insert(
        "a2".to_string(),
        PolygonTestConfig {
            group: Some("A".to_string()),
            points: Some(json!(5)),
        },
    );
    tests.insert(
        "b1".to_string(),
        PolygonTestConfig {
            group: Some("B".to_string()),
            points: Some(json!(5)),
        },
    );

    let config = ProblemScoringConfig {
        polygon_config: Some(PolygonScoringConfig {
            enable_groups: true,
            groups,
            tests,
        }),
        total_score: None,
        default_score: None,
        test_scores: None,
    };

    let dirs = vec!["a1".to_string(), "a2".to_string(), "b1".to_string()];
    let summary = calculate_problem_summary("OK", &mut test_cases, &dirs, &config);

    let scores: Vec<i64> = test_cases
        .iter()
        .map(|t| t.score.as_i64().unwrap())
        .collect();
    assert_eq!(scores, vec![0, 0, 0]);
    assert_eq!(
        summary,
        ProblemSummary {
            total: 3,
            passed: 2,
            score: 0.0,
            max_score: 15.0,
            status: "PARTIAL".to_string(),
        }
    );
}

#[test]
fn test_configured_total_score_and_rounding() {
    let mut test_cases = vec![
        test_case("01", "AC", json!(33.3333)),
        test_case("02", "AC", json!(66.6667)),
    ];
    let dirs = vec!["01".to_string(), "02".to_string()];
    let config = ProblemScoringConfig {
        polygon_config: None,
        total_score: Some(json!(100)),
        default_score: Some(json!(1)),
        test_scores: None,
    };

    let summary = calculate_problem_summary("OK", &mut test_cases, &dirs, &config);
    assert_eq!(
        summary,
        ProblemSummary {
            total: 2,
            passed: 2,
            score: 100.0,
            max_score: 100.0,
            status: "AC".to_string(),
        }
    );
}

#[test]
fn test_polygon_test_points_without_groups() {
    let mut test_cases = vec![
        test_case("test01", "AC", json!(0.4)),
        test_case("test02", "AC", json!(0.4)),
        test_case("test03", "WA", json!(0)),
    ];
    let dirs = vec![
        "test01".to_string(),
        "test02".to_string(),
        "test03".to_string(),
    ];
    let mut tests = HashMap::new();
    tests.insert(
        "test01".to_string(),
        PolygonTestConfig {
            group: None,
            points: Some(json!(0.4)),
        },
    );
    tests.insert(
        "test02".to_string(),
        PolygonTestConfig {
            group: None,
            points: Some(json!(0.4)),
        },
    );
    tests.insert(
        "test03".to_string(),
        PolygonTestConfig {
            group: None,
            points: Some(json!(0.4)),
        },
    );

    let config = ProblemScoringConfig {
        polygon_config: Some(PolygonScoringConfig {
            enable_groups: false,
            groups: HashMap::new(),
            tests,
        }),
        total_score: None,
        default_score: Some(json!(1)),
        test_scores: None,
    };

    let summary = calculate_problem_summary("OK", &mut test_cases, &dirs, &config);
    assert_eq!(
        summary,
        ProblemSummary {
            total: 3,
            passed: 2,
            score: 0.8,
            max_score: 1.2,
            status: "PARTIAL".to_string(),
        }
    );
}

#[test]
fn test_compile_errors_take_precedence() {
    let mut test_cases = vec![];
    let dirs = vec![];
    let config = ProblemScoringConfig::default();

    let summary = calculate_problem_summary("CE", &mut test_cases, &dirs, &config);
    assert_eq!(summary.status, "CE");
}

#[test]
fn test_ieee_floating_point_precision_epsilon_elimination() {
    let mut test_cases35: Vec<TestCaseRun> = (0..10)
        .map(|i| test_case(&format!("t{i}"), "AC", json!(0.35)))
        .collect();
    let dirs35: Vec<String> = (0..10).map(|i| format!("t{i}")).collect();
    let mut tests35 = HashMap::new();
    for dir in &dirs35 {
        tests35.insert(
            dir.clone(),
            PolygonTestConfig {
                group: None,
                points: Some(json!(0.35)),
            },
        );
    }
    let config35 = ProblemScoringConfig {
        polygon_config: Some(PolygonScoringConfig {
            enable_groups: false,
            groups: HashMap::new(),
            tests: tests35,
        }),
        total_score: None,
        default_score: None,
        test_scores: None,
    };
    let summary35 = calculate_problem_summary("OK", &mut test_cases35, &dirs35, &config35);
    assert_eq!(summary35.score, 3.5);
    assert_eq!(summary35.max_score, 3.5);

    let mut test_cases30: Vec<TestCaseRun> = (0..10)
        .map(|i| test_case(&format!("t{i}"), "AC", json!(0.3)))
        .collect();
    let dirs30: Vec<String> = (0..10).map(|i| format!("t{i}")).collect();
    let mut tests30 = HashMap::new();
    for dir in &dirs30 {
        tests30.insert(
            dir.clone(),
            PolygonTestConfig {
                group: None,
                points: Some(json!(0.3)),
            },
        );
    }
    let config30 = ProblemScoringConfig {
        polygon_config: Some(PolygonScoringConfig {
            enable_groups: false,
            groups: HashMap::new(),
            tests: tests30,
        }),
        total_score: None,
        default_score: None,
        test_scores: None,
    };
    let summary30 = calculate_problem_summary("OK", &mut test_cases30, &dirs30, &config30);
    assert_eq!(summary30.score, 3.0);
    assert_eq!(summary30.max_score, 3.0);
}

#[test]
fn test_fractional_points_exact_rational_accumulation() {
    let mut test_cases: Vec<TestCaseRun> = (0..6)
        .map(|i| test_case(&format!("t{i}"), "AC", json!(1.0 / 3.0)))
        .collect();
    let dirs: Vec<String> = (0..6).map(|i| format!("t{i}")).collect();
    let mut tests = HashMap::new();
    for dir in &dirs {
        tests.insert(
            dir.clone(),
            PolygonTestConfig {
                group: None,
                points: Some(json!("1/3")),
            },
        );
    }
    let config = ProblemScoringConfig {
        polygon_config: Some(PolygonScoringConfig {
            enable_groups: false,
            groups: HashMap::new(),
            tests,
        }),
        total_score: None,
        default_score: None,
        test_scores: None,
    };
    let summary = calculate_problem_summary("OK", &mut test_cases, &dirs, &config);
    assert_eq!(summary.score, 2.0);
    assert_eq!(summary.max_score, 2.0);
}

#[test]
fn group_max_score_ignores_stale_tests_and_missing_dependencies_block_points() {
    let mut test_cases = vec![
        test_case("1", "AC", json!("1/3")),
        test_case("2", "AC", json!(1)),
    ];
    let config = ProblemScoringConfig {
        polygon_config: Some(PolygonScoringConfig {
            enable_groups: true,
            groups: HashMap::from([(
                "group".to_string(),
                PolygonGroupConfig {
                    dependencies: vec!["missing".to_string()],
                    policy: Some("EACH_TEST".to_string()),
                },
            )]),
            tests: HashMap::from([
                (
                    "1".to_string(),
                    PolygonTestConfig {
                        group: Some("group".to_string()),
                        points: Some(json!("1/3")),
                    },
                ),
                (
                    "stale".to_string(),
                    PolygonTestConfig {
                        group: None,
                        points: Some(json!(100)),
                    },
                ),
            ]),
        }),
        ..Default::default()
    };
    let summary = calculate_problem_summary(
        "OK",
        &mut test_cases,
        &["1".to_string(), "2".to_string()],
        &config,
    );
    assert_eq!(summary.max_score, 1.3333333333333333);
    assert_eq!(test_cases[0].score, json!(0));
    assert_eq!(test_cases[1].score, json!(1));
}
