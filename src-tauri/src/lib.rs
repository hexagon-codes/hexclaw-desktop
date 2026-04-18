// HexClaw Desktop — Tauri 应用库入口
//
// 模块划分:
//   commands  — 前端可调用的 Tauri commands
//   sidecar   — hexclaw 进程生命周期管理
//   ollama    — Ollama 本地推理引擎管理
//   tray      — 系统托盘
//   window    — 窗口管理 + 全局快捷键

pub mod commands;
pub mod menu;
pub mod ollama;
pub mod sidecar;
pub mod tray;
pub mod window;

/// 运行 Tauri 应用
///
/// 初始化顺序:
///   1. 注册插件 (shell, notification, updater, global-shortcut, single-instance)
///   2. setup: 系统托盘 → sidecar 启动 → 快捷键注册 → 窗口关闭行为
///   3. 注册 commands
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 收紧文件创建权限: 新文件默认 0600, 新目录默认 0700
    #[cfg(unix)]
    {
        unsafe { libc::umask(0o077); }
    }

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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 已有实例运行时，聚焦主窗口
            crate::window::show_main_window(app);
        }))
        // 全局状态
        .manage(sidecar::SidecarState::default())
        .manage(ollama::OllamaState::default())
        // 初始化
        .setup(|app| {
            eprintln!("[HexClaw] setup 开始...");

            menu::setup(app)?;

            // 系统托盘
            tray::setup(app)?;

            // 启动 Ollama 本地推理引擎（优先复用外部实例，否则启动内嵌二进制）
            let ollama_started = match ollama::spawn_ollama(&app.handle()) {
                Ok(()) => {
                    log::info!("Ollama 进程就绪");
                    eprintln!("[HexClaw] Ollama 进程就绪 (managed={})", ollama::is_managed());
                    true
                }
                Err(e) => {
                    log::warn!("Ollama 启动失败（可选依赖，不阻塞）: {}", e);
                    eprintln!("[HexClaw] Ollama 启动失败: {}", e);
                    false
                }
            };

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

            // 异步健康检查
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // Ollama 健康检查（不阻塞 sidecar，并行执行）
                    if ollama_started {
                        let h = handle.clone();
                        tokio::spawn(async move {
                            ollama::wait_for_healthy(h, 15).await;
                        });
                    }
                    // sidecar 健康检查
                    if sidecar_started {
                        sidecar::wait_for_healthy(handle, 30).await;
                    }
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
            commands::get_ollama_status,
            commands::restart_ollama,
            commands::save_file_from_url,
            commands::save_bytes_to_path,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    ollama::stop_ollama();
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
