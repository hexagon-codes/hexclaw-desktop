// 系统托盘
//
// macOS: Menu Bar 常驻图标 (Template Image)
// Windows: System Tray 图标
// Linux: System Tray 图标
//
// 菜单项：打开主窗口、Quick Chat、日志、设置、退出

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TrayLocale {
    Chinese,
    English,
}

fn system_tray_locale() -> TrayLocale {
    let locale = sys_locale::get_locale().unwrap_or_else(|| "en".to_string());
    let normalized = locale.replace('_', "-").to_ascii_lowercase();
    if normalized.starts_with("zh") {
        TrayLocale::Chinese
    } else {
        // Unsupported locale fallback: English.
        TrayLocale::English
    }
}

/// 构建系统托盘
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let locale = system_tray_locale();
    let open = MenuItem::with_id(app, "open",
        if locale == TrayLocale::Chinese { "打开 HexClaw" } else { "Open HexClaw" },
        true,
        None::<&str>,
    )?;
    let quick_chat = MenuItem::with_id(app, "quick_chat",
        if locale == TrayLocale::Chinese { "快速对话..." } else { "Quick Chat..." },
        true,
        None::<&str>,
    )?;
    let separator1 = PredefinedMenuItem::separator(app)?;
    let logs = MenuItem::with_id(app, "logs",
        if locale == TrayLocale::Chinese { "日志" } else { "Logs" },
        true,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(app, "settings",
        if locale == TrayLocale::Chinese { "设置" } else { "Settings" },
        true,
        None::<&str>,
    )?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit",
        if locale == TrayLocale::Chinese { "退出 HexClaw" } else { "Quit HexClaw" },
        true,
        None::<&str>,
    )?;

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

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;

    TrayIconBuilder::new()
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                crate::window::show_main_window(app);
            }
            "quick_chat" => {
                let _ = crate::window::open_quick_chat(app);
            }
            "logs" => {
                if let Some(window) = app.get_webview_window("main") {
                    crate::window::show_main_window(app);
                    let _ = window.emit("navigate", "/logs");
                }
            }
            "settings" => {
                if let Some(window) = app.get_webview_window("main") {
                    crate::window::show_main_window(app);
                    let _ = window.emit("navigate", "/settings");
                }
            }
            "quit" => {
                crate::window::request_app_exit(app);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
