// 窗口管理
//
// 主窗口: 三栏布局，自定义标题栏
// Quick Chat: ⌘⇧H 唤起的轻量浮窗，always-on-top
//
// 关闭主窗口时隐藏到托盘而不是退出应用

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// 创建 Quick Chat 浮窗
///
/// 如果已存在则聚焦，否则新建。
pub fn open_quick_chat(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // 已存在则聚焦
    if let Some(window) = app.get_webview_window("quick-chat") {
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

    app.global_shortcut().on_shortcut("CmdOrCtrl+Shift+H", |app, _shortcut, event| {
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
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 阻止默认关闭，改为隐藏
                api.prevent_close();
                let _ = window.hide();
            }
        });
    }
}
