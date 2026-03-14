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
            &MenuItemBuilder::with_id("about", "关于 HexClaw")
                .build(handle)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItemBuilder::with_id("preferences", "设置...")
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
        "文件",
        true,
        &[
            &MenuItemBuilder::with_id("new_chat", "新建对话")
                .accelerator("CmdOrCtrl+N")
                .build(handle)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, Some("关闭窗口"))?,
        ],
    )?;

    // ─── Edit Menu ───
    let edit_menu = Submenu::with_items(
        handle,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(handle, Some("撤销"))?,
            &PredefinedMenuItem::redo(handle, Some("重做"))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, Some("剪切"))?,
            &PredefinedMenuItem::copy(handle, Some("拷贝"))?,
            &PredefinedMenuItem::paste(handle, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(handle, Some("全选"))?,
        ],
    )?;

    // ─── View Menu ───
    let view_menu = Submenu::with_items(
        handle,
        "显示",
        true,
        &[
            &MenuItemBuilder::with_id("toggle_sidebar", "切换侧边栏")
                .accelerator("CmdOrCtrl+\\")
                .build(handle)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::fullscreen(handle, Some("进入全屏幕"))?,
        ],
    )?;

    // ─── Window Menu ───
    let window_menu = Submenu::with_items(
        handle,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, Some("最小化"))?,
            &PredefinedMenuItem::maximize(handle, Some("最大化"))?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItemBuilder::with_id("quick_chat", "快捷对话")
                .accelerator("CmdOrCtrl+Shift+H")
                .build(handle)?,
        ],
    )?;

    // ─── Help Menu ───
    let help_menu = Submenu::with_items(
        handle,
        "帮助",
        true,
        &[
            &MenuItemBuilder::with_id("docs", "文档")
                .build(handle)?,
            &MenuItemBuilder::with_id("logs", "查看日志")
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
                    .title("关于 HexClaw")
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
