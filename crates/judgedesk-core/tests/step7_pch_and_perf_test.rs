use judgedesk_core::discovery::compile_config::ProblemCompileConfig;
use judgedesk_core::engine::compiler::{
    compile_submission_with_executor, CompileSubmissionRequest,
};
use judgedesk_core::engine::runner::{run_test_case, TestCaseExecutionConfig};
use judgedesk_core::executor_client::ExecutorClient;
use judgedesk_core::toolchains::discovery::resolve_toolchain_for_profile;
use judgedesk_core::toolchains::pch::{
    compute_pch_cache_key, ensure_universal_cpp_pch, extract_pch_compiler_flags,
    find_stdcxx_header_for_toolchain, get_pch_directory_for_toolchain, invalidate_pch_cache_dir,
    is_valid_pch_cache_dir, BenchmarkStats, PchCacheIdentity,
};
use judgedesk_core::toolchains::prewarm::{
    execute_selective_prewarm, native_compiler_kinds_to_prewarm, PrewarmOutcome,
};
use std::collections::BTreeSet;
use std::fs;
use std::sync::{Arc, Barrier};
use std::time::Instant;

mod common;

fn provision_full_test_toolchains() {
    if judgedesk_core::toolchains::package_trust::is_linux_full_build() {
        let resources = std::env::var_os("THEMIS_RESOURCE_DIR").expect("Full QA resources");
        let source = std::path::PathBuf::from(resources).join("toolchains/gcc-linux-x64");
        let destination = judgedesk_core::toolchains::discovery::get_app_data_dir()
            .join("toolchains/gcc-linux-x64");
        let receipt = judgedesk_core::toolchains::discovery::read_package_receipt(&source)
            .expect("pinned GCC fixture receipt");
        judgedesk_core::toolchains::package_trust::verify_managed_package(&source, &receipt, false)
            .expect("verify the actual Full GCC input before provisioning");
        judgedesk_core::toolchains::discovery::copy_dir_recursive(&source, &destination)
            .expect("provision Full GCC inside the isolated test root");
    }
}

#[test]
fn wp7_1_benchmark_stats_enforces_minimum_warmups_and_trials_and_computes_percentiles() {
    // Fewer than 3 warmups must be rejected
    let samples: Vec<f64> = (1..=20).map(|x| x as f64 * 10.0).collect();
    assert!(
        BenchmarkStats::from_samples(2, &samples, 0).is_err(),
        "fewer than 3 warmups must be rejected"
    );

    // Fewer than 20 trials must be rejected
    let too_few: Vec<f64> = (1..=19).map(|x| x as f64 * 10.0).collect();
    assert!(
        BenchmarkStats::from_samples(3, &too_few, 0).is_err(),
        "fewer than 20 trials must be rejected"
    );

    let stats = BenchmarkStats::from_samples(3, &samples, 0).expect("valid benchmark samples");
    assert_eq!(stats.warmup_count, 3);
    assert_eq!(stats.trial_count, 20);
    assert_eq!(stats.failure_count, 0);
    assert!((stats.min_ms - 10.0).abs() < 1e-6);
    assert!((stats.max_ms - 200.0).abs() < 1e-6);
    assert!(stats.p50_ms >= 90.0 && stats.p50_ms <= 110.0);
    assert!(stats.p90_ms >= 170.0 && stats.p90_ms <= 190.0);
    assert!(stats.p95_ms >= 180.0 && stats.p95_ms <= 200.0);
}

#[test]
fn wp7_2_pch_cache_identity_changes_on_any_dimension_mutation() {
    let base = PchCacheIdentity {
        compiler_path: "/usr/bin/g++".to_string(),
        compiler_size: 1_234_567,
        compiler_mtime_ms: 1_700_000_000_000,
        compiler_version: "14.2.0".to_string(),
        target_platform: "win32".to_string(),
        target_arch: "x64".to_string(),
        compiler_flags: vec!["-O2".to_string(), "-std=c++14".to_string()],
        header_sha256: "a".repeat(64),
        toolchain_digest: "b".repeat(64),
    };
    let base_key = compute_pch_cache_key(&base);
    assert_eq!(base_key.len(), 16);

    let mut diff_path = base.clone();
    diff_path.compiler_path = "/usr/local/bin/g++".to_string();
    assert_ne!(base_key, compute_pch_cache_key(&diff_path));

    let mut diff_size = base.clone();
    diff_size.compiler_size += 1;
    assert_ne!(base_key, compute_pch_cache_key(&diff_size));

    let mut diff_mtime = base.clone();
    diff_mtime.compiler_mtime_ms += 1000;
    assert_ne!(base_key, compute_pch_cache_key(&diff_mtime));

    let mut diff_ver = base.clone();
    diff_ver.compiler_version = "14.2.1".to_string();
    assert_ne!(base_key, compute_pch_cache_key(&diff_ver));

    let mut diff_target = base.clone();
    diff_target.target_arch = "arm64".to_string();
    assert_ne!(base_key, compute_pch_cache_key(&diff_target));

    let mut diff_flags = base.clone();
    diff_flags.compiler_flags = vec!["-O0".to_string(), "-std=c++17".to_string()];
    assert_ne!(base_key, compute_pch_cache_key(&diff_flags));

    let mut diff_header = base.clone();
    diff_header.header_sha256 = "c".repeat(64);
    assert_ne!(base_key, compute_pch_cache_key(&diff_header));

    let mut diff_digest = base.clone();
    diff_digest.toolchain_digest = "d".repeat(64);
    assert_ne!(base_key, compute_pch_cache_key(&diff_digest));
}

#[test]
fn wp7_2_and_wp7_3_single_flight_pch_generation_consumption_and_corrupt_fallback() {
    let env = common::OwnedTestEnvironment::new();
    common::ensure_test_environment();
    let exe_path = common::executor_binary_path();

    env.with_isolated_roots(|| {
        provision_full_test_toolchains();
        let live_client = Arc::new(ExecutorClient::spawn_sync(&exe_path).expect("spawn executor"));
        let toolchain = resolve_toolchain_for_profile("cpp", None, None);
        assert!(
            toolchain.ready,
            "C++ toolchain must be ready on host: {:?}",
            toolchain.diagnostic
        );
        assert!(
            find_stdcxx_header_for_toolchain(&toolchain).is_some(),
            "stdc++.h header must be locatable for active C++ toolchain"
        );

        let default_cfg = ProblemCompileConfig::default();
        let raw_flags = default_cfg.flags_for_language("cpp");
        let pch_flags = extract_pch_compiler_flags(raw_flags).expect("extract pch flags");

        // 1. Concurrent single-flight generation across 4 threads
        let barrier = Arc::new(Barrier::new(4));
        let mut handles = Vec::new();
        for _ in 0..4 {
            let client_clone = Arc::clone(&live_client);
            let tc_clone = toolchain.clone();
            let flags_clone = pch_flags.clone();
            let bar_clone = Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                bar_clone.wait();
                ensure_universal_cpp_pch(&client_clone, &tc_clone, &flags_clone)
            }));
        }

        let mut outcomes = Vec::new();
        for h in handles {
            outcomes.push(
                h.join()
                    .expect("join thread")
                    .expect("PCH generation must succeed"),
            );
        }

        let generated_count = outcomes.iter().filter(|o| o.generated).count();
        assert_eq!(
            generated_count, 1,
            "Exactly 1 thread must perform cold PCH generation under single-flight lock; outcomes={outcomes:?}"
        );
        let pch_dir = outcomes[0].pch_dir.clone();
        assert!(
            is_valid_pch_cache_dir(&pch_dir, &outcomes[0].identity),
            "Generated PCH cache directory must be valid"
        );
        assert_eq!(
            get_pch_directory_for_toolchain(&toolchain, &pch_flags),
            Some(pch_dir.clone())
        );

        // 2. Compile a C++ submission using #include <bits/stdc++.h> with warm PCH
        let work_dir = env.root().join("pch_compile_work");
        fs::create_dir_all(&work_dir).unwrap();
        let src_path = work_dir.join("stdcxx_solution.cpp");
        fs::write(
            &src_path,
            r#"#include <bits/stdc++.h>
using namespace std;
int main() {
    vector<int> v = {3, 1, 4, 1, 5};
    sort(v.begin(), v.end());
    int sum = accumulate(v.begin(), v.end(), 0);
    cout << sum << "\n";
    return 0;
}
"#,
        )
        .unwrap();

        let out_warm = work_dir.join("out_warm");
        fs::create_dir_all(&out_warm).unwrap();
        let comp_warm = compile_submission_with_executor(CompileSubmissionRequest {
            language: "cpp",
            source_path: &src_path,
            output_dir: &out_warm,
            platform: &live_client,
            timeout_ms: None,
            extra_include_dirs: &[],
        });
        assert_eq!(
            comp_warm.status, "OK",
            "Warm PCH compilation must succeed: {:?}",
            comp_warm.error
        );

        let inp = work_dir.join("1.inp");
        let exp = work_dir.join("1.out");
        fs::write(&inp, "").unwrap();
        fs::write(&exp, "14\n").unwrap();
        let run_warm = run_test_case(TestCaseExecutionConfig {
            executable_path: comp_warm.executable.as_ref().unwrap(),
            input_path: &inp,
            expected_output_path: &exp,
            input_file_name: "",
            output_file_name: "",
            time_limit_ms: 2_000,
            memory_limit_mb: 256,
            checker_type: "C1",
            custom_checker_path: None,
            workspace_dir: &out_warm.join("run_ws"),
            platform: &live_client,
        });
        assert_eq!(run_warm.status, "AC");

        // 2b. Student syntax error (CE) must NOT evict the valid shared PCH cache directory
        let ce_src_path = work_dir.join("student_ce.cpp");
        fs::write(
            &ce_src_path,
            "#include <bits/stdc++.h>\nusing namespace std;\nint main( { syntax error }\n",
        )
        .unwrap();
        let out_ce = work_dir.join("out_ce");
        fs::create_dir_all(&out_ce).unwrap();
        let comp_ce = compile_submission_with_executor(CompileSubmissionRequest {
            language: "cpp",
            source_path: &ce_src_path,
            output_dir: &out_ce,
            platform: &live_client,
            timeout_ms: None,
            extra_include_dirs: &[],
        });
        assert_eq!(
            comp_ce.status, "CE",
            "Broken student C++ submission must return CE: {:?}",
            comp_ce.error
        );
        assert!(
            is_valid_pch_cache_dir(&pch_dir, &outcomes[0].identity),
            "Valid PCH cache directory must NOT be evicted by an ordinary student syntax error (CE)"
        );
        assert_eq!(
            get_pch_directory_for_toolchain(&toolchain, &pch_flags),
            Some(pch_dir.clone()),
            "Active C++ toolchain must still resolve the warm PCH directory after a student CE"
        );

        // 3. Corrupt the .gch file on disk and verify automatic fallback without compilation failure
        let gch_path = pch_dir.join("bits").join("stdc++.h.gch");
        assert!(gch_path.is_file());
        // Overwrite with invalid payload (keeping > 1024 bytes so we test corruption detection + fallback)
        let mut corrupt_bytes = b"CORRUPT_PCH_HEADER_".repeat(120);
        corrupt_bytes.truncate(2048);
        fs::write(&gch_path, &corrupt_bytes).unwrap();

        let out_fallback = work_dir.join("out_fallback");
        fs::create_dir_all(&out_fallback).unwrap();
        let comp_fallback = compile_submission_with_executor(CompileSubmissionRequest {
            language: "cpp",
            source_path: &src_path,
            output_dir: &out_fallback,
            platform: &live_client,
            timeout_ms: None,
            extra_include_dirs: &[],
        });
        assert_eq!(
            comp_fallback.status, "OK",
            "Corrupt PCH must automatically fall back to standard header compilation without failing: {:?}",
            comp_fallback.error
        );

        // Also test mid-file corruption where magic bytes and exact file size are preserved
        let regen = ensure_universal_cpp_pch(&live_client, &toolchain, &pch_flags)
            .expect("regenerate valid PCH after eviction");
        assert!(regen.generated, "Corrupt PCH should have been evicted and regenerated");
        let mut mid_corrupt = fs::read(&gch_path).unwrap();
        let mid_start = mid_corrupt.len() / 2;
        let mid_end = (mid_start + 512).min(mid_corrupt.len());
        for b in &mut mid_corrupt[mid_start..mid_end] {
            *b ^= 0xFF;
        }
        fs::write(&gch_path, &mid_corrupt).unwrap();

        let out_mid_fallback = work_dir.join("out_mid_fallback");
        fs::create_dir_all(&out_mid_fallback).unwrap();
        let comp_mid_fallback = compile_submission_with_executor(CompileSubmissionRequest {
            language: "cpp",
            source_path: &src_path,
            output_dir: &out_mid_fallback,
            platform: &live_client,
            timeout_ms: None,
            extra_include_dirs: &[],
        });
        assert_eq!(
            comp_mid_fallback.status, "OK",
            "Mid-file corrupt PCH must be caught on compiler retry and fall back cleanly: {:?}",
            comp_mid_fallback.error
        );

        invalidate_pch_cache_dir(&pch_dir);
        live_client.shutdown_sync().expect("shutdown live executor");
    });
}

#[test]
fn wp7_4_selective_prewarm_only_warms_requested_native_compilers_and_respects_closing() {
    let env = common::OwnedTestEnvironment::new();
    common::ensure_test_environment();
    let exe_path = common::executor_binary_path();

    env.with_isolated_roots(|| {
        provision_full_test_toolchains();
        let mut required = BTreeSet::new();
        required.insert("python".to_string());
        required.insert("scratch".to_string());
        assert!(
            native_compiler_kinds_to_prewarm(&required).is_empty(),
            "Python/Scratch-only sessions must not prewarm native C/C++ compilers"
        );

        required.insert("cpp".to_string());
        assert_eq!(
            native_compiler_kinds_to_prewarm(&required),
            vec!["cpp".to_string()]
        );

        let live_client = ExecutorClient::spawn_sync(&exe_path).expect("spawn executor");

        // Closing state must immediately defer
        let deferred = execute_selective_prewarm(&live_client, &["cpp"], || true);
        assert_eq!(
            deferred,
            PrewarmOutcome::Deferred {
                reason: "SERVER_CLOSING".to_string()
            }
        );

        // Active state must prewarm C++ and populate PCH cache
        let completed = execute_selective_prewarm(&live_client, &["cpp"], || false);
        match completed {
            PrewarmOutcome::Completed {
                prewarmed_kinds,
                pch_dir,
            } => {
                assert_eq!(prewarmed_kinds, vec!["cpp".to_string()]);
                assert!(
                    pch_dir.is_some(),
                    "C++ selective prewarm must produce a valid PCH directory"
                );
            }
            other => panic!("Expected PrewarmOutcome::Completed, got {other:?}"),
        }

        live_client.shutdown_sync().expect("shutdown live executor");
    });
}

#[test]
fn g7_pch_compile_latency_benchmark_3_warmups_20_trials() {
    let env = common::OwnedTestEnvironment::new();
    common::ensure_test_environment();
    let exe_path = common::executor_binary_path();

    env.with_isolated_roots(|| {
        provision_full_test_toolchains();
        let live_client = ExecutorClient::spawn_sync(&exe_path).expect("spawn executor");
        let toolchain = resolve_toolchain_for_profile("cpp", None, None);
        assert!(toolchain.ready);

        let default_cfg = ProblemCompileConfig::default();
        let raw_flags = default_cfg.flags_for_language("cpp");
        let pch_flags = extract_pch_compiler_flags(raw_flags).expect("extract pch flags");

        let work_dir = env.root().join("perf_bench");
        fs::create_dir_all(&work_dir).unwrap();
        let src_path = work_dir.join("contest_sol.cpp");
        fs::write(
            &src_path,
            r#"#include <bits/stdc++.h>
using namespace std;
int main() {
    ios_base::sync_with_stdio(false);
    cin.tie(nullptr);
    vector<long long> a = {10, 20, 30, 40, 50};
    map<long long, int> freq;
    for (auto x : a) freq[x]++;
    cout << freq.size() << "\n";
    return 0;
}
"#,
        )
        .unwrap();

        // Phase A: Cold / No-PCH baseline (3 warmups + 20 trials with PCH disabled)
        std::env::set_var("JUDGEDESK_DISABLE_PCH", "1");
        for i in 0..3 {
            let out_dir = work_dir.join(format!("cold_warmup_{i}"));
            let res = compile_submission_with_executor(CompileSubmissionRequest {
                language: "cpp",
                source_path: &src_path,
                output_dir: &out_dir,
                platform: &live_client,
                timeout_ms: None,
                extra_include_dirs: &[],
            });
            assert_eq!(res.status, "OK");
        }
        let mut cold_samples = Vec::with_capacity(20);
        let mut cold_failures = 0usize;
        for i in 0..20 {
            let out_dir = work_dir.join(format!("cold_trial_{i}"));
            let t0 = Instant::now();
            let res = compile_submission_with_executor(CompileSubmissionRequest {
                language: "cpp",
                source_path: &src_path,
                output_dir: &out_dir,
                platform: &live_client,
                timeout_ms: None,
                extra_include_dirs: &[],
            });
            let elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0;
            if res.status == "OK" {
                cold_samples.push(elapsed_ms);
            } else {
                cold_failures += 1;
            }
        }
        std::env::remove_var("JUDGEDESK_DISABLE_PCH");

        let cold_stats =
            BenchmarkStats::from_samples(3, &cold_samples, cold_failures).expect("cold stats");
        assert_eq!(cold_stats.failure_count, 0);

        // Phase B: Warm PCH (ensure PCH generated, then 3 warmups + 20 trials)
        let ensured =
            ensure_universal_cpp_pch(&live_client, &toolchain, &pch_flags).expect("ensure PCH");
        assert!(ensured.pch_dir.is_dir());

        for i in 0..3 {
            let out_dir = work_dir.join(format!("warm_warmup_{i}"));
            let res = compile_submission_with_executor(CompileSubmissionRequest {
                language: "cpp",
                source_path: &src_path,
                output_dir: &out_dir,
                platform: &live_client,
                timeout_ms: None,
                extra_include_dirs: &[],
            });
            assert_eq!(res.status, "OK");
        }
        let mut warm_samples = Vec::with_capacity(20);
        let mut warm_failures = 0usize;
        for i in 0..20 {
            let out_dir = work_dir.join(format!("warm_trial_{i}"));
            let t0 = Instant::now();
            let res = compile_submission_with_executor(CompileSubmissionRequest {
                language: "cpp",
                source_path: &src_path,
                output_dir: &out_dir,
                platform: &live_client,
                timeout_ms: None,
                extra_include_dirs: &[],
            });
            let elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0;
            if res.status == "OK" {
                warm_samples.push(elapsed_ms);
            } else {
                warm_failures += 1;
            }
        }

        let warm_stats =
            BenchmarkStats::from_samples(3, &warm_samples, warm_failures).expect("warm stats");
        assert_eq!(warm_stats.failure_count, 0);
        eprintln!(
            "[G7_BENCHMARK] cold_p50={:.1}ms cold_p90={:.1}ms cold_p95={:.1}ms cold_min={:.1}ms cold_max={:.1}ms | warm_p50={:.1}ms warm_p90={:.1}ms warm_p95={:.1}ms warm_min={:.1}ms warm_max={:.1}ms | speedup={:.2}x",
            cold_stats.p50_ms,
            cold_stats.p90_ms,
            cold_stats.p95_ms,
            cold_stats.min_ms,
            cold_stats.max_ms,
            warm_stats.p50_ms,
            warm_stats.p90_ms,
            warm_stats.p95_ms,
            warm_stats.min_ms,
            warm_stats.max_ms,
            cold_stats.p50_ms / warm_stats.p50_ms.max(1.0)
        );
        assert!(
            warm_stats.p50_ms < cold_stats.p50_ms,
            "Warm PCH p50 ({:.1}ms) must be faster than Cold no-PCH p50 ({:.1}ms)",
            warm_stats.p50_ms,
            cold_stats.p50_ms
        );

        live_client.shutdown_sync().expect("shutdown live executor");
    });
}
