// 系统托盘
//
// macOS: Menu Bar 常驻图标 (Template Image)
// Windows: System Tray 图标
// Linux: System Tray 图标
//
// 菜单项：打开主窗口、Quick Chat、日志、设置、退出

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

/// 构建系统托盘
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let open = MenuItem::with_id(app, "open", "Open HexClaw", true, None::<&str>)?;
    let quick_chat = MenuItem::with_id(app, "quick_chat", "Quick Chat...", true, None::<&str>)?;
    let separator1 = PredefinedMenuItem::separator(app)?;
    let logs = MenuItem::with_id(app, "logs", "Logs", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit HexClaw", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &open,
            &separator1,
            &quick_chat,
            &logs,
            &settings,
            &separator2,
            &quit,
        ],
    )?;

    let icon = app.default_window_icon().cloned().unwrap_or_else(|| {
        log::warn!("默认窗口图标不存在，使用空图标");
        tauri::image::Image::new(&[], 0, 0)
    });

    TrayIconBuilder::new()
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quick_chat" => {
                let _ = crate::window::open_quick_chat(app);
            }
            "logs" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit("navigate", "/logs");
                }
            }
            "settings" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.emit("navigate", "/settings");
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键点击打开主窗口
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}
