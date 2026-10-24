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

pub const MIN_PROBLEM_MEMORY_LIMIT_MB: u64 = 8;
pub const MAX_PROBLEM_MEMORY_LIMIT_MB: u64 = 1024;
pub const DEFAULT_PROBLEM_MEMORY_LIMIT_MB: u64 = 256;
pub const DEFAULT_PROBLEM_TIME_LIMIT_MS: u64 = 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedProblemConfig {
    pub test_well_formed: bool,
    pub use_std_io: bool,
    pub use_std_in: bool,
    pub use_std_out: bool,
    pub input_file: String,
    pub output_file: String,
    pub time_limit_ms: u64,
    pub memory_limit_mb: u64,
    pub checker_type: String,
    pub is_interactive: bool,
    pub interactor: String,
    #[serde(default)]
    pub compile: super::compile_config::ProblemCompileConfig,
    pub scoring_config: crate::scoring::ProblemScoringConfig,
    #[serde(default)]
    pub test_time_limits_ms: HashMap<String, u64>,
}

impl NormalizedProblemConfig {
    pub fn input_file_for_execution(&self) -> &str {
        if self.use_std_in {
            ""
        } else {
            &self.input_file
        }
    }

    pub fn output_file_for_execution(&self) -> &str {
        if self.use_std_out {
            ""
        } else {
            &self.output_file
        }
    }

    pub fn test_time_limit_ms(&self, test_name: &str) -> u64 {
        self.test_time_limits_ms
            .get(test_name)
            .copied()
            .unwrap_or(self.time_limit_ms)
    }
}

pub fn normalize_problem_memory_limit(value: Option<&serde_json::Value>, fallback: u64) -> u64 {
    let Some(val) = value else {
        return fallback;
    };
    let parsed_f64 = match val {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    let Some(num) = parsed_f64 else {
        return fallback;
    };
    if !num.is_finite() || num <= 0.0 {
        return fallback;
    }
    let rounded = num.round() as u64;
    rounded.clamp(MIN_PROBLEM_MEMORY_LIMIT_MB, MAX_PROBLEM_MEMORY_LIMIT_MB)
}

fn normalize_problem_time_limit_ms(value: Option<&serde_json::Value>, fallback_ms: u64) -> u64 {
    let Some(val) = value else {
        return fallback_ms;
    };
    let parsed_f64 = match val {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    let Some(num) = parsed_f64 else {
        return fallback_ms;
    };
    if !num.is_finite() || num <= 0.0 {
        return fallback_ms;
    }
    let ms = if num <= 60.0 {
        (num * 1000.0).round() as u64
    } else {
        num.round() as u64
    };
    ms.clamp(1, 300_000)
}

fn extract_polygon_config(val: &serde_json::Value) -> Option<crate::scoring::PolygonScoringConfig> {
    if let Some(poly_val) = val.get("polygonConfig") {
        if let Ok(parsed) =
            serde_json::from_value::<crate::scoring::PolygonScoringConfig>(poly_val.clone())
        {
            return Some(parsed);
        }
    }
    if val.get("enableGroups").is_some()
        || val.get("tests").is_some()
        || val.get("groups").is_some()
    {
        if let Ok(parsed) =
            serde_json::from_value::<crate::scoring::PolygonScoringConfig>(val.clone())
        {
            return Some(parsed);
        }
    }
    None
}

pub fn normalize_problem_config(
    problem_name: &str,
    request_config: Option<&serde_json::Value>,
    stored_config: Option<&serde_json::Value>,
) -> NormalizedProblemConfig {
    let get_field = |keys: &[&str]| -> Option<&serde_json::Value> {
        for &k in keys {
            if let Some(v) = stored_config.and_then(|s| s.get(k)) {
                if !v.is_null() {
                    return Some(v);
                }
            }
        }
        for &k in keys {
            if let Some(v) = request_config.and_then(|r| r.get(k)) {
                if !v.is_null() {
                    return Some(v);
                }
            }
        }
        None
    };

    let get_non_empty_str = |keys: &[&str]| -> Option<String> {
        for &k in keys {
            if let Some(s) = stored_config
                .and_then(|v| v.get(k))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                return Some(s.to_string());
            }
        }
        for &k in keys {
            if let Some(s) = request_config
                .and_then(|v| v.get(k))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                return Some(s.to_string());
            }
        }
        None
    };

    let is_interactive = get_field(&["isInteractive", "is_interactive"])
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let interactor =
        get_non_empty_str(&["interactor"]).unwrap_or_else(|| "interactor.cpp".to_string());

    let test_well_formed = get_field(&["testWellFormed", "test_well_formed"])
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let stored_std_io = stored_config
        .and_then(|s| s.get("useStdIO"))
        .and_then(|v| v.as_bool());
    let req_std_io = request_config
        .and_then(|r| r.get("useStdIO"))
        .and_then(|v| v.as_bool());

    let use_std_io = if is_interactive {
        true
    } else {
        stored_std_io.or(req_std_io).unwrap_or(false)
    };

    let use_std_in = if is_interactive {
        true
    } else {
        stored_config
            .and_then(|s| s.get("useStdIn"))
            .and_then(|v| v.as_bool())
            .or(stored_std_io)
            .or_else(|| {
                request_config
                    .and_then(|r| r.get("useStdIn"))
                    .and_then(|v| v.as_bool())
            })
            .or(req_std_io)
            .unwrap_or(false)
    };

    let use_std_out = if is_interactive {
        true
    } else {
        stored_config
            .and_then(|s| s.get("useStdOut"))
            .and_then(|v| v.as_bool())
            .or(stored_std_io)
            .or_else(|| {
                request_config
                    .and_then(|r| r.get("useStdOut"))
                    .and_then(|v| v.as_bool())
            })
            .or(req_std_io)
            .unwrap_or(false)
    };

    let input_file = get_non_empty_str(&["inputFile", "input_file"])
        .unwrap_or_else(|| format!("{problem_name}.inp"));
    let output_file = get_non_empty_str(&["outputFile", "output_file"])
        .unwrap_or_else(|| format!("{problem_name}.out"));

    let memory_limit_mb = normalize_problem_memory_limit(
        get_field(&["memoryLimit", "memory_limit"]),
        DEFAULT_PROBLEM_MEMORY_LIMIT_MB,
    );

    let time_limit_ms = normalize_problem_time_limit_ms(
        get_field(&["timeLimit", "time_limit"]),
        DEFAULT_PROBLEM_TIME_LIMIT_MS,
    );

    let checker_type = get_non_empty_str(&["checkerType", "checker_type", "checker"])
        .unwrap_or_else(|| "C1".to_string());

    let polygon_config = stored_config
        .and_then(extract_polygon_config)
        .or_else(|| request_config.and_then(extract_polygon_config));

    let total_score = get_field(&["totalScore", "total_score"]).cloned();
    let default_score = get_field(&["defaultScore", "default_score"])
        .cloned()
        .or_else(|| Some(serde_json::json!(1)));

    let mut merged_test_scores = HashMap::new();
    for src in [request_config, stored_config].into_iter().flatten() {
        if let Some(obj) = src
            .get("testScores")
            .or_else(|| src.get("test_scores"))
            .and_then(|v| v.as_object())
        {
            for (k, v) in obj {
                if !v.is_null() && v.as_str() != Some("") {
                    merged_test_scores.insert(k.clone(), v.clone());
                }
            }
        }
    }

    let mut test_time_limits_ms = HashMap::new();
    for src in [request_config, stored_config].into_iter().flatten() {
        let poly_root = src.get("polygonConfig").unwrap_or(src);
        if let Some(tests_obj) = poly_root.get("tests").and_then(|v| v.as_object()) {
            for (k, tc_val) in tests_obj {
                let raw_tl = tc_val.get("timeLimit").or_else(|| tc_val.get("time_limit"));
                if let Some(tl_val) = raw_tl {
                    let parsed_ms = normalize_problem_time_limit_ms(Some(tl_val), 0);
                    if parsed_ms > 0 {
                        test_time_limits_ms.insert(k.clone(), parsed_ms);
                    }
                }
            }
        }
    }

    let scoring_config = crate::scoring::ProblemScoringConfig {
        polygon_config,
        total_score,
        default_score,
        test_scores: if merged_test_scores.is_empty() {
            None
        } else {
            Some(merged_test_scores)
        },
    };

    let compile_val = get_field(&["compile"]);
    let compile = super::compile_config::normalize_compile_config(compile_val).unwrap_or_default();

    NormalizedProblemConfig {
        test_well_formed,
        use_std_io,
        use_std_in,
        use_std_out,
        input_file,
        output_file,
        time_limit_ms,
        memory_limit_mb,
        checker_type,
        is_interactive,
        interactor,
        compile,
        scoring_config,
        test_time_limits_ms,
    }
}

pub fn try_normalize_problem_config(
    problem_name: &str,
    request_config: Option<&serde_json::Value>,
    stored_config: Option<&serde_json::Value>,
) -> Result<NormalizedProblemConfig, String> {
    let compile_val = stored_config
        .and_then(|s| s.get("compile"))
        .filter(|v| !v.is_null())
        .or_else(|| {
            request_config
                .and_then(|r| r.get("compile"))
                .filter(|v| !v.is_null())
        });
    let compile = super::compile_config::normalize_compile_config(compile_val)?;
    let mut cfg = normalize_problem_config(problem_name, request_config, stored_config);
    cfg.compile = compile;
    Ok(cfg)
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

fn to_canonical_point_json(r: &crate::rational::Rational) -> serde_json::Value {
    if r.is_integer() {
        if let Ok(n) = r.n.to_string().parse::<i64>() {
            return serde_json::json!(n);
        }
    }
    let formatted = crate::rational::format_rational(r.clone(), 4);
    if !formatted.contains('/') {
        if let Ok(f) = formatted.parse::<f64>() {
            if f.is_finite() && f.to_string() == formatted {
                return serde_json::json!(f);
            }
        }
    }
    serde_json::Value::String(formatted)
}

pub fn create_default_stored_problem_config(
    problem_name: &str,
    problem_directory: &Path,
    platform: &str,
) -> serde_json::Value {
    let custom_checkers = discover_custom_checkers(problem_directory, platform);
    let interactors = discover_interactors(problem_directory, platform);
    let checker_type = custom_checkers
        .first()
        .cloned()
        .unwrap_or_else(|| "C1".to_string());
    let interactor = interactors
        .first()
        .cloned()
        .unwrap_or_else(|| "interactor.cpp".to_string());
    let compile = super::compile_config::ProblemCompileConfig::default();
    serde_json::json!({
        "testWellFormed": false,
        "useStdIO": false,
        "useStdIn": false,
        "useStdOut": false,
        "inputFile": format!("{problem_name}.inp"),
        "outputFile": format!("{problem_name}.out"),
        "totalScore": serde_json::Value::Null,
        "defaultScore": 1,
        "testScores": {},
        "memoryLimit": DEFAULT_PROBLEM_MEMORY_LIMIT_MB,
        "checkerType": checker_type,
        "compile": compile,
        "enableGroups": false,
        "tests": {},
        "groups": {},
        "isInteractive": false,
        "interactor": interactor,
    })
}

pub fn reconcile_stored_problem_config_value(
    mut stored: serde_json::Value,
    discovered_tests: &[String],
) -> (serde_json::Value, bool) {
    if discovered_tests.is_empty() || !stored.is_object() {
        return (stored, false);
    }
    let has_tests = stored
        .get("tests")
        .and_then(|v| v.as_object())
        .is_some_and(|m| !m.is_empty());
    let has_test_scores = stored
        .get("testScores")
        .and_then(|v| v.as_object())
        .is_some_and(|m| !m.is_empty());
    if !has_tests && !has_test_scores {
        return (stored, false);
    }

    let tests_match = stored
        .get("tests")
        .and_then(|v| v.as_object())
        .filter(|m| !m.is_empty())
        .is_none_or(|m| {
            m.len() == discovered_tests.len()
                && discovered_tests.iter().all(|name| m.contains_key(name))
        });
    let scores_match = stored
        .get("testScores")
        .and_then(|v| v.as_object())
        .filter(|m| !m.is_empty())
        .is_none_or(|m| {
            m.len() == discovered_tests.len()
                && discovered_tests.iter().all(|name| m.contains_key(name))
        });
    if tests_match && scores_match {
        return (stored, false);
    }

    let enable_groups = stored
        .get("enableGroups")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if enable_groups {
        return (stored, false);
    }
    let default_score_rat = crate::scoring::default_or_one(stored.get("defaultScore"));
    let old_tests_map = stored
        .get("tests")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let old_scores_map = stored
        .get("testScores")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let old_points: Vec<crate::rational::Rational> = if !old_tests_map.is_empty() {
        old_tests_map
            .iter()
            .map(|(k, v)| {
                v.get("points")
                    .or_else(|| old_scores_map.get(k))
                    .filter(|val| !val.is_null() && val.as_str() != Some(""))
                    .map(crate::rational::parse_rational_value)
                    .unwrap_or_else(|| default_score_rat.clone())
            })
            .collect()
    } else {
        old_scores_map
            .values()
            .map(|val| {
                if !val.is_null() && val.as_str() != Some("") {
                    crate::rational::parse_rational_value(val)
                } else {
                    default_score_rat.clone()
                }
            })
            .collect()
    };

    let old_count = old_points.len();
    let all_old_equal = !old_points.is_empty() && old_points.iter().all(|p| *p == old_points[0]);
    let uniform_old_point = if all_old_equal {
        Some(old_points[0].clone())
    } else {
        None
    };

    let total_rat = stored
        .get("totalScore")
        .filter(|v| {
            !v.is_null() && !matches!(v, serde_json::Value::String(s) if s.trim().is_empty())
        })
        .map(crate::rational::parse_rational_value);
    let old_default_sum = crate::rational::multiply_rational(
        default_score_rat.clone(),
        crate::rational::Rational::new(old_count as i64, 1),
    );
    let was_default_sum_total = !enable_groups
        && old_count > 0
        && all_old_equal
        && uniform_old_point.as_ref() == Some(&default_score_rat)
        && total_rat.as_ref() == Some(&old_default_sum);

    let fallback_pt = uniform_old_point.unwrap_or_else(|| default_score_rat.clone());
    let initial_points: Vec<crate::rational::Rational> = discovered_tests
        .iter()
        .map(|name| {
            old_tests_map
                .get(name)
                .and_then(|v| v.get("points"))
                .or_else(|| old_scores_map.get(name))
                .filter(|val| !val.is_null() && val.as_str() != Some(""))
                .map(crate::rational::parse_rational_value)
                .unwrap_or_else(|| fallback_pt.clone())
        })
        .collect();

    let final_points: Vec<crate::rational::Rational> = if was_default_sum_total {
        vec![default_score_rat; discovered_tests.len()]
    } else if !enable_groups {
        if let Some(ref t_rat) = total_rat {
            if !t_rat.is_zero() && !t_rat.n.is_negative() {
                let all_init_equal = initial_points
                    .first()
                    .is_some_and(|first| initial_points.iter().all(|p| p == first));
                let sum_init = initial_points
                    .iter()
                    .fold(crate::rational::Rational::ZERO, |acc, p| {
                        crate::rational::add_rational(acc, p.clone())
                    });
                let count_rat = crate::rational::Rational::new(discovered_tests.len() as i64, 1);
                initial_points
                    .iter()
                    .map(|p| {
                        if all_init_equal || sum_init.is_zero() {
                            crate::rational::divide_rational(t_rat.clone(), count_rat.clone())
                        } else {
                            let ratio =
                                crate::rational::divide_rational(p.clone(), sum_init.clone());
                            crate::rational::multiply_rational(t_rat.clone(), ratio)
                        }
                    })
                    .collect()
            } else {
                initial_points
            }
        } else {
            initial_points
        }
    } else {
        initial_points
    };

    if let Some(obj) = stored.as_object_mut() {
        if was_default_sum_total {
            obj.insert("totalScore".to_string(), serde_json::Value::Null);
        }
        if has_tests {
            let mut new_tests = serde_json::Map::new();
            for (name, pt) in discovered_tests.iter().zip(final_points.iter()) {
                let mut entry = old_tests_map
                    .get(name)
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                entry.insert("points".to_string(), to_canonical_point_json(pt));
                new_tests.insert(name.clone(), serde_json::Value::Object(entry));
            }
            obj.insert("tests".to_string(), serde_json::Value::Object(new_tests));
        }
        if has_test_scores {
            let mut new_scores = serde_json::Map::new();
            for (name, pt) in discovered_tests.iter().zip(final_points.iter()) {
                new_scores.insert(name.clone(), to_canonical_point_json(pt));
            }
            obj.insert(
                "testScores".to_string(),
                serde_json::Value::Object(new_scores),
            );
        }
    }

    (stored, true)
}

fn write_stored_problem_config_file(
    problem_directory: &Path,
    file_name: &str,
    config: &serde_json::Value,
) -> bool {
    use std::io::Write;
    let Ok(config_path) =
        crate::storage::ensure_safe_contained_path(problem_directory, Path::new(file_name))
    else {
        return false;
    };
    let tmp_name = format!("{file_name}.{}.tmp", uuid::Uuid::new_v4());
    let Ok(tmp_path) =
        crate::storage::ensure_safe_contained_path(problem_directory, Path::new(&tmp_name))
    else {
        return false;
    };
    let res = (|| -> Result<(), Box<dyn std::error::Error>> {
        let content = serde_json::to_vec_pretty(config)?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)?;
        file.write_all(&content)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp_path, &config_path)?;
        Ok(())
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp_path);
        return false;
    }
    true
}

pub fn reconcile_existing_stored_problem_config(
    problem_directory: &Path,
) -> Option<serde_json::Value> {
    let cfg_path = problem_directory.join("Config.cfg");
    let json_path = problem_directory.join("config.json");
    let target_name = if cfg_path.is_file() {
        "Config.cfg"
    } else if json_path.is_file() {
        "config.json"
    } else {
        return None;
    };
    let stored = read_stored_problem_config(problem_directory)?;
    let is_interactive = stored
        .get("isInteractive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let discovered_tests = list_test_directories(problem_directory, is_interactive);
    let (reconciled, changed) = reconcile_stored_problem_config_value(stored, &discovered_tests);
    if changed {
        let _ = write_stored_problem_config_file(problem_directory, target_name, &reconciled);
    }
    Some(reconciled)
}

pub fn ensure_or_reconcile_stored_problem_config(
    problem_directory: &Path,
    problem_name: &str,
    platform: &str,
) -> Option<serde_json::Value> {
    if !problem_directory.is_dir() {
        return None;
    }
    if let Some(reconciled) = reconcile_existing_stored_problem_config(problem_directory) {
        return Some(reconciled);
    }
    let default_cfg =
        create_default_stored_problem_config(problem_name, problem_directory, platform);
    let _ = write_stored_problem_config_file(problem_directory, "Config.cfg", &default_cfg);
    Some(default_cfg)
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
