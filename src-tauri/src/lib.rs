// HexClaw Desktop — Tauri 应用库入口
//
// 模块划分:
//   commands  — 前端可调用的 Tauri commands
//   sidecar   — hexclaw 进程生命周期管理
//   tray      — 系统托盘
//   window    — 窗口管理 + 全局快捷键

pub mod commands;
pub mod menu;
pub mod sidecar;
pub mod tray;
pub mod window;

use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

/// 数据库迁移脚本
fn include_migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create chat tables",
        sql: "
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT '新对话',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL DEFAULT (datetime('now')),
                metadata TEXT,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
        ",
        kind: MigrationKind::Up,
    }]
}

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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:hexclaw.db", include_migrations())
                .build(),
        )
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
            eprintln!("[HexClaw] setup 开始...");

            // macOS 原生菜单栏
            menu::setup(app)?;

            // 系统托盘
            tray::setup(app)?;

            // 启动 hexclaw sidecar 进程
            match sidecar::spawn_sidecar(&app.handle()) {
                Ok(()) => {
                    log::info!("sidecar 进程已启动");
                    eprintln!("[HexClaw] sidecar 进程已启动");
                }
                Err(e) => {
                    log::error!("sidecar 启动失败: {}", e);
                    eprintln!("[HexClaw] sidecar 启动失败: {}", e);
                }
            }

            // 异步健康检查，等待 sidecar 就绪
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
            commands::check_engine_health,
            commands::proxy_api_request,
            commands::stream_chat,
            commands::backend_chat,
            commands::restart_sidecar,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    sidecar::stop_sidecar();
                }
            }
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("HexClaw Desktop 启动失败: {}", e);
            std::process::exit(1);
        });
}
