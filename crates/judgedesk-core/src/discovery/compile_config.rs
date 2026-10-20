use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const COMPILE_CONFIG_SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_COMPILE_PROFILE: &str = "themis";

const MAX_FLAG_COUNT: usize = 128;
const MAX_FLAG_LENGTH: usize = 4_096;
const MAX_FLAGS_TOTAL_LENGTH: usize = 16_384;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompileFlags {
    pub cpp: Vec<String>,
    pub c: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProblemCompileConfig {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub profile: String,
    pub flags: CompileFlags,
}

impl Default for ProblemCompileConfig {
    fn default() -> Self {
        Self {
            schema_version: COMPILE_CONFIG_SCHEMA_VERSION,
            profile: DEFAULT_COMPILE_PROFILE.to_string(),
            flags: CompileFlags {
                cpp: vec![
                    "-std=c++14".to_string(),
                    "-O2".to_string(),
                    "-pipe".to_string(),
                ],
                c: vec![
                    "-std=c11".to_string(),
                    "-O2".to_string(),
                    "-pipe".to_string(),
                ],
            },
        }
    }
}

impl ProblemCompileConfig {
    pub fn flags_for_language(&self, language: &str) -> &[String] {
        match language {
            "c" => &self.flags.c,
            "cpp" | "c++" | "cc" | "cxx" => &self.flags.cpp,
            _ => &[],
        }
    }
}

pub fn create_compile_config(profile: &str) -> Result<ProblemCompileConfig, String> {
    let flags = match profile {
        "themis" => CompileFlags {
            cpp: vec![
                "-std=c++14".to_string(),
                "-O2".to_string(),
                "-pipe".to_string(),
            ],
            c: vec![
                "-std=c11".to_string(),
                "-O2".to_string(),
                "-pipe".to_string(),
            ],
        },
        "modern_ioi_icpc_2025" => CompileFlags {
            cpp: vec![
                "-std=gnu++20".to_string(),
                "-O2".to_string(),
                "-pipe".to_string(),
            ],
            c: vec![
                "-std=gnu17".to_string(),
                "-O2".to_string(),
                "-pipe".to_string(),
            ],
        },
        "icpc_world_finals" => CompileFlags {
            cpp: vec![
                "-std=gnu++20".to_string(),
                "-O2".to_string(),
                "-g".to_string(),
            ],
            c: vec![
                "-std=gnu11".to_string(),
                "-O2".to_string(),
                "-g".to_string(),
            ],
        },
        other => {
            return Err(format!(
                "INVALID_COMPILE_CONFIG: preset profile '{other}' is unsupported"
            ));
        }
    };
    Ok(ProblemCompileConfig {
        schema_version: COMPILE_CONFIG_SCHEMA_VERSION,
        profile: profile.to_string(),
        flags,
    })
}

pub fn create_custom_compile_config(flags_value: &Value) -> Result<ProblemCompileConfig, String> {
    Ok(ProblemCompileConfig {
        schema_version: COMPILE_CONFIG_SCHEMA_VERSION,
        profile: "custom".to_string(),
        flags: normalize_compile_flags(flags_value)?,
    })
}

pub fn normalize_compile_config(value: Option<&Value>) -> Result<ProblemCompileConfig, String> {
    let Some(val) = value else {
        return Ok(ProblemCompileConfig::default());
    };
    if val.is_null() {
        return Ok(ProblemCompileConfig::default());
    }
    let Some(obj) = val.as_object() else {
        return Err("INVALID_COMPILE_CONFIG: compile must be an object".to_string());
    };

    if let Some(sv) = obj.get("schemaVersion") {
        if !sv.is_null() && sv.as_u64() != Some(u64::from(COMPILE_CONFIG_SCHEMA_VERSION)) {
            return Err(format!(
                "INVALID_COMPILE_CONFIG: unsupported schemaVersion '{}'",
                sv
            ));
        }
    }

    let Some(profile) = obj.get("profile").and_then(|v| v.as_str()) else {
        return Err("INVALID_COMPILE_CONFIG: profile is missing or unsupported".to_string());
    };
    if !matches!(
        profile,
        "themis" | "modern_ioi_icpc_2025" | "icpc_world_finals" | "custom"
    ) {
        return Err("INVALID_COMPILE_CONFIG: profile is missing or unsupported".to_string());
    }

    match obj.get("flags") {
        None | Some(Value::Null) => {
            if profile == "custom" {
                return Err(
                    "INVALID_COMPILE_CONFIG: custom profile requires cpp and c flag arrays"
                        .to_string(),
                );
            }
            create_compile_config(profile)
        }
        Some(flags_val) => Ok(ProblemCompileConfig {
            schema_version: COMPILE_CONFIG_SCHEMA_VERSION,
            profile: profile.to_string(),
            flags: normalize_compile_flags(flags_val)?,
        }),
    }
}

fn normalize_compile_flags(value: &Value) -> Result<CompileFlags, String> {
    let Some(obj) = value.as_object() else {
        return Err("INVALID_COMPILE_CONFIG: flags must contain cpp and c argv arrays".to_string());
    };
    let cpp_val = obj
        .get("cpp")
        .ok_or_else(|| "INVALID_COMPILE_CONFIG: flags must be an argv array".to_string())?;
    let c_val = obj
        .get("c")
        .ok_or_else(|| "INVALID_COMPILE_CONFIG: flags must be an argv array".to_string())?;
    Ok(CompileFlags {
        cpp: validate_custom_compile_flags(cpp_val)?,
        c: validate_custom_compile_flags(c_val)?,
    })
}

pub fn parse_custom_compile_flags(input: &str) -> Result<Vec<String>, String> {
    if input.contains('\0') || input.contains('\r') || input.contains('\n') {
        return Err("INVALID_COMPILE_CONFIG: flags cannot contain NUL or newlines".to_string());
    }

    let chars: Vec<char> = input.chars().collect();
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut token_started = false;
    let mut index = 0;

    while index < chars.len() {
        let ch = chars[index];
        if let Some(q) = quote {
            if ch == q {
                quote = None;
                token_started = true;
                index += 1;
                continue;
            }
            if ch == '\\' && q == '"' {
                if let Some(&next) = chars.get(index + 1) {
                    if next == '"' || next == '\\' {
                        current.push(next);
                        token_started = true;
                        index += 2;
                        continue;
                    }
                }
            }
            current.push(ch);
            token_started = true;
            index += 1;
            continue;
        }

        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            token_started = true;
            index += 1;
            continue;
        }
        if ch.is_whitespace() {
            if token_started {
                tokens.push(std::mem::take(&mut current));
                token_started = false;
            }
            index += 1;
            continue;
        }
        if ch == '\\' {
            if let Some(&next) = chars.get(index + 1) {
                if next.is_whitespace() || next == '\'' || next == '"' || next == '\\' {
                    current.push(next);
                    token_started = true;
                    index += 2;
                    continue;
                }
            }
        }
        current.push(ch);
        token_started = true;
        index += 1;
    }

    if quote.is_some() {
        return Err("INVALID_COMPILE_CONFIG: unterminated quoted flag".to_string());
    }
    if token_started {
        tokens.push(current);
    }
    Ok(tokens)
}

pub fn parse_and_validate_custom_compile_flags(input: &str) -> Result<Vec<String>, String> {
    let tokens = parse_custom_compile_flags(input)?;
    let arr = Value::Array(tokens.into_iter().map(Value::String).collect());
    validate_custom_compile_flags(&arr)
}

pub fn validate_custom_compile_flags(value: &Value) -> Result<Vec<String>, String> {
    let Some(arr) = value.as_array() else {
        return Err("INVALID_COMPILE_CONFIG: flags must be an argv array".to_string());
    };
    if arr.len() > MAX_FLAG_COUNT {
        return Err(format!(
            "INVALID_COMPILE_CONFIG: at most {MAX_FLAG_COUNT} flags are allowed"
        ));
    }

    let mut total_length = 0usize;
    let mut validated = Vec::with_capacity(arr.len());
    for (index, entry) in arr.iter().enumerate() {
        let Some(token) = entry.as_str().filter(|s| !s.is_empty()) else {
            return Err(format!(
                "INVALID_COMPILE_CONFIG: flag {} must be a non-empty string",
                index + 1
            ));
        };
        if token.len() > MAX_FLAG_LENGTH {
            return Err(format!(
                "INVALID_COMPILE_CONFIG: flag {} is too long",
                index + 1
            ));
        }
        if token.contains('\0') || token.contains('\r') || token.contains('\n') {
            return Err(format!(
                "INVALID_COMPILE_CONFIG: flag {} contains a forbidden control character",
                index + 1
            ));
        }
        total_length = total_length.saturating_add(token.len());
        if total_length > MAX_FLAGS_TOTAL_LENGTH {
            return Err("INVALID_COMPILE_CONFIG: combined flags are too long".to_string());
        }
        assert_safe_compile_flag(token, index)?;
        validated.push(token.to_string());
    }
    Ok(validated)
}

fn is_makefile_dep_flag(token: &str) -> bool {
    matches!(token, "-M" | "-MM" | "-MP" | "-MG")
        || token.starts_with("-MD")
        || token.starts_with("-MMD")
        || token.starts_with("-MF")
        || token.starts_with("-MT")
        || token.starts_with("-MQ")
        || token.starts_with("-MJ")
}

pub fn assert_safe_compile_flag(token: &str, index: usize) -> Result<(), String> {
    let lower = token.to_ascii_lowercase();
    let flag_num = index + 1;

    if token.starts_with('@') || token == "--" {
        return Err(format!(
            "INVALID_COMPILE_CONFIG: flag {flag_num} '{token}' cannot use response files or terminate JudgeDesk-managed arguments"
        ));
    }
    if !token.starts_with('-') || token == "-" {
        return Err(format!(
            "INVALID_COMPILE_CONFIG: flag {flag_num} '{token}' cannot add a source file, output file, or positional argument"
        ));
    }

    if token == "-o"
        || token.starts_with("-o")
        || lower == "--output"
        || lower.starts_with("--output=")
        || token == "-c"
        || token == "-S"
        || token == "-E"
        || is_makefile_dep_flag(token)
        || lower == "-fsyntax-only"
        || lower.starts_with("-save-temps")
        || lower.starts_with("--serialize-diagnostics")
    {
        return Err(format!(
            "INVALID_COMPILE_CONFIG: flag {flag_num} '{token}' would override the protected compilation mode or output"
        ));
    }

    if lower == "-x"
        || lower.starts_with("-x")
        || lower == "-include"
        || lower.starts_with("-include=")
        || lower == "--include"
        || lower.starts_with("--include=")
        || lower == "-imacros"
        || lower.starts_with("-imacros=")
        || lower == "--imacros"
        || lower.starts_with("--imacros=")
    {
        return Err(format!(
            "INVALID_COMPILE_CONFIG: flag {flag_num} '{token}' would override the protected source or language"
        ));
    }

    if lower.starts_with("-fplugin")
        || lower.starts_with("-fpass-plugin")
        || lower == "-xclang"
        || lower.starts_with("-xclang=")
        || lower == "-mllvm"
        || lower.starts_with("-mllvm=")
        || lower == "-load"
        || lower.starts_with("-load=")
        || lower == "-plugin"
        || lower.starts_with("-plugin=")
    {
        return Err(format!(
            "INVALID_COMPILE_CONFIG: flag {flag_num} '{token}' cannot load compiler plugins or internal compiler commands"
        ));
    }

    if token == "-B"
        || token.starts_with("-B")
        || lower == "--sysroot"
        || lower.starts_with("--sysroot=")
        || lower == "-isysroot"
        || lower.starts_with("-isysroot=")
        || lower == "--gcc-toolchain"
        || lower.starts_with("--gcc-toolchain=")
        || lower == "-gcc-toolchain"
        || lower.starts_with("-gcc-toolchain=")
        || lower == "-resource-dir"
        || lower.starts_with("-resource-dir=")
        || lower.starts_with("-specs=")
        || lower == "-specs"
        || lower.starts_with("--specs=")
        || lower == "--specs"
        || lower.starts_with("-wrapper")
        || lower.starts_with("-fuse-ld")
        || lower.starts_with("-stdlib")
        || lower.starts_with("-nostdinc")
        || lower == "-nostdlib"
        || lower == "-nodefaultlibs"
    {
        return Err(format!(
            "INVALID_COMPILE_CONFIG: flag {flag_num} '{token}' cannot override the managed compiler or toolchain root"
        ));
    }

    if token == "-I"
        || token.starts_with("-I")
        || token == "-L"
        || token.starts_with("-L")
        || lower.starts_with("-isystem")
        || lower.starts_with("-iquote")
        || lower.starts_with("-idirafter")
        || token == "-F"
        || token.starts_with("-F")
        || lower.starts_with("-iframework")
    {
        return Err(format!(
            "INVALID_COMPILE_CONFIG: flag {flag_num} '{token}' cannot add external include, framework, or library roots"
        ));
    }

    if lower == "-static"
        || lower == "-s"
        || lower == "-lm"
        || lower.starts_with("-wl,")
        || lower == "-xlinker"
        || lower.starts_with("-xlinker=")
        || lower.starts_with("-wa,")
        || lower.starts_with("-wp,")
    {
        return Err(format!(
            "INVALID_COMPILE_CONFIG: flag {flag_num} '{token}' is controlled by the JudgeDesk platform adapter"
        ));
    }

    Ok(())
}
