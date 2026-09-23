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
