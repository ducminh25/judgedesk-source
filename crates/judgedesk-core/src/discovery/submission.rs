use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Submission {
    #[serde(rename = "fileName")]
    pub file_name: String,
    #[serde(rename = "filePath")]
    pub file_path: PathBuf,
    #[serde(rename = "problemName")]
    pub problem_name: String,
    pub language: String,
}

pub fn map_extension_to_language(ext: &str) -> Option<&'static str> {
    let lower = ext.to_lowercase();
    match lower.as_str() {
        ".cpp" => Some("cpp"),
        ".c" => Some("c"),
        ".py" => Some("python"),
        ".pas" | ".pp" => Some("pascal"),
        ".java" => Some("java"),
        ".sb3" | ".sb2" | ".sb" => Some("scratch"),
        _ => None,
    }
}

pub fn list_contestants<P: AsRef<Path>>(
    contestants_dir: P,
    targets: Option<&[String]>,
) -> Vec<String> {
    let Ok(entries) = fs::read_dir(contestants_dir.as_ref()) else {
        return Vec::new();
    };

    let mut available_set = HashSet::new();
    let mut discovered = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false) {
            let name = entry.file_name().to_string_lossy().to_string();
            available_set.insert(name.clone());
            discovered.push(name);
        }
    }

    if let Some(target_list) = targets {
        let mut seen = HashSet::new();
        let mut result = Vec::new();
        for target in target_list {
            if available_set.contains(target) && seen.insert(target.clone()) {
                result.push(target.clone());
            }
        }
        result
    } else {
        discovered
    }
}

pub type SubmissionResolver = Box<dyn Fn(&str) -> Result<Option<Submission>, String>>;

pub fn create_submission_resolver<P: AsRef<Path>>(contestant_dir: P) -> SubmissionResolver {
    let mut candidates_by_problem: HashMap<String, Vec<Submission>> = HashMap::new();

    if let Ok(entries) = fs::read_dir(contestant_dir.as_ref()) {
        for entry in entries.flatten() {
            let path = entry.path();
            let is_file = fs::metadata(&path).map(|m| m.is_file()).unwrap_or(false);
            if !is_file {
                continue;
            }

            let file_name = entry.file_name().to_string_lossy().to_string();
            let ext = Path::new(&file_name)
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();

            let Some(language) = map_extension_to_language(&ext) else {
                continue;
            };

            let base_name = file_name
                .strip_suffix(&ext)
                .unwrap_or(&file_name)
                .to_string();
            let normalized_problem = base_name.to_lowercase();

            candidates_by_problem
                .entry(normalized_problem)
                .or_default()
                .push(Submission {
                    file_name,
                    file_path: path,
                    problem_name: base_name,
                    language: language.to_string(),
                });
        }
    }

    Box::new(move |target_problem: &str| {
        let normalized = target_problem.to_lowercase();
        let Some(candidates) = candidates_by_problem.get(&normalized) else {
            return Ok(None);
        };

        if candidates.is_empty() {
            return Ok(None);
        }

        if candidates.len() > 1 {
            let mut file_names: Vec<String> =
                candidates.iter().map(|c| c.file_name.clone()).collect();
            file_names.sort();
            return Err(format!(
                "AMBIGUOUS_SUBMISSION: '{target_problem}' has multiple supported source files: {}",
                file_names.join(", ")
            ));
        }

        Ok(Some(candidates[0].clone()))
    })
}

pub fn find_submission<P: AsRef<Path>>(
    contestant_dir: P,
    target_problem: &str,
) -> Result<Option<Submission>, String> {
    create_submission_resolver(contestant_dir)(target_problem)
}
