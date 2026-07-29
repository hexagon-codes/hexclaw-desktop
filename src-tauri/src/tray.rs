// 系统托盘
//
// macOS: Menu Bar 常驻图标 (Template Image)
// Windows: System Tray 图标
// Linux: System Tray 图标
//
// 菜单项：打开主窗口、Quick Chat、日志、设置、关于、退出

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
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

fn labels_for_locale(locale: TrayLocale) -> [&'static str; 6] {
    match locale {
        TrayLocale::Chinese => [
            "打开 HexClaw",
            "快速对话…",
            "日志",
            "设置",
            "关于河蟹",
            "退出 HexClaw",
        ],
        TrayLocale::English => [
            "Open HexClaw",
            "Quick Chat…",
            "Logs",
            "Settings",
            "About HexClaw",
            "Quit HexClaw",
        ],
    }
}

/// 构建系统托盘
pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let [open_label, quick_chat_label, logs_label, settings_label, about_label, quit_label] =
        labels_for_locale(system_tray_locale());
    let open = MenuItem::with_id(app, "open", open_label, true, None::<&str>)?;
    let quick_chat = MenuItem::with_id(app, "quick_chat", quick_chat_label, true, None::<&str>)?;
    let separator1 = PredefinedMenuItem::separator(app)?;
    let logs = MenuItem::with_id(app, "logs", logs_label, true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", settings_label, true, None::<&str>)?;
    let about = MenuItem::with_id(app, "about", about_label, true, None::<&str>)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", quit_label, true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &open,
            &separator1,
            &quick_chat,
            &logs,
            &settings,
            &about,
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
        .build(app)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{labels_for_locale, TrayLocale};

    #[test]
    fn bug_20260726_033_uses_exact_chinese_menu_labels_with_unicode_ellipsis() {
        assert_eq!(
            labels_for_locale(TrayLocale::Chinese),
            [
                "打开 HexClaw",
                "快速对话…",
                "日志",
                "设置",
                "关于河蟹",
                "退出 HexClaw",
            ]
        );
    }

    #[test]
    fn bug_20260726_033_uses_exact_english_menu_labels_with_unicode_ellipsis() {
        assert_eq!(
            labels_for_locale(TrayLocale::English),
            [
                "Open HexClaw",
                "Quick Chat…",
                "Logs",
                "Settings",
                "About HexClaw",
                "Quit HexClaw",
            ]
        );
    }
}
