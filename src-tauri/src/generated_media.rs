//! 已登记媒体通过当前后端认证读取，文件字节不经过 JSON IPC。

use crate::sidecar_client::SidecarClient;
use std::time::Duration;
use tauri::http::{Request, Response};

pub(crate) async fn read(request: Request<Vec<u8>>) -> Result<Response<Vec<u8>>, String> {
    let url = url::Url::parse(&request.uri().to_string()).map_err(|_| "Invalid media URL")?;
    let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    let path = query.get("path").ok_or("Media path is required")?;
    if !path.starts_with("/api/v1/files/generated/") {
        return Err("Unsupported media resource".into());
    }
    let method = match request.method().as_str() {
        "GET" => reqwest::Method::GET,
        "HEAD" => reqwest::Method::HEAD,
        _ => return Err("Unsupported media method".into()),
    };
    let client = SidecarClient::new(Duration::from_secs(300))?;
    client.connection().validate_scope(query.get("scope").map(String::as_str))?;
    let mut upstream = client.renderer_request(method.clone(), path)?;
    for header in ["range", "if-range", "if-none-match", "if-modified-since"] {
        if let Some(value) = request.headers().get(header) {
            upstream = upstream.header(header, value);
        }
    }
    let response = upstream.send().await.map_err(|error| format!("Media request failed: {error}"))?;
    SidecarClient::require_non_redirect(&response)?;
    let mut output = Response::builder().status(response.status().as_u16());
    for header in ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified", "cache-control"] {
        if let Some(value) = response.headers().get(header) {
            output = output.header(header, value);
        }
    }
    let body = if method == reqwest::Method::HEAD {
        Vec::new()
    } else {
        response.bytes().await.map_err(|error| format!("Media body failed: {error}"))?.to_vec()
    };
    output.body(body).map_err(|error| error.to_string())
}

pub(crate) fn failure() -> Response<Vec<u8>> {
    Response::builder().status(502).header("content-type", "text/plain")
        .body(b"Media resource unavailable".to_vec()).expect("static media response")
}
