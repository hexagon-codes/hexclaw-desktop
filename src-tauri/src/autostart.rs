/// 把旧版 LaunchAgent 自启项迁移为指向 `HexClaw.app` 的登录项。
///
/// 仅在已打包的 macOS `.app` 中执行：开发模式的可执行文件不具备应用名称和图标，
/// 不能用来创建系统登录项。先成功注册新登录项再删除旧 plist，避免迁移失败时丢失自启。
#[cfg(target_os = "macos")]
pub fn migrate_legacy_macos_autostart(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    use tauri_plugin_autostart::ManagerExt;

    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    if !executable
        .to_string_lossy()
        .contains(".app/Contents/MacOS/")
    {
        return Ok(());
    }

    let legacy_plist = app
        .path()
        .home_dir()
        .map_err(|e| e.to_string())?
        .join("Library/LaunchAgents/HexClaw.plist");
    if !legacy_plist.is_file() {
        return Ok(());
    }

    let manager = app.autolaunch();
    if !manager.is_enabled().map_err(|e| e.to_string())? {
        manager.enable().map_err(|e| e.to_string())?;
    }
    std::fs::remove_file(&legacy_plist).map_err(|e| {
        format!(
            "移除旧版 HexClaw LaunchAgent {} 失败: {e}",
            legacy_plist.display()
        )
    })
}

#[cfg(not(target_os = "macos"))]
pub fn migrate_legacy_macos_autostart(_app: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}
