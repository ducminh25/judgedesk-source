use std::path::{Path, PathBuf};
use std::process::Command;

use crate::storage::{
    ensure_no_reparse_or_symlink_chain, ensure_safe_contained_path, is_symlink_or_reparse_point,
    validate_existing_directory_path, validate_path_syntax,
};

#[cfg(windows)]
const STATIC_POWERSHELL_FOLDER_PICKER_SCRIPT: &str = "\
Add-Type -AssemblyName System.Windows.Forms; \
$d = New-Object System.Windows.Forms.FolderBrowserDialog; \
$d.Description = 'Select Folder'; \
$d.ShowNewFolderButton = $true; \
$defaultPath = $env:THEMIS_DEFAULT_PATH; \
if (-not [string]::IsNullOrWhiteSpace($defaultPath) -and (Test-Path -LiteralPath $defaultPath -PathType Container)) { \
    $d.SelectedPath = $defaultPath \
}; \
if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { \
    [Console]::Out.Write($d.SelectedPath) \
}";

#[cfg(target_os = "macos")]
const STATIC_APPLESCRIPT_FOLDER_PICKER_WITH_DEFAULT: &str = "\
on run argv\n\
    set defaultTarget to POSIX file (item 1 of argv)\n\
    return POSIX path of (choose folder with prompt \"Select Folder\" default location defaultTarget)\n\
end run";

#[cfg(target_os = "macos")]
const STATIC_APPLESCRIPT_FOLDER_PICKER_NO_DEFAULT: &str =
    "POSIX path of (choose folder with prompt \"Select Folder\")";

pub trait DirectoryPicker: Send + Sync {
    fn select_directory(&self, default_path: Option<&str>) -> Result<Option<String>, String>;
}

#[derive(Clone, Default)]
pub struct NativeDirectoryPicker;

impl NativeDirectoryPicker {
    /// Validates and canonicalizes an optional default folder path before passing it to the OS folder dialog.
    /// Rejects relative traversal (`..`, `.`), Windows ADS (`:`), symlinks/reparse points, and non-existent paths.
    pub fn validate_default_path(default_path: Option<&str>) -> Result<Option<PathBuf>, String> {
        let Some(raw) = default_path.map(str::trim).filter(|s| !s.is_empty()) else {
            return Ok(None);
        };
        let candidate = Path::new(raw);
        let canonical = validate_existing_directory_path(candidate)?;
        Ok(Some(canonical))
    }

    /// Builds the OS directory picker command without interpolating user paths into script text or shell commands.
    pub fn build_command(&self, default_path: Option<&str>) -> Result<Command, String> {
        let validated_default = Self::validate_default_path(default_path)?;

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let mut cmd = Command::new("powershell");
            cmd.creation_flags(CREATE_NO_WINDOW);
            cmd.args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-STA",
                "-Command",
                STATIC_POWERSHELL_FOLDER_PICKER_SCRIPT,
            ]);
            if let Some(dir) = validated_default {
                cmd.env("THEMIS_DEFAULT_PATH", dir);
            } else {
                cmd.env_remove("THEMIS_DEFAULT_PATH");
            }
            Ok(cmd)
        }

        #[cfg(target_os = "macos")]
        {
            let mut cmd = Command::new("osascript");
            if let Some(dir) = validated_default {
                cmd.args(["-e", STATIC_APPLESCRIPT_FOLDER_PICKER_WITH_DEFAULT, "--"]);
                cmd.arg(dir);
            } else {
                cmd.args(["-e", STATIC_APPLESCRIPT_FOLDER_PICKER_NO_DEFAULT]);
            }
            Ok(cmd)
        }

        #[cfg(all(not(windows), not(target_os = "macos")))]
        {
            let mut cmd = crate::host_process::command("zenity")?;
            cmd.args(["--file-selection", "--directory", "--title=Select Folder"]);
            if let Some(dir) = validated_default {
                cmd.arg("--filename");
                cmd.arg(dir);
            }
            Ok(cmd)
        }
    }
}

impl DirectoryPicker for NativeDirectoryPicker {
    fn select_directory(&self, default_path: Option<&str>) -> Result<Option<String>, String> {
        let mut cmd = self.build_command(default_path)?;
        #[cfg(all(not(windows), not(target_os = "macos")))]
        {
            let has_display = std::env::var_os("DISPLAY").is_some()
                || std::env::var_os("WAYLAND_DISPLAY").is_some();
            if !has_display {
                let _ = &mut cmd;
                return Ok(None);
            }
            if let Ok(output) = cmd.output() {
                if output.status.success() {
                    let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if !path_str.is_empty() {
                        return Ok(Some(path_str));
                    }
                }
            }
            Ok(None)
        }
        #[cfg(any(windows, target_os = "macos"))]
        {
            let output = cmd
                .output()
                .map_err(|e| format!("Failed to invoke native directory picker: {e}"))?;
            let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path_str.is_empty() {
                return Ok(Some(path_str));
            }
            Ok(None)
        }
    }
}

pub trait WorkbookOpener: Send + Sync {
    fn open_workbook(&self, book_path: &Path) -> Result<(), String>;

    fn open_workbook_with_mode(&self, book_path: &Path) -> Result<&'static str, String> {
        self.open_workbook(book_path)?;
        if cfg!(windows) {
            Ok("excel-unsaved")
        } else {
            Ok("system-open")
        }
    }
}

#[derive(Clone, Default)]
pub struct NativeWorkbookOpener {
    pub allowed_root: Option<PathBuf>,
}

impl NativeWorkbookOpener {
    pub fn with_allowed_root(allowed_root: PathBuf) -> Self {
        Self {
            allowed_root: Some(allowed_root),
        }
    }

    fn allowed_roots(&self) -> Vec<PathBuf> {
        if let Some(ref explicit) = self.allowed_root {
            return vec![explicit.clone()];
        }
        let mut roots = vec![std::env::temp_dir()];
        for env_key in [
            "THEMIS_ROOT",
            "THEMIS_APP_DATA_DIR",
            "LOCALAPPDATA",
            "XDG_DATA_HOME",
        ] {
            if let Some(val) = std::env::var_os(env_key) {
                let p = PathBuf::from(val);
                if p.is_absolute() && p.is_dir() {
                    roots.push(p);
                }
            }
        }
        let app_data = crate::toolchains::discovery::get_app_data_dir();
        if app_data.is_absolute() && app_data.is_dir() && !roots.contains(&app_data) {
            roots.push(app_data);
        }
        roots
    }

    /// Validates that `book_path` is an existing, canonical `.xlsx` regular file inside an allowed export root,
    /// with no traversal, ADS, or symlink/reparse point components.
    pub fn validate_workbook_path(&self, book_path: &Path) -> Result<PathBuf, String> {
        validate_path_syntax(book_path)?;
        if !book_path.is_absolute() {
            return Err(format!(
                "Workbook path must be absolute: {}",
                book_path.display()
            ));
        }
        ensure_no_reparse_or_symlink_chain(book_path, None)?;

        let ext_ok = book_path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("xlsx"));
        if !ext_ok {
            return Err(format!(
                "Workbook path must have .xlsx extension: {}",
                book_path.display()
            ));
        }

        let meta = std::fs::symlink_metadata(book_path).map_err(|e| {
            format!(
                "Workbook file does not exist ({}): {e}",
                book_path.display()
            )
        })?;
        if is_symlink_or_reparse_point(&meta) {
            return Err(format!(
                "Workbook path is a symbolic link or reparse point: {}",
                book_path.display()
            ));
        }
        if !meta.is_file() {
            return Err(format!(
                "Workbook path is not a regular file: {}",
                book_path.display()
            ));
        }

        for root in self.allowed_roots() {
            if let Ok(contained) = ensure_safe_contained_path(&root, book_path) {
                return Ok(contained);
            }
        }

        Err(format!(
            "Workbook path {} is outside allowed export roots",
            book_path.display()
        ))
    }

    #[cfg(windows)]
    fn find_windows_excel_executable() -> Option<PathBuf> {
        let mut roots = Vec::new();
        for key in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
            if let Some(val) = std::env::var_os(key) {
                let p = PathBuf::from(val);
                if !roots.contains(&p) {
                    roots.push(p);
                }
            }
        }
        let relative_candidates = [
            "Microsoft Office\\root\\Office16\\EXCEL.EXE",
            "Microsoft Office\\Office16\\EXCEL.EXE",
            "Microsoft Office\\root\\Office15\\EXCEL.EXE",
            "Microsoft Office\\Office15\\EXCEL.EXE",
        ];
        for root in roots {
            for rel in relative_candidates {
                let candidate = root.join(rel);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        None
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    fn find_linux_spreadsheet_executable() -> Option<PathBuf> {
        for candidate in [
            "/usr/bin/libreoffice",
            "/usr/bin/soffice",
            "/usr/bin/localc",
            "/snap/bin/libreoffice",
            "/usr/local/bin/libreoffice",
            "/usr/local/bin/soffice",
        ] {
            let p = PathBuf::from(candidate);
            if p.is_file() {
                return Some(p);
            }
        }
        for cmd_name in ["libreoffice", "soffice", "localc"] {
            if let Ok(output) = crate::host_process::command("which")
                .and_then(|mut command| command.arg(cmd_name).output().map_err(|e| e.to_string()))
            {
                if output.status.success() {
                    if let Some(first) = String::from_utf8_lossy(&output.stdout).lines().next() {
                        let path = PathBuf::from(first.trim());
                        if path.is_file() {
                            return Some(path);
                        }
                    }
                }
            }
        }
        None
    }

    /// Builds a direct OS process command (never `cmd /C start` or any shell) to open the validated workbook,
    /// returning both the command and the resolved open mode (`"excel-unsaved"` or `"system-open"`).
    pub fn build_command_with_mode(
        &self,
        book_path: &Path,
    ) -> Result<(Command, &'static str), String> {
        let canonical_book = self.validate_workbook_path(book_path)?;

        #[cfg(windows)]
        {
            if let Some(excel_exe) = Self::find_windows_excel_executable() {
                let mut cmd = Command::new(excel_exe);
                cmd.arg("/t").arg(canonical_book);
                return Ok((cmd, "excel-unsaved"));
            }
            let mut cmd = Command::new("explorer.exe");
            cmd.arg(canonical_book);
            Ok((cmd, "system-open"))
        }

        #[cfg(target_os = "macos")]
        {
            let mut cmd = Command::new("open");
            cmd.arg(canonical_book);
            Ok((cmd, "system-open"))
        }

        #[cfg(all(not(windows), not(target_os = "macos")))]
        {
            if let Some(lo_exe) = Self::find_linux_spreadsheet_executable() {
                let mut cmd = crate::host_process::command(lo_exe)?;
                cmd.arg("-n").arg(canonical_book);
                return Ok((cmd, "excel-unsaved"));
            }
            let mut cmd = crate::host_process::command("xdg-open")?;
            cmd.arg(canonical_book);
            Ok((cmd, "system-open"))
        }
    }

    /// Builds a direct OS process command (never `cmd /C start` or any shell) to open the validated workbook.
    pub fn build_command(&self, book_path: &Path) -> Result<Command, String> {
        let (cmd, _) = self.build_command_with_mode(book_path)?;
        Ok(cmd)
    }
}

impl WorkbookOpener for NativeWorkbookOpener {
    fn open_workbook(&self, book_path: &Path) -> Result<(), String> {
        let _ = self.open_workbook_with_mode(book_path)?;
        Ok(())
    }

    fn open_workbook_with_mode(&self, book_path: &Path) -> Result<&'static str, String> {
        let (cmd, mode) = self.build_command_with_mode(book_path)?;
        crate::host_process::launch_desktop(cmd)?;
        Ok(mode)
    }
}
