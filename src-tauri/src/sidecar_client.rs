//! Authenticated, loopback-only client for the managed HexClaw Sidecar.
//!
//! The renderer never receives the per-process capability. All native HTTP
//! operations resolve the current managed Sidecar port here, attach the same
//! bearer capability, reject redirects, and bound response bodies.

use crate::sidecar;
use percent_encoding::percent_decode_str;
use reqwest::{header, Method, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::time::Duration;
use url::Url;

pub(crate) const MAX_JSON_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct SidecarClient {
    client: reqwest::Client,
}

impl SidecarClient {
    pub(crate) fn new(timeout: Duration) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            // A managed loopback endpoint never redirects. Disabling redirects
            // also prevents a compromised endpoint from forwarding the bearer
            // capability to another origin or a metadata address.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| format!("build Sidecar client: {error}"))?;
        Ok(Self { client })
    }

    pub(crate) fn endpoint(relative_path: &str) -> Result<Url, String> {
        resolve_endpoint(relative_path).map(|(endpoint, _)| endpoint)
    }

    pub(crate) fn request(
        &self,
        method: Method,
        relative_path: &str,
    ) -> Result<reqwest::RequestBuilder, String> {
        let (endpoint, _) = resolve_endpoint(relative_path)?;
        self.request_endpoint(method, endpoint)
    }

    pub(crate) fn renderer_request(
        &self,
        method: Method,
        relative_path: &str,
    ) -> Result<reqwest::RequestBuilder, String> {
        let (endpoint, canonical_path) = resolve_endpoint(relative_path)?;
        if canonical_path.starts_with("/api/internal/") {
            return Err("Sidecar internal endpoint is native-coordinator only".into());
        }
        if method == Method::PUT && canonical_path == "/api/v1/config/llm" {
            return Err("LLM credential config is native-coordinator only".into());
        }
        self.request_endpoint(method, endpoint)
    }

    fn request_endpoint(
        &self,
        method: Method,
        endpoint: Url,
    ) -> Result<reqwest::RequestBuilder, String> {
        let capability = sidecar::capability_token()?;
        Ok(self
            .client
            .request(method, endpoint)
            .header(header::AUTHORIZATION, format!("Bearer {capability}")))
    }

    pub(crate) async fn get(&self, relative_path: &str) -> Result<Response, String> {
        self.request(Method::GET, relative_path)?
            .send()
            .await
            .map_err(|error| format!("Sidecar GET failed: {error}"))
    }

    pub(crate) async fn post_json<T: Serialize + ?Sized>(
        &self,
        relative_path: &str,
        body: &T,
        idempotency_key: Option<&str>,
    ) -> Result<Response, String> {
        let mut request = self.request(Method::POST, relative_path)?.json(body);
        if let Some(key) = idempotency_key {
            validate_header_value("idempotency key", key)?;
            request = request.header("Idempotency-Key", key);
        }
        request
            .send()
            .await
            .map_err(|error| format!("Sidecar POST failed: {error}"))
    }

    pub(crate) async fn read_json<T: DeserializeOwned>(response: Response) -> Result<T, String> {
        let status = response.status();
        let bytes = read_bounded(response, MAX_JSON_RESPONSE_BYTES).await?;
        if !status.is_success() {
            return Err(format!("Sidecar returned HTTP {}", status.as_u16()));
        }
        serde_json::from_slice(&bytes).map_err(|error| format!("decode Sidecar response: {error}"))
    }

    pub(crate) fn require_non_redirect(response: &Response) -> Result<(), String> {
        if response.status().is_redirection() {
            return Err(format!(
                "Sidecar redirect refused: HTTP {}",
                response.status().as_u16()
            ));
        }
        Ok(())
    }

    pub(crate) fn is_conflict(response: &Response) -> bool {
        response.status() == StatusCode::CONFLICT
    }
}

fn resolve_endpoint(relative_path: &str) -> Result<(Url, String), String> {
    let canonical_path = validate_relative_path(relative_path)?;
    let base = Url::parse(&format!("{}/", sidecar::base_url().trim_end_matches('/')))
        .map_err(|error| format!("resolve Sidecar base URL: {error}"))?;
    let url = base
        .join(relative_path.trim_start_matches('/'))
        .map_err(|error| format!("resolve Sidecar endpoint: {error}"))?;
    validate_exact_sidecar_origin(&url)?;
    Ok((url, canonical_path))
}

pub(crate) async fn read_bounded(mut response: Response, limit: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("Sidecar response exceeds limit".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("read Sidecar response: {error}"))?
    {
        let next_len = body
            .len()
            .checked_add(chunk.len())
            .ok_or("Sidecar response exceeds limit")?;
        if next_len > limit {
            return Err("Sidecar response exceeds limit".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn validate_relative_path(path: &str) -> Result<String, String> {
    let raw_path = path.split_once('?').map_or(path, |(raw_path, _)| raw_path);
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains('\0')
        || raw_path.contains('\\')
    {
        return Err("Sidecar path is invalid".into());
    }
    validate_percent_encoding(raw_path)?;
    let canonical_path = percent_decode_str(raw_path)
        .decode_utf8()
        .map_err(|_| "Sidecar path is invalid UTF-8".to_string())?
        .into_owned();
    if canonical_path.chars().any(char::is_control)
        || canonical_path
            .split('/')
            .any(|segment| matches!(segment, "." | ".."))
    {
        return Err("Sidecar path is invalid".into());
    }
    let parsed = Url::parse(&format!("http://sidecar.invalid{path}"))
        .map_err(|_| "Sidecar path is invalid".to_string())?;
    if parsed.fragment().is_some() {
        return Err("Sidecar path fragment is forbidden".into());
    }
    Ok(canonical_path)
}

fn validate_percent_encoding(raw_path: &str) -> Result<(), String> {
    let bytes = raw_path.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            index += 1;
            continue;
        }
        let Some(hex) = bytes.get(index + 1..index + 3) else {
            return Err("Sidecar path percent-encoding is invalid".into());
        };
        let Some(high) = (hex[0] as char).to_digit(16) else {
            return Err("Sidecar path percent-encoding is invalid".into());
        };
        let Some(low) = (hex[1] as char).to_digit(16) else {
            return Err("Sidecar path percent-encoding is invalid".into());
        };
        let decoded = ((high << 4) | low) as u8;
        if matches!(decoded, b'/' | b'\\') {
            return Err("Sidecar path encoded separator is forbidden".into());
        }
        index += 3;
    }
    Ok(())
}

fn validate_exact_sidecar_origin(url: &Url) -> Result<(), String> {
    let expected = Url::parse(&sidecar::base_url())
        .map_err(|error| format!("resolve Sidecar origin: {error}"))?;
    if url.scheme() != expected.scheme()
        || url.host_str() != expected.host_str()
        || url.port_or_known_default() != expected.port_or_known_default()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Sidecar endpoint escaped the managed loopback origin".into());
    }
    Ok(())
}

fn validate_header_value(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::process::{Child, Command, Stdio};
    use std::sync::mpsc;
    use std::thread;
    use std::time::Instant;

    fn ensure_capability() {
        let _ = crate::sidecar::initialize_capability_token();
        crate::sidecar::capability_token().expect("capability initialized");
    }

    struct ChildGuard(Child);

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    struct DirectoryGuard(PathBuf);

    impl Drop for DirectoryGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test(flavor = "current_thread")]
    #[ignore = "launches the real Sidecar binary; run explicitly with HEXCLAW_REAL_SIDECAR_BIN"]
    async fn real_sidecar_accepts_production_rust_client_capability() -> Result<(), String> {
        let binary = std::env::var_os("HEXCLAW_REAL_SIDECAR_BIN")
            .map(PathBuf::from)
            .ok_or_else(|| "HEXCLAW_REAL_SIDECAR_BIN is required".to_string())?;
        if !binary.is_file() {
            return Err("HEXCLAW_REAL_SIDECAR_BIN is not a file".to_string());
        }

        ensure_capability();
        let capability = crate::sidecar::capability_token()?;
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|error| format!("reserve Sidecar port: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("read Sidecar port: {error}"))?
            .port();
        drop(listener);

        let root = std::env::temp_dir().join(format!(
            "hexclaw-rust-client-boundary-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(root.join(".hexclaw"))
            .and_then(|_| fs::create_dir_all(root.join("tmp")))
            .map_err(|error| format!("create Sidecar sandbox: {error}"))?;
        let _directory = DirectoryGuard(root.clone());
        let config_path = root.join(".hexclaw/hexclaw.yaml");
        fs::write(
            &config_path,
            format!("server:\n  host: localhost\n  port: {port}\nknowledge:\n  enabled: true\n"),
        )
        .map_err(|error| format!("write Sidecar config: {error}"))?;

        let mut command = Command::new(&binary);
        command
            .args(["serve", "--desktop", "--config"])
            .arg(&config_path)
            .env_clear()
            .env("HOME", &root)
            .env("USERPROFILE", &root)
            .env("CFFIXED_USER_HOME", &root)
            .env("TMPDIR", root.join("tmp"))
            .env("TEMP", root.join("tmp"))
            .env("TMP", root.join("tmp"))
            .env("HEXCLAW_SIDECAR_CAPABILITY_TOKEN", capability)
            .env("HEXCLAW_LLM_PROVIDERS_JSON", "{}")
            .env("HEXCLAW_DISABLE_BACKGROUND_EGRESS", "1")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(path) = std::env::var_os("PATH") {
            command.env("PATH", path);
        }
        let child = command
            .spawn()
            .map_err(|error| format!("launch real Sidecar: {error}"))?;
        let mut child = ChildGuard(child);

        let raw_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .map_err(|error| format!("build boundary client: {error}"))?;
        let health_url = format!("http://localhost:{port}/health");
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Some(status) = child
                .0
                .try_wait()
                .map_err(|error| format!("poll real Sidecar: {error}"))?
            {
                return Err(format!("real Sidecar exited before readiness: {status}"));
            }
            match raw_client.get(&health_url).send().await {
                Ok(response) if response.status().is_success() => break,
                _ if Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                _ => return Err("real Sidecar did not become healthy within 60s".to_string()),
            }
        }

        let protected_url = Url::parse(&format!(
            "http://localhost:{port}/api/v1/knowledge/operations?corpus_id=default"
        ))
        .map_err(|error| format!("build protected endpoint: {error}"))?;
        let anonymous = raw_client
            .get(protected_url.clone())
            .send()
            .await
            .map_err(|error| format!("anonymous protected probe: {error}"))?;
        if anonymous.status() != reqwest::StatusCode::UNAUTHORIZED {
            return Err(format!(
                "anonymous protected probe returned {}, want 401",
                anonymous.status()
            ));
        }

        let authenticated = SidecarClient::new(Duration::from_secs(5))?
            .request_endpoint(Method::GET, protected_url)?
            .send()
            .await
            .map_err(|error| format!("production Rust client probe: {error}"))?;
        if authenticated.status() != reqwest::StatusCode::OK {
            return Err(format!(
                "production Rust client probe returned {}, want 200",
                authenticated.status()
            ));
        }

        Ok(())
    }

    #[test]
    fn endpoint_is_dynamic_loopback_and_rejects_origin_escape() {
        ensure_capability();
        let endpoint = SidecarClient::endpoint("/api/v1/health?probe=1").expect("endpoint");
        assert_eq!(endpoint.host_str(), Some("localhost"));
        assert_eq!(endpoint.port(), Some(crate::sidecar::sidecar_port()));
        assert!(SidecarClient::endpoint("https://example.com/x").is_err());
        assert!(SidecarClient::endpoint("//example.com/x").is_err());
        assert!(SidecarClient::endpoint("/api/../admin").is_err());
    }

    #[test]
    fn endpoint_rejects_percent_encoded_path_before_http_dispatch() {
        ensure_capability();
        for path in [
            "/api/internal%2fdesktop/credentials/hydrate",
            "/api/internal%2Fdesktop/credentials/hydrate",
            "/api/internal%5cdesktop/credentials/hydrate",
            "/api/%2e%2e/internal/desktop/credentials/hydrate",
            "/api/%2E%2E/internal/desktop/credentials/hydrate",
        ] {
            assert!(
                SidecarClient::endpoint(path).is_err(),
                "encoded renderer path must be rejected: {path}"
            );
        }
        assert!(
            SidecarClient::endpoint("/api/v1/knowledge/documents?user_id=child%201").is_ok(),
            "percent-encoding remains valid in query values"
        );
    }

    #[test]
    fn endpoint_allows_canonical_percent_encoded_dynamic_segments() {
        ensure_capability();
        let endpoint = SidecarClient::endpoint(
            "/api/v1/mcp/servers/%E6%B5%8B%E8%AF%95%20server%3A1?scope=child%201",
        )
        .expect("encoded dynamic segment");
        assert_eq!(endpoint.query(), Some("scope=child%201"));
    }

    #[test]
    fn renderer_request_policy_blocks_native_coordinator_and_credential_config_mutation() {
        ensure_capability();
        let client = SidecarClient::new(Duration::from_secs(1)).expect("client");

        assert!(client
            .renderer_request(Method::POST, "/api/internal/desktop/credentials/hydrate")
            .is_err());
        assert!(client
            .renderer_request(Method::POST, "/%61pi/internal/desktop/credentials/hydrate")
            .is_err());
        assert!(client
            .renderer_request(Method::PUT, "/api/v1/config/llm")
            .is_err());
        assert!(client
            .renderer_request(Method::PUT, "/%61pi/v1/config/llm")
            .is_err());

        let _ = client
            .renderer_request(Method::GET, "/api/v1/config/llm")
            .expect("masked config read remains renderer-accessible");
        let _ = client
            .renderer_request(Method::POST, "/api/v1/config/llm/test")
            .expect("provider probe remains renderer-accessible");
    }

    #[test]
    fn redirect_policy_is_fail_closed() {
        let client = SidecarClient::new(Duration::from_secs(1)).expect("client");
        let request = client
            .request(Method::GET, "/health")
            .expect("request")
            .build()
            .expect("build");
        assert_eq!(request.url().host_str(), Some("localhost"));
        assert!(request.headers().contains_key(header::AUTHORIZATION));
    }

    #[tokio::test]
    async fn bounded_reader_rejects_chunked_overflow_before_the_sender_closes() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind chunked fixture");
        let address = listener.local_addr().expect("fixture address");
        let (release_tx, release_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept fixture request");
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n3\r\nabc\r\n4\r\ndefg\r\n",
                )
                .expect("write unterminated chunked response");
            stream.flush().expect("flush chunked fixture");
            let _ = release_rx.recv_timeout(Duration::from_secs(5));
        });

        let response = reqwest::Client::new()
            .get(format!("http://{address}/chunked"))
            .send()
            .await
            .expect("request chunked fixture");
        let outcome = tokio::time::timeout(Duration::from_secs(1), read_bounded(response, 5)).await;
        let _ = release_tx.send(());
        server.join().expect("join chunked fixture");

        let error = outcome
            .expect("overflow must be rejected while the connection remains open")
            .expect_err("chunked response exceeds the limit");
        assert_eq!(error, "Sidecar response exceeds limit");
    }
}
