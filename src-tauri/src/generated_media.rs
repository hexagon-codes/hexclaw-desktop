//! 已登记媒体通过当前后端认证读取，文件字节不经过 JSON IPC。

use crate::sidecar_client::SidecarClient;
use std::time::Duration;
use tauri::http::{Request, Response};

pub(crate) async fn read(request: Request<Vec<u8>>) -> Result<Response<Vec<u8>>, String> {
    let url = url::Url::parse(&request.uri().to_string()).map_err(|_| "Invalid media URL")?;
    let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    let path = query.get("path").ok_or("Media path is required")?;
    if !is_media_path(path) {
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
    let response = client.send(upstream).await?;
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

fn is_media_path(path: &str) -> bool {
    let path = path.split('?').next().unwrap_or(path);
    if path.starts_with("/api/v1/files/generated/") { return true; }
    is_uploaded_image_path(path)
}

pub(crate) fn is_uploaded_image_path(path: &str) -> bool {
    let path = path.split('?').next().unwrap_or(path);
    let parts: Vec<_> = path.split('/').collect();
    matches!(parts.as_slice(), ["", "api", "v1", "attachments", id, "content"] if !id.is_empty())
        || matches!(parts.as_slice(), ["", "api", "v1", "sessions", session, "messages", message, "attachments", index, "content"]
            if !session.is_empty() && !message.is_empty() && !index.is_empty() && index.bytes().all(|b| b.is_ascii_digit()))
}

pub(crate) fn failure() -> Response<Vec<u8>> {
    Response::builder().status(502).header("content-type", "text/plain")
        .body(b"Media resource unavailable".to_vec()).expect("static media response")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn uploaded_image_larger_than_json_ipc_uses_native_media_body() {
        const SIZE: usize = 33 * 1024 * 1024 + 17;
        const CHILD: &str = "HEXCLAW_MEDIA_BODY_TEST_CHILD";
        let path = "/api/v1/sessions/source/messages/saved/attachments/0/content?pending=image";
        if std::env::var(CHILD).ok().as_deref() == Some("1") {
            let context = crate::backend_connection::current().unwrap().context;
            let scope = serde_json::json!([context.connection_id, context.backend_id, context.config_revision, context.activation_generation]).to_string();
            let mut url = url::Url::parse("hexclaw-media://localhost/asset").unwrap();
            url.query_pairs_mut().append_pair("path", path).append_pair("scope", &scope);
            let request = Request::builder().uri(url.as_str()).body(Vec::new()).unwrap();
            let runtime = tokio::runtime::Runtime::new().unwrap();
            let response = runtime.block_on(read(request)).unwrap();
            assert_eq!(response.status(), 200);
            assert_eq!(response.body().len(), SIZE);
            assert!(response.body().iter().all(|byte| *byte == b'x'));
            return;
        }
        // 子进程隔离原生连接状态与缓存目录，父进程只提供一次受控HTTP读取。
        let root = std::env::temp_dir().join(format!("hexclaw-media-body-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(15))).unwrap();
            let mut headers = Vec::new();
            let mut byte = [0];
            while !headers.ends_with(b"\r\n\r\n") { stream.read_exact(&mut byte).unwrap(); headers.push(byte[0]); }
            let headers = String::from_utf8(headers).unwrap();
            assert!(headers.starts_with(&format!("GET {path} HTTP/1.1")));
            assert!(headers.to_ascii_lowercase().contains("authorization: bearer "));
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {SIZE}\r\nConnection: close\r\n\r\n").unwrap();
            let chunk = vec![b'x'; 64 * 1024];
            let mut left = SIZE;
            while left > 0 { let size = left.min(chunk.len()); stream.write_all(&chunk[..size]).unwrap(); left -= size; }
        });
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "generated_media::tests::uploaded_image_larger_than_json_ipc_uses_native_media_body", "--nocapture"])
            .env(CHILD, "1").env("HEXCLAW_TEST_MODE", "1")
            .env("HEXCLAW_TEST_HOME", &root).env("HEXCLAW_SIDECAR_PORT", port.to_string())
            .output().unwrap();
        // 失败时唤醒尚未收到请求的服务线程，避免夹具阻塞测试收尾。
        if !result.status.success() { let _ = std::net::TcpStream::connect(("127.0.0.1", port)); }
        let server_result = server.join();
        let _ = std::fs::remove_dir_all(&root);
        assert!(result.status.success(), "native media child failed: {} {}", String::from_utf8_lossy(&result.stdout), String::from_utf8_lossy(&result.stderr));
        server_result.unwrap();
    }
}
