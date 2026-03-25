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

use tauri_plugin_sql::{Migration, MigrationKind};

/// 数据库迁移脚本
fn include_migrations() -> Vec<Migration> {
    vec![
        Migration {
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
        },
        Migration {
            version: 2,
            description: "create knowledge docs read-only cache",
            sql: "
                CREATE TABLE IF NOT EXISTS knowledge_docs_cache (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    source TEXT,
                    chunk_count INTEGER NOT NULL DEFAULT 0,
                    status TEXT,
                    error_message TEXT,
                    source_type TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT,
                    cached_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                CREATE TABLE IF NOT EXISTS knowledge_cache_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "create artifacts table and app_state",
            sql: "
                CREATE TABLE IF NOT EXISTS artifacts (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    message_id TEXT NOT NULL,
                    type TEXT NOT NULL DEFAULT 'code',
                    title TEXT NOT NULL,
                    language TEXT,
                    content TEXT NOT NULL,
                    previous_content TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id);
                CREATE INDEX IF NOT EXISTS idx_artifacts_message ON artifacts(message_id);

                CREATE TABLE IF NOT EXISTS app_state (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "production-grade session and message fields",
            sql: "
                -- sessions: 软删除 + 冗余统计 + 扩展元数据
                ALTER TABLE sessions ADD COLUMN status INTEGER NOT NULL DEFAULT 1;
                ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE sessions ADD COLUMN total_prompt_tokens INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE sessions ADD COLUMN total_completion_tokens INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE sessions ADD COLUMN last_message_preview TEXT NOT NULL DEFAULT '';
                ALTER TABLE sessions ADD COLUMN meta TEXT NOT NULL DEFAULT '{}';

                -- messages: 模型/成本/性能追踪 + 幂等 + 多模态 + 扩展
                ALTER TABLE messages ADD COLUMN content_type TEXT NOT NULL DEFAULT 'text';
                ALTER TABLE messages ADD COLUMN model_name TEXT NOT NULL DEFAULT '';
                ALTER TABLE messages ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE messages ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE messages ADD COLUMN finish_reason TEXT NOT NULL DEFAULT '';
                ALTER TABLE messages ADD COLUMN latency_ms INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE messages ADD COLUMN request_id TEXT NOT NULL DEFAULT '';
                ALTER TABLE messages ADD COLUMN meta TEXT NOT NULL DEFAULT '{}';
                ALTER TABLE messages ADD COLUMN parent_id TEXT NOT NULL DEFAULT '';
                ALTER TABLE messages ADD COLUMN feedback TEXT NOT NULL DEFAULT '';

                -- 索引
                CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, updated_at);
                CREATE INDEX IF NOT EXISTS idx_messages_request_id ON messages(request_id);
                CREATE INDEX IF NOT EXISTS idx_messages_parent_id ON messages(parent_id);
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "message outbox for offline queue",
            sql: "
                CREATE TABLE IF NOT EXISTS message_outbox (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    content TEXT NOT NULL,
                    attachments TEXT NOT NULL DEFAULT '[]',
                    status TEXT NOT NULL DEFAULT 'pending',
                    retry_count INTEGER NOT NULL DEFAULT 0,
                    error TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                CREATE INDEX IF NOT EXISTS idx_outbox_status ON message_outbox(status);
            ",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "prompt template library",
            sql: "
                CREATE TABLE IF NOT EXISTS prompt_templates (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    category TEXT NOT NULL DEFAULT '',
                    use_count INTEGER NOT NULL DEFAULT 0,
                    pinned INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                CREATE INDEX IF NOT EXISTS idx_templates_category ON prompt_templates(category);
                CREATE INDEX IF NOT EXISTS idx_templates_pinned ON prompt_templates(pinned DESC, use_count DESC);
            ",
            kind: MigrationKind::Up,
        },
    ]
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

    let app = tauri::Builder::default()
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
            crate::window::show_main_window(app);
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
            let sidecar_started = match sidecar::spawn_sidecar(&app.handle()) {
                Ok(()) => {
                    log::info!("sidecar 进程已启动");
                    eprintln!("[HexClaw] sidecar 进程已启动");
                    true
                }
                Err(e) => {
                    log::error!("sidecar 启动失败: {}", e);
                    eprintln!("[HexClaw] sidecar 启动失败: {}", e);
                    false
                }
            };

            // 异步健康检查，等待 sidecar 就绪
            if sidecar_started {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    sidecar::wait_for_healthy(handle, 30).await;
                });
            }

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
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("HexClaw Desktop 启动失败: {}", e);
            std::process::exit(1);
        });

    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        match event {
            tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } => {
                if !has_visible_windows {
                    crate::window::show_main_window(app_handle);
                }
            }
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                if crate::window::consume_app_exit_request() {
                    return;
                }

                let _ = code;
                api.prevent_exit();
                crate::window::hide_app_to_background(app_handle);
            }
            _ => {}
        }
    });
}
