use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc::UnboundedSender;

static SESSION_TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);

use crate::discovery::{
    create_problem_directory_resolver, create_submission_resolver, discover_test_cases,
    list_contestants,
};
use crate::engine::compiler::compile_submission;
use crate::engine::runner::{run_test_case, TestCaseExecutionConfig};
use crate::scoring::{
    calculate_problem_summary, ProblemScoringConfig, ProblemSummary, TestCaseRun,
};
use crate::executor_client::ExecutorClient;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum JudgeStreamEvent {
    #[serde(rename = "metadata")]
    Metadata(serde_json::Value),
    #[serde(rename = "progress")]
    Progress(ProgressData),
    #[serde(rename = "problem_completed")]
    ProblemCompleted(ProblemCompletedData),
    #[serde(rename = "done")]
    Done { success: bool },
    #[serde(rename = "error")]
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressData {
    pub contestant: String,
    pub problem: String,
    pub action: String,
    pub percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProblemCompletedData {
    pub contestant: String,
    #[serde(rename = "problemResult")]
    pub problem_result: ProblemResultData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProblemResultData {
    #[serde(rename = "problemName")]
    pub problem_name: String,
    pub language: String,
    #[serde(rename = "compileStatus")]
    pub compile_status: String,
    #[serde(rename = "compileError")]
    pub compile_error: Option<String>,
    #[serde(rename = "compileTime")]
    pub compile_time: Option<u64>,
    #[serde(rename = "testCases")]
    pub test_cases: Vec<TestCaseRun>,
    pub summary: ProblemSummary,
}

pub struct JudgeSessionConfig {
    pub thisinh_path: PathBuf,
    pub test_path: PathBuf,
    pub job_id: String,
    pub target_contestants: Vec<String>,
    pub target_problems: Vec<String>,
    pub cancel_flag: Arc<AtomicBool>,
    pub platform: Arc<ExecutorClient>,
}

pub async fn run_judge_session(
    config: JudgeSessionConfig,
    event_tx: UnboundedSender<JudgeStreamEvent>,
) {
    let health = config.platform.health();

    let metadata = serde_json::json!({
        "startedAt": chrono_like_now(),
        "platform": if cfg!(windows) { "win32" } else { "darwin" },
        "arch": if cfg!(target_arch = "x86_64") { "x64" } else { "arm64" },
        "build": {
            "appVersion": "1.5.0",
            "gitCommit": "native",
            "buildNumber": "1",
            "builtAt": "2026-09-19"
        },
        "executor": {
            "mode": health.mode,
            "version": health.executor_version,
            "ready": health.ready
        },
        "toolchains": {
            "cpp": { "source": "system", "version": "14.2.0", "submissionReady": true }
        }
    });

    let _ = event_tx.send(JudgeStreamEvent::Metadata(metadata));

    let targets = if config.target_contestants.is_empty() {
        None
    } else {
        Some(config.target_contestants.as_slice())
    };

    let contestants = list_contestants(&config.thisinh_path, targets);
    let problem_resolver = create_problem_directory_resolver(&config.test_path);

    let active_problems: Vec<String> = if config.target_problems.is_empty() {
        if let Ok(entries) = std::fs::read_dir(&config.test_path) {
            let mut list = Vec::new();
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    list.push(entry.file_name().to_string_lossy().to_string());
                }
            }
            list
        } else {
            Vec::new()
        }
    } else {
        config.target_problems.clone()
    };

    let total_operations = contestants.len() * active_problems.len();
    let mut completed_operations = 0;

    for contestant in &contestants {
        let contestant_dir = config.thisinh_path.join(contestant);
        let resolve_submission = create_submission_resolver(&contestant_dir);

        for problem_name in &active_problems {
            if config.cancel_flag.load(Ordering::Relaxed) {
                let _ = event_tx.send(JudgeStreamEvent::Error {
                    message: "JUDGE_CANCELLED: judging was cancelled.".to_string(),
                });
                return;
            }

            let problem_dir = match problem_resolver(problem_name) {
                Some(dir) => dir,
                None => {
                    let missing_result = ProblemResultData {
                        problem_name: problem_name.clone(),
                        language: "unknown".to_string(),
                        compile_status: "SKIPPED".to_string(),
                        compile_error: Some("not_found".to_string()),
                        compile_time: None,
                        test_cases: Vec::new(),
                        summary: ProblemSummary {
                            total: 0,
                            passed: 0,
                            score: 0.0,
                            max_score: 0.0,
                            status: "FAIL".to_string(),
                        },
                    };
                    let _ =
                        event_tx.send(JudgeStreamEvent::ProblemCompleted(ProblemCompletedData {
                            contestant: contestant.clone(),
                            problem_result: missing_result,
                        }));
                    completed_operations += 1;
                    continue;
                }
            };

            // Read problem config from Config.cfg or config.json
            let cfg_path = problem_dir.path.join("Config.cfg");
            let fallback_cfg = problem_dir.path.join("config.json");
            let cfg_val: Option<serde_json::Value> = if cfg_path.is_file() {
                std::fs::read_to_string(&cfg_path)
                    .ok()
                    .and_then(|s| serde_json::from_str(&s).ok())
            } else if fallback_cfg.is_file() {
                std::fs::read_to_string(&fallback_cfg)
                    .ok()
                    .and_then(|s| serde_json::from_str(&s).ok())
            } else {
                None
            };

            let scoring_config: ProblemScoringConfig = cfg_val
                .as_ref()
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();

            let time_limit_ms = cfg_val
                .as_ref()
                .and_then(|v| v.get("timeLimit").or_else(|| v.get("time_limit")))
                .and_then(|v| v.as_u64())
                .unwrap_or(1000);

            let memory_limit_mb = cfg_val
                .as_ref()
                .and_then(|v| v.get("memoryLimit").or_else(|| v.get("memory_limit")))
                .and_then(|v| v.as_u64())
                .unwrap_or(256);

            let checker_type = cfg_val
                .as_ref()
                .and_then(|v| v.get("checkerType").or_else(|| v.get("checker_type")))
                .and_then(|v| v.as_str())
                .unwrap_or("C1")
                .to_string();

            let use_stdin = cfg_val
                .as_ref()
                .and_then(|v| v.get("useStdIn").or_else(|| v.get("useStdIO")))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let use_stdout = cfg_val
                .as_ref()
                .and_then(|v| v.get("useStdOut").or_else(|| v.get("useStdIO")))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let input_file_name = if use_stdin {
                String::new()
            } else {
                cfg_val
                    .as_ref()
                    .and_then(|v| v.get("inputFile"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("{}.inp", problem_name))
            };

            let output_file_name = if use_stdout {
                String::new()
            } else {
                cfg_val
                    .as_ref()
                    .and_then(|v| v.get("outputFile"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("{}.out", problem_name))
            };

            let percent = if total_operations > 0 {
                (completed_operations as f64 / total_operations as f64) * 100.0
            } else {
                0.0
            };

            let _ = event_tx.send(JudgeStreamEvent::Progress(ProgressData {
                contestant: contestant.clone(),
                problem: problem_name.clone(),
                action: "Discovering submission".to_string(),
                percent,
            }));

            let submission = match resolve_submission(problem_name) {
                Ok(Some(s)) => s,
                Ok(None) => {
                    let missing_result = ProblemResultData {
                        problem_name: problem_name.clone(),
                        language: "unknown".to_string(),
                        compile_status: "SKIPPED".to_string(),
                        compile_error: Some("not_found".to_string()),
                        compile_time: None,
                        test_cases: Vec::new(),
                        summary: ProblemSummary {
                            total: 0,
                            passed: 0,
                            score: 0.0,
                            max_score: 0.0,
                            status: "FAIL".to_string(),
                        },
                    };
                    let _ =
                        event_tx.send(JudgeStreamEvent::ProblemCompleted(ProblemCompletedData {
                            contestant: contestant.clone(),
                            problem_result: missing_result,
                        }));
                    completed_operations += 1;
                    continue;
                }
                Err(err) => {
                    let _ = event_tx.send(JudgeStreamEvent::Error { message: err });
                    return;
                }
            };

            // Compile submission
            let temp_id = SESSION_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
            let temp_dir = std::env::temp_dir().join(format!(
                "judge_{}_{}_{}_{}",
                std::process::id(),
                temp_id,
                contestant,
                problem_name
            ));
            let _ = std::fs::create_dir_all(&temp_dir);

            let _ = event_tx.send(JudgeStreamEvent::Progress(ProgressData {
                contestant: contestant.clone(),
                problem: problem_name.clone(),
                action: "Compiling".to_string(),
                percent,
            }));

            let compile_start = std::time::Instant::now();
            let comp_res =
                compile_submission(&submission.language, &submission.file_path, &temp_dir);
            let compile_time_ms = compile_start.elapsed().as_millis() as u64;

            if comp_res.status == "CE" {
                let problem_result = ProblemResultData {
                    problem_name: problem_name.clone(),
                    language: submission.language.clone(),
                    compile_status: "CE".to_string(),
                    compile_error: comp_res.error,
                    compile_time: Some(compile_time_ms),
                    test_cases: Vec::new(),
                    summary: ProblemSummary {
                        total: 0,
                        passed: 0,
                        score: 0.0,
                        max_score: 0.0,
                        status: "CE".to_string(),
                    },
                };

                let _ = event_tx.send(JudgeStreamEvent::ProblemCompleted(ProblemCompletedData {
                    contestant: contestant.clone(),
                    problem_result,
                }));
                let _ = std::fs::remove_dir_all(&temp_dir);
                completed_operations += 1;
                continue;
            }

            let exe_path = comp_res.executable.unwrap();
            let is_interactive = cfg_val
                .as_ref()
                .and_then(|v| v.get("isInteractive"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            // Resolve custom checker if present
            let platform_str = if cfg!(windows) { "win32" } else { "darwin" };
            let custom_checkers =
                crate::discovery::discover_custom_checkers(&problem_dir.path, platform_str);
            let custom_checker_name = if !crate::checkers::is_built_in_checker(&checker_type)
                && !checker_type.is_empty()
            {
                Some(checker_type.clone())
            } else {
                custom_checkers.first().cloned()
            };

            let compiled_checker_path: Option<PathBuf> =
                if let Some(ref chk_name) = custom_checker_name {
                    let chk_src = problem_dir.path.join(chk_name);
                    if chk_src.is_file() {
                        let chk_res = crate::engine::compiler::compile_checker(&chk_src, &temp_dir);
                        if chk_res.status == "OK" {
                            chk_res.executable
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                };

            let testcases = discover_test_cases(&problem_dir.path, is_interactive);
            let test_dirs: Vec<String> = testcases.iter().map(|tc| tc.name.clone()).collect();
            let mut test_runs = Vec::new();

            let tc_count = testcases.len();
            for (tc_idx, tc) in testcases.iter().enumerate() {
                if config.cancel_flag.load(Ordering::Relaxed) {
                    let _ = event_tx.send(JudgeStreamEvent::Error {
                        message: "JUDGE_CANCELLED: judging was cancelled.".to_string(),
                    });
                    return;
                }

                let tc_percent = percent
                    + (tc_idx as f64 / tc_count.max(1) as f64)
                        * (100.0 / total_operations.max(1) as f64);
                let _ = event_tx.send(JudgeStreamEvent::Progress(ProgressData {
                    contestant: contestant.clone(),
                    problem: problem_name.clone(),
                    action: format!("Judging Test {}", tc.name),
                    percent: tc_percent,
                }));

                let workspace_dir = temp_dir.join(&tc.name);
                let exec_res = run_test_case(TestCaseExecutionConfig {
                    executable_path: &exe_path,
                    input_path: &tc.input_path,
                    expected_output_path: &tc.output_path,
                    input_file_name: &input_file_name,
                    output_file_name: &output_file_name,
                    time_limit_ms,
                    memory_limit_mb,
                    checker_type: &checker_type,
                    custom_checker_path: compiled_checker_path.as_deref(),
                    workspace_dir: &workspace_dir,
                    platform: &config.platform,
                });

                let configured_points = scoring_config
                    .polygon_config
                    .as_ref()
                    .and_then(|p| p.tests.get(&tc.name))
                    .and_then(|t| t.points.clone())
                    .or_else(|| {
                        scoring_config
                            .test_scores
                            .as_ref()
                            .and_then(|m| m.get(&tc.name).cloned())
                    })
                    .or_else(|| scoring_config.default_score.clone())
                    .unwrap_or_else(|| serde_json::json!(1));

                let score_val = if exec_res.score_multiplier >= 1.0 {
                    configured_points
                } else if exec_res.score_multiplier > 0.0 {
                    let rat_mult =
                        crate::rational::float_to_rational(exec_res.score_multiplier, 10000);
                    let base_rat = crate::rational::parse_rational_value(&configured_points);
                    let partial_rat = crate::rational::multiply_rational(base_rat, rat_mult);
                    crate::rational::to_canonical_point_value(partial_rat)
                } else {
                    serde_json::json!(0)
                };

                test_runs.push(TestCaseRun {
                    name: tc.name.clone(),
                    status: exec_res.status,
                    score: score_val,
                    execution_time: Some(exec_res.execution_time_ms),
                    peak_memory: Some(exec_res.memory_used_kb),
                    checker_message: exec_res.message,
                    expected_output_preview: exec_res.expected_output_preview,
                    actual_output_preview: exec_res.actual_output_preview,
                    error_detail: exec_res.error_detail,
                });
            }

            let summary =
                calculate_problem_summary("OK", &mut test_runs, &test_dirs, &scoring_config);

            let problem_result = ProblemResultData {
                problem_name: problem_name.clone(),
                language: submission.language.clone(),
                compile_status: "OK".to_string(),
                compile_error: None,
                compile_time: Some(compile_time_ms),
                test_cases: test_runs,
                summary,
            };

            let _ = event_tx.send(JudgeStreamEvent::ProblemCompleted(ProblemCompletedData {
                contestant: contestant.clone(),
                problem_result,
            }));

            let _ = std::fs::remove_dir_all(&temp_dir);
            completed_operations += 1;
        }
    }

    let _ = event_tx.send(JudgeStreamEvent::Progress(ProgressData {
        contestant: String::new(),
        problem: String::new(),
        action: "progress.completed".to_string(),
        percent: 100.0,
    }));

    let _ = event_tx.send(JudgeStreamEvent::Done { success: true });
}

fn chrono_like_now() -> String {
    chrono::Utc::now().to_rfc3339()
}
