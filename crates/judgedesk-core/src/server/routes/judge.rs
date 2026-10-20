use std::path::PathBuf;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_stream::StreamExt;

use crate::engine::{run_judge_session, JudgeSessionConfig, JudgeStreamEvent, ProgressData};
use crate::server::dto::{BatchJudgePayload, CancelJudgePayload};
use crate::server::state::{AppState, JobAdmissionResult};

pub async fn handle_batch_judge(
    State(state): State<AppState>,
    Json(payload): Json<BatchJudgePayload>,
) -> Response {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let mut admitted_job_id: Option<String> = None;

    match state.admit_judge_job(payload.job_id.as_deref()) {
        JobAdmissionResult::Rejected {
            code: "JUDGE_JOB_ID_INVALID",
            message,
        } => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "success": false,
                    "code": "JUDGE_JOB_ID_INVALID",
                    "message": message
                })),
            )
                .into_response();
        }
        JobAdmissionResult::Rejected { code: _, message } => {
            let _ = tx.send(JudgeStreamEvent::Error { message });
        }
        JobAdmissionResult::Admitted(judge_lease) => {
            let _ = tx.send(JudgeStreamEvent::Progress(ProgressData {
                contestant: String::new(),
                problem: String::new(),
                action: "progress.initializing".to_string(),
                percent: 0.0,
            }));
            let job_id_str = judge_lease.job_id().to_string();
            admitted_job_id = Some(job_id_str.clone());
            let cancel_flag = judge_lease.cancel_flag();
            let platform = state.platform.clone();
            let app_data_dir = state
                .toolchains
                .read()
                .ok()
                .and_then(|g| g.app_data_dir.clone());
            let toolchain_selections = state
                .toolchains
                .read()
                .ok()
                .map(|g| g.selections.clone())
                .unwrap_or_default();

            let session_config = JudgeSessionConfig {
                thisinh_path: PathBuf::from(payload.thisinh_path),
                test_path: PathBuf::from(payload.test_path),
                job_id: job_id_str,
                target_contestants: payload.target_contestants,
                target_problems: payload.target_problems,
                problem_configs: payload.problem_configs,
                app_data_dir,
                toolchain_selections,
                cancel_flag,
                platform,
            };

            let rt_handle = tokio::runtime::Handle::current();
            tokio::task::spawn_blocking(move || {
                let _lease = judge_lease;
                rt_handle.block_on(run_judge_session(session_config, tx));
            });
        }
    }

    let stream = UnboundedReceiverStream::new(rx).map(|event| {
        let line = serde_json::to_string(&event).unwrap_or_default();
        Ok::<_, std::io::Error>(format!("{line}\n"))
    });

    let body = axum::body::Body::from_stream(stream);

    let mut builder = Response::builder()
        .header("Content-Type", "application/x-ndjson")
        .header("Cache-Control", "no-cache");
    if let Some(ref jid) = admitted_job_id {
        builder = builder.header("X-JudgeDesk-Job-Id", jid);
    }

    match builder.body(body) {
        Ok(resp) => resp,
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to build response",
        )
            .into_response(),
    }
}

pub async fn handle_batch_judge_cancel(State(state): State<AppState>, body: Bytes) -> Response {
    let requested_job_id = if body.is_empty() {
        None
    } else {
        serde_json::from_slice::<CancelJudgePayload>(&body)
            .ok()
            .and_then(|p| p.job_id)
    };
    if let Some(ref raw_id) = requested_job_id {
        if !raw_id.is_empty() {
            if let Err(message) = crate::server::state::validate_job_id(raw_id) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({
                        "success": false,
                        "code": "JUDGE_JOB_ID_INVALID",
                        "message": message
                    })),
                )
                    .into_response();
            }
        }
    }
    let cancelled_runs = state.cancel_judge_job(requested_job_id.as_deref());
    if requested_job_id.as_deref().is_some_and(|s| !s.is_empty()) && cancelled_runs == 0 {
        return Json(json!({
            "message": "Cancellation registered before judging job admission.",
            "pending": true,
            "success": true
        }))
        .into_response();
    }
    Json(json!({
        "success": true,
        "cancelledRuns": cancelled_runs
    }))
    .into_response()
}
