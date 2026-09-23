use judgedesk_core::server::{
    start_embedded_server_with_state, AppState, DirectoryPicker, WorkbookOpener,
};
use std::io::Write;
use std::sync::Arc;

struct TestDirectoryPicker {
    mock_file: Option<String>,
}

impl DirectoryPicker for TestDirectoryPicker {
    fn select_directory(&self, _default_path: Option<&str>) -> Result<Option<String>, String> {
        if let Some(ref mock) = self.mock_file {
            let p = std::path::Path::new(mock);
            let val = if p.exists() && p.is_file() {
                std::fs::read_to_string(p)
                    .unwrap_or_default()
                    .trim()
                    .to_string()
            } else {
                mock.clone()
            };
            if val == "__CANCEL__" {
                return Ok(None);
            }
            if val == "__ERROR__" {
                return Err("Directory selection failed.".to_string());
            }
            return Ok(Some(val));
        }
        Ok(None)
    }
}

struct TestWorkbookOpener;

impl WorkbookOpener for TestWorkbookOpener {
    fn open_workbook(&self, _path: &std::path::Path) -> Result<(), String> {
        // Suppress launching UI during automated test parity runs
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(0);

    let mock_file = std::env::var("JUDGEDESK_TEST_SELECT_DIRECTORY").ok();

    let mut state = AppState::default();
    state.directory_picker = Arc::new(TestDirectoryPicker { mock_file });
    state.workbook_opener = Arc::new(TestWorkbookOpener);

    let (addr, handle) = start_embedded_server_with_state(port, state).await?;
    println!("JUDGEDESK_CORE_PORT={}", addr.port());
    let _ = std::io::stdout().flush();
    handle.await?;
    Ok(())
}
