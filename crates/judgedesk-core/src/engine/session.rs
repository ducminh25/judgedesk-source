use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc::UnboundedSender;

static SESSION_TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);

use crate::discovery::testcase::read_stored_problem_config;
use crate::discovery::{
    create_problem_directory_resolver, create_submission_resolver, discover_test_cases,
    list_contestants,
};
use crate::engine::compiler::{
    compile_checker_with_executor, compile_submission_with_selection, CompileSubmissionRequest,
};
use crate::engine::runner::{
    run_interactive_test_case_with_max_score, run_test_case_with_max_score, TestCaseExecutionConfig,
};
use crate::executor_client::ExecutorClient;
use crate::scoring::{calculate_problem_summary, ProblemSummary, TestCaseRun};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum JudgeStreamEvent {
    #[serde(rename = "metadata")]
    Metadata(serde_json::Value),
    #[serde(rename = "progress")]
    Progress(ProgressData),
    #[serde(rename = "problem_completed")]
    ProblemCompleted(Box<ProblemCompletedData>),
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
    pub problem_configs: std::collections::HashMap<String, serde_json::Value>,
    pub app_data_dir: Option<PathBuf>,
    pub toolchain_selections:
        std::collections::HashMap<String, crate::server::dto::ProfileSelection>,
    pub cancel_flag: Arc<AtomicBool>,
    pub platform: Arc<ExecutorClient>,
}

fn build_toolchain_metadata_entry(
    profile_id: &str,
    config: &JudgeSessionConfig,
) -> serde_json::Value {
    let sel = config.toolchain_selections.get(profile_id);
    let mode = sel.map(|s| s.mode.as_str());
    let custom = sel.and_then(|s| s.local_path.as_deref());
    let tc = crate::toolchains::discovery::resolve_toolchain_for_profile_in(
        config.app_data_dir.as_deref(),
        profile_id,
        mode,
        custom,
    );
    if cfg!(target_os = "macos") && profile_id == "cpp" && mode == Some("managed") && !tc.ready {
        return serde_json::json!({
            "checkerReady": false,
            "source": "managed",
            "submissionReady": false,
            "version": ""
        });
    }
    let source = if tc.ready {
        tc.source_mode.as_str()
    } else {
        "system"
    };
    let version = if tc.version == "unknown" || tc.version.is_empty() {
        if profile_id == "python" {
            "3.12.0".to_string()
        } else {
            "14.2.0".to_string()
        }
    } else {
        tc.version
    };
    if profile_id == "python" {
        serde_json::json!({
            "checkerReady": true,
            "source": source,
            "submissionReady": true,
            "version": version
        })
    } else {
        serde_json::json!({
            "checkerReady": true,
            "provenance": if source == "managed" { "managed-package" } else { "quick_verified_direct" },
            "source": source,
            "submissionReady": true,
            "version": version
        })
    }
}

pub async fn run_judge_session(
    config: JudgeSessionConfig,
    event_tx: UnboundedSender<JudgeStreamEvent>,
) {
    if config.cancel_flag.load(Ordering::SeqCst) {
        let _ = event_tx.send(JudgeStreamEvent::Error {
            message: "JUDGE_CANCELLED: judging was cancelled.".to_string(),
        });
        return;
    }

    let health = config.platform.health();
    let cpp_meta = build_toolchain_metadata_entry("cpp", &config);
    let python_meta = build_toolchain_metadata_entry("python", &config);

    let metadata = serde_json::json!({
        "startedAt": chrono_like_now(),
        "platform": if cfg!(windows) { "win32" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" },
        "arch": if cfg!(target_arch = "x86_64") { "x64" } else { "arm64" },
        "build": crate::build_metadata::BUILD_METADATA,
        "executor": {
            "mode": health.mode,
            "version": health.executor_version,
            "ready": health.ready
        },
        "toolchains": {
            "cpp": cpp_meta,
            "python": python_meta
        }
    });

    let _ = event_tx.send(JudgeStreamEvent::Metadata(metadata));

    let _ = event_tx.send(JudgeStreamEvent::Progress(ProgressData {
        contestant: String::new(),
        problem: String::new(),
        action: "progress.scanning".to_string(),
        percent: 0.0,
    }));

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
    let mut compiled_helper_cache: std::collections::HashMap<
        PathBuf,
        (
            Option<crate::storage::OwnedWorkspace>,
            crate::engine::compiler::CompilationOutput,
        ),
    > = std::collections::HashMap::new();

    for contestant in &contestants {
        let contestant_dir = config.thisinh_path.join(contestant);
        let resolve_submission = create_submission_resolver(&contestant_dir);

        for problem_name in &active_problems {
            if config.cancel_flag.load(Ordering::SeqCst) {
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
                            score_exact: None,
                            max_score_exact: None,
                            status: "FAIL".to_string(),
                        },
                    };
                    let _ = event_tx.send(JudgeStreamEvent::ProblemCompleted(Box::new(
                        ProblemCompletedData {
                            contestant: contestant.clone(),
                            problem_result: missing_result,
                        },
                    )));
                    completed_operations += 1;
                    continue;
                }
            };

            let cfg_val = read_stored_problem_config(&problem_dir.path);
            let req_cfg_val = config.problem_configs.get(problem_name).or_else(|| {
                config
                    .problem_configs
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case(problem_name))
                    .map(|(_, v)| v)
            });
            let normalized_cfg = match crate::discovery::try_normalize_problem_config(
                problem_name,
                req_cfg_val,
                cfg_val.as_ref(),
            ) {
                Ok(cfg) => cfg,
                Err(message) => {
                    let _ = event_tx.send(JudgeStreamEvent::Error { message });
                    return;
                }
            };

            let mut effective_wellformed_cfg = cfg_val.clone().or_else(|| req_cfg_val.cloned());
            if normalized_cfg.test_well_formed {
                let mut obj = effective_wellformed_cfg
                    .and_then(|v| v.as_object().cloned())
                    .unwrap_or_default();
                obj.insert("testWellFormed".to_string(), serde_json::Value::Bool(true));
                obj.insert(
                    "isInteractive".to_string(),
                    serde_json::Value::Bool(normalized_cfg.is_interactive),
                );
                effective_wellformed_cfg = Some(serde_json::Value::Object(obj));
            }
            if let Err(message) = crate::discovery::test_wellformed::validate_configured_test_inputs(
                &problem_dir.path,
                effective_wellformed_cfg.as_ref(),
            ) {
                let _ = event_tx.send(JudgeStreamEvent::Error { message });
                return;
            }

            let scoring_config = normalized_cfg.scoring_config.clone();
            let memory_limit_mb = normalized_cfg.memory_limit_mb;
            let checker_type = normalized_cfg.checker_type.clone();
            let input_file_name = normalized_cfg.input_file_for_execution();
            let output_file_name = normalized_cfg.output_file_for_execution();
            let is_interactive = normalized_cfg.is_interactive;

            let testcases = discover_test_cases(&problem_dir.path, is_interactive);
            let test_dirs: Vec<String> = testcases.iter().map(|tc| tc.name.clone()).collect();

            let percent = if total_operations > 0 {
                (completed_operations as f64 / total_operations as f64) * 100.0
            } else {
                0.0
            };

            let _ = event_tx.send(JudgeStreamEvent::Progress(ProgressData {
                contestant: contestant.clone(),
                problem: problem_name.clone(),
                action: "progress.locating".to_string(),
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
                            score_exact: None,
                            max_score_exact: None,
                            status: "FAIL".to_string(),
                        },
                    };
                    let _ = event_tx.send(JudgeStreamEvent::ProblemCompleted(Box::new(
                        ProblemCompletedData {
                            contestant: contestant.clone(),
                            problem_result: missing_result,
                        },
                    )));
                    completed_operations += 1;
                    continue;
                }
                Err(err) => {
                    let _ = event_tx.send(JudgeStreamEvent::Error { message: err });
                    return;
                }
            };

            if let Some(unreadable_tc) = testcases
                .iter()
                .find(|tc| !crate::discovery::test_wellformed::is_text_file(&tc.input_path))
            {
                let summary =
                    calculate_problem_summary("JE", &mut Vec::new(), &test_dirs, &scoring_config);
                let problem_result = ProblemResultData {
                    problem_name: problem_name.clone(),
                    language: submission.language.clone(),
                    compile_status: "JE".to_string(),
                    compile_error: Some(format!(
                        "Unreadable input file: {}. Only text files are allowed.",
                        unreadable_tc.input_file_name
                    )),
                    compile_time: Some(0),
                    test_cases: Vec::new(),
                    summary,
                };
                let _ = event_tx.send(JudgeStreamEvent::ProblemCompleted(Box::new(
                    ProblemCompletedData {
                        contestant: contestant.clone(),
                        problem_result,
                    },
                )));
                completed_operations += 1;
                continue;
            }

            // Compile submission inside an OwnedWorkspace
            let _temp_id = SESSION_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
            let compile_ws = match crate::storage::OwnedWorkspace::create_in_temp("judge") {
                Ok(ws) => ws,
                Err(err) => {
                    let _ = event_tx.send(JudgeStreamEvent::Error {
                        message: format!("Failed to create compile workspace: {err}"),
                    });
                    return;
                }
            };
            let temp_dir = compile_ws.root().to_path_buf();

            let _ = event_tx.send(JudgeStreamEvent::Progress(ProgressData {
                contestant: contestant.clone(),
                problem: problem_name.clone(),
                action: "progress.compilingSubmission".to_string(),
                percent,
            }));

            let lower_lang = submission.language.trim().to_ascii_lowercase();
            let profile_key = match lower_lang.as_str() {
                "cpp" | "c++" | "cc" | "cxx" => "cpp",
                "c" => "c",
                "python" | "py" | "python3" => "python",
                "pascal" | "pas" | "pp" | "fpc" => "pascal",
                "java" => "java",
                other => other,
            };
            let sel = config.toolchain_selections.get(profile_key);
            let preferred_mode = sel.map(|s| s.mode.as_str());
            let custom_path = sel.and_then(|s| s.local_path.as_deref());

            let compile_start = std::time::Instant::now();
            let comp_res = compile_submission_with_selection(
                CompileSubmissionRequest {
                    language: &submission.language,
                    source_path: &submission.file_path,
                    output_dir: &temp_dir,
                    platform: &config.platform,
                    timeout_ms: None,
                    extra_include_dirs: &[],
                },
                Some(&normalized_cfg.compile),
                preferred_mode,
                custom_path,
            );
            let compile_time_ms = compile_start.elapsed().as_millis() as u64;

            if config.cancel_flag.load(Ordering::SeqCst) {
                let _ = event_tx.send(JudgeStreamEvent::Error {
                    message: "JUDGE_CANCELLED: judging was cancelled.".to_string(),
                });
                return;
            }

            if comp_res.status == "CE" || comp_res.status == "JE" {
                let failure_status = comp_res.status.clone();
                let summary = calculate_problem_summary(
                    &failure_status,
                    &mut Vec::new(),
                    &test_dirs,
                    &scoring_config,
                );
                let problem_result = ProblemResultData {
                    problem_name: problem_name.clone(),
                    language: submission.language.clone(),
                    compile_status: failure_status,
                    compile_error: comp_res.error,
                    compile_time: Some(compile_time_ms),
                    test_cases: Vec::new(),
                    summary,
                };

                let _ = event_tx.send(JudgeStreamEvent::ProblemCompleted(Box::new(
                    ProblemCompletedData {
                        contestant: contestant.clone(),
                        problem_result,
                    },
                )));
                completed_operations += 1;
                continue;
            }

            let exe_path = match comp_res.executable {
                Some(path) => path,
                None => {
                    let summary = calculate_problem_summary(
                        "CE",
                        &mut Vec::new(),
                        &test_dirs,
                        &scoring_config,
                    );
                    let problem_result = ProblemResultData {
                        problem_name: problem_name.clone(),
                        language: submission.language.clone(),
                        compile_status: "CE".to_string(),
                        compile_error: comp_res
                            .error
                            .or_else(|| Some("No executable generated".to_string())),
                        compile_time: Some(compile_time_ms),
                        test_cases: Vec::new(),
                        summary,
                    };

                    let _ = event_tx.send(JudgeStreamEvent::ProblemCompleted(Box::new(
                        ProblemCompletedData {
                            contestant: contestant.clone(),
                            problem_result,
                        },
                    )));
                    completed_operations += 1;
                    continue;
                }
            };

            // Resolve custom checker or interactor if present — fail closed (JE) if compilation fails
            let platform_str = if cfg!(windows) {
                "win32"
            } else if cfg!(target_os = "macos") {
                "darwin"
            } else {
                "linux"
            };
            let mut checker_compile_error: Option<String> = None;
            let compiled_interactor_path: Option<PathBuf> = if is_interactive {
                let discovered_interactors =
                    crate::discovery::discover_interactors(&problem_dir.path, platform_str);
                let inter_name = if !normalized_cfg.interactor.is_empty() {
                    Some(normalized_cfg.interactor.clone())
                } else {
                    discovered_interactors.first().cloned()
                };
                if let Some(ref name) = inter_name {
                    let inter_src = problem_dir.path.join(name);
                    if inter_src.is_file() {
                        let inter_res = if let Some((_, cached)) =
                            compiled_helper_cache.get(&inter_src)
                        {
                            cached.clone()
                        } else {
                            let _ = event_tx.send(JudgeStreamEvent::Progress(ProgressData {
                                contestant: contestant.clone(),
                                problem: problem_name.clone(),
                                action: format!("Compiling interactor ({name})"),
                                percent,
                            }));
                            let helper_ws =
                                crate::storage::OwnedWorkspace::create_in_temp("interactor").ok();
                            let out_root =
                                helper_ws.as_ref().map(|ws| ws.root()).unwrap_or(&temp_dir);
                            let res = compile_checker_with_executor(
                                &inter_src,
                                out_root,
                                &config.platform,
                            );
                            compiled_helper_cache
                                .insert(inter_src.clone(), (helper_ws, res.clone()));
                            res
                        };
                        if inter_res.status == "OK" {
                            inter_res.executable
                        } else {
                            checker_compile_error = Some(format!(
                                "Interactor '{name}' failed to compile: {}",
                                inter_res.error.unwrap_or(inter_res.status)
                            ));
                            None
                        }
                    } else {
                        checker_compile_error = Some(format!(
                            "Interactor '{name}' not found in problem directory"
                        ));
                        None
                    }
                } else {
                    checker_compile_error = Some(
                        "Interactive problem is missing an interactor executable or source file"
                            .to_string(),
                    );
                    None
                }
            } else {
                None
            };

            let custom_checkers =
                crate::discovery::discover_custom_checkers(&problem_dir.path, platform_str);
            let explicit_custom_checker = !is_interactive
                && !crate::checkers::is_built_in_checker(&checker_type)
                && !checker_type.is_empty();
            let custom_checker_name = if is_interactive {
                None
            } else if explicit_custom_checker {
                Some(checker_type.clone())
            } else {
                custom_checkers.first().cloned()
            };

            let compiled_checker_path: Option<PathBuf> = if let Some(ref chk_name) =
                custom_checker_name
            {
                let chk_src = problem_dir.path.join(chk_name);
                if chk_src.is_file() {
                    let chk_res = if let Some((_, cached)) = compiled_helper_cache.get(&chk_src) {
                        cached.clone()
                    } else {
                        let _ = event_tx.send(JudgeStreamEvent::Progress(ProgressData {
                            contestant: contestant.clone(),
                            problem: problem_name.clone(),
                            action: format!("Compiling custom checker ({chk_name})"),
                            percent,
                        }));
                        let helper_ws =
                            crate::storage::OwnedWorkspace::create_in_temp("checker").ok();
                        let out_root = helper_ws.as_ref().map(|ws| ws.root()).unwrap_or(&temp_dir);
                        let res =
                            compile_checker_with_executor(&chk_src, out_root, &config.platform);
                        compiled_helper_cache.insert(chk_src.clone(), (helper_ws, res.clone()));
                        res
                    };
                    if chk_res.status == "OK" {
                        chk_res.executable
                    } else {
                        checker_compile_error = Some(format!(
                            "Custom checker '{chk_name}' failed to compile: {}",
                            chk_res.error.unwrap_or(chk_res.status)
                        ));
                        None
                    }
                } else if explicit_custom_checker {
                    checker_compile_error = Some(format!(
                        "Custom checker '{chk_name}' not found in problem directory"
                    ));
                    None
                } else {
                    None
                }
            } else {
                None
            };

            if config.cancel_flag.load(Ordering::SeqCst) {
                let _ = event_tx.send(JudgeStreamEvent::Error {
                    message: "JUDGE_CANCELLED: judging was cancelled.".to_string(),
                });
                return;
            }

            if let Some(chk_err) = checker_compile_error {
                let summary =
                    calculate_problem_summary("JE", &mut Vec::new(), &test_dirs, &scoring_config);
                let problem_result = ProblemResultData {
                    problem_name: problem_name.clone(),
                    language: submission.language.clone(),
                    compile_status: "JE".to_string(),
                    compile_error: Some(chk_err),
                    compile_time: Some(compile_time_ms),
                    test_cases: Vec::new(),
                    summary,
                };
                let _ = event_tx.send(JudgeStreamEvent::ProblemCompleted(Box::new(
                    ProblemCompletedData {
                        contestant: contestant.clone(),
                        problem_result,
                    },
                )));
                completed_operations += 1;
                continue;
            }

            let mut test_runs = Vec::new();
            let tc_weights: Vec<crate::rational::Rational> = testcases
                .iter()
                .map(|tc| test_case_weight(&scoring_config, &tc.name))
                .collect();
            let total_weight = tc_weights
                .iter()
                .fold(crate::rational::Rational::ZERO, |acc, w| {
                    crate::rational::add_rational(acc, w.clone())
                });

            let tc_count = testcases.len();
            for (tc_idx, tc) in testcases.iter().enumerate() {
                if config.cancel_flag.load(Ordering::SeqCst) {
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
                    action: format!("Judging test {} of {}", tc_idx + 1, tc_count),
                    percent: tc_percent,
                }));

                let tc_time_limit_ms = normalized_cfg.test_time_limit_ms(&tc.name);
                let workspace_dir = temp_dir.join(&tc.name);
                let tc_cfg = TestCaseExecutionConfig {
                    executable_path: &exe_path,
                    input_path: &tc.input_path,
                    expected_output_path: &tc.output_path,
                    input_file_name,
                    output_file_name,
                    time_limit_ms: tc_time_limit_ms,
                    memory_limit_mb,
                    checker_type: &checker_type,
                    custom_checker_path: compiled_checker_path.as_deref(),
                    workspace_dir: &workspace_dir,
                    platform: &config.platform,
                };
                let tc_max_score_exact = test_case_score(
                    &scoring_config,
                    tc_weights[tc_idx].clone(),
                    total_weight.clone(),
                );
                let exec_res = if let Some(ref inter_exe) = compiled_interactor_path {
                    run_interactive_test_case_with_max_score(
                        tc_cfg,
                        inter_exe,
                        tc_max_score_exact.clone(),
                    )
                } else {
                    run_test_case_with_max_score(tc_cfg, tc_max_score_exact.clone())
                };

                if config.cancel_flag.load(Ordering::SeqCst) {
                    let _ = event_tx.send(JudgeStreamEvent::Error {
                        message: "JUDGE_CANCELLED: judging was cancelled.".to_string(),
                    });
                    return;
                }

                let exact_award = crate::rational::multiply_rational(
                    tc_max_score_exact,
                    exec_res.score_multiplier_exact,
                );
                let score_val = crate::rational::to_canonical_point_value(exact_award.clone());

                test_runs.push(TestCaseRun {
                    name: tc.name.clone(),
                    status: exec_res.status,
                    score: score_val,
                    score_exact: Some(exact_award),
                    execution_time: Some(exec_res.execution_time_ms),
                    peak_memory: Some(exec_res.memory_used_kb),
                    checker_message: exec_res.message,
                    expected_output_preview: exec_res.expected_output_preview,
                    actual_output_preview: exec_res.actual_output_preview,
                    error_detail: exec_res.error_detail,
                    execution: exec_res.execution,
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

            let _ = event_tx.send(JudgeStreamEvent::ProblemCompleted(Box::new(
                ProblemCompletedData {
                    contestant: contestant.clone(),
                    problem_result,
                },
            )));

            drop(compile_ws);
            completed_operations += 1;
        }
    }

    if !contestants.is_empty() {
        let _ = event_tx.send(JudgeStreamEvent::Progress(ProgressData {
            contestant: String::new(),
            problem: String::new(),
            action: "progress.completed".to_string(),
            percent: 100.0,
        }));
    }

    let _ = event_tx.send(JudgeStreamEvent::Done { success: true });
}

fn is_non_empty_score_value(val: &serde_json::Value) -> bool {
    !val.is_null() && !matches!(val, serde_json::Value::String(s) if s.trim().is_empty())
}

fn test_case_weight(
    config: &crate::scoring::ProblemScoringConfig,
    test_name: &str,
) -> crate::rational::Rational {
    if let Some(pts) = config
        .polygon_config
        .as_ref()
        .and_then(|p| p.tests.get(test_name))
        .and_then(|t| t.points.as_ref())
        .filter(|v| is_non_empty_score_value(v))
    {
        return crate::rational::parse_rational_value(pts);
    }
    if let Some(pts) = config
        .test_scores
        .as_ref()
        .and_then(|m| m.get(test_name))
        .filter(|v| is_non_empty_score_value(v))
    {
        return crate::rational::parse_rational_value(pts);
    }
    crate::scoring::default_or_one(config.default_score.as_ref())
}

fn test_case_score(
    config: &crate::scoring::ProblemScoringConfig,
    weight: crate::rational::Rational,
    total_weight: crate::rational::Rational,
) -> crate::rational::Rational {
    let enable_groups = config
        .polygon_config
        .as_ref()
        .is_some_and(|p| p.enable_groups);
    if !enable_groups {
        if let Some(ts) = config
            .total_score
            .as_ref()
            .filter(|v| is_non_empty_score_value(v))
        {
            if total_weight.is_zero() {
                return crate::rational::Rational::ZERO;
            }
            let total_score_rat = crate::rational::parse_rational_value(ts);
            return crate::rational::divide_rational(
                crate::rational::multiply_rational(weight, total_score_rat),
                total_weight,
            );
        }
    }
    weight
}

fn chrono_like_now() -> String {
    chrono::Utc::now().to_rfc3339()
}
