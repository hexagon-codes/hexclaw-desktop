// 窗口管理
//
// 主窗口: 三栏布局，自定义标题栏
// Quick Chat: ⌘⇧H 唤起的轻量浮窗，always-on-top
//
// 关闭主窗口时隐藏到菜单栏/托盘而不是退出应用

use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_store::StoreExt;

const UI_STATE_STORE: &str = "ui-state.json";
const HIDE_NOTICE_SHOWN_KEY: &str = "desktop.hideNoticeShown";
static ALLOW_APP_EXIT: AtomicBool = AtomicBool::new(false);

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

/// 真正退出应用。
pub fn request_app_exit(app: &tauri::AppHandle) {
    ALLOW_APP_EXIT.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// 当前退出请求是否允许真正结束应用。
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
                hide_app_to_background(&app);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{consume_app_exit_request, ALLOW_APP_EXIT};
    use std::sync::atomic::Ordering;

    #[test]
    fn explicit_exit_request_is_consumed_once() {
        ALLOW_APP_EXIT.store(true, Ordering::SeqCst);

        assert!(consume_app_exit_request());
        assert!(!consume_app_exit_request());
    }
}
