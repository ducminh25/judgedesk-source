use judgedesk_core::engine::compiler::{
    compile_submission_with_executor, CompilationFailureProvenance, CompileSubmissionRequest,
    CHECKER_COMPILE_WALL_TIME_MS, SUBMISSION_COMPILE_WALL_TIME_MS,
};
use judgedesk_core::engine::runner::{run_test_case, TestCaseExecutionConfig};
use judgedesk_core::executor_client::ExecutorClient;
use std::fs;
use std::path::PathBuf;

mod common;

fn build_minimal_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut central_dir = Vec::new();

    for &(name, data) in entries {
        let local_offset = buf.len() as u32;
        let crc = compute_crc32(data);
        let size = data.len() as u32;
        let name_bytes = name.as_bytes();

        // Local file header (0x04034b50)
        buf.extend_from_slice(&0x04034b50u32.to_le_bytes());
        buf.extend_from_slice(&20u16.to_le_bytes()); // version needed
        buf.extend_from_slice(&0u16.to_le_bytes()); // flags
        buf.extend_from_slice(&0u16.to_le_bytes()); // compression = 0 (store)
        buf.extend_from_slice(&0u16.to_le_bytes()); // mod time
        buf.extend_from_slice(&0u16.to_le_bytes()); // mod date
        buf.extend_from_slice(&crc.to_le_bytes());
        buf.extend_from_slice(&size.to_le_bytes());
        buf.extend_from_slice(&size.to_le_bytes());
        buf.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes()); // extra len
        buf.extend_from_slice(name_bytes);
        buf.extend_from_slice(data);

        // Central directory header (0x02014b50)
        central_dir.extend_from_slice(&0x02014b50u32.to_le_bytes());
        central_dir.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central_dir.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // flags
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // compression = 0
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // mod time
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // mod date
        central_dir.extend_from_slice(&crc.to_le_bytes());
        central_dir.extend_from_slice(&size.to_le_bytes());
        central_dir.extend_from_slice(&size.to_le_bytes());
        central_dir.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // extra len
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // comment len
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // disk number
        central_dir.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        central_dir.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        central_dir.extend_from_slice(&local_offset.to_le_bytes());
        central_dir.extend_from_slice(name_bytes);
    }

    let cd_offset = buf.len() as u32;
    let cd_size = central_dir.len() as u32;
    let count = entries.len() as u16;
    buf.extend_from_slice(&central_dir);

    // End of central directory record (0x06054b50)
    buf.extend_from_slice(&0x06054b50u32.to_le_bytes());
    buf.extend_from_slice(&0u16.to_le_bytes()); // disk
    buf.extend_from_slice(&0u16.to_le_bytes()); // cd start disk
    buf.extend_from_slice(&count.to_le_bytes());
    buf.extend_from_slice(&count.to_le_bytes());
    buf.extend_from_slice(&cd_size.to_le_bytes());
    buf.extend_from_slice(&cd_offset.to_le_bytes());
    buf.extend_from_slice(&0u16.to_le_bytes()); // comment len

    buf
}

fn compute_crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &b in bytes {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

#[test]
fn step3_compiler_rs_contains_zero_host_command_spawns_and_enforces_timeouts() {
    assert_eq!(SUBMISSION_COMPILE_WALL_TIME_MS, 15_000);
    assert_eq!(CHECKER_COMPILE_WALL_TIME_MS, 60_000);

    let compiler_rs = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("engine")
        .join("compiler.rs");
    let source = fs::read_to_string(&compiler_rs).expect("read compiler.rs");
    assert!(
        !source.contains("std::process::Command") && !source.contains("Command::new"),
        "compiler.rs must not spawn host compilers outside ExecutorClient"
    );
}

#[test]
fn step3_compiler_provenance_distinguishes_ce_from_je() {
    let env = common::OwnedTestEnvironment::new();
    common::ensure_test_environment();

    let work_dir = env.root().join("provenance_work");
    fs::create_dir_all(&work_dir).unwrap();

    let valid_cpp = work_dir.join("valid.cpp");
    fs::write(&valid_cpp, "int main() { return 0; }\n").unwrap();

    // 1. Unavailable ExecutorClient -> must return status "JE" with JudgeEnvironment provenance
    let unavailable = ExecutorClient::unavailable("unit test executor offline");
    let out_je = compile_submission_with_executor(CompileSubmissionRequest {
        language: "cpp",
        source_path: &valid_cpp,
        output_dir: &work_dir,
        platform: &unavailable,
        timeout_ms: None,
        extra_include_dirs: &[],
    });
    assert_eq!(out_je.status, "JE", "unavailable executor must yield JE");
    assert_eq!(
        out_je.provenance,
        Some(CompilationFailureProvenance::JudgeEnvironment)
    );

    // 2. Syntax-broken C++ with live ExecutorClient -> must return status "CE" with SubmissionError provenance
    let exe_path = common::executor_binary_path();
    let live_client = env
        .with_isolated_roots(|| ExecutorClient::spawn_sync(&exe_path))
        .expect("spawn live executor");

    let broken_cpp = work_dir.join("broken.cpp");
    fs::write(&broken_cpp, "int main( { syntax_error_here }\n").unwrap();

    let out_ce = compile_submission_with_executor(CompileSubmissionRequest {
        language: "cpp",
        source_path: &broken_cpp,
        output_dir: &work_dir,
        platform: &live_client,
        timeout_ms: None,
        extra_include_dirs: &[],
    });
    assert_eq!(out_ce.status, "CE", "syntax error must yield CE");
    assert_eq!(
        out_ce.provenance,
        Some(CompilationFailureProvenance::SubmissionError)
    );

    live_client.shutdown_sync().expect("shutdown live executor");
}

#[test]
fn step3_scratch_malformed_or_hostile_sb3_rejected_as_ce() {
    let env = common::OwnedTestEnvironment::new();
    common::ensure_test_environment();
    let exe_path = common::executor_binary_path();
    let live_client = env
        .with_isolated_roots(|| ExecutorClient::spawn_sync(&exe_path))
        .expect("spawn live executor");

    let work_dir = env.root().join("scratch_bad");
    fs::create_dir_all(&work_dir).unwrap();

    // 1. Not a valid ZIP
    let bad_zip = work_dir.join("corrupt.sb3");
    fs::write(&bad_zip, b"not a zip archive at all").unwrap();
    let res1 = compile_submission_with_executor(CompileSubmissionRequest {
        language: "scratch",
        source_path: &bad_zip,
        output_dir: &work_dir,
        platform: &live_client,
        timeout_ms: None,
        extra_include_dirs: &[],
    });
    assert_eq!(res1.status, "CE");
    assert_eq!(
        res1.provenance,
        Some(CompilationFailureProvenance::SubmissionError)
    );

    // 2. ZIP missing project.json
    let no_project = work_dir.join("no_project.sb3");
    fs::write(&no_project, build_minimal_zip(&[("other.txt", b"hello")])).unwrap();
    let res2 = compile_submission_with_executor(CompileSubmissionRequest {
        language: "scratch",
        source_path: &no_project,
        output_dir: &work_dir,
        platform: &live_client,
        timeout_ms: None,
        extra_include_dirs: &[],
    });
    assert_eq!(res2.status, "CE");

    // 3. ZIP with path traversal entry
    let traversal = work_dir.join("traversal.sb3");
    let valid_proj = br#"{"targets":[]}"#;
    fs::write(
        &traversal,
        build_minimal_zip(&[("project.json", valid_proj), ("../escape.txt", b"boom")]),
    )
    .unwrap();
    let res3 = compile_submission_with_executor(CompileSubmissionRequest {
        language: "scratch",
        source_path: &traversal,
        output_dir: &work_dir,
        platform: &live_client,
        timeout_ms: None,
        extra_include_dirs: &[],
    });
    assert_eq!(res3.status, "CE");

    // 4. ZIP with invalid Scratch 3.0 schema (missing targets array)
    let bad_schema = work_dir.join("bad_schema.sb3");
    fs::write(
        &bad_schema,
        build_minimal_zip(&[("project.json", br#"{"notTargets": 123}"#)]),
    )
    .unwrap();
    let res4 = compile_submission_with_executor(CompileSubmissionRequest {
        language: "scratch",
        source_path: &bad_schema,
        output_dir: &work_dir,
        platform: &live_client,
        timeout_ms: None,
        extra_include_dirs: &[],
    });
    assert_eq!(res4.status, "CE");

    live_client.shutdown_sync().expect("shutdown live executor");
}

#[test]
fn step3_six_language_batch_compile_and_run_via_executor_client() {
    let env = common::OwnedTestEnvironment::new();
    common::ensure_test_environment();
    let exe_path = common::executor_binary_path();
    let live_client = env
        .with_isolated_roots(|| ExecutorClient::spawn_sync(&exe_path))
        .expect("spawn live executor");

    let base_dir = env.root().join("six_langs");
    fs::create_dir_all(&base_dir).unwrap();

    let input_path = base_dir.join("1.inp");
    let expected_path = base_dir.join("1.out");
    fs::write(&input_path, "12 30\n").unwrap();
    fs::write(&expected_path, "42\n").unwrap();

    // First verify Python syntax error -> CE and Java package declaration -> CE
    let bad_py = base_dir.join("bad.py");
    fs::write(&bad_py, "def broken(:\n    pass\n").unwrap();
    let bad_py_res = compile_submission_with_executor(CompileSubmissionRequest {
        language: "python",
        source_path: &bad_py,
        output_dir: &base_dir,
        platform: &live_client,
        timeout_ms: None,
        extra_include_dirs: &[],
    });
    assert_eq!(
        bad_py_res.status, "CE",
        "Python syntax error must be caught as CE"
    );

    let pkg_java = base_dir.join("PkgMain.java");
    fs::write(
        &pkg_java,
        "package contest;\npublic class Main { public static void main(String[] a) {} }\n",
    )
    .unwrap();
    let pkg_java_res = compile_submission_with_executor(CompileSubmissionRequest {
        language: "java",
        source_path: &pkg_java,
        output_dir: &base_dir,
        platform: &live_client,
        timeout_ms: None,
        extra_include_dirs: &[],
    });
    assert_eq!(
        pkg_java_res.status, "CE",
        "Java non-default package declaration must be rejected as CE"
    );

    // Prepare valid sources for all 6 languages
    let cpp_src = base_dir.join("sol.cpp");
    fs::write(
        &cpp_src,
        "#include <iostream>\nint main() { int a, b; if (std::cin >> a >> b) std::cout << (a + b) << '\\n'; return 0; }\n",
    )
    .unwrap();

    let c_src = base_dir.join("sol.c");
    fs::write(
        &c_src,
        "#include <stdio.h>\nint main(void) { int a, b; if (scanf(\"%d %d\", &a, &b) == 2) printf(\"%d\\n\", a + b); return 0; }\n",
    )
    .unwrap();

    let py_src = base_dir.join("sol.py");
    fs::write(
        &py_src,
        "import sys\nparts = sys.stdin.read().split()\nprint(int(parts[0]) + int(parts[1]))\n",
    )
    .unwrap();

    let pas_src = base_dir.join("sol.pas");
    fs::write(
        &pas_src,
        "program Sol;\nvar a, b: longint;\nbegin\n  readln(a, b);\n  writeln(a + b);\nend.\n",
    )
    .unwrap();

    let java_src = base_dir.join("Main.java");
    fs::write(
        &java_src,
        "import java.util.Scanner;\npublic class Main {\n  public static void main(String[] args) {\n    Scanner sc = new Scanner(System.in);\n    int a = sc.nextInt();\n    int b = sc.nextInt();\n    System.out.println(a + b);\n  }\n}\n",
    )
    .unwrap();

    let scratch_json = concat!(
        "{\"targets\":[{\"isStage\":true,\"name\":\"Stage\",\"variables\":{},\"lists\":{},\"broadcasts\":{},\"blocks\":{},",
        "\"comments\":{},\"currentCostume\":0,\"costumes\":[{\"assetId\":\"cd21514d0531fdffb22204e0ec5ed84a\",\"name\":\"backdrop1\",",
        "\"md5ext\":\"cd21514d0531fdffb22204e0ec5ed84a.svg\",\"dataFormat\":\"svg\",\"rotationCenterX\":240,\"rotationCenterY\":180}],",
        "\"sounds\":[],\"volume\":100,\"layerOrder\":0,\"tempo\":60,\"videoTransparency\":50,\"videoState\":\"on\",\"textToSpeechLanguage\":null},",
        "{\"isStage\":false,\"name\":\"Sprite1\",\"variables\":{},\"lists\":{},\"broadcasts\":{},\"blocks\":{\"start\":{\"opcode\":\"event_whenflagclicked\",",
        "\"next\":\"say\",\"parent\":null,\"inputs\":{},\"fields\":{},\"shadow\":false,\"topLevel\":true},\"say\":{\"opcode\":\"looks_say\",\"next\":null,",
        "\"parent\":\"start\",\"inputs\":{\"MESSAGE\":[1,[10,\"42\"]]},\"fields\":{},\"shadow\":false,\"topLevel\":false}},",
        "\"comments\":{},\"currentCostume\":0,\"costumes\":[{\"assetId\":\"bcf454acf82e4504149f7ffe07081dbc\",\"name\":\"costume1\",",
        "\"bitmapResolution\":1,\"md5ext\":\"bcf454acf82e4504149f7ffe07081dbc.svg\",\"dataFormat\":\"svg\",\"rotationCenterX\":48,\"rotationCenterY\":50}],",
        "\"sounds\":[],\"volume\":100,\"layerOrder\":1,\"visible\":true,\"x\":0,\"y\":0,\"size\":100,\"direction\":90,\"draggable\":false,",
        "\"rotationStyle\":\"all around\"}],\"monitors\":[],\"extensions\":[],\"meta\":{\"semver\":\"3.0.0\",\"vm\":\"0.2.0\",\"agent\":\"JudgeDesk\"}}"
    );
    let scratch_sb3 = base_dir.join("sol.sb3");
    fs::write(
        &scratch_sb3,
        build_minimal_zip(&[("project.json", scratch_json.as_bytes())]),
    )
    .unwrap();

    let cases = [
        ("cpp", &cpp_src, 3_000u64, 256u64),
        ("c", &c_src, 3_000u64, 256u64),
        ("python", &py_src, 10_000u64, 256u64),
        ("pascal", &pas_src, 3_000u64, 256u64),
        ("java", &java_src, 15_000u64, 512u64),
        ("scratch", &scratch_sb3, 10_000u64, 512u64),
    ];

    for (lang, src_path, tl_ms, ml_mb) in cases {
        let out_dir = base_dir.join(format!("out_{lang}"));
        fs::create_dir_all(&out_dir).unwrap();

        let comp = compile_submission_with_executor(CompileSubmissionRequest {
            language: lang,
            source_path: src_path,
            output_dir: &out_dir,
            platform: &live_client,
            timeout_ms: None,
            extra_include_dirs: &[],
        });
        assert_eq!(
            comp.status, "OK",
            "{lang} compilation failed: {:?}",
            comp.error
        );
        let artifact_path = comp.executable.expect("compiled artifact path");

        let run_ws = out_dir.join("tc1");
        let run_res = run_test_case(TestCaseExecutionConfig {
            executable_path: &artifact_path,
            input_path: &input_path,
            expected_output_path: &expected_path,
            input_file_name: "",
            output_file_name: "",
            time_limit_ms: tl_ms,
            memory_limit_mb: ml_mb,
            checker_type: "C1",
            custom_checker_path: None,
            workspace_dir: &run_ws,
            platform: &live_client,
        });
        assert_eq!(
            run_res.status, "AC",
            "{lang} batch execution did not return AC: {:?}",
            run_res
        );
    }

    #[cfg(target_os = "macos")]
    {
        struct DarwinEnvGuard {
            prev_sdkroot: Option<std::ffi::OsString>,
            prev_dev_dir: Option<std::ffi::OsString>,
        }
        impl Drop for DarwinEnvGuard {
            fn drop(&mut self) {
                match self.prev_sdkroot.take() {
                    Some(v) => std::env::set_var("SDKROOT", v),
                    None => std::env::remove_var("SDKROOT"),
                }
                match self.prev_dev_dir.take() {
                    Some(v) => std::env::set_var("DEVELOPER_DIR", v),
                    None => std::env::remove_var("DEVELOPER_DIR"),
                }
            }
        }
        let _env_guard = DarwinEnvGuard {
            prev_sdkroot: std::env::var_os("SDKROOT"),
            prev_dev_dir: std::env::var_os("DEVELOPER_DIR"),
        };

        let xcode_dev = std::path::Path::new("/Applications/Xcode.app/Contents/Developer");
        let xcode_sdk = xcode_dev.join("Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk");
        let clt_dev = std::path::Path::new("/Library/Developer/CommandLineTools");
        let clt_sdk = clt_dev.join("SDKs/MacOSX.sdk");

        let mut env_combos: Vec<(&str, Option<std::path::PathBuf>, Option<std::path::PathBuf>)> =
            Vec::new();
        if clt_sdk.is_dir() {
            env_combos.push(("clt_sdk_only", Some(clt_sdk.clone()), None));
            if clt_dev.is_dir() {
                env_combos.push((
                    "clt_sdk_and_dev",
                    Some(clt_sdk.clone()),
                    Some(clt_dev.to_path_buf()),
                ));
            }
        }
        if xcode_sdk.is_dir() {
            env_combos.push(("xcode_sdk_only", Some(xcode_sdk.clone()), None));
            if xcode_dev.is_dir() {
                env_combos.push((
                    "xcode_sdk_and_dev",
                    Some(xcode_sdk.clone()),
                    Some(xcode_dev.to_path_buf()),
                ));
            }
            if clt_dev.is_dir() {
                env_combos.push((
                    "cross_root_xcode_sdk_clt_dev",
                    Some(xcode_sdk),
                    Some(clt_dev.to_path_buf()),
                ));
            }
        }
        if clt_sdk.is_dir() && xcode_dev.is_dir() {
            env_combos.push((
                "cross_root_clt_sdk_xcode_dev",
                Some(clt_sdk),
                Some(xcode_dev.to_path_buf()),
            ));
        }

        for (tag, sdk_opt, dev_opt) in env_combos {
            match sdk_opt {
                Some(ref p) => std::env::set_var("SDKROOT", p),
                None => std::env::remove_var("SDKROOT"),
            }
            match dev_opt {
                Some(ref p) => std::env::set_var("DEVELOPER_DIR", p),
                None => std::env::remove_var("DEVELOPER_DIR"),
            }

            let out_dir = base_dir.join(format!("out_pascal_{tag}"));
            fs::create_dir_all(&out_dir).unwrap();
            let comp = compile_submission_with_executor(CompileSubmissionRequest {
                language: "pascal",
                source_path: &pas_src,
                output_dir: &out_dir,
                platform: &live_client,
                timeout_ms: None,
                extra_include_dirs: &[],
            });
            assert_eq!(
                comp.status, "OK",
                "pascal compilation under {tag} failed: {:?}",
                comp.error
            );
            let artifact_path = comp.executable.expect("compiled pascal artifact path");
            let run_ws = out_dir.join("tc1");
            let run_res = run_test_case(TestCaseExecutionConfig {
                executable_path: &artifact_path,
                input_path: &input_path,
                expected_output_path: &expected_path,
                input_file_name: "",
                output_file_name: "",
                time_limit_ms: 3_000,
                memory_limit_mb: 256,
                checker_type: "C1",
                custom_checker_path: None,
                workspace_dir: &run_ws,
                platform: &live_client,
            });
            assert_eq!(
                run_res.status, "AC",
                "pascal execution under {tag} did not return AC: {:?}",
                run_res
            );
        }
    }

    live_client.shutdown_sync().expect("shutdown live executor");
}

#[test]
fn step3_compile_submission_with_config_applies_presets_and_rejects_unsafe_flags() {
    use judgedesk_core::discovery::compile_config::{
        create_custom_compile_config, CompileFlags, ProblemCompileConfig,
        COMPILE_CONFIG_SCHEMA_VERSION,
    };
    use judgedesk_core::engine::compiler::compile_submission_with_config;

    let env = common::OwnedTestEnvironment::new();
    common::ensure_test_environment();
    let exe_path = common::executor_binary_path();
    let live_client = env
        .with_isolated_roots(|| ExecutorClient::spawn_sync(&exe_path))
        .expect("spawn live executor");

    let work_dir = env.root().join("config_compile_work");
    fs::create_dir_all(&work_dir).unwrap();
    let cpp_src = work_dir.join("preset_check.cpp");
    fs::write(
        &cpp_src,
        r#"#include <iostream>
int main() {
#ifdef __OPTIMIZE__
    std::cout << "OPT\n";
#else
    std::cout << "NO_OPT\n";
#endif
    return 0;
}
"#,
    )
    .unwrap();

    // 1. Custom -O0 config must compile without __OPTIMIZE__
    let o0_cfg = create_custom_compile_config(&serde_json::json!({
        "cpp": ["-std=c++17", "-O0"],
        "c": ["-std=c11", "-O0"]
    }))
    .expect("create custom -O0 config");
    let out_o0 = work_dir.join("out_o0");
    fs::create_dir_all(&out_o0).unwrap();
    let comp_o0 = compile_submission_with_config(
        CompileSubmissionRequest {
            language: "cpp",
            source_path: &cpp_src,
            output_dir: &out_o0,
            platform: &live_client,
            timeout_ms: None,
            extra_include_dirs: &[],
        },
        Some(&o0_cfg),
    );
    assert_eq!(
        comp_o0.status, "OK",
        "custom -O0 compile failed: {:?}",
        comp_o0.error
    );

    let inp = work_dir.join("empty.inp");
    let exp_no_opt = work_dir.join("no_opt.out");
    fs::write(&inp, "").unwrap();
    fs::write(&exp_no_opt, "NO_OPT\n").unwrap();
    let run_o0 = run_test_case(TestCaseExecutionConfig {
        executable_path: &comp_o0.executable.unwrap(),
        input_path: &inp,
        expected_output_path: &exp_no_opt,
        input_file_name: "",
        output_file_name: "",
        time_limit_ms: 2_000,
        memory_limit_mb: 256,
        checker_type: "C1",
        custom_checker_path: None,
        workspace_dir: &out_o0.join("ws"),
        platform: &live_client,
    });
    assert_eq!(
        run_o0.status, "AC",
        "Expected NO_OPT under -O0: {:?}",
        run_o0
    );

    // 2. Unsafe custom flag (-include) must be rejected before spawning compiler
    let bad_custom = ProblemCompileConfig {
        schema_version: COMPILE_CONFIG_SCHEMA_VERSION,
        profile: "custom".to_string(),
        flags: CompileFlags {
            cpp: vec!["-O2".to_string(), "-include".to_string()],
            c: vec!["-O2".to_string()],
        },
    };
    let comp_bad = compile_submission_with_config(
        CompileSubmissionRequest {
            language: "cpp",
            source_path: &cpp_src,
            output_dir: &out_o0,
            platform: &live_client,
            timeout_ms: None,
            extra_include_dirs: &[],
        },
        Some(&bad_custom),
    );
    assert_eq!(comp_bad.status, "JE");
    assert_eq!(
        comp_bad.provenance,
        Some(CompilationFailureProvenance::JudgeEnvironment)
    );

    live_client.shutdown_sync().expect("shutdown live executor");
}
