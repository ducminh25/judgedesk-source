use super::{
    dto::{ArticleView, Snapshot},
    service::{now, RefreshReason, Runtime},
    AnnouncementService,
};
use std::sync::Arc;
use tauri::State;
type Result<T> = std::result::Result<T, String>;
async fn blocking<T: Send + 'static>(
    runtime: Arc<Runtime>,
    task: impl FnOnce(&Runtime) -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(move || task(&runtime))
        .await
        .map_err(|_| "task".to_owned())?
}
#[tauri::command]
pub async fn announcements_snapshot(service: State<'_, AnnouncementService>) -> Result<Snapshot> {
    blocking(service.runtime().await?, Runtime::snapshot).await
}
#[tauri::command]
pub async fn announcements_refresh(
    service: State<'_, AnnouncementService>,
    reason: Option<RefreshReason>,
) -> Result<Snapshot> {
    service
        .runtime()
        .await?
        .refresh_for(reason.unwrap_or_default())
        .await
}
#[tauri::command]
pub async fn announcements_set_read(
    service: State<'_, AnnouncementService>,
    uid: String,
    read: bool,
) -> Result<Snapshot> {
    blocking(service.runtime().await?, move |runtime| {
        runtime
            .store
            .set_read(&uid, read, &now())
            .map(Into::into)
            .map_err(|_| "storage".into())
    })
    .await
}
#[tauri::command]
pub async fn announcements_mark_all_read(
    service: State<'_, AnnouncementService>,
    uids: Vec<String>,
) -> Result<Snapshot> {
    blocking(service.runtime().await?, move |runtime| {
        runtime
            .store
            .mark_all_read(&uids, &now())
            .map(Into::into)
            .map_err(|_| "storage".into())
    })
    .await
}
#[tauri::command]
pub async fn announcements_delete(
    service: State<'_, AnnouncementService>,
    uid: String,
) -> Result<Snapshot> {
    blocking(service.runtime().await?, move |runtime| {
        runtime
            .store
            .delete(&uid)
            .map(Into::into)
            .map_err(|_| "storage".into())
    })
    .await
}
#[tauri::command]
pub async fn announcements_article_open(
    service: State<'_, AnnouncementService>,
    uid: String,
    feed_hash: String,
) -> Result<ArticleView> {
    blocking(service.runtime().await?, move |runtime| {
        runtime.open_article(&uid, &feed_hash)
    })
    .await
}
#[tauri::command]
pub async fn announcements_article_close(
    service: State<'_, AnnouncementService>,
    view_id: String,
) -> Result<()> {
    blocking(service.runtime().await?, move |runtime| {
        runtime.close_article(&view_id)
    })
    .await
}
#[tauri::command]
pub async fn announcements_image(
    service: State<'_, AnnouncementService>,
    view_id: String,
    image_id: String,
) -> Result<tauri::ipc::Response> {
    service
        .runtime()
        .await?
        .image(&view_id, &image_id)
        .await
        .map(tauri::ipc::Response::new)
}
#[tauri::command]
pub async fn announcements_thumbnail(
    service: State<'_, AnnouncementService>,
    uid: String,
    feed_hash: String,
) -> Result<tauri::ipc::Response> {
    service
        .runtime()
        .await?
        .thumbnail(&uid, &feed_hash)
        .await
        .map(tauri::ipc::Response::new)
}
#[tauri::command]
pub async fn announcements_open_link(
    app: tauri::AppHandle,
    service: State<'_, AnnouncementService>,
    view_id: String,
    link_id: String,
) -> Result<()> {
    let url = service.runtime().await?.link(&view_id, &link_id)?;
    // This command is the authority: URL is resolved from a verified, pinned article,
    // then independently checked against the announcement-specific host/path policy.
    crate::host_tools::launch_external_url(app, url).await
}
