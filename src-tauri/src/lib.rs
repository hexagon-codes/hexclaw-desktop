// HexClaw Desktop — Tauri 应用库入口
//
// 模块划分:
//   commands  — 前端可调用的 Tauri commands
//   sidecar   — hexclaw 进程生命周期管理
//   tray      — 系统托盘
//   window    — 窗口管理 + 全局快捷键

pub mod commands;
pub mod sidecar;
pub mod tray;
pub mod window;

use tauri::Manager;

/// 运行 Tauri 应用
///
/// 初始化顺序:
///   1. 注册插件 (shell, notification, updater, global-shortcut, single-instance)
///   2. setup: 系统托盘 → sidecar 启动 → 快捷键注册 → 窗口关闭行为
///   3. 注册 commands
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        // 插件
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::init())
        .plugin(tauri_plugin_global_shortcut::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 已有实例运行时，聚焦主窗口
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // 全局状态
        .manage(sidecar::SidecarState::default())
        // 初始化
        .setup(|app| {
            // 系统托盘
            tray::setup(app)?;

            // 异步启动 sidecar 健康检查
            // (实际的 hexclaw 进程由外部启动或 sidecar 模式管理)
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                sidecar::wait_for_healthy(handle, 30).await;
            });

            // 全局快捷键
            window::register_shortcuts(app)?;

            // 主窗口关闭行为: 隐藏到托盘
            window::setup_close_behavior(app);

            log::info!("HexClaw Desktop v{} 启动完成", env!("CARGO_PKG_VERSION"));
            Ok(())
        })
        // Tauri commands
        .invoke_handler(tauri::generate_handler![
            commands::get_sidecar_status,
            commands::get_platform_info,
        ])
        .run(tauri::generate_context!())
        .expect("HexClaw Desktop 启动失败");
}
