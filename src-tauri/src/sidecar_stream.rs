//! Streaming authenticated HTTP bridge for Sidecar SSE/progress responses.

use crate::sidecar_client::SidecarClient;
use futures_util::StreamExt;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{ipc::Channel, State};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;
const MAX_STREAM_BYTES: usize = 64 * 1024 * 1024;
const MAX_ACTIVE_STREAMS: usize = 16;

#[derive(Default, Clone)]
pub struct NativeSidecarStreamRegistry {
    streams: Arc<Mutex<HashMap<String, CancellationToken>>>,
}

struct ActiveStreamRegistration {
    stream_id: String,
    streams: Arc<Mutex<HashMap<String, CancellationToken>>>,
    cancellation: CancellationToken,
}

impl NativeSidecarStreamRegistry {
    fn try_register(&self, stream_id: String) -> Result<ActiveStreamRegistration, String> {
        let mut streams = self
            .streams
            .lock()
            .map_err(|_| "Sidecar stream registry poisoned")?;
        if streams.len() >= MAX_ACTIVE_STREAMS {
            return Err("Too many active Sidecar streams".into());
        }
        if streams.contains_key(&stream_id) {
            return Err("Sidecar stream identity is already active".into());
        }
        let cancellation = CancellationToken::new();
        streams.insert(stream_id.clone(), cancellation.clone());
        Ok(ActiveStreamRegistration {
            stream_id,
            streams: self.streams.clone(),
            cancellation,
        })
    }

    fn cancel(&self, stream_id: &str) -> Result<(), String> {
        if let Some(cancellation) = self
            .streams
            .lock()
            .map_err(|_| "Sidecar stream registry poisoned")?
            .remove(stream_id)
        {
            cancellation.cancel();
        }
        Ok(())
    }

    #[cfg(test)]
    fn active_count(&self) -> Result<usize, String> {
        self.streams
            .lock()
            .map(|streams| streams.len())
            .map_err(|_| "Sidecar stream registry poisoned".into())
    }
}

impl ActiveStreamRegistration {
    fn token(&self) -> CancellationToken {
        self.cancellation.clone()
    }
}

impl Drop for ActiveStreamRegistration {
    fn drop(&mut self) {
        if let Ok(mut streams) = self.streams.lock() {
            streams.remove(&self.stream_id);
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeSidecarStreamRequest {
    method: String,
    path: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    body: Vec<u8>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NativeSidecarStreamEvent {
    Open {
        status: u16,
        headers: BTreeMap<String, String>,
    },
    Chunk {
        data: Vec<u8>,
    },
    End,
    Error {
        message: String,
    },
}

fn stream_method(method: &str) -> Result<Method, String> {
    match method.trim().to_ascii_uppercase().as_str() {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        _ => Err("Sidecar streaming HTTP method is not allowed".into()),
    }
}

fn request_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "accept" | "content-type" | "idempotency-key" | "range"
    )
}

fn response_header(name: &reqwest::header::HeaderName) -> bool {
    matches!(
        name.as_str(),
        "content-type" | "content-length" | "content-disposition" | "etag" | "last-modified"
    )
}

fn validate_request(request: &NativeSidecarStreamRequest) -> Result<Method, String> {
    if request.body.len() > MAX_REQUEST_BYTES {
        return Err("Sidecar streaming request body exceeds IPC limit".into());
    }
    let method = stream_method(&request.method)?;
    for (name, value) in &request.headers {
        if !request_header(name) || value.len() > 1024 || value.chars().any(char::is_control) {
            return Err("Sidecar streaming request header is not allowed".into());
        }
    }
    Ok(method)
}

fn send_event(
    channel: &Channel<NativeSidecarStreamEvent>,
    event: NativeSidecarStreamEvent,
) -> Result<(), String> {
    channel
        .send(event)
        .map_err(|_| "Sidecar stream receiver is unavailable".to_string())
}

#[tauri::command]
pub async fn sidecar_stream_open(
    request: NativeSidecarStreamRequest,
    on_event: Channel<NativeSidecarStreamEvent>,
    registry: State<'_, NativeSidecarStreamRegistry>,
) -> Result<String, String> {
    let method = validate_request(&request)?;
    let client = SidecarClient::new(Duration::from_secs(60 * 60))?;
    let mut builder = client.renderer_request(method, &request.path)?;
    for (name, value) in request.headers {
        builder = builder.header(name, value);
    }
    if !request.body.is_empty() {
        builder = builder.body(request.body);
    }

    let stream_id = Uuid::new_v4().to_string();
    let registration = registry.try_register(stream_id.clone())?;
    let cancellation = registration.token();

    tauri::async_runtime::spawn(async move {
        let _registration = registration;
        let result = async {
            let response = tokio::select! {
                _ = cancellation.cancelled() => return Ok(()),
                response = builder.send() => response.map_err(|_| "Sidecar streaming request failed".to_string())?,
            };
            SidecarClient::require_non_redirect(&response)?;
            let status = response.status().as_u16();
            let headers = response
                .headers()
                .iter()
                .filter(|(name, _)| response_header(name))
                .filter_map(|(name, value)| {
                    value
                        .to_str()
                        .ok()
                        .map(|value| (name.as_str().to_owned(), value.to_owned()))
                })
                .collect();
            send_event(
                &on_event,
                NativeSidecarStreamEvent::Open { status, headers },
            )?;

            let mut received = 0usize;
            let mut body = response.bytes_stream();
            loop {
                let next = tokio::select! {
                    _ = cancellation.cancelled() => return Ok(()),
                    next = body.next() => next,
                };
                match next {
                    Some(Ok(chunk)) => {
                        received = received
                            .checked_add(chunk.len())
                            .ok_or_else(|| "Sidecar stream size overflow".to_string())?;
                        if received > MAX_STREAM_BYTES {
                            return Err("Sidecar stream exceeds limit".into());
                        }
                        send_event(
                            &on_event,
                            NativeSidecarStreamEvent::Chunk {
                                data: chunk.to_vec(),
                            },
                        )?;
                    }
                    Some(Err(_)) => return Err("Sidecar stream receive failed".into()),
                    None => {
                        send_event(&on_event, NativeSidecarStreamEvent::End)?;
                        return Ok(());
                    }
                }
            }
        }
        .await;
        if let Err(message) = result {
            let _ = send_event(&on_event, NativeSidecarStreamEvent::Error { message });
        }
    });

    Ok(stream_id)
}

#[tauri::command]
pub fn sidecar_stream_cancel(
    stream_id: String,
    registry: State<'_, NativeSidecarStreamRegistry>,
) -> Result<(), String> {
    registry.cancel(&stream_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_request_shape_is_bounded_and_header_allowlisted() {
        let valid = NativeSidecarStreamRequest {
            method: "POST".into(),
            path: "/api/v1/cron/jobs/stream".into(),
            headers: BTreeMap::from([("accept".into(), "text/event-stream".into())]),
            body: b"{}".to_vec(),
        };
        assert_eq!(validate_request(&valid).expect("valid"), Method::POST);
        assert!(validate_request(&NativeSidecarStreamRequest {
            headers: BTreeMap::from([("authorization".into(), "renderer-token".into())]),
            ..valid
        })
        .is_err());
    }

    #[test]
    fn active_stream_registry_is_bounded_and_drop_always_releases_capacity() {
        let registry = NativeSidecarStreamRegistry::default();
        let mut registrations = Vec::new();
        for index in 0..MAX_ACTIVE_STREAMS {
            registrations.push(
                registry
                    .try_register(format!("stream-{index}"))
                    .expect("capacity must be available"),
            );
        }
        assert!(registry.try_register("overflow".into()).is_err());
        assert_eq!(
            registry.active_count().expect("active count"),
            MAX_ACTIVE_STREAMS
        );

        registrations.pop();
        assert_eq!(
            registry.active_count().expect("released count"),
            MAX_ACTIVE_STREAMS - 1
        );
        assert!(registry.try_register("replacement".into()).is_ok());
    }

    #[test]
    fn receiver_send_failure_is_terminal() {
        let channel = Channel::new(|_| {
            Err(
                std::io::Error::new(std::io::ErrorKind::BrokenPipe, "renderer channel closed")
                    .into(),
            )
        });
        let error = send_event(&channel, NativeSidecarStreamEvent::End)
            .expect_err("closed renderer channel must terminate the native stream");
        assert_eq!(error, "Sidecar stream receiver is unavailable");
    }
}
