use super::natural_sort::natural_cmp;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub type ProblemDirectoryResolver = dyn Fn(&str) -> Option<ProblemDirectory>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProblemDirectory {
    pub name: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TestCaseFiles {
    pub name: String,
    pub directory: PathBuf,
    #[serde(rename = "inputPath")]
    pub input_path: PathBuf,
    #[serde(rename = "outputPath")]
    pub output_path: PathBuf,
    #[serde(rename = "inputFileName")]
    pub input_file_name: String,
}

pub fn create_problem_directory_resolver<P: AsRef<Path>>(
    tests_directory: P,
) -> Box<ProblemDirectoryResolver> {
    let mut entries_list = Vec::new();
    if let Ok(entries) = fs::read_dir(tests_directory.as_ref()) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            entries_list.push((name, path));
        }
    }

    Box::new(move |problem_name: &str| {
        let lower = problem_name.to_lowercase();
        entries_list
            .iter()
            .find(|(name, _)| name.to_lowercase() == lower)
            .map(|(name, path)| ProblemDirectory {
                name: name.clone(),
                path: path.clone(),
            })
    })
}

pub fn resolve_test_case_files<P: AsRef<Path>>(
    problem_directory: P,
    test_name: &str,
    is_interactive: bool,
) -> Option<TestCaseFiles> {
    let directory = problem_directory.as_ref().join(test_name);
    let meta = fs::metadata(&directory).ok()?;
    if !meta.is_dir() {
        return None;
    }

    let entries = fs::read_dir(&directory).ok()?;
    let mut regular_files = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if fs::metadata(&p).map(|m| m.is_file()).unwrap_or(false) {
            regular_files.push(entry.file_name().to_string_lossy().to_string());
        }
    }

    let input_file_name = regular_files.iter().find(|name| {
        let lower = name.to_lowercase();
        lower.ends_with(".inp") || lower.ends_with(".in")
    })?;

    let output_file_name = regular_files.iter().find(|name| {
        let lower = name.to_lowercase();
        lower.ends_with(".out") || lower.ends_with(".ans")
    });

    if !is_interactive && output_file_name.is_none() {
        return None;
    }

    Some(TestCaseFiles {
        name: test_name.to_string(),
        input_path: directory.join(input_file_name),
        output_path: output_file_name
            .map(|f| directory.join(f))
            .unwrap_or_default(),
        input_file_name: input_file_name.clone(),
        directory,
    })
}

pub fn discover_test_cases<P: AsRef<Path>>(
    problem_directory: P,
    is_interactive: bool,
) -> Vec<TestCaseFiles> {
    let Ok(entries) = fs::read_dir(problem_directory.as_ref()) else {
        return Vec::new();
    };

    let mut result = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if fs::metadata(&p).map(|m| m.is_dir()).unwrap_or(false) {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(tc) =
                resolve_test_case_files(problem_directory.as_ref(), &name, is_interactive)
            {
                result.push(tc);
            }
        }
    }

    result.sort_by(|a, b| natural_cmp(&a.name, &b.name));
    result
}

pub fn list_test_directories<P: AsRef<Path>>(
    problem_directory: P,
    is_interactive: bool,
) -> Vec<String> {
    discover_test_cases(problem_directory, is_interactive)
        .into_iter()
        .map(|tc| tc.name)
        .collect()
}

fn get_extension_priority(file_name: &str) -> usize {
    let lower = file_name.to_lowercase();
    if lower.ends_with(".exe") {
        0
    } else if lower.ends_with(".cpp") {
        1
    } else if lower.ends_with(".py") {
        2
    } else {
        3
    }
}

pub fn discover_custom_checkers<P: AsRef<Path>>(problem_path: P, platform: &str) -> Vec<String> {
    let is_windows = platform == "win32";
    let Ok(entries) = fs::read_dir(problem_path.as_ref()) else {
        return Vec::new();
    };

    let mut files = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if !fs::metadata(&p).map(|m| m.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        let is_candidate = lower.ends_with(".cpp")
            || lower.ends_with(".py")
            || (is_windows && lower.ends_with(".exe"));

        if is_candidate {
            files.push(name);
        }
    }

    files.sort_by(|a, b| {
        let prio_a = get_extension_priority(a);
        let prio_b = get_extension_priority(b);
        if prio_a != prio_b {
            prio_a.cmp(&prio_b)
        } else {
            natural_cmp(a, b)
        }
    });

    files
}

pub fn discover_interactors<P: AsRef<Path>>(problem_path: P, platform: &str) -> Vec<String> {
    let is_windows = platform == "win32";
    let Ok(entries) = fs::read_dir(problem_path.as_ref()) else {
        return Vec::new();
    };

    let mut files = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if !fs::metadata(&p).map(|m| m.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        let is_candidate = lower.starts_with("interactor")
            && (lower.ends_with(".cpp")
                || lower.ends_with(".py")
                || (is_windows && lower.ends_with(".exe")));

        if is_candidate {
            files.push(name);
        }
    }

    files.sort_by(|a, b| {
        let prio_a = get_extension_priority(a);
        let prio_b = get_extension_priority(b);
        if prio_a != prio_b {
            prio_a.cmp(&prio_b)
        } else {
            natural_cmp(a, b)
        }
    });

    files
}
