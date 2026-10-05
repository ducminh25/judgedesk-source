use super::natural_sort::natural_cmp;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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

fn is_input_ext(ext: &str) -> bool {
    let lower = ext.to_lowercase();
    lower == "inp" || lower == "in"
}

fn is_output_ext(ext: &str) -> bool {
    let lower = ext.to_lowercase();
    lower == "out" || lower == "ans"
}

pub fn create_problem_directory_resolver<P: AsRef<Path>>(
    tests_directory: P,
) -> Box<ProblemDirectoryResolver> {
    let mut entries_list = Vec::new();
    let tests_path = tests_directory.as_ref().to_path_buf();
    if let Ok(entries) = fs::read_dir(&tests_path) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            if path.is_dir() {
                entries_list.push((name, path));
            }
        }
    }
    let can_match_self = is_flat_test_directory(&tests_path);
    let base_name = tests_path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();

    Box::new(move |problem_name: &str| {
        let lower = problem_name.to_lowercase();
        if can_match_self && !base_name.is_empty() && base_name.to_lowercase() == lower {
            return Some(ProblemDirectory {
                name: base_name.clone(),
                path: tests_path.clone(),
            });
        }
        if let Some((name, path)) = entries_list
            .iter()
            .find(|(name, _)| name.to_lowercase() == lower)
        {
            return Some(ProblemDirectory {
                name: name.clone(),
                path: path.clone(),
            });
        }
        None
    })
}

fn resolve_directory_test_case_files<P: AsRef<Path>>(
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
        let p = Path::new(name);
        p.extension()
            .and_then(|e| e.to_str())
            .map(is_input_ext)
            .unwrap_or(false)
    })?;

    let output_file_name = regular_files.iter().find(|name| {
        let p = Path::new(name);
        p.extension()
            .and_then(|e| e.to_str())
            .map(is_output_ext)
            .unwrap_or(false)
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

pub fn resolve_test_case_files<P: AsRef<Path>>(
    problem_directory: P,
    test_name: &str,
    is_interactive: bool,
) -> Option<TestCaseFiles> {
    let target_lower = test_name.to_lowercase();
    discover_test_cases(problem_directory, is_interactive)
        .into_iter()
        .find(|test_case| test_case.name.to_lowercase() == target_lower)
}

fn discover_flat_test_cases<P: AsRef<Path>>(
    problem_directory: P,
    mut regular_files: Vec<String>,
    is_interactive: bool,
) -> Vec<TestCaseFiles> {
    let mut input_map: HashMap<String, String> = HashMap::new();
    let mut output_map: HashMap<String, String> = HashMap::new();

    regular_files.sort();
    for file_name in regular_files {
        let path_obj = Path::new(&file_name);
        let stem = match path_obj.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s,
            None => continue,
        };
        let stem_lower = stem.to_lowercase();
        let ext = match path_obj.extension().and_then(|e| e.to_str()) {
            Some(e) => e,
            None => continue,
        };

        if is_input_ext(ext) {
            let prefer = match input_map.get(&stem_lower) {
                None => true,
                Some(existing) => {
                    let existing_ext = Path::new(existing)
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("");
                    ext.eq_ignore_ascii_case("inp") && !existing_ext.eq_ignore_ascii_case("inp")
                }
            };
            if prefer {
                input_map.insert(stem_lower, file_name);
            }
        } else if is_output_ext(ext) {
            let prefer = match output_map.get(&stem_lower) {
                None => true,
                Some(existing) => {
                    let existing_ext = Path::new(existing)
                        .extension()
                        .and_then(|e| e.to_str())
                        .unwrap_or("");
                    ext.eq_ignore_ascii_case("out") && !existing_ext.eq_ignore_ascii_case("out")
                }
            };
            if prefer {
                output_map.insert(stem_lower, file_name);
            }
        }
    }

    let dir_buf = problem_directory.as_ref().to_path_buf();
    let mut result = Vec::new();
    for (stem_lower, input_name) in input_map {
        let output_name = output_map.get(&stem_lower);
        if !is_interactive && output_name.is_none() {
            continue;
        }

        let test_name = Path::new(&input_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&stem_lower)
            .to_string();

        result.push(TestCaseFiles {
            name: test_name,
            input_path: dir_buf.join(&input_name),
            output_path: output_name.map(|f| dir_buf.join(f)).unwrap_or_default(),
            input_file_name: input_name,
            directory: dir_buf.clone(),
        });
    }

    result
}

pub fn discover_test_cases<P: AsRef<Path>>(
    problem_directory: P,
    is_interactive: bool,
) -> Vec<TestCaseFiles> {
    let Ok(entries) = fs::read_dir(problem_directory.as_ref()) else {
        return Vec::new();
    };

    let mut dir_test_cases = Vec::new();
    let mut regular_files = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if fs::metadata(&p).map(|m| m.is_dir()).unwrap_or(false) {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(tc) =
                resolve_directory_test_case_files(problem_directory.as_ref(), &name, is_interactive)
            {
                dir_test_cases.push(tc);
            }
        } else if entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false)
        {
            regular_files.push(entry.file_name().to_string_lossy().to_string());
        }
    }

    let mut selected = if dir_test_cases.is_empty() {
        discover_flat_test_cases(problem_directory.as_ref(), regular_files, is_interactive)
    } else {
        dir_test_cases
    };

    selected.sort_by(|a, b| natural_cmp(&a.name, &b.name).then_with(|| a.name.cmp(&b.name)));
    selected
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

pub fn read_stored_problem_config(problem_directory: &Path) -> Option<serde_json::Value> {
    let cfg_path = problem_directory.join("Config.cfg");
    let json_path = problem_directory.join("config.json");
    let target = if cfg_path.is_file() {
        cfg_path
    } else if json_path.is_file() {
        json_path
    } else {
        return None;
    };
    fs::read_to_string(target)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
}

/// Detects a selected flat layout without mistaking a problem container's samples for tests.
pub fn is_flat_test_directory<P: AsRef<Path>>(problem_directory: P) -> bool {
    let directory = problem_directory.as_ref();
    let has_flat_tests = [false, true].into_iter().any(|is_interactive| {
        discover_test_cases(directory, is_interactive)
            .iter()
            .any(|test_case| test_case.directory == directory)
    });
    if !has_flat_tests {
        return false;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return false;
    };
    let root_name = directory
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase());
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let child = entry.path();
        let same_name = root_name
            .as_ref()
            .is_some_and(|name| *name == entry.file_name().to_string_lossy().to_lowercase());
        let is_interactive = same_name
            || read_stored_problem_config(&child)
                .and_then(|config| {
                    config
                        .get("isInteractive")
                        .and_then(|value| value.as_bool())
                })
                .unwrap_or(false);
        let child_tests = discover_test_cases(&child, is_interactive);
        if child_tests
            .iter()
            .any(|test_case| test_case.directory != child)
            || (same_name && !child_tests.is_empty())
        {
            return false;
        }
    }
    true
}

/// Maps the UI's repeated root name to a flat problem, including helper folders and binaries.
/// Real nested problems, symlinks, and special filesystem entries remain distinct.
pub fn resolve_problem_directory_path<P: AsRef<Path>>(problem_directory: P) -> PathBuf {
    let directory = problem_directory.as_ref();
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.is_dir() || metadata.is_file() => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => return directory.to_path_buf(),
    }
    let Some(parent) = directory.parent() else {
        return directory.to_path_buf();
    };
    let repeated_name =
        directory
            .file_name()
            .zip(parent.file_name())
            .is_some_and(|(name, parent_name)| {
                name.to_string_lossy().to_lowercase()
                    == parent_name.to_string_lossy().to_lowercase()
            });
    if repeated_name && is_flat_test_directory(parent) {
        parent.to_path_buf()
    } else {
        directory.to_path_buf()
    }
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
