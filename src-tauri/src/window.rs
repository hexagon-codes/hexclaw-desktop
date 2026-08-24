// 窗口管理
//
// 主窗口: 三栏布局，自定义标题栏
// Quick Chat: ⌘⇧H 唤起的轻量浮窗，always-on-top
//
// 关闭主窗口时隐藏到菜单栏/托盘而不是退出应用

use serde_json::json;
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_store::StoreExt;

const UI_STATE_STORE: &str = "ui-state.json";
const HIDE_NOTICE_SHOWN_KEY: &str = "desktop.hideNoticeShown";
const SYSTEM_QUIT_CONFIRM_WINDOW: Duration = Duration::from_secs(2);

#[cfg(test)]
static ALLOW_APP_EXIT: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LifecycleSource {
    WindowClose,
    SystemQuit,
    ExplicitTrayQuit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LifecycleDecision {
    HideKeepRunning,
    HideAndPrompt,
    Exit,
}

#[derive(Debug, Default)]
pub struct LifecycleController {
    last_system_quit: Option<Instant>,
    explicit_exit_pending: bool,
}

impl LifecycleController {
    fn decide(&mut self, source: LifecycleSource, now: Instant) -> LifecycleDecision {
        match source {
            LifecycleSource::WindowClose => LifecycleDecision::HideKeepRunning,
            LifecycleSource::ExplicitTrayQuit => {
                self.explicit_exit_pending = true;
                LifecycleDecision::Exit
            }
            LifecycleSource::SystemQuit => {
                if self.explicit_exit_pending {
                    self.explicit_exit_pending = false;
                    return LifecycleDecision::Exit;
                }

                if self.last_system_quit.is_some_and(|previous| {
                    now.saturating_duration_since(previous) < SYSTEM_QUIT_CONFIRM_WINDOW
                }) {
                    self.last_system_quit = None;
                    LifecycleDecision::Exit
                } else {
                    self.last_system_quit = Some(now);
                    LifecycleDecision::HideAndPrompt
                }
            }
        }
    }
}

#[derive(Debug, Default)]
pub struct LifecycleState(Mutex<LifecycleController>);

pub fn lifecycle_decision(app: &tauri::AppHandle, source: LifecycleSource) -> LifecycleDecision {
    let state = app.state::<LifecycleState>();
    let decision = state
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .decide(source, Instant::now());
    decision
}

fn background_entry_label() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "菜单栏"
    }

    #[cfg(not(target_os = "macos"))]
    {
        "系统托盘"
    }
}

fn maybe_notify_hidden_to_background(
    app: &tauri::AppHandle,
) -> Result<(), Box<dyn std::error::Error>> {
    let store = app.store(UI_STATE_STORE)?;
    if store
        .get(HIDE_NOTICE_SHOWN_KEY)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return Ok(());
    }

    let entry = background_entry_label();
    let _ = app
        .notification()
        .builder()
        .title("HexClaw 仍在后台运行")
        .body(format!(
            "关闭主窗口后，HexClaw 和引擎会继续在{}运行。点击 {} 图标或 Dock 图标可重新打开，选择 Quit HexClaw 才会完全退出。",
            entry, entry
        ))
        .show();

    store.set(HIDE_NOTICE_SHOWN_KEY, json!(true));
    store.save()?;
    Ok(())
}

/// 显示并聚焦主窗口
pub fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// 隐藏所有窗口，应用继续驻留在菜单栏/托盘。
pub fn hide_app_to_background(app: &tauri::AppHandle) {
    for window in app.webview_windows().values() {
        let _ = window.hide();
    }

    if let Err(err) = maybe_notify_hidden_to_background(app) {
        log::warn!("写入后台常驻提示状态失败: {}", err);
    }
}

/// 首次系统退出请求：隐藏窗口并发出原生轻提示，不触发后台引擎停机。
pub fn hide_app_for_system_quit_confirmation(app: &tauri::AppHandle) {
    for window in app.webview_windows().values() {
        let _ = window.hide();
    }

    let _ = app
        .notification()
        .builder()
        .title("HexClaw 仍在后台运行")
        .body("2 秒内再次按 Cmd+Q 退出 HexClaw。")
        .show();
}

/// 处理来自系统菜单的退出请求，并返回本次生命周期决策。
pub fn handle_system_quit_request(app: &tauri::AppHandle) -> LifecycleDecision {
    let decision = lifecycle_decision(app, LifecycleSource::SystemQuit);
    match decision {
        LifecycleDecision::HideAndPrompt => hide_app_for_system_quit_confirmation(app),
        LifecycleDecision::HideKeepRunning => hide_app_to_background(app),
        LifecycleDecision::Exit => {}
    }
    decision
}

/// 停止由桌面应用拥有的后台引擎；重复调用保持幂等。
pub fn stop_background_engines() {
    crate::ollama::stop_ollama();
    if let Err(error) = crate::sidecar::stop_sidecar() {
        log::error!("停止 sidecar 失败: {}", error);
    }
}

/// 真正退出应用。
pub fn request_app_exit(app: &tauri::AppHandle) {
    let decision = lifecycle_decision(app, LifecycleSource::ExplicitTrayQuit);
    debug_assert_eq!(decision, LifecycleDecision::Exit);
    stop_background_engines();
    app.exit(0);
}

/// 当前退出请求是否允许真正结束应用。
#[cfg(test)]
pub fn consume_app_exit_request() -> bool {
    ALLOW_APP_EXIT.swap(false, Ordering::SeqCst)
}

/// 创建 Quick Chat 浮窗
///
/// 如果已存在则聚焦，否则新建。
pub fn open_quick_chat(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // 已存在则聚焦
    if let Some(window) = app.get_webview_window("quick-chat") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    // 新建浮窗
    WebviewWindowBuilder::new(app, "quick-chat", WebviewUrl::App("/quick-chat".into()))
        .title("HexClaw Quick Chat")
        .inner_size(480.0, 420.0)
        .resizable(true)
        .always_on_top(true)
        .center()
        .decorations(true)
        .build()?;

    Ok(())
}

/// 打开「关于」窗口
///
/// macOS 菜单 "About" 与应用内版本号入口共用此函数，保证只有一个关于窗口、一套窗口配置。
/// 已存在则聚焦，否则新建。
pub fn open_about(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(window) = app.get_webview_window("about") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(app, "about", WebviewUrl::App("/about".into()))
        .title("关于河蟹")
        .inner_size(520.0, 760.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .center()
        .build()?;

    Ok(())
}

/// 注册全局快捷键
///
/// ⌘⇧H (macOS) / Ctrl+Shift+H (Windows/Linux) — 打开 Quick Chat
pub fn register_shortcuts(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::ShortcutState;

    app.global_shortcut()
        .on_shortcut("CmdOrCtrl+Shift+H", |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let _ = open_quick_chat(app);
            }
        })?;

    log::info!("全局快捷键已注册: CmdOrCtrl+Shift+H → Quick Chat");
    Ok(())
}

/// 设置主窗口关闭行为: 隐藏到托盘而非退出
pub fn setup_close_behavior(app: &tauri::App) {
    if let Some(window) = app.get_webview_window("main") {
        let app = app.handle().clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 阻止默认关闭，改为隐藏
                api.prevent_close();
                if lifecycle_decision(&app, LifecycleSource::WindowClose)
                    == LifecycleDecision::HideKeepRunning
                {
                    hide_app_to_background(&app);
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{
        consume_app_exit_request, stop_background_engines, LifecycleController, LifecycleDecision,
        LifecycleSource, ALLOW_APP_EXIT,
    };
    use std::sync::atomic::Ordering;
    use std::time::{Duration, Instant};

    #[test]
    fn explicit_exit_request_is_consumed_once() {
        ALLOW_APP_EXIT.store(true, Ordering::SeqCst);

        assert!(consume_app_exit_request());
        assert!(!consume_app_exit_request());
    }

    #[test]
    fn first_system_quit_stays_running_and_second_inside_two_seconds_exits() {
        let mut controller = LifecycleController::default();
        let first = Instant::now();

        assert_eq!(
            controller.decide(LifecycleSource::SystemQuit, first),
            LifecycleDecision::HideAndPrompt
        );
        assert_eq!(
            controller.decide(
                LifecycleSource::SystemQuit,
                first + Duration::from_millis(1_999)
            ),
            LifecycleDecision::Exit
        );
    }

    #[test]
    fn system_quit_at_two_seconds_rearms_instead_of_exiting() {
        let mut controller = LifecycleController::default();
        let first = Instant::now();

        assert_eq!(
            controller.decide(LifecycleSource::SystemQuit, first),
            LifecycleDecision::HideAndPrompt
        );
        assert_eq!(
            controller.decide(
                LifecycleSource::SystemQuit,
                first + Duration::from_millis(2_000)
            ),
            LifecycleDecision::HideAndPrompt
        );
    }

    #[test]
    fn stopping_background_engines_twice_is_idempotent() {
        stop_background_engines();
        stop_background_engines();
    }
}
