mod common;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use judgedesk_core::engine::compiler::compile_checker_with_executor;
use judgedesk_core::engine::runner::{run_test_case, TestCaseExecutionConfig};
use judgedesk_core::engine::{run_judge_session, JudgeSessionConfig, JudgeStreamEvent};
use judgedesk_core::executor_client::ExecutorClient;
use judgedesk_core::rational::{
    add_rational, format_rational, multiply_rational, parse_rational, subtract_rational, Rational,
};

fn spawn_test_executor(env: &common::OwnedTestEnvironment) -> ExecutorClient {
    common::ensure_test_environment();
    let exe_path = common::executor_binary_path();
    env.with_isolated_roots(|| ExecutorClient::spawn_sync(&exe_path).expect("spawn test executor"))
}

#[test]
fn step5_exact_bigint_rational_overflow_and_long_decimal_precision() {
    // 1. Sum 1/p_k for the first 25 primes (product ~ 2.3e36 >> i64::MAX ~ 9.22e18).
    // Subtracting the first 24 primes must recover 1/97 with zero overflow or saturation drift.
    let primes: [i64; 25] = [
        2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89,
        97,
    ];
    let mut sum = Rational::ZERO;
    for &p in &primes {
        sum = add_rational(sum, Rational::new(1, p));
    }
    for &p in &primes[..24] {
        sum = subtract_rational(sum, Rational::new(1, p));
    }
    assert_eq!(
        format_rational(sum, 2),
        "1/97",
        "BigInt Rational must not overflow or saturate when LCM exceeds i64::MAX"
    );

    // 2. Exact 29-digit decimal string parsing without IEEE-754 f64 loss
    let dec = parse_rational("0.12345678901234567890123456789");
    let scale = parse_rational("100000000000000000000000000000");
    let prod = multiply_rational(dec, scale);
    assert_eq!(
        format_rational(prod, 2),
        "12345678901234567890123456789",
        "Decimal string parsing must not truncate to 53-bit f64 mantissa"
    );

    // 3. Huge fraction reduction beyond u128::MAX
    let huge = parse_rational(
        "300000000000000000000000000000000000000000000/900000000000000000000000000000000000000000000",
    );
    assert_eq!(format_rational(huge, 2), "1/3");
}

#[test]
fn step5_custom_checker_runs_inside_sandbox_and_zero_host_command_spawns_in_runner() {
    let runner_rs = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("engine")
        .join("runner.rs");
    let source = fs::read_to_string(&runner_rs).expect("read runner.rs");
    assert!(
        !source.contains("std::process::Command") && !source.contains("Command::new"),
        "runner.rs must not spawn custom checkers on the host via std::process::Command"
    );

    let env = common::OwnedTestEnvironment::new();
    let client = spawn_test_executor(&env);

    // Create a host secret outside the executor root that a sandboxed custom checker MUST NOT be able to read
    let secret_file = env.root().join("host_secret_outside_sandbox.txt");
    fs::write(&secret_file, "TOP_SECRET_VALUE").unwrap();
    let escaped_secret = secret_file.to_string_lossy().replace('\\', "\\\\");

    let work_dir = env.root().join("checker_work");
    fs::create_dir_all(&work_dir).unwrap();

    // Custom checker that:
    // 1. Tries to read host_secret_outside_sandbox.txt; if readable, exits 3 (FAIL — sandbox escape!).
    // 2. Reads actual.txt (argv[2]); if "42", exits 0 (AC); if "21", outputs "0.5\n" to stdout and "Half credit\n" to stderr and exits 0 (PARTIAL); otherwise exits 1 (WA).
    let chk_src = work_dir.join("chk.cpp");
    let chk_code = format!(
        r#"#include <bits/stdc++.h>
using namespace std;
int main(int argc, char* argv[]) {{
    ifstream secret("{escaped_secret}");
    if (secret.is_open()) {{
        string s;
        if (secret >> s && s == "TOP_SECRET_VALUE") {{
            cerr << "SANDBOX_BREACH: read host secret" << endl;
            return 3;
        }}
    }}
    if (argc < 3) return 3;
    ifstream act(argv[2]);
    string val;
    act >> val;
    if (val == "42") {{
        cerr << "Exact match" << endl;
        return 0;
    }}
    if (val == "21") {{
        cout << "0.5" << endl;
        cerr << "Half credit" << endl;
        return 0;
    }}
    cerr << "Wrong answer" << endl;
    return 1;
}}
"#
    );
    fs::write(&chk_src, chk_code).unwrap();

    let chk_comp = compile_checker_with_executor(&chk_src, &work_dir, &client);
    assert_eq!(
        chk_comp.status, "OK",
        "Custom checker compile failed: {:?}",
        chk_comp.error
    );
    let chk_exe = chk_comp.executable.expect("checker executable");

    // Compile a simple C++ submission that echoes stdin
    let sub_src = work_dir.join("sub.cpp");
    fs::write(
        &sub_src,
        "#include <bits/stdc++.h>\nusing namespace std;\nint main() { string s; if (cin >> s) cout << s << \"\\n\"; return 0; }\n",
    )
    .unwrap();
    let sub_comp = judgedesk_core::engine::compiler::compile_submission_with_executor(
        judgedesk_core::engine::compiler::CompileSubmissionRequest {
            language: "cpp",
            source_path: &sub_src,
            output_dir: &work_dir,
            platform: &client,
            timeout_ms: None,
            extra_include_dirs: &[],
        },
    );
    assert_eq!(sub_comp.status, "OK");
    let sub_exe = sub_comp.executable.unwrap();

    let inp_42 = work_dir.join("inp42.txt");
    let out_42 = work_dir.join("out42.txt");
    fs::write(&inp_42, "42\n").unwrap();
    fs::write(&out_42, "42\n").unwrap();

    let res_ac = run_test_case(TestCaseExecutionConfig {
        executable_path: &sub_exe,
        input_path: &inp_42,
        expected_output_path: &out_42,
        input_file_name: "",
        output_file_name: "",
        time_limit_ms: 2000,
        memory_limit_mb: 256,
        checker_type: "chk.cpp",
        custom_checker_path: Some(&chk_exe),
        workspace_dir: &work_dir.join("ws_ac"),
        platform: &client,
    });
    assert_eq!(
        res_ac.status, "AC",
        "Expected AC from sandboxed checker, got: {res_ac:?}"
    );
    assert_eq!(res_ac.score_multiplier, 1.0);

    let inp_21 = work_dir.join("inp21.txt");
    fs::write(&inp_21, "21\n").unwrap();
    let res_partial = run_test_case(TestCaseExecutionConfig {
        executable_path: &sub_exe,
        input_path: &inp_21,
        expected_output_path: &out_42,
        input_file_name: "",
        output_file_name: "",
        time_limit_ms: 2000,
        memory_limit_mb: 256,
        checker_type: "chk.cpp",
        custom_checker_path: Some(&chk_exe),
        workspace_dir: &work_dir.join("ws_partial"),
        platform: &client,
    });
    assert_eq!(
        res_partial.status, "PARTIAL",
        "Expected PARTIAL from sandboxed checker, got: {res_partial:?}"
    );
    assert!((res_partial.score_multiplier - 0.5).abs() < 1e-9);

    client.shutdown_sync().unwrap();
}

#[tokio::test]
async fn step5_interactive_problem_end_to_end_ac_and_wa() {
    let env = common::OwnedTestEnvironment::new();
    let client = Arc::new(spawn_test_executor(&env));

    let ts_dir = env.root().join("thisinh");
    let alice_dir = ts_dir.join("Alice");
    let bob_dir = ts_dir.join("Bob");
    fs::create_dir_all(&alice_dir).unwrap();
    fs::create_dir_all(&bob_dir).unwrap();

    // Alice reads target bound N from interactor and prints the secret number (N / 2)
    fs::write(
        alice_dir.join("GUESS.cpp"),
        r#"#include <bits/stdc++.h>
using namespace std;
int main() {
    int n;
    if (!(cin >> n)) return 0;
    cout << (n / 2) << endl;
    cout.flush();
    return 0;
}
"#,
    )
    .unwrap();

    // Bob prints the wrong answer (n - 1)
    fs::write(
        bob_dir.join("GUESS.cpp"),
        r#"#include <bits/stdc++.h>
using namespace std;
int main() {
    int n;
    if (!(cin >> n)) return 0;
    cout << (n - 1) << endl;
    cout.flush();
    return 0;
}
"#,
    )
    .unwrap();

    let test_dir = env.root().join("tests");
    let guess_dir = test_dir.join("GUESS");
    let tc1_dir = guess_dir.join("Test01");
    fs::create_dir_all(&tc1_dir).unwrap();
    fs::write(tc1_dir.join("GUESS.inp"), "84\n").unwrap();
    fs::write(tc1_dir.join("GUESS.out"), "42\n").unwrap();

    fs::write(
        guess_dir.join("config.json"),
        serde_json::json!({
            "isInteractive": true,
            "interactor": "interactor.cpp",
            "defaultScore": 10,
            "timeLimit": 2000,
            "memoryLimit": 256
        })
        .to_string(),
    )
    .unwrap();

    // Interactor reads N from argv[1] (input.txt), sends N to submission via stdout,
    // reads guess from submission via stdin, and exits 0 if guess == N/2 else exits 1.
    fs::write(
        guess_dir.join("interactor.cpp"),
        r#"#include <bits/stdc++.h>
using namespace std;
int main(int argc, char* argv[]) {
    if (argc < 2) return 3;
    ifstream fin(argv[1]);
    int n = 0;
    fin >> n;
    cout << n << endl;
    cout.flush();
    int guess = -1;
    if (!(cin >> guess)) {
        cerr << "No output from contestant" << endl;
        return 1;
    }
    if (guess == n / 2) {
        cerr << "Correct interactive guess" << endl;
        return 0;
    }
    cerr << "Wrong interactive guess: " << guess << endl;
    return 1;
}
"#,
    )
    .unwrap();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let session_cfg = JudgeSessionConfig {
        thisinh_path: ts_dir,
        test_path: test_dir,
        job_id: "job-interactive-step5".to_string(),
        target_contestants: vec!["Alice".to_string(), "Bob".to_string()],
        target_problems: vec!["GUESS".to_string()],
        problem_configs: std::collections::HashMap::new(),
        app_data_dir: None,
        toolchain_selections: std::collections::HashMap::new(),
        cancel_flag: Arc::new(AtomicBool::new(false)),
        platform: Arc::clone(&client),
    };

    tokio::task::spawn_blocking(move || {
        tokio::runtime::Handle::current().block_on(run_judge_session(session_cfg, tx));
    })
    .await
    .unwrap();

    let mut alice_score = None;
    let mut alice_status = None;
    let mut bob_score = None;
    let mut bob_status = None;

    while let Some(ev) = rx.recv().await {
        if let JudgeStreamEvent::ProblemCompleted(data) = ev {
            if data.contestant == "Alice" {
                alice_score = Some(data.problem_result.summary.score);
                alice_status = Some(data.problem_result.summary.status);
            } else if data.contestant == "Bob" {
                bob_score = Some(data.problem_result.summary.score);
                bob_status = Some(data.problem_result.summary.status);
            }
        }
    }

    assert_eq!(
        alice_status.as_deref(),
        Some("AC"),
        "Expected Alice AC on interactive problem"
    );
    assert_eq!(alice_score, Some(10.0));
    assert_eq!(
        bob_status.as_deref(),
        Some("WA"),
        "Expected Bob WA on interactive problem"
    );
    assert_eq!(bob_score, Some(0.0));
}

#[test]
fn step5_rational_canonical_json_comparison_and_je_zero_score_invariants() {
    use judgedesk_core::checkers::custom::parse_partial_score_rational;
    use judgedesk_core::rational::{compare_rational, to_canonical_point_value};
    use judgedesk_core::scoring::{
        calculate_problem_summary, PolygonGroupConfig, PolygonScoringConfig, PolygonTestConfig,
        ProblemScoringConfig, TestCaseRun,
    };
    use std::cmp::Ordering;

    // 1. Exact comparison without f64 conversion
    let a = parse_rational("9007199254740992/9007199254740993");
    let b = parse_rational("9007199254740993/9007199254740994");
    assert_eq!(compare_rational(&a, &b), Ordering::Less);
    assert!(a < b);

    // 2. MAX_SAFE_INTEGER (2^53 - 1 = 9007199254740991) boundary for JSON serialization
    let safe_int = parse_rational("9007199254740991");
    assert_eq!(
        to_canonical_point_value(safe_int),
        serde_json::json!(9007199254740991_i64)
    );
    let unsafe_js_int = parse_rational("9007199254740993");
    assert_eq!(
        to_canonical_point_value(unsafe_js_int.clone()),
        serde_json::json!("9007199254740993")
    );
    assert_eq!(
        serde_json::to_value(&unsafe_js_int).unwrap(),
        serde_json::json!({ "n": "9007199254740993", "d": 1 })
    );

    // 3. Exact rational partial score parsing from checker output (fractions + high-precision decimals)
    let mult_third = parse_partial_score_rational("points 1/3", "", Rational::new(10, 1))
        .expect("parse fraction partial score");
    assert_eq!(mult_third, Rational::new(1, 3));

    let mult_scaled = parse_partial_score_rational("", "5\n", Rational::new(15, 1))
        .expect("parse raw points scaled by max_score");
    assert_eq!(mult_scaled, Rational::new(1, 3));

    let mult_hp = parse_partial_score_rational(
        "result = 0.12345678901234567890123456789",
        "",
        Rational::ONE,
    )
    .expect("parse 29-digit decimal partial score");
    assert_eq!(
        format_rational(
            multiply_rational(mult_hp, parse_rational("100000000000000000000000000000")),
            2
        ),
        "12345678901234567890123456789"
    );

    // 4. JE forces problem summary status="JE", score=0, scoreExact=0, while preserving testcase evidence
    let mut test_cases = vec![
        TestCaseRun {
            name: "Test01".to_string(),
            status: "AC".to_string(),
            score: to_canonical_point_value(Rational::new(10, 3)),
            score_exact: Some(Rational::new(10, 3)),
            execution_time: Some(10),
            peak_memory: Some(4096),
            checker_message: None,
            expected_output_preview: None,
            actual_output_preview: None,
            error_detail: None,
            execution: None,
        },
        TestCaseRun {
            name: "Test02".to_string(),
            status: "JE".to_string(),
            score: serde_json::json!(0),
            score_exact: Some(Rational::ZERO),
            execution_time: Some(0),
            peak_memory: Some(0),
            checker_message: Some("Checker sandbox error".to_string()),
            expected_output_preview: None,
            actual_output_preview: None,
            error_detail: None,
            execution: None,
        },
    ];
    let mut groups = std::collections::HashMap::new();
    groups.insert(
        "G1".to_string(),
        PolygonGroupConfig {
            dependencies: vec![],
            policy: Some("COMPLETE_GROUP".to_string()),
        },
    );
    let mut tests = std::collections::HashMap::new();
    tests.insert(
        "Test01".to_string(),
        PolygonTestConfig {
            group: Some("G1".to_string()),
            points: Some(serde_json::json!(10)),
        },
    );
    tests.insert(
        "Test02".to_string(),
        PolygonTestConfig {
            group: Some("G1".to_string()),
            points: Some(serde_json::json!(10)),
        },
    );
    let config = ProblemScoringConfig {
        polygon_config: Some(PolygonScoringConfig {
            enable_groups: true,
            groups,
            tests,
        }),
        total_score: None,
        default_score: Some(serde_json::json!(10)),
        test_scores: None,
    };
    let summary = calculate_problem_summary(
        "OK",
        &mut test_cases,
        &["Test01".to_string(), "Test02".to_string()],
        &config,
    );
    assert_eq!(summary.status, "JE");
    assert_eq!(summary.score, 0.0);
    assert_eq!(summary.score_exact, Some(Rational::ZERO));
    assert_eq!(summary.max_score_exact, Some(Rational::new(20, 1)));
    assert_eq!(
        test_cases[0].score_exact,
        Some(Rational::new(10, 3)),
        "JE must preserve testcase score_exact evidence without group zeroing"
    );
}

#[tokio::test]
async fn step5_session_proportional_total_score_and_exact_partial_checker_awards() {
    let env = common::OwnedTestEnvironment::new();
    let client = Arc::new(spawn_test_executor(&env));

    let ts_dir = env.root().join("thisinh_partial");
    let alice_dir = ts_dir.join("Alice");
    fs::create_dir_all(&alice_dir).unwrap();

    // Submission echoes the input token
    fs::write(
        alice_dir.join("PARTIAL.cpp"),
        r#"#include <bits/stdc++.h>
using namespace std;
int main() {
    string s;
    if (cin >> s) cout << s << "\n";
    return 0;
}
"#,
    )
    .unwrap();

    let test_dir = env.root().join("tests_partial");
    let prob_dir = test_dir.join("PARTIAL");
    for (tc, val) in [("Test01", "T1"), ("Test02", "T2"), ("Test03", "T3")] {
        let dir = prob_dir.join(tc);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("PARTIAL.inp"), format!("{val}\n")).unwrap();
        fs::write(dir.join("PARTIAL.out"), format!("{val}\n")).unwrap();
    }

    // Custom checker:
    // T1 -> PARTIAL with exact fraction 1/3 (stdout "1/3", exit 0)
    // T2 -> AC (stderr "Full credit", exit 0, nothing on stdout)
    // T3 -> PARTIAL with 0.5 (stderr "points 0.5", exit 7)
    fs::write(
        prob_dir.join("chk.cpp"),
        r#"#include <bits/stdc++.h>
using namespace std;
int main(int argc, char* argv[]) {
    if (argc < 3) return 3;
    ifstream act(argv[2]);
    string s;
    act >> s;
    if (s == "T1") {
        cout << "1/3" << endl;
        cerr << "One third credit" << endl;
        return 0;
    }
    if (s == "T2") {
        cerr << "Full credit" << endl;
        return 0;
    }
    if (s == "T3") {
        cerr << "points 0.5" << endl;
        return 7;
    }
    return 1;
}
"#,
    )
    .unwrap();

    // enableGroups: false, totalScore: 100 across 3 tests of equal weight 1 -> 100/3 per test.
    // Awards: (100/3)*(1/3) + (100/3)*1 + (100/3)*(1/2) = 100/9 + 300/9 + 150/9 = 550/9.
    fs::write(
        prob_dir.join("config.json"),
        serde_json::json!({
            "checker": "chk.cpp",
            "useStdIO": true,
            "defaultScore": 1,
            "totalScore": 100,
            "enableGroups": false,
            "timeLimit": 2000,
            "memoryLimit": 256
        })
        .to_string(),
    )
    .unwrap();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let session_cfg = JudgeSessionConfig {
        thisinh_path: ts_dir,
        test_path: test_dir,
        job_id: "job-partial-rational-step5".to_string(),
        target_contestants: vec!["Alice".to_string()],
        target_problems: vec!["PARTIAL".to_string()],
        problem_configs: std::collections::HashMap::new(),
        app_data_dir: None,
        toolchain_selections: std::collections::HashMap::new(),
        cancel_flag: Arc::new(AtomicBool::new(false)),
        platform: Arc::clone(&client),
    };

    tokio::task::spawn_blocking(move || {
        tokio::runtime::Handle::current().block_on(run_judge_session(session_cfg, tx));
    })
    .await
    .unwrap();

    let mut prob_res = None;
    while let Some(ev) = rx.recv().await {
        if let JudgeStreamEvent::ProblemCompleted(data) = ev {
            if data.contestant == "Alice" && data.problem_result.problem_name == "PARTIAL" {
                prob_res = Some(data.problem_result);
            }
        }
    }

    let res = prob_res.expect("ProblemCompleted for Alice PARTIAL");
    assert_eq!(res.summary.status, "PARTIAL");
    assert_eq!(
        res.summary.max_score_exact,
        Some(Rational::new(100, 1)),
        "Expected totalScore=100 as max_score_exact"
    );
    assert_eq!(
        res.summary.score_exact,
        Some(Rational::new(550, 9)),
        "Expected exact sum 100/9 + 100/3 + 50/3 = 550/9"
    );
    assert_eq!(res.test_cases.len(), 3);
    assert_eq!(res.test_cases[0].score_exact, Some(Rational::new(100, 9)));
    assert_eq!(res.test_cases[1].score_exact, Some(Rational::new(100, 3)));
    assert_eq!(res.test_cases[2].score_exact, Some(Rational::new(50, 3)));

    // Verify that a custom checker exiting 7 with a partial score exceeding max_score
    // (e.g. "result = 20" when max_score is 10) fails closed as JE with 0 points,
    // while "result = 5" when max_score is 10 yields PARTIAL with multiplier 1/2.
    let work_dir = env.root().join("checker_bounds_work");
    fs::create_dir_all(&work_dir).unwrap();
    let chk_src = work_dir.join("chk_bounds.cpp");
    fs::write(
        &chk_src,
        r#"#include <bits/stdc++.h>
using namespace std;
int main(int argc, char* argv[]) {
    ifstream act(argv[2]);
    string val;
    act >> val;
    if (val == "OVER") {
        cerr << "result = 20" << endl;
        return 7;
    }
    if (val == "HALF_RAW") {
        cerr << "result = 5" << endl;
        return 7;
    }
    return 1;
}
"#,
    )
    .unwrap();
    let chk_comp = compile_checker_with_executor(&chk_src, &work_dir, &client);
    assert_eq!(chk_comp.status, "OK");
    let chk_exe = chk_comp.executable.unwrap();

    let sub_src = work_dir.join("echo.cpp");
    fs::write(
        &sub_src,
        "#include <bits/stdc++.h>\nusing namespace std;\nint main() { string s; if (cin >> s) cout << s << \"\\n\"; return 0; }\n",
    )
    .unwrap();
    let sub_comp = judgedesk_core::engine::compiler::compile_submission_with_executor(
        judgedesk_core::engine::compiler::CompileSubmissionRequest {
            language: "cpp",
            source_path: &sub_src,
            output_dir: &work_dir,
            platform: &client,
            timeout_ms: None,
            extra_include_dirs: &[],
        },
    );
    assert_eq!(sub_comp.status, "OK");
    let sub_exe = sub_comp.executable.unwrap();

    let inp_over = work_dir.join("inp_over.txt");
    let out_dummy = work_dir.join("out_dummy.txt");
    fs::write(&inp_over, "OVER\n").unwrap();
    fs::write(&out_dummy, "OVER\n").unwrap();
    let res_over = judgedesk_core::engine::runner::run_test_case_with_max_score(
        TestCaseExecutionConfig {
            executable_path: &sub_exe,
            input_path: &inp_over,
            expected_output_path: &out_dummy,
            input_file_name: "",
            output_file_name: "",
            time_limit_ms: 2000,
            memory_limit_mb: 256,
            checker_type: "chk_bounds.cpp",
            custom_checker_path: Some(&chk_exe),
            workspace_dir: &work_dir.join("ws_over"),
            platform: &client,
        },
        Rational::new(10, 1),
    );
    assert_eq!(
        res_over.status, "JE",
        "Expected JE when exit code 7 partial score exceeds max_score, got: {res_over:?}"
    );
    assert_eq!(res_over.score_multiplier_exact, Rational::ZERO);

    let inp_half = work_dir.join("inp_half.txt");
    fs::write(&inp_half, "HALF_RAW\n").unwrap();
    let res_half = judgedesk_core::engine::runner::run_test_case_with_max_score(
        TestCaseExecutionConfig {
            executable_path: &sub_exe,
            input_path: &inp_half,
            expected_output_path: &out_dummy,
            input_file_name: "",
            output_file_name: "",
            time_limit_ms: 2000,
            memory_limit_mb: 256,
            checker_type: "chk_bounds.cpp",
            custom_checker_path: Some(&chk_exe),
            workspace_dir: &work_dir.join("ws_half"),
            platform: &client,
        },
        Rational::new(10, 1),
    );
    assert_eq!(
        res_half.status, "PARTIAL",
        "Expected PARTIAL when exit code 7 outputs raw 5 against max_score 10, got: {res_half:?}"
    );
    assert_eq!(res_half.score_multiplier_exact, Rational::new(1, 2));
}

#[tokio::test]
async fn step5_builtin_checker_selection_ignores_custom_checker_and_default_selects_custom_checker()
{
    let env = common::OwnedTestEnvironment::new();
    let client = Arc::new(spawn_test_executor(&env));

    let ts_dir = env.root().join("thisinh");
    let alice_dir = ts_dir.join("Alice");
    fs::create_dir_all(&alice_dir).unwrap();

    fs::write(
        alice_dir.join("MEXARRAY.cpp"),
        r#"#include <bits/stdc++.h>
using namespace std;
int main() {
    ifstream cin("MEXARRAY.inp");
    ofstream cout("MEXARRAY.out");
    int x;
    while (cin >> x) cout << x << " ";
    cout << "\n";
    return 0;
}
"#,
    )
    .unwrap();

    let test_dir = env.root().join("tests");
    let prob_dir = test_dir.join("MEXARRAY");
    for (tc, val) in [("Test01", "1 2 3"), ("Test02", "4 5 6")] {
        let dir = prob_dir.join(tc);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("MEXARRAY.inp"), format!("{val}\n")).unwrap();
        fs::write(dir.join("MEXARRAY.out"), format!("{val}\n")).unwrap();
    }

    // Place a custom checker in the problem folder that ALWAYS exits 3 (JE) if executed!
    fs::write(
        prob_dir.join("always_je_checker.cpp"),
        r#"#include <bits/stdc++.h>
int main() { return 3; }
"#,
    )
    .unwrap();

    // 1. When Config.cfg explicitly selects built-in "C1" (or "polygon:lcmp"),
    //    run_judge_session MUST NOT execute always_je_checker.cpp and MUST grade AC (2/2).
    for builtin in ["C1", "polygon:lcmp"] {
        fs::write(
            prob_dir.join("Config.cfg"),
            serde_json::json!({
                "checkerType": builtin,
                "useStdIn": false,
                "useStdOut": false,
                "inputFile": "MEXARRAY.inp",
                "outputFile": "MEXARRAY.out",
                "defaultScore": 1,
                "totalScore": serde_json::Value::Null,
                "enableGroups": false,
                "tests": {
                    "Test01": { "points": 1 },
                    "Test02": { "points": 1 }
                },
                "testScores": {
                    "Test01": 1,
                    "Test02": 1
                }
            })
            .to_string(),
        )
        .unwrap();

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let session_cfg = JudgeSessionConfig {
            thisinh_path: ts_dir.clone(),
            test_path: test_dir.clone(),
            job_id: format!("job-mexarray-{builtin}"),
            target_contestants: vec!["Alice".to_string()],
            target_problems: vec!["MEXARRAY".to_string()],
            problem_configs: std::collections::HashMap::new(),
            app_data_dir: None,
            toolchain_selections: std::collections::HashMap::new(),
            cancel_flag: Arc::new(AtomicBool::new(false)),
            platform: Arc::clone(&client),
        };

        tokio::task::spawn_blocking(move || {
            tokio::runtime::Handle::current().block_on(run_judge_session(session_cfg, tx));
        })
        .await
        .unwrap();

        let mut prob_res = None;
        while let Some(ev) = rx.recv().await {
            if let JudgeStreamEvent::ProblemCompleted(data) = ev {
                if data.contestant == "Alice" && data.problem_result.problem_name == "MEXARRAY" {
                    prob_res = Some(data.problem_result);
                }
            }
        }
        let res = prob_res.expect("ProblemCompleted for MEXARRAY");
        assert_eq!(
            res.summary.status, "AC",
            "Built-in checker {builtin} must be used instead of custom checker in folder, got: {:?}",
            res.test_cases
        );
        assert_eq!(res.summary.score, 2.0);
        assert_eq!(res.summary.max_score, 2.0);
    }

    // 2. Now add Test03 to MEXARRAY on disk (test count changes from 2 to 3)
    //    while Config.cfg still has only Test01 and Test02 from the previous 2-test setup.
    let tc3_dir = prob_dir.join("Test03");
    fs::create_dir_all(&tc3_dir).unwrap();
    fs::write(tc3_dir.join("MEXARRAY.inp"), "7 8 9\n").unwrap();
    fs::write(tc3_dir.join("MEXARRAY.out"), "7 8 9\n").unwrap();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let session_cfg = JudgeSessionConfig {
        thisinh_path: ts_dir.clone(),
        test_path: test_dir.clone(),
        job_id: "job-mexarray-3tests".to_string(),
        target_contestants: vec!["Alice".to_string()],
        target_problems: vec!["MEXARRAY".to_string()],
        problem_configs: std::collections::HashMap::new(),
        app_data_dir: None,
        toolchain_selections: std::collections::HashMap::new(),
        cancel_flag: Arc::new(AtomicBool::new(false)),
        platform: Arc::clone(&client),
    };

    tokio::task::spawn_blocking(move || {
        tokio::runtime::Handle::current().block_on(run_judge_session(session_cfg, tx));
    })
    .await
    .unwrap();

    let mut prob_res = None;
    while let Some(ev) = rx.recv().await {
        if let JudgeStreamEvent::ProblemCompleted(data) = ev {
            if data.contestant == "Alice" && data.problem_result.problem_name == "MEXARRAY" {
                prob_res = Some(data.problem_result);
            }
        }
    }
    let res = prob_res.expect("ProblemCompleted for MEXARRAY with 3 tests");
    assert_eq!(res.summary.status, "AC");
    assert_eq!(res.summary.total, 3);
    assert_eq!(res.summary.passed, 3);
    assert_eq!(
        res.summary.score, 3.0,
        "Score must be 3.0 for 3 passed tests"
    );
    assert_eq!(
        res.summary.max_score, 3.0,
        "Max score must update to 3.0 when a 3rd test is added"
    );
}
