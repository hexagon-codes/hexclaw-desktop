// macOS 原生菜单栏
//
// 遵循 Apple HIG 标准菜单结构:
//   App Menu → File → Edit → View → Window → Help

use tauri::{
    menu::{Menu, MenuItemBuilder, PredefinedMenuItem, Submenu},
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};

/// 构建原生应用菜单栏
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle();

    // ─── App Menu ───
    let app_menu = Submenu::with_items(
        handle,
        "HexClaw",
        true,
        &[
            &MenuItemBuilder::with_id("about", "About HexClaw")
                .build(handle)?,
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
            &PredefinedMenuItem::quit(handle, None)?,
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
            &MenuItemBuilder::with_id("docs", "Documentation")
                .build(handle)?,
            &MenuItemBuilder::with_id("logs", "View Logs")
                .build(handle)?,
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

    // ─── Menu Event Handler ───
    app.on_menu_event(move |app, event| {
        let window = app.get_webview_window("main");
        match event.id().as_ref() {
            "about" => {
                // 如果 about 窗口已存在，聚焦它
                if let Some(w) = app.get_webview_window("about") {
                    let _ = w.show();
                    let _ = w.set_focus();
                } else {
                    // 创建自定义 About 窗口
                    let _ = WebviewWindowBuilder::new(
                        app,
                        "about",
                        WebviewUrl::App("/about".into()),
                    )
                    .title("About HexClaw")
                    .inner_size(520.0, 720.0)
                    .resizable(false)
                    .minimizable(false)
                    .maximizable(false)
                    .center()
                    .build();
                }
            }
            "preferences" => {
                if let Some(w) = &window {
                    let _ = w.show();
                    let _ = w.set_focus();
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
                    let _ = w.show();
                    let _ = w.set_focus();
                    let _ = w.emit("navigate", "/logs");
                }
            }
            _ => {}
        }
    });

    Ok(())
}
