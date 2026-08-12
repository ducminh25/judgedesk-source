use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const FORMAT_NAME: &str = "judgedesk-contest";
const FORMAT_VERSION: u64 = 1;
const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 250_000;
const MAX_UNCOMPRESSED_BYTES: u64 = 64 * 1024 * 1024 * 1024;
static UNIQUE_COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique_suffix() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let counter = UNIQUE_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{timestamp}-{counter}", std::process::id())
}

fn contest_workspace_root() -> PathBuf {
    std::env::temp_dir()
        .join("JudgeDesk")
        .join("contest-workspaces")
}

fn unique_workspace_directory() -> PathBuf {
    contest_workspace_root().join(unique_suffix())
}

pub fn cleanup_contest_workspaces() {
    let _ = fs::remove_dir_all(contest_workspace_root());
}

fn validate_manifest(manifest_json: &str) -> Result<Value, String> {
    if manifest_json.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("Contest manifest is too large".to_string());
    }
    let manifest: Value = serde_json::from_str(manifest_json)
        .map_err(|error| format!("Invalid contest manifest: {error}"))?;
    if manifest.get("format").and_then(Value::as_str) != Some(FORMAT_NAME) {
        return Err("This is not a JudgeDesk contest file".to_string());
    }
    if manifest.get("formatVersion").and_then(Value::as_u64) != Some(FORMAT_VERSION) {
        return Err("Unsupported JudgeDesk contest file version".to_string());
    }
    Ok(manifest)
}

fn validate_archive_extension(path: &Path) -> Result<(), String> {
    let valid = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("judgedesk"));
    if valid {
        Ok(())
    } else {
        Err("Contest files must use the .judgedesk extension".to_string())
    }
}

fn portable_relative_path(path: &Path) -> Result<String, String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => parts.push(
                value
                    .to_str()
                    .ok_or_else(|| "Contest contains a non-Unicode file name".to_string())?,
            ),
            _ => return Err("Contest contains an unsafe relative path".to_string()),
        }
    }
    Ok(parts.join("/"))
}

#[cfg(unix)]
fn file_mode(metadata: &fs::Metadata, _default_mode: u32) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode()
}

#[cfg(not(unix))]
fn file_mode(_metadata: &fs::Metadata, default_mode: u32) -> u32 {
    default_mode
}

fn add_directory_tree<W: Write + std::io::Seek>(
    writer: &mut ZipWriter<W>,
    source: &Path,
    archive_prefix: &str,
    excluded_paths: &HashSet<PathBuf>,
) -> Result<(), String> {
    if !source.exists() || !source.is_dir() {
        return Err(format!(
            "Source directory does not exist: {}",
            source.display()
        ));
    }

    writer
        .add_directory(
            format!("{archive_prefix}/"),
            SimpleFileOptions::default().unix_permissions(0o755),
        )
        .map_err(|error| error.to_string())?;

    for entry in WalkDir::new(source).follow_links(false).min_depth(1) {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if excluded_paths.contains(path) {
            continue;
        }
        if entry.file_type().is_symlink() {
            return Err(format!(
                "Symbolic links are not supported in contest files: {}",
                path.display()
            ));
        }

        let relative = path
            .strip_prefix(source)
            .map_err(|error| error.to_string())?;
        let relative_name = portable_relative_path(relative)?;
        let archive_name = format!("{archive_prefix}/{relative_name}");
        let metadata = entry.metadata().map_err(|error| error.to_string())?;

        if entry.file_type().is_dir() {
            writer
                .add_directory(
                    format!("{archive_name}/"),
                    SimpleFileOptions::default().unix_permissions(file_mode(&metadata, 0o755)),
                )
                .map_err(|error| error.to_string())?;
            continue;
        }
        if !entry.file_type().is_file() {
            return Err(format!("Unsupported contest entry: {}", path.display()));
        }

        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .compression_level(Some(6))
            .large_file(metadata.len() >= u32::MAX as u64)
            .unix_permissions(file_mode(&metadata, 0o644));
        writer
            .start_file(archive_name, options)
            .map_err(|error| error.to_string())?;
        let mut input = BufReader::new(File::open(path).map_err(|error| error.to_string())?);
        std::io::copy(&mut input, writer).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn replace_archive(temp_path: &Path, destination: &Path) -> Result<(), String> {
    if !destination.exists() {
        return fs::rename(temp_path, destination).map_err(|error| error.to_string());
    }

    let backup_path = destination.with_extension(format!("judgedesk.backup-{}", unique_suffix()));
    fs::rename(destination, &backup_path).map_err(|error| error.to_string())?;
    match fs::rename(temp_path, destination) {
        Ok(()) => {
            let _ = fs::remove_file(backup_path);
            Ok(())
        }
        Err(error) => {
            let _ = fs::rename(&backup_path, destination);
            Err(error.to_string())
        }
    }
}

fn save_contest_archive_impl(
    destination: &Path,
    contestants_path: Option<&Path>,
    tests_path: Option<&Path>,
    manifest_json: &str,
) -> Result<(), String> {
    validate_archive_extension(destination)?;
    validate_manifest(manifest_json)?;
    if contestants_path.is_some_and(|path| !path.is_dir())
        || tests_path.is_some_and(|path| !path.is_dir())
    {
        return Err("A selected contest source directory no longer exists".to_string());
    }
    if contestants_path.is_none() && tests_path.is_none() {
        return Err("Load problems or contestants before saving a contest".to_string());
    }

    let parent = destination
        .parent()
        .ok_or_else(|| "The contest destination has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp_path = parent.join(format!(".judgedesk-save-{}.tmp", unique_suffix()));
    let mut excluded_paths = HashSet::new();
    excluded_paths.insert(destination.to_path_buf());
    excluded_paths.insert(temp_path.clone());

    let result = (|| {
        let output = BufWriter::new(File::create(&temp_path).map_err(|error| error.to_string())?);
        let mut writer = ZipWriter::new(output);
        writer
            .start_file(
                "manifest.json",
                SimpleFileOptions::default()
                    .compression_method(CompressionMethod::Deflated)
                    .compression_level(Some(6))
                    .unix_permissions(0o644),
            )
            .map_err(|error| error.to_string())?;
        writer
            .write_all(manifest_json.as_bytes())
            .map_err(|error| error.to_string())?;
        if let Some(path) = contestants_path {
            add_directory_tree(&mut writer, path, "contestants", &excluded_paths)?;
        } else {
            writer
                .add_directory(
                    "contestants/",
                    SimpleFileOptions::default().unix_permissions(0o755),
                )
                .map_err(|error| error.to_string())?;
        }
        if let Some(path) = tests_path {
            add_directory_tree(&mut writer, path, "problems", &excluded_paths)?;
        } else {
            writer
                .add_directory(
                    "problems/",
                    SimpleFileOptions::default().unix_permissions(0o755),
                )
                .map_err(|error| error.to_string())?;
        }

        let mut output = writer.finish().map_err(|error| error.to_string())?;
        output.flush().map_err(|error| error.to_string())?;
        output
            .get_ref()
            .sync_all()
            .map_err(|error| error.to_string())?;
        replace_archive(&temp_path, destination)
    })();

    if result.is_err() {
        let _ = fs::remove_file(temp_path);
    }
    result
}

fn validate_archive_entries(archive: &mut ZipArchive<BufReader<File>>) -> Result<(), String> {
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("Contest archive contains too many files".to_string());
    }
    let mut total_size = 0_u64;
    let mut names = HashSet::new();
    let mut has_manifest = false;
    let mut has_problems = false;
    let mut has_contestants = false;

    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| format!("Unsafe archive path: {}", entry.name()))?;
        let name = portable_relative_path(&enclosed)?;
        if !names.insert(name.clone()) {
            return Err(format!("Duplicate archive entry: {name}"));
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!("Symbolic links are not allowed: {name}"));
        }
        total_size = total_size
            .checked_add(entry.size())
            .ok_or_else(|| "Contest archive size overflow".to_string())?;
        if total_size > MAX_UNCOMPRESSED_BYTES {
            return Err("Contest archive is too large to extract safely".to_string());
        }

        if name == "manifest.json" {
            has_manifest = true;
            continue;
        }
        let first = enclosed.components().next();
        match first {
            Some(Component::Normal(value)) if value == "problems" => has_problems = true,
            Some(Component::Normal(value)) if value == "contestants" => has_contestants = true,
            _ => return Err(format!("Unexpected archive entry: {name}")),
        }
    }

    if !has_manifest || !has_problems || !has_contestants {
        return Err("Contest archive is missing required content".to_string());
    }
    Ok(())
}

fn read_manifest(archive: &mut ZipArchive<BufReader<File>>) -> Result<Value, String> {
    let mut entry = archive
        .by_name("manifest.json")
        .map_err(|_| "Contest archive has no manifest.json".to_string())?;
    if entry.size() > MAX_MANIFEST_BYTES {
        return Err("Contest manifest is too large".to_string());
    }
    let mut contents = String::new();
    entry
        .read_to_string(&mut contents)
        .map_err(|error| error.to_string())?;
    validate_manifest(&contents)
}

#[cfg(unix)]
fn restore_permissions(path: &Path, mode: Option<u32>) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if let Some(mode) = mode {
        fs::set_permissions(path, fs::Permissions::from_mode(mode & 0o777))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn restore_permissions(_path: &Path, _mode: Option<u32>) -> Result<(), String> {
    Ok(())
}

fn open_contest_archive_impl(path: &Path) -> Result<Value, String> {
    validate_archive_extension(path)?;
    let input = BufReader::new(File::open(path).map_err(|error| error.to_string())?);
    let mut archive = ZipArchive::new(input).map_err(|error| error.to_string())?;
    validate_archive_entries(&mut archive)?;
    let manifest = read_manifest(&mut archive)?;
    let workspace = unique_workspace_directory();
    fs::create_dir_all(&workspace).map_err(|error| error.to_string())?;

    let extraction_result = (|| {
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
            let enclosed = entry
                .enclosed_name()
                .ok_or_else(|| format!("Unsafe archive path: {}", entry.name()))?;
            if enclosed == Path::new("manifest.json") {
                continue;
            }
            let output_path = workspace.join(&enclosed);
            if entry.is_dir() {
                fs::create_dir_all(&output_path).map_err(|error| error.to_string())?;
                restore_permissions(&output_path, entry.unix_mode())?;
                continue;
            }
            if let Some(parent) = output_path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let mut output = File::create(&output_path).map_err(|error| error.to_string())?;
            std::io::copy(&mut entry, &mut output).map_err(|error| error.to_string())?;
            restore_permissions(&output_path, entry.unix_mode())?;
        }
        Ok::<(), String>(())
    })();

    if let Err(error) = extraction_result {
        let _ = fs::remove_dir_all(&workspace);
        return Err(error);
    }

    Ok(json!({
        "manifest": manifest,
        "contestantsPath": workspace.join("contestants").to_string_lossy(),
        "testsPath": workspace.join("problems").to_string_lossy()
    }))
}

#[tauri::command]
pub async fn save_contest_archive(
    destination: String,
    contestants_path: String,
    tests_path: String,
    manifest_json: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_contest_archive_impl(
            Path::new(&destination),
            (!contestants_path.trim().is_empty()).then(|| Path::new(&contestants_path)),
            (!tests_path.trim().is_empty()).then(|| Path::new(&tests_path)),
            &manifest_json,
        )
    })
    .await
    .map_err(|error| format!("Contest archive worker failed: {error}"))?
}

#[tauri::command]
pub async fn open_contest_archive(path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || open_contest_archive_impl(Path::new(&path)))
        .await
        .map_err(|error| format!("Contest archive worker failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // These tests exercise the process-wide extracted-workspace cleanup. Cargo
    // runs tests in parallel by default, so one test could delete the other's
    // freshly extracted archive between open and assertion.
    static ARCHIVE_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn test_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("judgedesk-{label}-{}", unique_suffix()))
    }

    #[test]
    fn contest_archive_round_trips_manifest_sources_tests_and_permissions() {
        let _guard = ARCHIVE_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        cleanup_contest_workspaces();
        let root = test_directory("archive-test");
        let contestants = root.join("source-contestants");
        let problems = root.join("source-problems");
        fs::create_dir_all(contestants.join("Alice")).unwrap();
        fs::create_dir_all(problems.join("A").join("test01")).unwrap();
        fs::write(contestants.join("Alice").join("A.cpp"), "int main() {}\n").unwrap();
        fs::write(problems.join("A").join("test01").join("A.in"), "1 2\n").unwrap();
        fs::write(problems.join("A").join("test01").join("A.out"), "3\n").unwrap();
        let destination = root.join("sample.judgedesk");
        let manifest = r#"{"format":"judgedesk-contest","formatVersion":1,"workspace":{}}"#;

        save_contest_archive_impl(&destination, Some(&contestants), Some(&problems), manifest)
            .unwrap();
        let opened = open_contest_archive_impl(&destination).unwrap();
        assert_eq!(opened["manifest"]["formatVersion"], 1);
        let extracted_contestants = PathBuf::from(opened["contestantsPath"].as_str().unwrap());
        let extracted_problems = PathBuf::from(opened["testsPath"].as_str().unwrap());
        assert_eq!(
            fs::read_to_string(extracted_contestants.join("Alice").join("A.cpp")).unwrap(),
            "int main() {}\n"
        );
        assert_eq!(
            fs::read_to_string(extracted_problems.join("A").join("test01").join("A.out")).unwrap(),
            "3\n"
        );

        let _ = fs::remove_dir_all(root);
        cleanup_contest_workspaces();
    }

    #[test]
    fn rejects_non_judgedesk_destinations() {
        let error = validate_archive_extension(Path::new("contest.zip")).unwrap_err();
        assert!(error.contains(".judgedesk"));
    }

    #[test]
    fn contest_archive_can_save_only_problems_or_only_contestants() {
        let _guard = ARCHIVE_TEST_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        cleanup_contest_workspaces();
        let root = test_directory("partial-archive-test");
        let problems = root.join("source-problems");
        fs::create_dir_all(problems.join("A").join("test01")).unwrap();
        fs::write(problems.join("A").join("test01").join("A.in"), "42\n").unwrap();
        let destination = root.join("problems-only.judgedesk");
        let manifest = r#"{"format":"judgedesk-contest","formatVersion":1,"workspace":{}}"#;

        save_contest_archive_impl(&destination, None, Some(&problems), manifest).unwrap();
        let opened = open_contest_archive_impl(&destination).unwrap();
        let extracted_contestants = PathBuf::from(opened["contestantsPath"].as_str().unwrap());
        let extracted_problems = PathBuf::from(opened["testsPath"].as_str().unwrap());
        assert_eq!(fs::read_dir(extracted_contestants).unwrap().count(), 0);
        assert_eq!(
            fs::read_to_string(extracted_problems.join("A").join("test01").join("A.in")).unwrap(),
            "42\n"
        );

        let _ = fs::remove_dir_all(root);
        cleanup_contest_workspaces();
    }
}
