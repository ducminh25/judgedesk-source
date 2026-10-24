use judgedesk_core::discovery::*;
use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;

struct TempDir(PathBuf);
impl TempDir {
    fn new(prefix: &str) -> Self {
        let path = std::env::temp_dir().join(format!("{prefix}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn test_case_insensitive_matching_and_natural_sorting() {
    let temp = TempDir::new("themis_discovery_test");
    let contestants = temp.0.join("contestants");
    let tests = temp.0.join("tests");

    let alice = contestants.join("Alice");
    fs::create_dir_all(&alice).unwrap();
    File::create(alice.join("SUM.CPP"))
        .unwrap()
        .write_all(b"int main(){}")
        .unwrap();

    for name in ["10", "2"] {
        let d = tests.join("Sum").join(name);
        fs::create_dir_all(&d).unwrap();
        File::create(d.join("data.inp"))
            .unwrap()
            .write_all(b"1")
            .unwrap();
        File::create(d.join("data.out"))
            .unwrap()
            .write_all(b"2")
            .unwrap();
    }

    assert_eq!(
        list_contestants(&contestants, Some(&["Alice".to_string()])),
        vec!["Alice".to_string()]
    );

    let sub = find_submission(&alice, "sum").unwrap().unwrap();
    assert_eq!(sub.language, "cpp");
    assert_eq!(sub.problem_name, "SUM");

    let resolver = create_problem_directory_resolver(&tests);
    let problem = resolver("SUM").unwrap();
    assert_eq!(list_test_directories(&problem.path, false), vec!["2", "10"]);

    let tc2 = testcase::resolve_test_case_files(&problem.path, "2", false).unwrap();
    assert_eq!(tc2.input_file_name, "data.inp");
}

#[test]
fn test_discovery_ignores_incomplete_pairs() {
    let temp = TempDir::new("judgedesk_incomplete_test");
    let root = &temp.0;

    let test01 = root.join("test01");
    fs::create_dir_all(&test01).unwrap();
    File::create(test01.join("data.inp")).unwrap();
    File::create(test01.join("data.out")).unwrap();

    let test02 = root.join("test02");
    fs::create_dir_all(&test02).unwrap();
    File::create(test02.join("sample.IN")).unwrap();
    File::create(test02.join("sample.ANS")).unwrap();

    let pycache = root.join("__pycache__");
    fs::create_dir_all(&pycache).unwrap();
    File::create(pycache.join("checker.cpython-312.pyc")).unwrap();

    let input_only = root.join("input-only");
    fs::create_dir_all(&input_only).unwrap();
    File::create(input_only.join("data.inp")).unwrap();

    let output_only = root.join("output-only");
    fs::create_dir_all(&output_only).unwrap();
    File::create(output_only.join("data.out")).unwrap();

    let fake_files = root.join("fake-files");
    fs::create_dir_all(fake_files.join("data.inp")).unwrap();
    fs::create_dir_all(fake_files.join("data.out")).unwrap();

    let empty = root.join("empty");
    fs::create_dir_all(&empty).unwrap();

    assert_eq!(
        list_test_directories(root, false),
        vec!["test01".to_string(), "test02".to_string()]
    );
    assert_eq!(
        testcase::resolve_test_case_files(root, "__pycache__", false),
        None
    );
    assert_eq!(
        testcase::resolve_test_case_files(root, "input-only", false),
        None
    );
    assert_eq!(
        testcase::resolve_test_case_files(root, "output-only", false),
        None
    );
    assert_eq!(
        testcase::resolve_test_case_files(root, "fake-files", false),
        None
    );
}

#[test]
fn test_python_discovery() {
    let temp = TempDir::new("themis_python_test");
    let root = &temp.0;
    File::create(root.join("GRAPH.PY"))
        .unwrap()
        .write_all(b"print('ok')")
        .unwrap();

    let sub = find_submission(root, "graph").unwrap().unwrap();
    assert_eq!(sub.file_name, "GRAPH.PY");
    assert_eq!(sub.language, "python");
    assert_eq!(sub.problem_name, "GRAPH");
}

#[test]
fn test_ambiguous_submission_fails_closed() {
    let temp = TempDir::new("themis_ambiguous_test");
    let root = &temp.0;
    File::create(root.join("SUM.cpp")).unwrap();
    File::create(root.join("SUM.py")).unwrap();

    let err = find_submission(root, "SUM").unwrap_err();
    assert!(err.contains("AMBIGUOUS_SUBMISSION"));
    assert!(err.contains("SUM.cpp"));
    assert!(err.contains("SUM.py"));
}

#[test]
fn test_interactive_discovery_allows_input_only() {
    let temp = TempDir::new("themis_interactive_test");
    let root = &temp.0;
    let test01 = root.join("test01");
    fs::create_dir_all(&test01).unwrap();
    File::create(test01.join("data.inp"))
        .unwrap()
        .write_all(b"42")
        .unwrap();

    // Non-interactive ignores
    assert_eq!(discover_test_cases(root, false).len(), 0);

    // Interactive accepts
    let tcs = discover_test_cases(root, true);
    assert_eq!(tcs.len(), 1);
    assert_eq!(tcs[0].name, "test01");
    assert_eq!(tcs[0].input_file_name, "data.inp");
    assert_eq!(tcs[0].output_path.to_string_lossy(), "");
}

#[test]
fn test_custom_checkers_and_interactors_order() {
    let temp = TempDir::new("themis_checkers_test");
    let root = &temp.0;
    for name in [
        "checker10.py",
        "checker2.cpp",
        "legacy.exe",
        "alpha.exe",
        "notes.txt",
    ] {
        File::create(root.join(name)).unwrap();
    }

    assert_eq!(
        discover_custom_checkers(root, "win32"),
        vec!["alpha.exe", "legacy.exe", "checker2.cpp", "checker10.py"]
    );
    assert_eq!(
        discover_custom_checkers(root, "darwin"),
        vec!["checker2.cpp", "checker10.py"]
    );

    let temp2 = TempDir::new("themis_interactors_test");
    let root2 = &temp2.0;
    for name in [
        "interactor.cpp",
        "interactor2.py",
        "interactor.exe",
        "interactor_custom.exe",
        "notes.txt",
    ] {
        File::create(root2.join(name)).unwrap();
    }

    assert_eq!(
        discover_interactors(root2, "win32"),
        vec![
            "interactor_custom.exe",
            "interactor.exe",
            "interactor.cpp",
            "interactor2.py"
        ]
    );
    assert_eq!(
        discover_interactors(root2, "darwin"),
        vec!["interactor.cpp", "interactor2.py"]
    );
}

#[test]
fn test_flat_test_discovery_in_single_folder() {
    let temp = TempDir::new("flat_discovery_test");
    let root = &temp.0;

    File::create(root.join("1.inp"))
        .unwrap()
        .write_all(b"10")
        .unwrap();
    File::create(root.join("1.out"))
        .unwrap()
        .write_all(b"20")
        .unwrap();
    File::create(root.join("2.INP"))
        .unwrap()
        .write_all(b"30")
        .unwrap();
    File::create(root.join("2.OUT"))
        .unwrap()
        .write_all(b"40")
        .unwrap();
    File::create(root.join("10.inp"))
        .unwrap()
        .write_all(b"50")
        .unwrap();
    File::create(root.join("10.out"))
        .unwrap()
        .write_all(b"60")
        .unwrap();
    File::create(root.join("case-a.in"))
        .unwrap()
        .write_all(b"70")
        .unwrap();
    File::create(root.join("case-a.ans"))
        .unwrap()
        .write_all(b"80")
        .unwrap();
    File::create(root.join("incomplete.inp"))
        .unwrap()
        .write_all(b"90")
        .unwrap();
    File::create(root.join("orphan.out"))
        .unwrap()
        .write_all(b"100")
        .unwrap();
    File::create(root.join("solution.cpp"))
        .unwrap()
        .write_all(b"int main(){}")
        .unwrap();
    File::create(root.join("Config.cfg"))
        .unwrap()
        .write_all(b"{}")
        .unwrap();

    assert_eq!(
        list_test_directories(root, false),
        vec![
            "1".to_string(),
            "2".to_string(),
            "10".to_string(),
            "case-a".to_string()
        ]
    );

    let discovered = discover_test_cases(root, false);
    assert_eq!(discovered.len(), 4);
    assert_eq!(discovered[0].name, "1");
    assert_eq!(discovered[0].input_path, root.join("1.inp"));
    assert_eq!(discovered[0].output_path, root.join("1.out"));
    assert_eq!(discovered[0].input_file_name, "1.inp");

    assert_eq!(discovered[1].name, "2");
    assert_eq!(discovered[1].input_path, root.join("2.INP"));
    assert_eq!(discovered[1].output_path, root.join("2.OUT"));
    assert_eq!(discovered[1].input_file_name, "2.INP");

    assert_eq!(discovered[2].name, "10");
    assert_eq!(discovered[2].input_file_name, "10.inp");

    assert_eq!(discovered[3].name, "case-a");
    assert_eq!(discovered[3].input_file_name, "case-a.in");
    assert_eq!(discovered[3].output_path, root.join("case-a.ans"));

    let resolved_one = testcase::resolve_test_case_files(root, "1", false).unwrap();
    assert_eq!(resolved_one.name, "1");
    assert_eq!(resolved_one.input_file_name, "1.inp");
    assert_eq!(resolved_one.output_path, root.join("1.out"));

    assert_eq!(
        testcase::resolve_test_case_files(root, "incomplete", false),
        None
    );
    assert_eq!(
        testcase::resolve_test_case_files(root, "orphan", false),
        None
    );
    assert_eq!(
        testcase::resolve_test_case_files(root, "solution", false),
        None
    );
}

#[test]
fn test_flat_test_discovery_interactive_allows_input_only() {
    let temp = TempDir::new("flat_interactive_test");
    let root = &temp.0;

    File::create(root.join("1.inp"))
        .unwrap()
        .write_all(b"42")
        .unwrap();
    File::create(root.join("2.in"))
        .unwrap()
        .write_all(b"99")
        .unwrap();

    assert_eq!(discover_test_cases(root, false).len(), 0);

    let interactive_tests = discover_test_cases(root, true);
    assert_eq!(interactive_tests.len(), 2);
    assert_eq!(interactive_tests[0].name, "1");
    assert_eq!(interactive_tests[0].output_path.to_string_lossy(), "");
    assert_eq!(interactive_tests[1].name, "2");
    assert_eq!(interactive_tests[1].output_path.to_string_lossy(), "");

    let resolved_interactive = testcase::resolve_test_case_files(root, "1", true).unwrap();
    assert_eq!(resolved_interactive.name, "1");
    assert_eq!(resolved_interactive.output_path.to_string_lossy(), "");
}

#[test]
fn test_discovery_prefers_directory_tests_when_themis_structure_present() {
    let temp = TempDir::new("themis_precedence_test");
    let root = &temp.0;

    for dir_name in ["Test01", "Test02"] {
        let dir = root.join(dir_name);
        fs::create_dir_all(&dir).unwrap();
        File::create(dir.join("BAI1.INP"))
            .unwrap()
            .write_all(b"1")
            .unwrap();
        File::create(dir.join("BAI1.OUT"))
            .unwrap()
            .write_all(b"2")
            .unwrap();
    }

    File::create(root.join("BAI1.INP"))
        .unwrap()
        .write_all(b"sample")
        .unwrap();
    File::create(root.join("BAI1.OUT"))
        .unwrap()
        .write_all(b"sample")
        .unwrap();

    assert_eq!(
        list_test_directories(root, false),
        vec!["Test01".to_string(), "Test02".to_string()]
    );
    let discovered = discover_test_cases(root, false);
    assert_eq!(discovered.len(), 2);
    assert_eq!(discovered[0].name, "Test01");
    assert_eq!(discovered[1].name, "Test02");
}

#[test]
fn test_create_problem_directory_resolver_matches_self() {
    let temp = TempDir::new("single_problem_test");
    let root = &temp.0;
    let sum_dir = root.join("SUM");
    fs::create_dir_all(&sum_dir).unwrap();
    File::create(sum_dir.join("1.inp"))
        .unwrap()
        .write_all(b"1")
        .unwrap();
    File::create(sum_dir.join("1.out"))
        .unwrap()
        .write_all(b"2")
        .unwrap();

    let resolver = create_problem_directory_resolver(&sum_dir);
    let resolved = resolver("sum");
    assert!(resolved.is_some());
    let p = resolved.unwrap();
    assert_eq!(p.name, "SUM");
    assert_eq!(p.path, sum_dir);
}

#[test]
fn test_directory_tests_take_precedence_over_more_flat_pairs() {
    let temp = TempDir::new("themis_more_flat_samples_test");
    let root = &temp.0;
    let test_dir = root.join("test1");
    fs::create_dir_all(&test_dir).unwrap();
    File::create(test_dir.join("SUM.inp")).unwrap();
    File::create(test_dir.join("SUM.out")).unwrap();
    for stem in ["test1", "test2"] {
        File::create(root.join(format!("{stem}.inp"))).unwrap();
        File::create(root.join(format!("{stem}.out"))).unwrap();
    }

    let discovered = discover_test_cases(root, false);
    assert_eq!(discovered.len(), 1);
    assert_eq!(discovered[0].directory, test_dir);
    assert_eq!(
        testcase::resolve_test_case_files(root, "test1", false),
        Some(discovered[0].clone())
    );
}

#[test]
fn test_resolver_does_not_return_flat_cases_omitted_by_directory_layout() {
    let temp = TempDir::new("themis_resolve_selected_test");
    let root = &temp.0;
    let test_dir = root.join("Test01");
    fs::create_dir_all(&test_dir).unwrap();
    File::create(test_dir.join("SUM.inp")).unwrap();
    File::create(test_dir.join("SUM.out")).unwrap();
    File::create(root.join("sample.inp")).unwrap();
    File::create(root.join("sample.out")).unwrap();

    assert_eq!(list_test_directories(root, false), vec!["Test01"]);
    assert_eq!(
        testcase::resolve_test_case_files(root, "sample", false),
        None
    );
}

#[test]
fn test_problem_directory_resolver_rejects_files_missing_paths_and_containers() {
    let temp = TempDir::new("problem_resolver_validation_test");
    let root = &temp.0;
    File::create(root.join("FILE")).unwrap();
    let sum_dir = root.join("SUM");
    fs::create_dir_all(&sum_dir).unwrap();
    File::create(sum_dir.join("test1.inp")).unwrap();
    File::create(sum_dir.join("test1.out")).unwrap();

    let resolver = create_problem_directory_resolver(root);
    assert_eq!(resolver("FILE"), None);
    assert_eq!(resolver(root.file_name().unwrap().to_str().unwrap()), None);
    assert_eq!(resolver("sum").unwrap().path, sum_dir);

    let missing = root.join("MISSING");
    let missing_resolver = create_problem_directory_resolver(&missing);
    assert_eq!(missing_resolver("missing"), None);
}

#[test]
fn test_flat_extension_preference_and_resolver_consistency() {
    let temp = TempDir::new("flat_extension_preference_test");
    let root = &temp.0;
    for file in ["test1.in", "test1.inp", "test1.ans", "test1.out"] {
        File::create(root.join(file)).unwrap();
    }

    let discovered = discover_test_cases(root, false);
    assert_eq!(discovered.len(), 1);
    assert_eq!(discovered[0].input_path, root.join("test1.inp"));
    assert_eq!(discovered[0].output_path, root.join("test1.out"));
    assert_eq!(
        testcase::resolve_test_case_files(root, "TEST1", false),
        Some(discovered[0].clone())
    );
}

#[test]
fn test_flat_natural_sort_has_deterministic_name_tiebreaker() {
    let temp = TempDir::new("flat_natural_sort_tie_test");
    let root = &temp.0;
    for stem in ["1", "01", "001"] {
        File::create(root.join(format!("{stem}.inp"))).unwrap();
        File::create(root.join(format!("{stem}.out"))).unwrap();
    }

    for _ in 0..32 {
        assert_eq!(list_test_directories(root, false), vec!["001", "01", "1"]);
    }
}

#[test]
fn test_flat_directory_detection_includes_interactive_inputs_and_ignores_helpers() {
    let temp = TempDir::new("flat_directory_detection_test");
    let root = &temp.0;
    let sum_dir = root.join("SUM");
    fs::create_dir_all(sum_dir.join("__pycache__")).unwrap();
    File::create(sum_dir.join("test1.in")).unwrap();

    assert!(testcase::is_flat_test_directory(&sum_dir));
    assert!(!testcase::is_flat_test_directory(root));
    assert!(!testcase::is_flat_test_directory(root.join("missing")));
    let resolver = create_problem_directory_resolver(&sum_dir);
    assert_eq!(resolver("sum").unwrap().path, sum_dir);

    let themis_dir = sum_dir.join("Test01");
    fs::create_dir_all(&themis_dir).unwrap();
    File::create(themis_dir.join("SUM.inp")).unwrap();
    assert!(!testcase::is_flat_test_directory(&sum_dir));
}

#[test]
fn test_flat_directory_detection_accepts_complete_pairs_with_input_only_helpers() {
    let temp = TempDir::new("flat_directory_input_helper_test");
    let root = &temp.0;
    let sum_dir = root.join("SUM");
    fs::create_dir_all(sum_dir.join("examples")).unwrap();
    File::create(sum_dir.join("test1.inp")).unwrap();
    File::create(sum_dir.join("test1.out")).unwrap();
    File::create(sum_dir.join("examples").join("example.in")).unwrap();

    assert!(testcase::is_flat_test_directory(&sum_dir));
    assert_eq!(
        create_problem_directory_resolver(&sum_dir)("sum")
            .unwrap()
            .path,
        sum_dir
    );
    assert_eq!(
        testcase::resolve_problem_directory_path(sum_dir.join("SUM")),
        sum_dir
    );
}

#[test]
fn test_synthetic_problem_path_resolves_only_repeated_flat_directory_name() {
    let temp = TempDir::new("synthetic_problem_path_test");
    let root = &temp.0;
    let sum_dir = root.join("SUM");
    fs::create_dir_all(&sum_dir).unwrap();
    File::create(sum_dir.join("test1.inp")).unwrap();
    File::create(sum_dir.join("test1.out")).unwrap();

    assert_eq!(
        testcase::resolve_problem_directory_path(sum_dir.join("sum")),
        sum_dir
    );
    let unrelated = sum_dir.join("OTHER");
    assert_eq!(
        testcase::resolve_problem_directory_path(&unrelated),
        unrelated
    );

    let container_alias = root.join(root.file_name().unwrap());
    assert_eq!(
        testcase::resolve_problem_directory_path(&container_alias),
        container_alias
    );
    let missing = root.join("MISSING").join("MISSING");
    assert_eq!(testcase::resolve_problem_directory_path(&missing), missing);

    let existing = sum_dir.join("SUM");
    fs::create_dir_all(&existing).unwrap();
    assert_eq!(testcase::resolve_problem_directory_path(&existing), sum_dir);
    File::create(existing.join("SUM.inp")).unwrap();
    File::create(existing.join("SUM.out")).unwrap();
    assert_eq!(
        testcase::resolve_problem_directory_path(&existing),
        existing
    );
}

#[test]
fn test_direct_flat_root_resolver_ignores_same_name_auxiliary_directory() {
    let temp = TempDir::new("flat_root_same_name_helper_test");
    let root = temp.0.join("SUM");
    fs::create_dir_all(root.join("SUM").join("docs")).unwrap();
    File::create(root.join("test1.inp")).unwrap();
    File::create(root.join("test1.out")).unwrap();

    assert_eq!(
        create_problem_directory_resolver(&root)("sum")
            .unwrap()
            .path,
        root
    );
    assert_eq!(
        testcase::resolve_problem_directory_path(root.join("SUM")),
        root
    );

    File::create(root.join("SUM").join("SUM.inp")).unwrap();
    File::create(root.join("SUM").join("SUM.out")).unwrap();
    assert_eq!(
        create_problem_directory_resolver(&root)("sum")
            .unwrap()
            .path,
        root.join("SUM")
    );
}

#[test]
fn test_synthetic_problem_path_maps_existing_same_name_compiled_binary() {
    let temp = TempDir::new("flat_root_same_name_file_test");
    let root = temp.0.join("SUM");
    fs::create_dir_all(&root).unwrap();
    File::create(root.join("test1.inp")).unwrap();
    File::create(root.join("test1.out")).unwrap();
    let file = root.join("SUM");
    File::create(&file).unwrap();

    assert_eq!(testcase::resolve_problem_directory_path(&file), root);
}

#[test]
fn test_flat_root_samples_do_not_hide_nested_themis_problem() {
    let temp = TempDir::new("flat_samples_nested_problem_test");
    let root = temp.0.join("SUM");
    let problem = root.join("SUM");
    let test_dir = problem.join("Test01");
    fs::create_dir_all(&test_dir).unwrap();
    File::create(test_dir.join("data.inp")).unwrap();
    File::create(test_dir.join("data.out")).unwrap();
    File::create(root.join("sample.inp")).unwrap();
    File::create(root.join("sample.out")).unwrap();

    assert!(!testcase::is_flat_test_directory(&root));
    assert_eq!(
        create_problem_directory_resolver(&root)("sum")
            .unwrap()
            .path,
        problem
    );
    assert_eq!(testcase::resolve_problem_directory_path(&problem), problem);
}

#[test]
fn test_flat_root_samples_do_not_hide_same_name_interactive_problem() {
    let temp = TempDir::new("flat_samples_interactive_problem_test");
    let root = temp.0.join("SUM");
    let problem = root.join("SUM");
    fs::create_dir_all(&problem).unwrap();
    File::create(problem.join("1.in")).unwrap();
    File::create(root.join("sample.inp")).unwrap();
    File::create(root.join("sample.out")).unwrap();

    assert!(!testcase::is_flat_test_directory(&root));
    assert_eq!(
        create_problem_directory_resolver(&root)("sum")
            .unwrap()
            .path,
        problem
    );
    assert_eq!(testcase::resolve_problem_directory_path(&problem), problem);
}

#[test]
fn test_flat_root_samples_do_not_hide_differently_named_nested_problem() {
    let temp = TempDir::new("flat_samples_other_nested_problem_test");
    let root = temp.0.join("contest");
    let test_dir = root.join("SUM").join("Test01");
    fs::create_dir_all(&test_dir).unwrap();
    File::create(test_dir.join("data.inp")).unwrap();
    File::create(test_dir.join("data.out")).unwrap();
    File::create(root.join("sample.inp")).unwrap();
    File::create(root.join("sample.out")).unwrap();

    assert!(!testcase::is_flat_test_directory(&root));
    assert_eq!(create_problem_directory_resolver(&root)("contest"), None);
}

#[test]
fn test_flat_root_accepts_nested_input_only_generator_examples_without_config() {
    let temp = TempDir::new("flat_nested_input_only_generator_test");
    let root = temp.0.join("SUM");
    fs::create_dir_all(root.join("generator").join("examples")).unwrap();
    File::create(root.join("generator").join("examples").join("example.in")).unwrap();
    File::create(root.join("test1.inp")).unwrap();
    File::create(root.join("test1.out")).unwrap();

    assert!(testcase::is_flat_test_directory(&root));
    assert_eq!(
        create_problem_directory_resolver(&root)("sum")
            .unwrap()
            .path,
        root
    );
}

#[test]
fn test_nested_child_mode_prefers_config_cfg_over_config_json() {
    let temp = TempDir::new("flat_nested_child_config_precedence_test");
    let root = temp.0.join("SUM");
    let generator = root.join("generator");
    fs::create_dir_all(generator.join("examples")).unwrap();
    File::create(generator.join("examples").join("example.in")).unwrap();
    File::create(root.join("test1.inp")).unwrap();
    File::create(root.join("test1.out")).unwrap();
    fs::write(generator.join("Config.cfg"), r#"{"isInteractive":false}"#).unwrap();
    fs::write(generator.join("config.json"), r#"{"isInteractive":true}"#).unwrap();

    assert!(testcase::is_flat_test_directory(&root));
    fs::write(generator.join("Config.cfg"), "invalid config").unwrap();
    assert!(testcase::is_flat_test_directory(&root));
}

#[test]
fn test_flat_root_samples_do_not_hide_configured_nested_interactive_problem() {
    let temp = TempDir::new("flat_nested_configured_interactive_problem_test");
    let root = temp.0.join("contest");
    let problem = root.join("SUM");
    fs::create_dir_all(problem.join("Test01")).unwrap();
    File::create(problem.join("Test01").join("data.in")).unwrap();
    fs::write(problem.join("config.json"), r#"{"isInteractive":true}"#).unwrap();
    File::create(root.join("sample.inp")).unwrap();
    File::create(root.join("sample.out")).unwrap();

    assert!(!testcase::is_flat_test_directory(&root));
    assert_eq!(create_problem_directory_resolver(&root)("contest"), None);
    assert_eq!(
        create_problem_directory_resolver(&root)("sum")
            .unwrap()
            .path,
        problem
    );
}

#[cfg(unix)]
#[test]
fn test_synthetic_problem_path_preserves_dangling_same_name_symlink() {
    let temp = TempDir::new("flat_root_same_name_symlink_test");
    let root = temp.0.join("SUM");
    fs::create_dir_all(&root).unwrap();
    File::create(root.join("test1.inp")).unwrap();
    File::create(root.join("test1.out")).unwrap();
    let link = root.join("SUM");
    std::os::unix::fs::symlink(root.join("missing"), &link).unwrap();

    assert_eq!(testcase::resolve_problem_directory_path(&link), link);
}

#[test]
fn test_ensure_or_reconcile_stored_problem_config_creates_default_and_reconciles_test_changes() {
    let temp = TempDir::new("ensure_or_reconcile_config_test");
    let prob_dir = temp.0.join("MEXARRAY");
    fs::create_dir_all(prob_dir.join("Test01")).unwrap();
    fs::create_dir_all(prob_dir.join("Test02")).unwrap();
    fs::write(prob_dir.join("Test01").join("MEXARRAY.inp"), "1\n").unwrap();
    fs::write(prob_dir.join("Test01").join("MEXARRAY.out"), "1\n").unwrap();
    fs::write(prob_dir.join("Test02").join("MEXARRAY.inp"), "2\n").unwrap();
    fs::write(prob_dir.join("Test02").join("MEXARRAY.out"), "2\n").unwrap();
    fs::write(prob_dir.join("CheckMEXARRAY.exe"), "stub").unwrap();
    fs::write(prob_dir.join("lcmp.cpp"), "int main(){}").unwrap();

    // 1. First import (no Config.cfg yet) creates Config.cfg with highest-priority checker
    let created =
        testcase::ensure_or_reconcile_stored_problem_config(&prob_dir, "MEXARRAY", "win32")
            .expect("should create default Config.cfg");
    assert!(prob_dir.join("Config.cfg").is_file());
    assert_eq!(
        created.get("checkerType").and_then(|v| v.as_str()),
        Some("CheckMEXARRAY.exe")
    );
    assert_eq!(
        created.get("inputFile").and_then(|v| v.as_str()),
        Some("MEXARRAY.inp")
    );
    assert_eq!(
        created.get("outputFile").and_then(|v| v.as_str()),
        Some("MEXARRAY.out")
    );
    assert!(created.get("totalScore").is_some_and(|v| v.is_null()));
    assert_eq!(
        created.get("defaultScore").and_then(|v| v.as_i64()),
        Some(1)
    );
    assert!(
        testcase::try_normalize_problem_config("MEXARRAY", None, Some(&created)).is_ok(),
        "default Config.cfg must normalize cleanly"
    );

    // 2. Suppose Config.cfg had legacy saved 2 tests with 1pt each and totalScore="2",
    //    and later Test03 is added on disk -> reconciles to 3 tests of 1pt each and totalScore=null.
    fs::write(
        prob_dir.join("Config.cfg"),
        serde_json::json!({
            "checkerType": "C1",
            "defaultScore": 1,
            "totalScore": "2",
            "enableGroups": false,
            "tests": {
                "Test01": { "points": 1 },
                "Test02": { "points": 1 }
            },
            "testScores": {
                "Test01": 1,
                "Test02": 1
            },
            "groups": {}
        })
        .to_string(),
    )
    .unwrap();

    fs::create_dir_all(prob_dir.join("Test03")).unwrap();
    fs::write(prob_dir.join("Test03").join("MEXARRAY.inp"), "3\n").unwrap();
    fs::write(prob_dir.join("Test03").join("MEXARRAY.out"), "3\n").unwrap();

    let reconciled_default =
        testcase::ensure_or_reconcile_stored_problem_config(&prob_dir, "MEXARRAY", "win32")
            .expect("should reconcile Config.cfg");
    assert_eq!(
        reconciled_default
            .get("checkerType")
            .and_then(|v| v.as_str()),
        Some("C1"),
        "explicit checkerType C1 in Config.cfg must be preserved"
    );
    assert!(
        reconciled_default
            .get("totalScore")
            .is_some_and(|v| v.is_null()),
        "legacy 1pt-per-test sum totalScore must reset to null when test count changes"
    );
    let tests_obj = reconciled_default
        .get("tests")
        .and_then(|v| v.as_object())
        .unwrap();
    assert_eq!(tests_obj.len(), 3);
    assert_eq!(
        tests_obj
            .get("Test03")
            .and_then(|v| v.get("points"))
            .and_then(|v| v.as_i64()),
        Some(1)
    );

    // 3. Suppose Config.cfg had a fixed custom totalScore="90" across 2 tests (45 pts each),
    //    and now there are 3 tests -> redistributes 90 across 3 tests (30 pts each).
    fs::write(
        prob_dir.join("Config.cfg"),
        serde_json::json!({
            "checkerType": "C1",
            "defaultScore": 1,
            "totalScore": "90",
            "enableGroups": false,
            "tests": {
                "Test01": { "points": 45 },
                "Test02": { "points": 45 },
                "StaleTest": { "points": 45 }
            },
            "testScores": {
                "Test01": 45,
                "Test02": 45,
                "StaleTest": 45
            },
            "groups": {}
        })
        .to_string(),
    )
    .unwrap();
    // Wait: if there were 2 tests of 45 each (Test01, Test02), and now Test03 exists:
    fs::write(
        prob_dir.join("Config.cfg"),
        serde_json::json!({
            "checkerType": "C1",
            "defaultScore": 1,
            "totalScore": "90",
            "enableGroups": false,
            "tests": {
                "Test01": { "points": 45 },
                "Test02": { "points": 45 }
            },
            "testScores": {
                "Test01": 45,
                "Test02": 45
            },
            "groups": {}
        })
        .to_string(),
    )
    .unwrap();

    let reconciled_fixed =
        testcase::ensure_or_reconcile_stored_problem_config(&prob_dir, "MEXARRAY", "win32")
            .expect("should reconcile fixed totalScore Config.cfg");
    assert_eq!(
        reconciled_fixed.get("totalScore").and_then(|v| v.as_str()),
        Some("90")
    );
    let fixed_tests = reconciled_fixed
        .get("tests")
        .and_then(|v| v.as_object())
        .unwrap();
    assert_eq!(fixed_tests.len(), 3);
    for name in ["Test01", "Test02", "Test03"] {
        assert_eq!(
            fixed_tests
                .get(name)
                .and_then(|v| v.get("points"))
                .and_then(|v| v.as_i64()),
            Some(30)
        );
    }
}

#[test]
fn test_rational_comma_decimals_and_lowercase_config_and_macos_metadata() {
    use judgedesk_core::rational::{parse_rational, Rational};
    assert_eq!(parse_rational("2,5"), Rational::new(5, 2));
    assert_eq!(parse_rational(" 2,5 "), Rational::new(5, 2));
    assert_eq!(parse_rational("2,5/5"), Rational::new(1, 2));
    assert_eq!(parse_rational(",5"), Rational::new(1, 2));
    assert_eq!(parse_rational("-,5"), Rational::new(-1, 2));

    let temp = TempDir::new("comma_and_metadata_discovery_test");
    let tests_root = temp.0.join("Tests");
    let contestants_root = temp.0.join("Contestants");
    fs::create_dir_all(tests_root.join("__MACOSX")).unwrap();
    fs::create_dir_all(contestants_root.join("__MACOSX")).unwrap();

    let prob_dir = tests_root.join("CAU1");
    let test01 = prob_dir.join("Test01");
    fs::create_dir_all(&test01).unwrap();
    fs::write(test01.join("._CAU1.INP"), b"\x00\x05\x16\x07macos-fork").unwrap();
    fs::write(test01.join("._CAU1.OUT"), b"\x00\x05\x16\x07macos-fork").unwrap();
    fs::write(test01.join("CAU1.INP"), "10\n").unwrap();
    fs::write(test01.join("CAU1.OUT"), "20\n").unwrap();
    fs::write(prob_dir.join("._checker.cpp"), "macos-fork").unwrap();
    fs::write(prob_dir.join("checker.cpp"), "int main(){}").unwrap();
    fs::write(
        prob_dir.join("config.cfg"),
        serde_json::json!({ "totalScore": "2,5", "memoryLimit": 512 }).to_string(),
    )
    .unwrap();

    let alice_dir = contestants_root.join("Alice");
    fs::create_dir_all(&alice_dir).unwrap();
    fs::write(alice_dir.join("._CAU1.cpp"), "macos-fork").unwrap();
    fs::write(alice_dir.join("CAU1.cpp"), "int main(){}").unwrap();

    assert_eq!(
        judgedesk_core::discovery::submission::list_contestants(&contestants_root, None),
        vec!["Alice".to_string()]
    );
    let sub = judgedesk_core::discovery::submission::find_submission(&alice_dir, "cau1")
        .expect("resolve submission")
        .expect("submission found");
    assert_eq!(sub.file_name, "CAU1.cpp");

    assert_eq!(
        testcase::discover_custom_checkers(&prob_dir, "linux"),
        vec!["checker.cpp".to_string()]
    );
    let resolved_tc = testcase::resolve_test_case_files(&prob_dir, "Test01", false)
        .expect("Test01 should resolve");
    assert_eq!(resolved_tc.input_file_name, "CAU1.INP");
    assert_eq!(resolved_tc.output_path, test01.join("CAU1.OUT"));

    let stored = testcase::read_stored_problem_config(&prob_dir).expect("read config.cfg");
    let norm = testcase::normalize_problem_config("CAU1", None, Some(&stored));
    assert_eq!(norm.memory_limit_mb, 512);
    assert_eq!(
        norm.scoring_config
            .total_score
            .as_ref()
            .map(judgedesk_core::rational::parse_rational_value),
        Some(Rational::new(5, 2))
    );

    let invalid_score_cfg = serde_json::json!({ "totalScore": "invalid_text" });
    let norm_invalid = testcase::normalize_problem_config("CAU1", None, Some(&invalid_score_cfg));
    assert!(
        norm_invalid.scoring_config.total_score.is_none(),
        "invalid non-zero string totalScore must normalize to None instead of 0"
    );
}
