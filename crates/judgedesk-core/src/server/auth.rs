use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::header::{
    ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    CACHE_CONTROL, HOST, ORIGIN, VARY,
};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde_json::json;

pub const API_SESSION_HEADER: &str = "x-judgedesk-session";
pub const ALLOWED_API_ORIGINS: [&str; 5] = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
];

#[derive(Clone)]
pub struct DesktopApiBoundary {
    port: u16,
    token: Arc<str>,
}

impl std::fmt::Debug for DesktopApiBoundary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DesktopApiBoundary")
            .field("port", &self.port)
            .field("token", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Eq, PartialEq)]
pub struct ApiAuthorizationError {
    pub status: StatusCode,
    pub code: &'static str,
}

impl DesktopApiBoundary {
    pub fn new(port: u16, token: String) -> Result<Self, String> {
        if port == 0 {
            return Err("desktop API port must be nonzero".into());
        }
        if token.len() != 64
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("desktop API session token must be 64 lowercase hex characters".into());
        }
        Ok(Self {
            port,
            token: token.into(),
        })
    }
}

pub fn constant_time_token_matches(actual: Option<&HeaderValue>, expected: &str) -> bool {
    let Some(actual) = actual.and_then(|value| value.to_str().ok()) else {
        return false;
    };
    if actual.len() != expected.len() {
        return false;
    }
    actual
        .bytes()
        .zip(expected.bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

pub fn authorize_api_request(
    method: &Method,
    headers: &HeaderMap,
    boundary: &DesktopApiBoundary,
) -> Result<Option<HeaderValue>, ApiAuthorizationError> {
    let expected_host = format!("127.0.0.1:{}", boundary.port);
    if headers.get(HOST).and_then(|value| value.to_str().ok()) != Some(expected_host.as_str()) {
        return Err(ApiAuthorizationError {
            status: StatusCode::FORBIDDEN,
            code: "API_HOST_REJECTED",
        });
    }
    let origin = headers.get(ORIGIN).cloned();
    if origin.as_ref().is_some_and(|value| {
        value
            .to_str()
            .ok()
            .is_none_or(|value| !ALLOWED_API_ORIGINS.contains(&value))
    }) {
        return Err(ApiAuthorizationError {
            status: StatusCode::FORBIDDEN,
            code: "API_ORIGIN_REJECTED",
        });
    }
    if method != Method::OPTIONS
        && !constant_time_token_matches(headers.get(API_SESSION_HEADER), &boundary.token)
    {
        return Err(ApiAuthorizationError {
            status: StatusCode::UNAUTHORIZED,
            code: "API_SESSION_REQUIRED",
        });
    }
    Ok(origin)
}

pub fn decorate_api_response(response: &mut Response, origin: Option<HeaderValue>) {
    if let Some(origin) = origin {
        response
            .headers_mut()
            .insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        response
            .headers_mut()
            .insert(VARY, HeaderValue::from_static("Origin"));
    }
    response.headers_mut().insert(
        ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static(
            "Origin, X-Requested-With, Content-Type, Accept, x-judgedesk-session",
        ),
    );
    response.headers_mut().insert(
        ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, PUT, DELETE, OPTIONS"),
    );
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
}

pub async fn enforce_desktop_api_boundary(
    State(boundary): State<DesktopApiBoundary>,
    request: Request,
    next: Next,
) -> Response {
    let origin = match authorize_api_request(request.method(), request.headers(), &boundary) {
        Ok(origin) => origin,
        Err(error) => {
            return (
                error.status,
                Json(json!({
                    "success": false,
                    "code": error.code,
                    "message": "JudgeDesk rejected an unauthorized desktop API request."
                })),
            )
                .into_response();
        }
    };
    let mut response = if request.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    decorate_api_response(&mut response, origin);
    response
}

pub fn attach_desktop_boundary(router: Router, boundary: DesktopApiBoundary) -> Router {
    router.layer(middleware::from_fn_with_state(
        boundary,
        enforce_desktop_api_boundary,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request_headers(token: Option<&str>, origin: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(HOST, HeaderValue::from_static("127.0.0.1:41321"));
        if let Some(token) = token {
            headers.insert(API_SESSION_HEADER, HeaderValue::from_str(token).unwrap());
        }
        if let Some(origin) = origin {
            headers.insert(ORIGIN, HeaderValue::from_str(origin).unwrap());
        }
        headers
    }

    #[test]
    fn desktop_api_boundary_requires_token_host_and_allowed_origin() {
        let token = "a".repeat(64);
        let boundary = DesktopApiBoundary::new(41_321, token.clone()).unwrap();
        assert!(authorize_api_request(
            &Method::POST,
            &request_headers(Some(&token), Some("tauri://localhost")),
            &boundary,
        )
        .is_ok());
        assert_eq!(
            authorize_api_request(
                &Method::POST,
                &request_headers(None, Some("tauri://localhost")),
                &boundary,
            )
            .unwrap_err()
            .status,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            authorize_api_request(
                &Method::POST,
                &request_headers(Some(&token), Some("https://evil.test")),
                &boundary,
            )
            .unwrap_err()
            .status,
            StatusCode::FORBIDDEN
        );
        let mut wrong_host = request_headers(Some(&token), None);
        wrong_host.insert(HOST, HeaderValue::from_static("localhost:41321"));
        assert_eq!(
            authorize_api_request(&Method::POST, &wrong_host, &boundary)
                .unwrap_err()
                .code,
            "API_HOST_REJECTED"
        );
    }

    #[test]
    fn desktop_api_preflight_still_validates_host_and_origin() {
        let boundary = DesktopApiBoundary::new(41_321, "b".repeat(64)).unwrap();
        assert!(authorize_api_request(
            &Method::OPTIONS,
            &request_headers(None, Some("http://localhost:5173")),
            &boundary,
        )
        .is_ok());
        assert!(authorize_api_request(
            &Method::OPTIONS,
            &request_headers(None, Some("https://evil.test")),
            &boundary,
        )
        .is_err());
    }
}
