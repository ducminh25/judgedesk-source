use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

fn checker_source(checker_id: &str) -> Option<(&'static str, &'static str)> {
    match checker_id {
        "C1" => Some(("judgers", "C1LinesWordsIgnoreCase.cpp")),
        "C2" => Some(("judgers", "C2LinesWordsCase.cpp")),
        "C3" => Some(("judgers", "C3WordsIgnoreCase.cpp")),
        "C4" => Some(("judgers", "C4WordsCase.cpp")),
        "C5" => Some(("judgers", "C5Binary.cpp")),
        "polygon:fcmp" => Some(("judgers/polygon", "fcmp.cpp")),
        "polygon:hcmp" => Some(("judgers/polygon", "hcmp.cpp")),
        "polygon:lcmp" => Some(("judgers/polygon", "lcmp.cpp")),
        "polygon:ncmp" => Some(("judgers/polygon", "ncmp.cpp")),
        "polygon:nyesno" => Some(("judgers/polygon", "nyesno.cpp")),
        "polygon:rcmp4" => Some(("judgers/polygon", "rcmp4.cpp")),
        "polygon:rcmp6" => Some(("judgers/polygon", "rcmp6.cpp")),
        "polygon:rcmp9" => Some(("judgers/polygon", "rcmp9.cpp")),
        "polygon:wcmp" => Some(("judgers/polygon", "wcmp.cpp")),
        "polygon:yesno" => Some(("judgers/polygon", "yesno.cpp")),
        _ => None,
    }
}

fn copy_once(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        return Ok(());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::copy(source, destination)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn open_checker_source(app: tauri::AppHandle, checker_id: String) -> Result<(), String> {
    let (resource_folder, filename) = checker_source(&checker_id)
        .ok_or_else(|| format!("Unknown built-in checker: {checker_id}"))?;
    let resource_directory = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let source = resource_directory.join(resource_folder).join(filename);
    if !source.is_file() {
        return Err(format!(
            "Bundled checker source was not found: {}",
            source.display()
        ));
    }

    let editable_directory: PathBuf = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("checker-sources")
        .join(env!("CARGO_PKG_VERSION"));
    let destination = editable_directory.join(filename);
    copy_once(&source, &destination)?;
    app.opener()
        .open_path(destination.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| error.to_string())
}
