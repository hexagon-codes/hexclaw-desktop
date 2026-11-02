//! Native authenticated WebSocket bridge for the managed Sidecar.
//!
//! WebView code receives browser-like events but never sees the process-scoped
//! bearer. Only the two product WebSocket paths are accepted.

use crate::backend_connection;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{ipc::Channel, State};
use tokio::sync::mpsc;
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{
        client::IntoClientRequest,
        http::{header::AUTHORIZATION, HeaderValue},
        protocol::CloseFrame,
        Message,
    },
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const MAX_SOCKET_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ACTIVE_SOCKETS: usize = 16;
const SOCKET_COMMAND_BUFFER: usize = 8;

// WebSocket握手复用HTTP客户端的系统代理、TLS与重定向语义，连接身份仍由原请求冻结。
async fn connect_native_websocket(
    request: tokio_tungstenite::tungstenite::http::Request<()>,
    client: &reqwest::Client,
) -> Result<WebSocketStream<hyper_util::rt::TokioIo<hyper::upgrade::Upgraded>>, String> {
    use tokio_tungstenite::tungstenite::{handshake::derive_accept_key, protocol::Role};
    let key = request.headers().get("sec-websocket-key").ok_or("WebSocket key is missing")?;
    let expected = derive_accept_key(key.as_bytes());
    let mut url = url::Url::parse(&request.uri().to_string()).map_err(|_| "Invalid WebSocket endpoint")?;
    let scheme = match url.scheme() { "wss" => "https", "ws" => "http", _ => return Err("Invalid WebSocket scheme".into()) };
    url.set_scheme(scheme).map_err(|_| "Invalid WebSocket scheme")?;
    let response = client.get(url).headers(request.headers().clone()).send().await
        .map_err(|error| format!("WebSocket handshake failed: {error}"))?;
    let header_has = |name: &str, token: &str| response.headers().get(name)
        .and_then(|value| value.to_str().ok()).is_some_and(|value| value.split(',').any(|v| v.trim().eq_ignore_ascii_case(token)));
    if response.status() != reqwest::StatusCode::SWITCHING_PROTOCOLS
        || !header_has("upgrade", "websocket") || !header_has("connection", "upgrade")
        || response.headers().get("sec-websocket-accept").and_then(|v| v.to_str().ok()) != Some(expected.as_str()) {
        return Err(format!("WebSocket handshake rejected: HTTP {}", response.status().as_u16()));
    }
    let mut response: tokio_tungstenite::tungstenite::http::Response<reqwest::Body> = response.into();
    let upgraded = hyper::upgrade::on(&mut response).await.map_err(|error| format!("WebSocket upgrade failed: {error}"))?;
    Ok(WebSocketStream::from_raw_socket(hyper_util::rt::TokioIo::new(upgraded), Role::Client, None).await)
}

enum SocketCommand {
    Text(String),
    Close,
}

#[derive(Clone)]
struct SocketHandle {
    sender: mpsc::Sender<SocketCommand>,
    cancellation: CancellationToken,
    opened: Arc<AtomicBool>,
}

#[derive(Default, Clone)]
pub struct NativeSidecarSocketRegistry {
    sockets: Arc<Mutex<HashMap<String, SocketHandle>>>,
}

fn socket_command_channel() -> (mpsc::Sender<SocketCommand>, mpsc::Receiver<SocketCommand>) {
    mpsc::channel(SOCKET_COMMAND_BUFFER)
}

fn close_socket_handle(handle: SocketHandle) {
    if !handle.opened.load(Ordering::Acquire) {
        handle.cancellation.cancel();
        return;
    }
    if handle.sender.try_send(SocketCommand::Close).is_err() {
        handle.cancellation.cancel();
    }
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NativeSidecarSocketEvent {
    Open,
    Message {
        data: String,
    },
    Error {
        message: String,
    },
    Close {
        code: u16,
        reason: String,
        was_clean: bool,
    },
}

fn socket_path(path: &str) -> Result<&str, String> {
    let without_query = path.split('?').next().unwrap_or(path);
    if matches!(without_query, "/ws" | "/api/v1/logs/stream") {
        Ok(path)
    } else {
        Err("Sidecar WebSocket path is not allowed".into())
    }
}

fn websocket_request(
    path: &str,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, String> {
    scoped_websocket_request(path, None)
}

fn scoped_websocket_request(path: &str, scope: Option<&str>) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, String> {
    let connection = backend_connection::current()?;
    connection.validate_scope(scope)?;
    let mut url = connection.endpoint(socket_path(path)?)?;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme)
        .map_err(|_| "resolve Sidecar WebSocket scheme".to_string())?;
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| "build Sidecar WebSocket request".to_string())?;
    let value = HeaderValue::from_str(&format!("Bearer {}", connection.token()))
        .map_err(|_| "build Sidecar WebSocket authorization".to_string())?;
    request.headers_mut().insert(AUTHORIZATION, value);
    Ok(request)
}

fn send_event(channel: &Channel<NativeSidecarSocketEvent>, event: NativeSidecarSocketEvent) {
    let _ = channel.send(event);
}

fn close_event(frame: Option<CloseFrame>, was_clean: bool) -> NativeSidecarSocketEvent {
    let (code, reason) = frame
        .map(|frame| (frame.code.into(), frame.reason.to_string()))
        .unwrap_or((1006, String::new()));
    NativeSidecarSocketEvent::Close {
        code,
        reason,
        was_clean,
    }
}

#[tauri::command]
pub async fn sidecar_socket_open(
    path: String,
    scope: Option<String>,
    on_event: Channel<NativeSidecarSocketEvent>,
    registry: State<'_, NativeSidecarSocketRegistry>,
) -> Result<String, String> {
    let request = scoped_websocket_request(&path, scope.as_deref())?;
    let endpoint = url::Url::parse(&request.uri().to_string()).map_err(|_| "Invalid WebSocket endpoint")?;
    let client = crate::backend_connection::backend_http_client(&endpoint).timeout(std::time::Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none()).build()
        .map_err(|error| format!("Create WebSocket HTTP client: {error}"))?;
    let socket_id = Uuid::new_v4().to_string();
    let (sender, mut receiver) = socket_command_channel();
    let cancellation = CancellationToken::new();
    let opened = Arc::new(AtomicBool::new(false));
    let mut sockets = registry
        .sockets
        .lock()
        .map_err(|_| "Sidecar socket registry poisoned")?;
    if sockets.len() >= MAX_ACTIVE_SOCKETS {
        return Err("Sidecar socket limit reached".into());
    }
    sockets.insert(
        socket_id.clone(),
        SocketHandle {
            sender,
            cancellation: cancellation.clone(),
            opened: opened.clone(),
        },
    );
    drop(sockets);

    let sockets = registry.sockets.clone();
    let task_socket_id = socket_id.clone();
    tauri::async_runtime::spawn(async move {
        let connected = tokio::select! {
            _ = cancellation.cancelled() => {
                if let Ok(mut sockets) = sockets.lock() {
                    sockets.remove(&task_socket_id);
                }
                return;
            }
            connected = connect_native_websocket(request, &client) => connected,
        };
        let Ok(stream) = connected else {
            send_event(
                &on_event,
                NativeSidecarSocketEvent::Error {
                    message: "Sidecar WebSocket connection failed".into(),
                },
            );
            send_event(&on_event, close_event(None, false));
            if let Ok(mut sockets) = sockets.lock() {
                sockets.remove(&task_socket_id);
            }
            return;
        };
        opened.store(true, Ordering::Release);
        let (mut writer, mut reader) = stream.split();
        send_event(&on_event, NativeSidecarSocketEvent::Open);

        let mut close_sent = false;
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => {
                    close_sent = writer.send(Message::Close(None)).await.is_ok();
                    break;
                }
                command = receiver.recv() => match command {
                    Some(SocketCommand::Text(data)) => {
                        if writer.send(Message::Text(data.into())).await.is_err() {
                            send_event(&on_event, NativeSidecarSocketEvent::Error {
                                message: "Sidecar WebSocket send failed".into(),
                            });
                            break;
                        }
                    }
                    Some(SocketCommand::Close) => {
                        close_sent = writer.send(Message::Close(None)).await.is_ok();
                        break;
                    }
                    None => {
                        close_sent = writer.send(Message::Close(None)).await.is_ok();
                        break;
                    }
                },
                frame = reader.next() => match frame {
                    Some(Ok(Message::Text(data))) => {
                        if data.len() > MAX_SOCKET_MESSAGE_BYTES {
                            send_event(&on_event, NativeSidecarSocketEvent::Error {
                                message: "Sidecar WebSocket message exceeds limit".into(),
                            });
                            break;
                        }
                        send_event(&on_event, NativeSidecarSocketEvent::Message { data: data.to_string() });
                    }
                    Some(Ok(Message::Ping(data))) => {
                        if writer.send(Message::Pong(data)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Close(frame))) => {
                        send_event(&on_event, close_event(frame, true));
                        if let Ok(mut sockets) = sockets.lock() {
                            sockets.remove(&task_socket_id);
                        }
                        return;
                    }
                    Some(Ok(Message::Binary(_))) => {
                        send_event(&on_event, NativeSidecarSocketEvent::Error {
                            message: "Binary Sidecar WebSocket messages are forbidden".into(),
                        });
                        break;
                    }
                    Some(Ok(Message::Frame(_))) => {}
                    Some(Err(_)) => {
                        send_event(&on_event, NativeSidecarSocketEvent::Error {
                            message: "Sidecar WebSocket receive failed".into(),
                        });
                        break;
                    }
                    None => break,
                }
            }
        }
        send_event(&on_event, close_event(None, close_sent));
        if let Ok(mut sockets) = sockets.lock() {
            sockets.remove(&task_socket_id);
        }
    });
    Ok(socket_id)
}

#[tauri::command]
pub fn sidecar_socket_send(
    socket_id: String,
    data: String,
    registry: State<'_, NativeSidecarSocketRegistry>,
) -> Result<(), String> {
    if data.is_empty() || data.len() > MAX_SOCKET_MESSAGE_BYTES {
        return Err("Sidecar WebSocket message is invalid".into());
    }
    let sender = registry
        .sockets
        .lock()
        .map_err(|_| "Sidecar socket registry poisoned")?
        .get(&socket_id)
        .map(|handle| handle.sender.clone())
        .ok_or("Sidecar WebSocket is not connected")?;
    sender
        .try_send(SocketCommand::Text(data))
        .map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => {
                "Sidecar WebSocket outgoing queue is full".to_string()
            }
            mpsc::error::TrySendError::Closed(_) => "Sidecar WebSocket is closed".to_string(),
        })
}

#[tauri::command]
pub fn sidecar_socket_close(
    socket_id: String,
    registry: State<'_, NativeSidecarSocketRegistry>,
) -> Result<(), String> {
    let handle = registry
        .sockets
        .lock()
        .map_err(|_| "Sidecar socket registry poisoned")?
        .remove(&socket_id);
    if let Some(handle) = handle {
        close_socket_handle(handle);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn websocket_handshake_uses_http_proxy_and_preserves_loopback_bypass() {
        for proxy in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                ws.send(Message::Text("native-proxy-ok".into())).await.unwrap();
                let _ = ws.next().await;
            });
            let (url, client) = if proxy {
                ("ws://native-backend.invalid/ws".to_string(), reqwest::Client::builder().no_proxy()
                    .proxy(reqwest::Proxy::all(format!("http://{address}")).unwrap())
                    .timeout(std::time::Duration::from_secs(3)).build().unwrap())
            } else {
                (format!("ws://{address}/ws"), reqwest::Client::builder().no_proxy()
                    .proxy(reqwest::Proxy::all("http://127.0.0.1:1").unwrap()
                        .no_proxy(reqwest::NoProxy::from_string("127.0.0.1")))
                    .timeout(std::time::Duration::from_secs(3)).build().unwrap())
            };
            let request = url.into_client_request().unwrap();
            let mut ws = connect_native_websocket(request, &client).await.unwrap();
            assert_eq!(ws.next().await.unwrap().unwrap().into_text().unwrap(), "native-proxy-ok");
            ws.close(None).await.unwrap();
            server.await.unwrap();
        }
    }

    #[test]
    fn websocket_request_is_fixed_origin_and_authenticated() {
        crate::sidecar::initialize_capability_token().expect("capability");
        let request = websocket_request("/ws").expect("request");
        assert_eq!(request.uri().host(), Some("localhost"));
        assert!(request.headers().contains_key(AUTHORIZATION));
        assert!(websocket_request("/api/v1/logs/stream").is_ok());
        assert!(websocket_request("/api/v1/anything-else").is_err());
        assert!(websocket_request("//example.com/ws").is_err());
    }

    #[test]
    fn renderer_socket_commands_have_bounded_backpressure() {
        let (sender, _receiver) = socket_command_channel();
        for _ in 0..SOCKET_COMMAND_BUFFER {
            sender
                .try_send(SocketCommand::Text("bounded".into()))
                .expect("buffer slot");
        }
        assert!(sender
            .try_send(SocketCommand::Text("overflow".into()))
            .is_err());
    }

    #[test]
    fn close_is_queued_after_prior_text_for_open_socket() {
        let (sender, mut receiver) = socket_command_channel();
        let cancellation = CancellationToken::new();
        let opened = Arc::new(AtomicBool::new(true));
        sender
            .try_send(SocketCommand::Text("cancel".into()))
            .expect("cancel command");

        close_socket_handle(SocketHandle {
            sender,
            cancellation: cancellation.clone(),
            opened,
        });

        assert!(matches!(
            receiver.try_recv(),
            Ok(SocketCommand::Text(data)) if data == "cancel"
        ));
        assert!(matches!(receiver.try_recv(), Ok(SocketCommand::Close)));
        assert!(!cancellation.is_cancelled());
    }

    #[test]
    fn close_cancels_an_unopened_socket_promptly() {
        let (sender, _receiver) = socket_command_channel();
        let cancellation = CancellationToken::new();
        close_socket_handle(SocketHandle {
            sender,
            cancellation: cancellation.clone(),
            opened: Arc::new(AtomicBool::new(false)),
        });
        assert!(cancellation.is_cancelled());
    }
}
