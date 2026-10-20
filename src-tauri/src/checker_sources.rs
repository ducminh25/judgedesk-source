use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri_plugin_opener::OpenerExt;

static PREVIEW_COUNTER: AtomicU64 = AtomicU64::new(0);
const TESTLIB_SOURCE: &str = include_str!("../../judgers/testlib.h");
const POLYGON_LICENSE: &str = include_str!("../../judgers/polygon/LICENSE");

fn checker_source(checker_id: &str) -> Option<(&'static str, &'static str, bool)> {
    match checker_id {
        "C1" => Some((
            "C1LinesWordsIgnoreCase.cpp",
            include_str!("../../judgers/C1LinesWordsIgnoreCase.cpp"),
            false,
        )),
        "C2" => Some((
            "C2LinesWordsCase.cpp",
            include_str!("../../judgers/C2LinesWordsCase.cpp"),
            false,
        )),
        "C3" => Some((
            "C3WordsIgnoreCase.cpp",
            include_str!("../../judgers/C3WordsIgnoreCase.cpp"),
            false,
        )),
        "C4" => Some((
            "C4WordsCase.cpp",
            include_str!("../../judgers/C4WordsCase.cpp"),
            false,
        )),
        "C5" => Some((
            "C5Binary.cpp",
            include_str!("../../judgers/C5Binary.cpp"),
            false,
        )),
        "polygon:fcmp" => Some((
            "fcmp.cpp",
            include_str!("../../judgers/polygon/fcmp.cpp"),
            true,
        )),
        "polygon:hcmp" => Some((
            "hcmp.cpp",
            include_str!("../../judgers/polygon/hcmp.cpp"),
            true,
        )),
        "polygon:lcmp" => Some((
            "lcmp.cpp",
            include_str!("../../judgers/polygon/lcmp.cpp"),
            true,
        )),
        "polygon:ncmp" => Some((
            "ncmp.cpp",
            include_str!("../../judgers/polygon/ncmp.cpp"),
            true,
        )),
        "polygon:nyesno" => Some((
            "nyesno.cpp",
            include_str!("../../judgers/polygon/nyesno.cpp"),
            true,
        )),
        "polygon:rcmp4" => Some((
            "rcmp4.cpp",
            include_str!("../../judgers/polygon/rcmp4.cpp"),
            true,
        )),
        "polygon:rcmp6" => Some((
            "rcmp6.cpp",
            include_str!("../../judgers/polygon/rcmp6.cpp"),
            true,
        )),
        "polygon:rcmp9" => Some((
            "rcmp9.cpp",
            include_str!("../../judgers/polygon/rcmp9.cpp"),
            true,
        )),
        "polygon:wcmp" => Some((
            "wcmp.cpp",
            include_str!("../../judgers/polygon/wcmp.cpp"),
            true,
        )),
        "polygon:yesno" => Some((
            "yesno.cpp",
            include_str!("../../judgers/polygon/yesno.cpp"),
            true,
        )),
        _ => None,
    }
}

fn preview_root() -> PathBuf {
    std::env::temp_dir()
        .join("JudgeDesk")
        .join("checker-preview")
}

fn unique_preview_directory(checker_id: &str) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = PREVIEW_COUNTER.fetch_add(1, Ordering::Relaxed);
    let safe_checker_id = checker_id.replace(':', "-");
    preview_root().join(format!(
        "{}-{}-{}-{}",
        std::process::id(),
        timestamp,
        sequence,
        safe_checker_id
    ))
}

pub fn cleanup_checker_previews() {
    let _ = fs::remove_dir_all(preview_root());
}

fn write_checker_preview(checker_id: &str) -> Result<PathBuf, String> {
    let (filename, source_contents, include_polygon_license) = checker_source(checker_id)
        .ok_or_else(|| format!("Unknown built-in checker: {checker_id}"))?;
    let preview_directory = unique_preview_directory(checker_id);
    fs::create_dir_all(&preview_directory).map_err(|error| error.to_string())?;

    let source_path = preview_directory.join(filename);
    fs::write(&source_path, source_contents).map_err(|error| error.to_string())?;
    fs::write(preview_directory.join("testlib.h"), TESTLIB_SOURCE)
        .map_err(|error| error.to_string())?;
    if include_polygon_license {
        fs::write(preview_directory.join("LICENSE"), POLYGON_LICENSE)
            .map_err(|error| error.to_string())?;
    }
    Ok(source_path)
}

#[tauri::command]
pub fn open_checker_source(app: tauri::AppHandle, checker_id: String) -> Result<(), String> {
    let source_path = write_checker_preview(&checker_id)?;
    let path_str = source_path.to_string_lossy().into_owned();
    if let Err(opener_err) = app.opener().open_path(&path_str, None::<&str>) {
        #[cfg(target_os = "linux")]
        {
            if std::process::Command::new("xdg-open")
                .arg(&source_path)
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        return Err(opener_err.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_view_uses_a_fresh_canonical_preview_with_testlib() {
        cleanup_checker_previews();
        let first = write_checker_preview("polygon:fcmp").expect("first preview");
        fs::write(&first, "user modified preview").expect("modify first preview");

        let second = write_checker_preview("polygon:fcmp").expect("second preview");
        assert_ne!(first.parent(), second.parent());
        assert_eq!(
            fs::read_to_string(&second).expect("read second preview"),
            include_str!("../../judgers/polygon/fcmp.cpp")
        );
        assert_eq!(
            fs::read_to_string(second.parent().unwrap().join("testlib.h"))
                .expect("read preview testlib"),
            TESTLIB_SOURCE
        );
        assert!(second.parent().unwrap().join("LICENSE").is_file());
        cleanup_checker_previews();
    }
}
