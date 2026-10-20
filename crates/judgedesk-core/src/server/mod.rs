pub mod auth;
pub mod dto;
pub mod observability;
pub mod os_integration;
pub mod routes;
pub mod state;

use std::net::SocketAddr;

use axum::routing::{get, post};
use axum::Router;

pub use auth::{attach_desktop_boundary, DesktopApiBoundary};
pub use dto::ProfileSelection;
pub use os_integration::{
    DirectoryPicker, NativeDirectoryPicker, NativeWorkbookOpener, WorkbookOpener,
};
pub use state::{
    resolve_packaged_executor_path, AppState, JobAdmissionResult, ServerLifecyclePhase,
    ToolchainStore,
};

use routes::discovery::{
    handle_fetch_contestants, handle_fetch_polygon_tests, handle_fetch_problems,
    handle_fetch_tests, handle_get_polygon_config, handle_save_polygon_config,
};
use routes::export::handle_open_excel;
use routes::judge::{handle_batch_judge, handle_batch_judge_cancel};
use routes::osd::{handle_osd_events, handle_osd_start, handle_osd_status, handle_osd_stop};
use routes::system::{
    handle_distribution, handle_select_directory, handle_shutdown, handle_status,
};
use routes::toolchains::{
    handle_toolchains, handle_toolchains_certification_plan, handle_toolchains_certify,
    handle_toolchains_custom_path, handle_toolchains_diagnose, handle_toolchains_execution_policy,
    handle_toolchains_install, handle_toolchains_op_success, handle_toolchains_preference,
    handle_toolchains_prewarm, handle_toolchains_rescan, handle_toolchains_uninstall,
};

fn api_router(state: AppState) -> Router {
    Router::new()
        .route("/api/status", get(handle_status))
        .route("/api/fetch-contestants", get(handle_fetch_contestants))
        .route("/api/fetch-problems", get(handle_fetch_problems))
        .route("/api/fetch-tests", get(handle_fetch_tests))
        .route("/api/fetch-polygon-tests", get(handle_fetch_polygon_tests))
        .route(
            "/api/polygon-config",
            get(handle_get_polygon_config).post(handle_save_polygon_config),
        )
        .route("/api/batch-judge", post(handle_batch_judge))
        .route("/api/batch-judge/cancel", post(handle_batch_judge_cancel))
        .route("/api/shutdown", post(handle_shutdown))
        .route("/api/toolchains", get(handle_toolchains))
        .route("/api/toolchains/rescan", post(handle_toolchains_rescan))
        .route(
            "/api/toolchains/execution-policy",
            axum::routing::put(handle_toolchains_execution_policy),
        )
        .route("/api/toolchains/prewarm", post(handle_toolchains_prewarm))
        .route(
            "/api/toolchains/profiles/{profile_id}/preference",
            axum::routing::put(handle_toolchains_preference),
        )
        .route(
            "/api/toolchains/profiles/{profile_id}/certification-plan",
            post(handle_toolchains_certification_plan),
        )
        .route(
            "/api/toolchains/profiles/{profile_id}/certify",
            post(handle_toolchains_certify),
        )
        .route(
            "/api/toolchains/profiles/{profile_id}/diagnose",
            post(handle_toolchains_diagnose),
        )
        .route(
            "/api/toolchains/custom-path",
            post(handle_toolchains_custom_path),
        )
        .route(
            "/api/toolchains/{id}/install",
            post(handle_toolchains_install),
        )
        .route(
            "/api/toolchains/{id}/cancel",
            post(handle_toolchains_op_success),
        )
        .route(
            "/api/toolchains/{id}",
            axum::routing::delete(handle_toolchains_uninstall),
        )
        .route("/api/distribution", get(handle_distribution))
        .route(
            "/api/open-excel",
            post(handle_open_excel).layer(axum::extract::DefaultBodyLimit::max(256 * 1024 * 1024)),
        )
        .route("/api/select-directory", post(handle_select_directory))
        .route("/api/osd/status", get(handle_osd_status))
        .route("/api/osd/start", post(handle_osd_start))
        .route("/api/osd/stop", post(handle_osd_stop))
        .route("/api/osd/events", get(handle_osd_events))
        .with_state(state)
}

pub fn create_router(state: AppState) -> Router {
    api_router(state)
}

fn create_desktop_router(state: AppState, boundary: DesktopApiBoundary) -> Router {
    attach_desktop_boundary(api_router(state), boundary)
}

pub async fn start_embedded_server(
    port: u16,
) -> Result<(SocketAddr, tokio::task::JoinHandle<()>), Box<dyn std::error::Error + Send + Sync>> {
    start_embedded_server_with_state(port, AppState::default()).await
}

pub async fn start_embedded_server_with_tree_guard(
    port: u16,
    guard: crate::executor_client::TreeGuardContract,
    api_token: String,
) -> Result<(SocketAddr, tokio::task::JoinHandle<()>), Box<dyn std::error::Error + Send + Sync>> {
    let (addr, _pid, handle) =
        start_embedded_server_with_tree_guard_and_pid(port, guard, api_token).await?;
    Ok((addr, handle))
}

pub async fn start_embedded_server_with_tree_guard_and_pid(
    port: u16,
    guard: crate::executor_client::TreeGuardContract,
    api_token: String,
) -> Result<
    (SocketAddr, Option<u32>, tokio::task::JoinHandle<()>),
    Box<dyn std::error::Error + Send + Sync>,
> {
    let state = AppState::from_packaged_executor_with_tree_guard(guard);
    let executor_pid = state.platform.process_id();
    let (addr, handle) =
        start_embedded_server_with_state_and_session(port, state, Some(api_token)).await?;
    Ok((addr, executor_pid, handle))
}

pub async fn start_embedded_server_with_state(
    port: u16,
    state: AppState,
) -> Result<(SocketAddr, tokio::task::JoinHandle<()>), Box<dyn std::error::Error + Send + Sync>> {
    start_embedded_server_with_state_and_session(port, state, None).await
}

pub async fn start_embedded_server_with_state_and_session(
    port: u16,
    mut state: AppState,
    api_token: Option<String>,
) -> Result<(SocketAddr, tokio::task::JoinHandle<()>), Box<dyn std::error::Error + Send + Sync>> {
    println!("{}", crate::build_metadata::startup_log()?);
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::mpsc::channel::<()>(1);
    state.shutdown_tx = Some(shutdown_tx);

    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}")).await?;
    let local_addr = listener.local_addr()?;
    let app = match api_token {
        Some(token) => {
            create_desktop_router(state, DesktopApiBoundary::new(local_addr.port(), token)?)
        }
        None => create_router(state),
    };

    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.recv().await;
            })
            .await;
    });

    Ok((local_addr, handle))
}
