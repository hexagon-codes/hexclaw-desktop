// macOS 原生菜单栏
//
// 遵循 Apple HIG 标准菜单结构:
//   App Menu → File → Edit → View → Window → Help

use tauri::{
    menu::{Menu, MenuItemBuilder, PredefinedMenuItem, Submenu},
    Emitter, Manager,
};

fn system_quit_label() -> &'static str {
    let locale = sys_locale::get_locale().unwrap_or_else(|| "en".to_string());
    if locale.to_ascii_lowercase().starts_with("zh") {
        "退出 HexClaw"
    } else {
        "Quit HexClaw"
    }
}

pub(crate) fn dispatch_native_menu_action(app: &tauri::AppHandle, id: &str) {
    let window = app.get_webview_window("main");
    match id {
        "open" => {
            crate::window::show_main_window(app);
        }
        "about" => {
            // 与应用内版本号入口共用同一开窗逻辑（单一关于窗口 + 单套配置）
            let _ = crate::window::open_about(app);
        }
        "preferences" => {
            if let Some(w) = &window {
                let _ = w.show();
                let _ = w.set_focus();
                let _ = w.emit("navigate", "/settings");
            }
        }
        "settings" => {
            if let Some(w) = &window {
                crate::window::show_main_window(app);
                let _ = w.emit("navigate", "/settings");
            }
        }
        "new_chat" => {
            if let Some(w) = &window {
                let _ = w.emit("menu-action", "new-chat");
            }
        }
        "toggle_sidebar" => {
            if let Some(w) = &window {
                let _ = w.emit("menu-action", "toggle-sidebar");
            }
        }
        "quick_chat" => {
            let _ = crate::window::open_quick_chat(app);
        }
        "logs" => {
            if let Some(w) = &window {
                crate::window::show_main_window(app);
                let _ = w.emit("navigate", "/logs");
            }
        }
        "quit" => {
            crate::window::request_app_exit(app);
        }
        "system_quit" => {
            if crate::window::handle_system_quit_request(app)
                == crate::window::LifecycleDecision::Exit
            {
                crate::window::request_app_exit(app);
            }
        }
        _ => {}
    }
}

/// 构建原生应用菜单栏
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle();

    // ─── App Menu ───
    let app_menu = Submenu::with_items(
        handle,
        "HexClaw",
        true,
        &[
            &MenuItemBuilder::with_id("about", "About HexClaw").build(handle)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItemBuilder::with_id("preferences", "Settings...")
                .accelerator("CmdOrCtrl+,")
                .build(handle)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::show_all(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItemBuilder::with_id("system_quit", system_quit_label())
                .accelerator("CmdOrCtrl+Q")
                .build(handle)?,
        ],
    )?;

    // ─── File Menu ───
    let file_menu = Submenu::with_items(
        handle,
        "File",
        true,
        &[
            &MenuItemBuilder::with_id("new_chat", "New Chat")
                .accelerator("CmdOrCtrl+N")
                .build(handle)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, Some("Close Window"))?,
        ],
    )?;

    // ─── Edit Menu ───
    let edit_menu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ],
    )?;

    // ─── View Menu ───
    let view_menu = Submenu::with_items(
        handle,
        "View",
        true,
        &[
            &MenuItemBuilder::with_id("toggle_sidebar", "Toggle Sidebar")
                .accelerator("CmdOrCtrl+\\")
                .build(handle)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::fullscreen(handle, None)?,
        ],
    )?;

    // ─── Window Menu ───
    let window_menu = Submenu::with_items(
        handle,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItemBuilder::with_id("quick_chat", "Quick Chat")
                .accelerator("CmdOrCtrl+Shift+H")
                .build(handle)?,
        ],
    )?;

    // ─── Help Menu ───
    let help_menu = Submenu::with_items(
        handle,
        "Help",
        true,
        &[
            &MenuItemBuilder::with_id("docs", "Documentation").build(handle)?,
            &MenuItemBuilder::with_id("logs", "View Logs").build(handle)?,
        ],
    )?;

    let menu = Menu::with_items(
        handle,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )?;

    app.set_menu(menu)?;

    // Tauri 的 App 与 Tray MenuEvent 都进入同一个全局 listener 列表。
    // 这里只注册一次，避免同一 action 被重复分发。
    app.on_menu_event(|app, event| {
        dispatch_native_menu_action(app, event.id().as_ref());
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::system_quit_label;

    #[test]
    fn system_quit_copy_matches_the_approved_locales() {
        assert!(matches!(
            system_quit_label(),
            "退出 HexClaw" | "Quit HexClaw"
        ));
    }
}
