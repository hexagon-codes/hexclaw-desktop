//! 应用文件共用的认证条件缓存；缓存故障始终让位于正常网络读取。

use crate::backend_connection::ConnectionSnapshot;
use futures_util::{Stream, StreamExt};
use reqwest::{header, Body, Client, Method, RequestBuilder, Response};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    io,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex, OnceLock, Weak},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{Mutex as AsyncMutex, OwnedMutexGuard},
};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

type FileLocks = Mutex<HashMap<String, Weak<AsyncMutex<()>>>>;
type ByteStream = Pin<Box<dyn Stream<Item = Result<Vec<u8>, io::Error>> + Send>>;
static LOCKS: OnceLock<FileLocks> = OnceLock::new();

#[derive(Clone, Serialize, Deserialize)]
struct Record {
    etag: String,
    digest: String,
    size: u64,
    status: u16,
    headers: BTreeMap<String, String>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn lock_for(key: &str) -> Option<Arc<AsyncMutex<()>>> {
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .ok()?;
    locks.retain(|_, value| value.strong_count() > 0);
    if let Some(lock) = locks.get(key).and_then(Weak::upgrade) {
        return Some(lock);
    }
    let lock = Arc::new(AsyncMutex::new(()));
    locks.insert(key.to_owned(), Arc::downgrade(&lock));
    Some(lock)
}

pub(crate) fn is_file_response(response: &Response) -> bool {
    if response.headers().contains_key(header::CONTENT_DISPOSITION) {
        return true;
    }
    let mime = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    !mime.is_empty()
        && mime != "application/json"
        && !mime.ends_with("+json")
        && !matches!(mime.as_str(), "text/event-stream" | "text/html")
}

fn strong_etag(response: &Response) -> Option<String> {
    let value = response.headers().get(header::ETAG)?.to_str().ok()?;
    (value.starts_with('"') && value.ends_with('"') && value.len() > 2).then(|| value.to_owned())
}

fn storage_allowed(headers: &BTreeMap<String, String>) -> bool {
    !headers.get("cache-control").is_some_and(|v| {
        v.split(',')
            .any(|v| v.trim().eq_ignore_ascii_case("no-store"))
    }) && !headers
        .get("vary")
        .is_some_and(|v| v.split(',').any(|v| v.trim() == "*"))
}

fn stored_headers(response: &Response) -> BTreeMap<String, String> {
    response
        .headers()
        .iter()
        .filter(|(key, _)| {
            matches!(
                key.as_str(),
                "content-type"
                    | "content-length"
                    | "content-disposition"
                    | "content-range"
                    | "accept-ranges"
                    | "etag"
                    | "last-modified"
                    | "cache-control"
                    | "vary"
                    | "content-encoding"
                    | "x-content-sha256"
                    | "x-hexclaw-artifact-id"
                    | "x-hexclaw-source-digest"
                    | "x-hexclaw-object-counts"
            )
        })
        .filter_map(|(k, v)| {
            v.to_str()
                .ok()
                .map(|v| (k.as_str().to_owned(), v.to_owned()))
        })
        .collect()
}

async fn candidate(directory: &Path) -> Option<Record> {
    let record: Record =
        serde_json::from_slice(&tokio::fs::read(directory.join("index.json")).await.ok()?).ok()?;
    if !storage_allowed(&record.headers) {
        return None;
    }
    if record.digest.len() != 64
        || !record.digest.bytes().all(|b| b.is_ascii_hexdigit())
        || !record.etag.starts_with('"')
        || !record.etag.ends_with('"')
    {
        return None;
    }
    let mut file = tokio::fs::File::open(directory.join(format!("{}.bin", record.digest)))
        .await
        .ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut size = 0_u64;
    loop {
        let n = file.read(&mut buffer).await.ok()?;
        if n == 0 {
            break;
        }
        size += n as u64;
        hasher.update(&buffer[..n]);
    }
    (size == record.size && hex(&hasher.finalize()) == record.digest).then_some(record)
}

fn response_with_body(record: &Record, body: Body) -> Option<Response> {
    let mut response = tauri::http::Response::builder().status(record.status);
    for (key, value) in &record.headers {
        response = response.header(key, value);
    }
    response.body(body).ok().map(Response::from)
}

async fn cached_response(
    directory: &Path,
    record: &Record,
    guard: OwnedMutexGuard<()>,
) -> Option<Response> {
    let file = tokio::fs::File::open(directory.join(format!("{}.bin", record.digest)))
        .await
        .ok()?;
    let stream = futures_util::stream::try_unfold(
        (ReaderStream::new(file), guard),
        |(mut stream, guard)| async move {
            match stream.next().await {
                Some(bytes) => bytes.map(|bytes| Some((bytes, (stream, guard)))),
                None => Ok(None),
            }
        },
    );
    response_with_body(record, Body::wrap_stream(stream))
}

struct WriteThrough {
    upstream: ByteStream,
    output: Option<tokio::fs::File>,
    temporary: PathBuf,
    directory: PathBuf,
    record: Record,
    expected_size: Option<u64>,
    hasher: Sha256,
    size: u64,
    _guard: OwnedMutexGuard<()>,
}

impl WriteThrough {
    async fn commit(&mut self) {
        if self
            .expected_size
            .is_some_and(|expected| expected != self.size)
        {
            return;
        }
        let Some(mut output) = self.output.take() else {
            return;
        };
        if output.flush().await.is_err() || output.sync_all().await.is_err() {
            return;
        }
        drop(output);
        self.record.digest = hex(&self.hasher.clone().finalize());
        self.record.size = self.size;
        self.record
            .headers
            .insert("content-length".into(), self.size.to_string());
        let payload = self.directory.join(format!("{}.bin", self.record.digest));
        let old = candidate(&self.directory).await;
        let _ = tokio::fs::remove_file(&payload).await;
        if tokio::fs::rename(&self.temporary, &payload).await.is_err() {
            return;
        }
        let Ok(metadata) = serde_json::to_vec(&self.record) else {
            return;
        };
        let path = self
            .directory
            .join(format!(".index-{}.tmp", Uuid::new_v4()));
        if tokio::fs::write(&path, metadata).await.is_err() {
            return;
        }
        if tokio::fs::rename(&path, self.directory.join("index.json"))
            .await
            .is_err()
        {
            let _ = tokio::fs::remove_file(self.directory.join("index.json")).await;
            if tokio::fs::rename(&path, self.directory.join("index.json"))
                .await
                .is_err()
            {
                let _ = tokio::fs::remove_file(path).await;
                return;
            }
        }
        if let Some(old) = old.filter(|old| old.digest != self.record.digest) {
            let _ =
                tokio::fs::remove_file(self.directory.join(format!("{}.bin", old.digest))).await;
        }
    }
}

impl Drop for WriteThrough {
    fn drop(&mut self) {
        self.output.take();
        let _ = std::fs::remove_file(&self.temporary);
    }
}

async fn write_through(
    response: Response,
    directory: PathBuf,
    guard: OwnedMutexGuard<()>,
) -> Response {
    if !storage_allowed(&stored_headers(&response)) {
        let _ = tokio::fs::remove_dir_all(&directory).await;
        return response;
    }
    let Some(etag) = strong_etag(&response) else {
        return response;
    };
    if !response.status().is_success() || !is_file_response(&response) {
        return response;
    }
    if tokio::fs::create_dir_all(&directory).await.is_err() {
        return response;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if tokio::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
            .await
            .is_err()
        {
            return response;
        }
    }
    let temporary = directory.join(format!(".payload-{}.tmp", Uuid::new_v4()));
    let mut options = tokio::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let Ok(output) = options.open(&temporary).await else {
        return response;
    };
    let record = Record {
        etag,
        digest: String::new(),
        size: 0,
        status: response.status().as_u16(),
        headers: stored_headers(&response),
    };
    let envelope = record.clone();
    let state = WriteThrough {
        expected_size: response.content_length(),
        upstream: Box::pin(response.bytes_stream().map(|r| {
            r.map(|b| b.to_vec())
                .map_err(|error| io::Error::other(error.without_url()))
        })),
        output: Some(output),
        temporary,
        directory,
        record,
        hasher: Sha256::new(),
        size: 0,
        _guard: guard,
    };
    let stream = futures_util::stream::try_unfold(state, |mut state| async move {
        match state.upstream.next().await {
            Some(Ok(bytes)) => {
                state.size += bytes.len() as u64;
                state.hasher.update(&bytes);
                if let Some(output) = &mut state.output {
                    if output.write_all(&bytes).await.is_err() {
                        state.output = None;
                    }
                }
                Ok(Some((bytes, state)))
            }
            Some(Err(error)) => Err(error),
            None => {
                state.commit().await;
                Ok(None)
            }
        }
    });
    response_with_body(&envelope, Body::wrap_stream(stream))
        .expect("upstream response headers remain valid")
}

pub(crate) async fn send(
    client: &Client,
    connection: &ConnectionSnapshot,
    builder: RequestBuilder,
) -> Result<Response, String> {
    let mut request = builder
        .build()
        .map_err(|error| format!("Build Sidecar request: {}", error.without_url()))?;
    if request.method() != Method::GET
        || request.body().is_some()
        || request.headers().contains_key(header::IF_NONE_MATCH)
        || request.headers().contains_key(header::IF_MODIFIED_SINCE)
    {
        return client
            .execute(request)
            .await
            .map_err(|error| format!("Sidecar request failed: {}", error.without_url()));
    }
    let mut key = Sha256::new();
    for value in [
        connection.context.connection_id.as_str(),
        connection.context.backend_id.as_str(),
        connection.token(),
        request.url().as_str(),
    ] {
        key.update(value.as_bytes());
        key.update([0]);
    }
    let mut representation_headers: BTreeMap<String, Vec<Vec<u8>>> = BTreeMap::new();
    for (name, value) in request.headers() {
        representation_headers
            .entry(name.as_str().to_owned())
            .or_default()
            .push(value.as_bytes().to_vec());
    }
    for (name, values) in representation_headers {
        key.update(name.as_bytes());
        key.update([0]);
        for value in values {
            key.update(value);
            key.update([0]);
        }
    }
    let key = hex(&key.finalize());
    let Some(lock) = lock_for(&key) else {
        return client
            .execute(request)
            .await
            .map_err(|e| e.without_url().to_string());
    };
    let guard = lock.lock_owned().await;
    let directory = crate::sidecar::desktop_config_path()
        .ok()
        .and_then(|p| p.parent().map(|p| p.join("cache").join("files").join(&key)));
    let Some(directory) = directory else {
        return client
            .execute(request)
            .await
            .map_err(|e| e.without_url().to_string());
    };
    let previous = candidate(&directory).await;
    if let Some(record) = &previous {
        if let Ok(value) = header::HeaderValue::from_str(&record.etag) {
            request.headers_mut().insert(header::IF_NONE_MATCH, value);
        }
    }
    let fallback = request.try_clone();
    let response = client
        .execute(request)
        .await
        .map_err(|error| format!("Sidecar request failed: {}", error.without_url()))?;
    if matches!(response.status().as_u16(), 401 | 403 | 404 | 410) {
        let _ = tokio::fs::remove_dir_all(&directory).await;
        return Ok(response);
    }
    if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        if !storage_allowed(&stored_headers(&response)) {
            let _ = tokio::fs::remove_dir_all(&directory).await;
            let Some(mut fallback) = fallback else {
                return Ok(response);
            };
            fallback.headers_mut().remove(header::IF_NONE_MATCH);
            return client
                .execute(fallback)
                .await
                .map_err(|error| format!("Sidecar file read failed: {}", error.without_url()));
        }
        if let Some(record) = &previous {
            if let Some(cached) = cached_response(&directory, record, guard).await {
                return Ok(cached);
            }
            // 缓存读取失败时只重读这个幂等文件，不重放任何业务请求。
            let Some(mut fallback) = fallback else {
                return Err("Cached file is unavailable".into());
            };
            fallback.headers_mut().remove(header::IF_NONE_MATCH);
            return client
                .execute(fallback)
                .await
                .map_err(|error| format!("Sidecar file read failed: {}", error.without_url()));
        }
        return Ok(response);
    }
    Ok(write_through(response, directory, guard).await)
}
