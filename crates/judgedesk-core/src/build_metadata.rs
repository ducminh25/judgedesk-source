//! Application identity comes from the owning build environment, never this crate's version.
#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildMetadata {
    pub app_version: &'static str,
    pub git_commit: &'static str,
    pub build_number: &'static str,
    pub built_at: &'static str,
    pub backend: &'static str,
    pub target: &'static str,
    pub features: &'static [&'static str],
    pub source_state: &'static str,
    pub build_mode: &'static str,
}

include!(concat!(env!("OUT_DIR"), "/build_identity.rs"));

pub fn startup_log() -> Result<String, serde_json::Error> {
    serde_json::to_string(&BUILD_METADATA).map(|json| format!("JUDGEDESK_BUILD_IDENTITY={json}"))
}
