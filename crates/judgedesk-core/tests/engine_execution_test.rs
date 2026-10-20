use judgedesk_core::engine::compiler::{
    compile_checker_with_executor, compile_submission_with_executor, CompilationOutput,
    CompileSubmissionRequest,
};
use judgedesk_core::engine::runner::{run_test_case, TestCaseExecutionConfig};
use judgedesk_core::executor_client::ExecutorClient;
use std::fs;
use std::path::Path;

mod common;

fn compile_cpp(
    source_path: &Path,
    output_dir: &Path,
    platform: &ExecutorClient,
) -> CompilationOutput {
    compile_submission_with_executor(CompileSubmissionRequest {
        language: "cpp",
        source_path,
        output_dir,
        platform,
        timeout_ms: None,
        extra_include_dirs: &[],
    })
}

#[test]
fn test_platform_initialization_is_confined_to_owned_test_root() {
    let test_environment = common::OwnedTestEnvironment::new();
    let owned_root = test_environment.root().to_path_buf();
    let executor_bin = common::executor_binary_path();
    let platform = test_environment
        .with_isolated_roots(|| ExecutorClient::spawn_sync(&executor_bin).expect("spawn executor"));

    assert!(
        platform.root().starts_with(&owned_root),
        "test platform root {} must remain inside owned root {}",
        platform.root().display(),
        owned_root.display()
    );

    drop(platform);
    drop(test_environment);
    assert!(
        !owned_root.exists(),
        "owned platform test root must be removed after teardown"
    );
}

#[test]
fn test_cpp_compile_and_run_ac() {
    let test_environment = common::OwnedTestEnvironment::new();
    let executor_bin = common::executor_binary_path();
    let platform = test_environment
        .with_isolated_roots(|| ExecutorClient::spawn_sync(&executor_bin).expect("spawn executor"));
    let temp_dir = std::env::temp_dir().join(format!("test_exec_ac_{}", std::process::id()));
    fs::create_dir_all(&temp_dir).unwrap();

    let cpp_source = temp_dir.join("solution.cpp");
    fs::write(
        &cpp_source,
        r#"#include <iostream>
using namespace std;
int main() {
    int a, b;
    if (cin >> a >> b) {
        cout << (a + b) << endl;
    }
    return 0;
}
"#,
    )
    .unwrap();

    let comp_res = compile_cpp(&cpp_source, &temp_dir, &platform);
    assert_eq!(
        comp_res.status, "OK",
        "Compilation failed: {:?}",
        comp_res.error
    );
    let exe_path = comp_res.executable.unwrap();
    assert!(exe_path.exists());

    let inp_file = temp_dir.join("add.inp");
    let out_file = temp_dir.join("add.out");
    fs::write(&inp_file, "10 20\n").unwrap();
    fs::write(&out_file, "30\n").unwrap();

    let ws_dir = temp_dir.join("ws");

    let result = run_test_case(TestCaseExecutionConfig {
        executable_path: &exe_path,
        input_path: &inp_file,
        expected_output_path: &out_file,
        input_file_name: "",
        output_file_name: "",
        time_limit_ms: 2000,
        memory_limit_mb: 256,
        checker_type: "C1",
        custom_checker_path: None,
        workspace_dir: &ws_dir,
        platform: &platform,
    });

    assert_eq!(
        result.status, "AC",
        "Unexpected status: {:?}, msg: {:?}",
        result.status, result.message
    );
    assert_eq!(result.message.as_deref(), Some("single line"));
    assert_eq!(result.error_detail, None);
    let exec = result
        .execution
        .expect("AC test should populate execution diagnostics");
    assert_eq!(exec.reason, "exited");
    assert_eq!(exec.exit_code, Some(0));
    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_cpp_compile_and_run_wa() {
    let test_environment = common::OwnedTestEnvironment::new();
    let executor_bin = common::executor_binary_path();
    let platform = test_environment
        .with_isolated_roots(|| ExecutorClient::spawn_sync(&executor_bin).expect("spawn executor"));
    let temp_dir = std::env::temp_dir().join(format!("test_exec_wa_{}", std::process::id()));
    fs::create_dir_all(&temp_dir).unwrap();

    let cpp_source = temp_dir.join("solution.cpp");
    fs::write(
        &cpp_source,
        r#"#include <iostream>
using namespace std;
int main() {
    cout << "wrong answer" << endl;
    return 0;
}
"#,
    )
    .unwrap();

    let comp_res = compile_cpp(&cpp_source, &temp_dir, &platform);
    let exe_path = comp_res.executable.unwrap();

    let inp_file = temp_dir.join("test.inp");
    let out_file = temp_dir.join("test.out");
    fs::write(&inp_file, "10\n").unwrap();
    fs::write(&out_file, "correct answer\n").unwrap();

    let ws_dir = temp_dir.join("ws");

    let result = run_test_case(TestCaseExecutionConfig {
        executable_path: &exe_path,
        input_path: &inp_file,
        expected_output_path: &out_file,
        input_file_name: "",
        output_file_name: "",
        time_limit_ms: 2000,
        memory_limit_mb: 256,
        checker_type: "C1",
        custom_checker_path: None,
        workspace_dir: &ws_dir,
        platform: &platform,
    });

    assert_eq!(result.status, "WA");
    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_cpp_compile_and_run_tle() {
    let test_environment = common::OwnedTestEnvironment::new();
    let executor_bin = common::executor_binary_path();
    let platform = test_environment
        .with_isolated_roots(|| ExecutorClient::spawn_sync(&executor_bin).expect("spawn executor"));
    let temp_dir = std::env::temp_dir().join(format!("test_exec_tle_{}", std::process::id()));
    fs::create_dir_all(&temp_dir).unwrap();

    let cpp_source = temp_dir.join("solution.cpp");
    fs::write(
        &cpp_source,
        r#"#include <iostream>
int main() {
    std::cerr << "debug stderr flood should not leak into checker_message\n";
    volatile int x = 0;
    while (true) {
        x++;
    }
    return 0;
}
"#,
    )
    .unwrap();

    let comp_res = compile_cpp(&cpp_source, &temp_dir, &platform);
    let exe_path = comp_res.executable.unwrap();

    let inp_file = temp_dir.join("test.inp");
    let out_file = temp_dir.join("test.out");
    fs::write(&inp_file, "10\n").unwrap();
    fs::write(&out_file, "10\n").unwrap();

    let ws_dir = temp_dir.join("ws");

    let result = run_test_case(TestCaseExecutionConfig {
        executable_path: &exe_path,
        input_path: &inp_file,
        expected_output_path: &out_file,
        input_file_name: "test.inp",
        output_file_name: "test.out",
        time_limit_ms: 200, // 200ms time limit
        memory_limit_mb: 256,
        checker_type: "C1",
        custom_checker_path: None,
        workspace_dir: &ws_dir,
        platform: &platform,
    });

    assert_eq!(result.status, "TLE");
    assert!(result.execution_time_ms >= 200);
    assert_eq!(result.message, None);
    assert_eq!(result.error_detail, None);
    let exec = result
        .execution
        .expect("TLE test should populate execution diagnostics");
    assert!(
        exec.reason == "wall_time_limit" || exec.reason == "cpu_time_limit",
        "unexpected TLE reason: {}",
        exec.reason
    );
    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_cpp_compile_and_run_re() {
    let test_environment = common::OwnedTestEnvironment::new();
    let executor_bin = common::executor_binary_path();
    let platform = test_environment
        .with_isolated_roots(|| ExecutorClient::spawn_sync(&executor_bin).expect("spawn executor"));
    let temp_dir = std::env::temp_dir().join(format!("test_exec_re_{}", std::process::id()));
    fs::create_dir_all(&temp_dir).unwrap();

    let cpp_source = temp_dir.join("solution.cpp");
    fs::write(
        &cpp_source,
        r#"#include <cstdlib>
int main() {
    exit(42);
}
"#,
    )
    .unwrap();

    let comp_res = compile_cpp(&cpp_source, &temp_dir, &platform);
    let exe_path = comp_res.executable.unwrap();

    let inp_file = temp_dir.join("test.inp");
    let out_file = temp_dir.join("test.out");
    fs::write(&inp_file, "1\n").unwrap();
    fs::write(&out_file, "1\n").unwrap();

    let ws_dir = temp_dir.join("ws");

    let result = run_test_case(TestCaseExecutionConfig {
        executable_path: &exe_path,
        input_path: &inp_file,
        expected_output_path: &out_file,
        input_file_name: "test.inp",
        output_file_name: "test.out",
        time_limit_ms: 2000,
        memory_limit_mb: 256,
        checker_type: "C1",
        custom_checker_path: None,
        workspace_dir: &ws_dir,
        platform: &platform,
    });

    assert_eq!(result.status, "RE");
    assert_eq!(result.message, None);
    let err = result
        .error_detail
        .as_deref()
        .expect("RE test should populate error_detail");
    assert!(
        err.contains("Exit code 42"),
        "expected error_detail to contain 'Exit code 42', got: {err}"
    );
    let exec = result
        .execution
        .expect("RE test should populate execution diagnostics");
    assert_eq!(exec.reason, "exited");
    assert_eq!(exec.exit_code, Some(42));
    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_cpp_freopen_file_io() {
    let test_environment = common::OwnedTestEnvironment::new();
    let executor_bin = common::executor_binary_path();
    let platform = test_environment
        .with_isolated_roots(|| ExecutorClient::spawn_sync(&executor_bin).expect("spawn executor"));
    let temp_dir = std::env::temp_dir().join(format!("test_exec_freopen_{}", std::process::id()));
    fs::create_dir_all(&temp_dir).unwrap();

    let cpp_source = temp_dir.join("solution.cpp");
    fs::write(
        &cpp_source,
        r#"#include <cstdio>
int main() {
    freopen("problem.inp", "r", stdin);
    freopen("problem.out", "w", stdout);
    int a, b;
    if (scanf("%d %d", &a, &b) == 2) {
        printf("%d\n", a * b);
    }
    return 0;
}
"#,
    )
    .unwrap();

    let comp_res = compile_cpp(&cpp_source, &temp_dir, &platform);
    let exe_path = comp_res.executable.unwrap();

    let inp_file = temp_dir.join("problem.inp");
    let out_file = temp_dir.join("problem.out");
    fs::write(&inp_file, "6 7\n").unwrap();
    fs::write(&out_file, "42\n").unwrap();

    let ws_dir = temp_dir.join("ws");

    let result = run_test_case(TestCaseExecutionConfig {
        executable_path: &exe_path,
        input_path: &inp_file,
        expected_output_path: &out_file,
        input_file_name: "problem.inp",
        output_file_name: "problem.out",
        time_limit_ms: 2000,
        memory_limit_mb: 256,
        checker_type: "C1",
        custom_checker_path: None,
        workspace_dir: &ws_dir,
        platform: &platform,
    });

    assert_eq!(result.status, "AC");

    // E2E-02 regression: if output_file_name is required ("DATA.OUT") and the submission
    // only writes to stdout without creating DATA.OUT, it MUST receive WA (never fall back to stdout).
    let stdout_only_source = temp_dir.join("stdout_only.cpp");
    fs::write(
        &stdout_only_source,
        r#"#include <cstdio>
int main() {
    printf("42\n");
    return 0;
}
"#,
    )
    .unwrap();
    let comp_stdout_only = compile_cpp(&stdout_only_source, &temp_dir, &platform);
    let stdout_only_exe = comp_stdout_only.executable.unwrap();

    let missing_file_result = run_test_case(TestCaseExecutionConfig {
        executable_path: &stdout_only_exe,
        input_path: &inp_file,
        expected_output_path: &out_file,
        input_file_name: "DATA.INP",
        output_file_name: "DATA.OUT",
        time_limit_ms: 2000,
        memory_limit_mb: 256,
        checker_type: "C1",
        custom_checker_path: None,
        workspace_dir: &ws_dir,
        platform: &platform,
    });
    assert_eq!(
        missing_file_result.status, "WA",
        "Printing to stdout when output_file_name is required must be WA, got: {:?}",
        missing_file_result.status
    );

    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_custom_checker_execution() {
    let test_environment = common::OwnedTestEnvironment::new();
    let executor_bin = common::executor_binary_path();
    let platform = test_environment
        .with_isolated_roots(|| ExecutorClient::spawn_sync(&executor_bin).expect("spawn executor"));
    let temp_dir =
        std::env::temp_dir().join(format!("test_exec_custom_chk_{}", std::process::id()));
    fs::create_dir_all(&temp_dir).unwrap();

    // Solution outputting 42
    let cpp_source = temp_dir.join("solution.cpp");
    fs::write(
        &cpp_source,
        r#"#include <iostream>
using namespace std;
int main() {
    cout << 42 << endl;
    return 0;
}
"#,
    )
    .unwrap();

    let comp_sol = compile_cpp(&cpp_source, &temp_dir, &platform);
    let sol_exe = comp_sol.executable.unwrap();

    // Custom checker checking if contestant output matches 42
    let chk_source = temp_dir.join("checker.cpp");
    fs::write(
        &chk_source,
        r#"#include <iostream>
#include <fstream>
#include <string>
using namespace std;

// Testlib exit codes: 0 = OK, 1 = WA, 7 = Partial
int main(int argc, char* argv[]) {
    // argv: [prog, input, actual, expected]
    if (argc < 4) return 1;
    ifstream actual(argv[2]);
    int val;
    if (actual >> val) {
        if (val == 42) {
            cout << "ok Correct answer!" << endl;
            return 0;
        } else if (val == 21) {
            cerr << "points 0.5" << endl;
            return 7;
        }
    }
    cout << "wrong answer" << endl;
    return 1;
}
"#,
    )
    .unwrap();

    let chk_res = compile_checker_with_executor(&chk_source, &temp_dir, &platform);
    assert_eq!(
        chk_res.status, "OK",
        "Checker compilation failed: {:?}",
        chk_res.error
    );
    let chk_exe = chk_res.executable.unwrap();
    assert_ne!(
        sol_exe, chk_exe,
        "Checker artifact must not overwrite submission artifact"
    );
    assert!(
        chk_exe
            .to_string_lossy()
            .contains("__judgedesk_checker_build"),
        "Checker artifact must be isolated in __judgedesk_checker_build, got: {}",
        chk_exe.display()
    );
    assert!(sol_exe.exists() && chk_exe.exists());

    let inp_file = temp_dir.join("test.inp");
    let out_file = temp_dir.join("test.out");
    fs::write(&inp_file, "dummy\n").unwrap();
    fs::write(&out_file, "42\n").unwrap();

    let ws_dir = temp_dir.join("ws");

    let result = run_test_case(TestCaseExecutionConfig {
        executable_path: &sol_exe,
        input_path: &inp_file,
        expected_output_path: &out_file,
        input_file_name: "",
        output_file_name: "",
        time_limit_ms: 4000,
        memory_limit_mb: 256,
        checker_type: "custom",
        custom_checker_path: Some(&chk_exe),
        workspace_dir: &ws_dir,
        platform: &platform,
    });

    assert_eq!(result.status, "AC");
    assert_eq!(result.score_multiplier, 1.0);
    assert!(result.message.unwrap().contains("Correct answer"));
    let _ = fs::remove_dir_all(&temp_dir);
}

#[test]
fn test_runner_c1_bai5_fixture_double_cr() {
    let test_environment = common::OwnedTestEnvironment::new();
    let executor_bin = common::executor_binary_path();
    let platform = test_environment
        .with_isolated_roots(|| ExecutorClient::spawn_sync(&executor_bin).expect("spawn executor"));
    let temp_dir = std::env::temp_dir().join(format!("test_exec_bai5_{}", std::process::id()));
    fs::create_dir_all(&temp_dir).unwrap();

    let cpp_source = temp_dir.join("BAI5.CPP");
    fs::write(
        &cpp_source,
        r#"#include <iostream>
using namespace std;
int main() {
    cout << 6 << "\r\n";
    return 0;
}
"#,
    )
    .unwrap();

    let comp_res = compile_cpp(&cpp_source, &temp_dir, &platform);
    assert_eq!(comp_res.status, "OK");
    let exe_path = comp_res.executable.unwrap();

    let inp_file = temp_dir.join("BAI5.INP");
    let out_file = temp_dir.join("BAI5.OUT");
    fs::write(&inp_file, "dummy\r\n").unwrap();
    // The exact BAI5 test00 expected output with double CR at EOF (\r\r\n):
    fs::write(&out_file, b"6\r\r\n").unwrap();

    let ws_dir = temp_dir.join("ws");

    let result = run_test_case(TestCaseExecutionConfig {
        executable_path: &exe_path,
        input_path: &inp_file,
        expected_output_path: &out_file,
        input_file_name: "",
        output_file_name: "",
        time_limit_ms: 2000,
        memory_limit_mb: 256,
        checker_type: "C1",
        custom_checker_path: None,
        workspace_dir: &ws_dir,
        platform: &platform,
    });

    assert_eq!(
        result.status, "AC",
        "Expected AC for BAI5 double CR test00, got: {:?} ({:?})",
        result.status, result.message
    );
    assert_eq!(result.message.as_deref(), Some("single line"));

    let _ = fs::remove_dir_all(&temp_dir);
}
