use super::discover_test_cases;
use serde::Serialize;
use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct WellFormedIssue {
    pub code: &'static str,
    pub line: usize,
    pub column: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemWellFormedIssue {
    #[serde(flatten)]
    pub issue: WellFormedIssue,
    pub test_name: String,
    pub file_name: String,
}

#[derive(Debug, Serialize)]
pub struct TestInputValidationResult {
    pub tests: usize,
    pub issues: Vec<ProblemWellFormedIssue>,
}

#[derive(Default)]
struct InputValidator {
    issues: Vec<WellFormedIssue>,
    line: usize,
    column: usize,
    line_length: usize,
    previous_space: bool,
    last_space_column: usize,
    pending_cr: bool,
    has_bytes: bool,
    last_completed_empty_line: usize,
    last_was_eol: bool,
}

impl InputValidator {
    fn report(&mut self, code: &'static str, line: usize, column: usize) {
        if self.issues.len() < 200 {
            self.issues.push(WellFormedIssue { code, line, column });
        }
    }

    fn complete_line(&mut self) {
        if self.last_space_column > 1 {
            self.report("edge_space", self.line, self.last_space_column);
        }
        if self.line_length == 0 {
            if self.line == 1 {
                self.report("edge_empty_line", self.line, 1);
            }
            self.last_completed_empty_line = self.line;
        } else {
            self.last_completed_empty_line = 0;
        }
        self.line += 1;
        self.column = 1;
        self.line_length = 0;
        self.previous_space = false;
        self.last_space_column = 0;
        self.last_was_eol = true;
    }

    fn accept(&mut self, byte: u8) {
        self.has_bytes = true;
        if self.pending_cr {
            self.pending_cr = false;
            if byte == b'\n' {
                self.complete_line();
                return;
            }
            self.report("control_character", self.line, self.column);
            self.line_length += 1;
            self.column += 1;
        }
        if byte == b'\r' {
            self.pending_cr = true;
            self.last_was_eol = false;
            return;
        }
        if byte == b'\n' {
            self.complete_line();
            return;
        }
        if byte < 32 {
            self.report("control_character", self.line, self.column);
        }
        if byte == b' ' {
            if self.line_length == 0 {
                self.report("edge_space", self.line, self.column);
            }
            if self.previous_space {
                self.report("consecutive_spaces", self.line, self.column);
            }
            self.last_space_column = self.column;
            self.previous_space = true;
        } else {
            self.last_space_column = 0;
            self.previous_space = false;
        }
        self.line_length += 1;
        self.column += 1;
        self.last_was_eol = false;
    }

    fn finish(mut self) -> Vec<WellFormedIssue> {
        if self.pending_cr {
            self.report("control_character", self.line, self.column);
            self.column += 1;
            self.last_was_eol = false;
        }
        if !self.has_bytes {
            self.report("empty", 1, 1);
            return self.issues;
        }
        if self.last_completed_empty_line > 0 {
            self.report("edge_empty_line", self.last_completed_empty_line, 1);
        }
        if !self.last_was_eol {
            self.report("missing_eol", self.line, self.column);
        }
        self.issues
    }
}

/// Bounded byte validation, matching the Node backend. Never repairs input files.
pub fn validate_test_input_file(input_path: &Path) -> io::Result<Vec<WellFormedIssue>> {
    let mut file = File::open(input_path)?;
    let mut buffer = [0u8; 64 * 1024];
    let mut validator = InputValidator {
        line: 1,
        column: 1,
        ..Default::default()
    };
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        for &byte in &buffer[..count] {
            validator.accept(byte);
        }
    }
    Ok(validator.finish())
}

pub fn validate_problem_test_inputs(
    problem: &Path,
    is_interactive: bool,
) -> io::Result<TestInputValidationResult> {
    // Discovery uses an empty list for unreadable directories; validation must fail closed.
    std::fs::read_dir(problem)?;
    let tests = discover_test_cases(problem, is_interactive);
    let mut issues = Vec::new();
    for testcase in &tests {
        for issue in validate_test_input_file(&testcase.input_path)? {
            issues.push(ProblemWellFormedIssue {
                issue,
                test_name: testcase.name.clone(),
                file_name: testcase.input_file_name.clone(),
            });
        }
    }
    Ok(TestInputValidationResult {
        tests: tests.len(),
        issues,
    })
}

pub fn validate_configured_test_inputs(
    problem: &Path,
    config: Option<&serde_json::Value>,
) -> Result<(), String> {
    let enabled = config
        .and_then(|c| c.get("testWellFormed"))
        .and_then(|v| v.as_bool())
        == Some(true);
    if !enabled {
        return Ok(());
    }
    let interactive = config
        .and_then(|c| c.get("isInteractive"))
        .and_then(|v| v.as_bool())
        == Some(true);
    let result = validate_problem_test_inputs(problem, interactive)
        .map_err(|error| format!("TEST_VALIDATION_ERROR: {}: {error}", problem.display()))?;
    if let Some(first) = result.issues.first() {
        return Err(format!(
            "TEST_NOT_WELL_FORMED: {}/{}:{}:{} ({})",
            first.test_name,
            first.file_name,
            first.issue.line,
            first.issue.column,
            first.issue.code
        ));
    }
    Ok(())
}
