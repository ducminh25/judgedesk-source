use serde::Deserialize;

#[derive(Clone, Debug)]
pub struct ProfileSelection {
    pub mode: String,
    pub local_path: Option<String>,
}

#[derive(Deserialize, Default)]
pub struct PathQuery {
    #[serde(default)]
    pub path: String,
}

#[derive(Deserialize, Default)]
pub struct FetchTestsQuery {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub problem: Option<String>,
    #[serde(rename = "isInteractive", default)]
    pub is_interactive: Option<String>,
}

#[derive(Deserialize)]
pub struct SavePolygonConfigPayload {
    pub path: String,
    pub config: serde_json::Value,
    #[serde(rename = "validateOnly", default)]
    pub validate_only: bool,
}

#[derive(Deserialize)]
pub struct BatchJudgePayload {
    #[serde(rename = "thisinhPath")]
    pub thisinh_path: String,
    #[serde(rename = "testPath")]
    pub test_path: String,
    #[serde(rename = "jobId", default)]
    pub job_id: Option<String>,
    #[serde(rename = "problemConfigs", default)]
    pub problem_configs: std::collections::HashMap<String, serde_json::Value>,
    #[serde(rename = "targetContestants", default)]
    pub target_contestants: Vec<String>,
    #[serde(rename = "targetProblems", default)]
    pub target_problems: Vec<String>,
}

#[derive(Deserialize, Default)]
pub struct CancelJudgePayload {
    #[serde(rename = "jobId", default)]
    pub job_id: Option<String>,
}

#[derive(Deserialize)]
pub struct SelectDirectoryPayload {
    #[serde(rename = "defaultPath", default)]
    pub default_path: Option<String>,
}

pub struct ProfileBuildSpec<'a> {
    pub id: &'a str,
    pub display_name_key: &'a str,
    pub extensions: &'a [&'a str],
    pub kind: &'a str,
    pub supported_versions: &'a [&'a str],
    pub selection: &'a ProfileSelection,
    pub default_executable: &'a str,
    pub version: &'a str,
    pub roles: serde_json::Value,
    pub managed_available: bool,
    pub managed_package: Option<(&'a str, &'a str, bool)>,
    pub candidates: Vec<serde_json::Value>,
}
