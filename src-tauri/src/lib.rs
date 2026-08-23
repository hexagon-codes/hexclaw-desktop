// HexClaw Desktop — Tauri 应用库入口
//
// 模块划分:
//   commands  — 前端可调用的 Tauri commands
//   sidecar   — hexclaw 进程生命周期管理
//   ollama    — Ollama 本地推理引擎管理
//   tray      — 系统托盘
//   window    — 窗口管理 + 全局快捷键

use tauri::Manager;

pub mod autostart;
pub mod commands;
pub mod menu;
pub mod native_file;
pub mod native_print;
pub mod ollama;
pub mod print_coordinator;
pub mod provider_credentials;
pub mod sidecar;
pub(crate) mod sidecar_client;
pub mod sidecar_socket;
pub mod sidecar_stream;
pub(crate) mod sidecar_supervisor;
pub mod test_runtime;
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
        unsafe {
            libc::umask(0o077);
        }
    }

    test_runtime::prepare_shell_path_isolation()
        .unwrap_or_else(|err| panic!("test runtime path isolation refused startup: {err}"));

    sidecar::initialize_capability_token()
        .unwrap_or_else(|err| panic!("initialize Sidecar capability: {err}"));

    env_logger::init();

    let app = tauri::Builder::default()
        // 插件
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // macOS 必须注册 .app 登录项；LaunchAgent 只指向包内裸可执行文件，
        // 会在「登录项与扩展」里显示 hexclaw-desktop 和通用 exec 图标。
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::AppleScript,
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
        .manage(ollama::OllamaState::default())
        .manage(window::LifecycleState::default())
        .manage(native_file::NativeFileGrantRegistry::default())
        .manage(native_file::NativeFileTransferRegistry::default())
        .manage(print_coordinator::PrintOperationLocks::default())
        .manage(provider_credentials::ProviderCredentialCoordinator::default())
        .manage(commands::SidecarFetchRegistry::default())
        .manage(sidecar_socket::NativeSidecarSocketRegistry::default())
        .manage(sidecar_stream::NativeSidecarStreamRegistry::default())
        // 初始化
        .setup(|app| {
            eprintln!("[HexClaw] setup 开始...");

            if let Err(error) = native_file::prune_stale_staging_files(app.handle()) {
                log::warn!("清理遗留原生临时文件失败: {}", error);
            }

            if let Err(e) = autostart::migrate_legacy_macos_autostart(app.handle()) {
                log::warn!("旧版 macOS 自启项迁移失败，将保留原配置: {}", e);
            }

            menu::setup(app)?;
            test_runtime::setup_native_quit_test_harness(app)
                .map_err(|error| format!("native quit test harness setup: {error}"))?;

            // 系统托盘
            tray::setup(app)?;

            // 启动 Ollama 本地推理引擎（优先复用外部实例，否则启动内嵌二进制）
            let ollama_started = if test_runtime::should_start_managed_ollama() {
                match ollama::spawn_ollama(app.handle()) {
                    Ok(()) => {
                        log::info!("Ollama 进程就绪");
                        eprintln!(
                            "[HexClaw] Ollama 进程就绪 (managed={})",
                            ollama::is_managed()
                        );
                        true
                    }
                    Err(e) => {
                        log::warn!("Ollama 启动失败（可选依赖，不阻塞）: {}", e);
                        eprintln!("[HexClaw] Ollama 启动失败: {}", e);
                        false
                    }
                }
            } else {
                log::info!("测试沙箱模式：跳过用户 Ollama 探测与托管");
                false
            };

            // 启动 hexclaw sidecar 进程
            let sidecar_instance = match sidecar::spawn_sidecar(app.handle()) {
                Ok(instance) => {
                    log::info!("sidecar 进程已启动");
                    eprintln!("[HexClaw] sidecar 进程已启动");
                    Some(instance)
                }
                Err(e) => {
                    log::error!("sidecar 启动失败: {}", e);
                    eprintln!("[HexClaw] sidecar 启动失败: {}", e);
                    None
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
                    if let Some(instance) = sidecar_instance {
                        if let Err(error) = sidecar::wait_for_healthy(handle, 30, instance).await {
                            log::error!("sidecar 健康检查失败: {}", error);
                        }
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
            commands::sidecar_fetch,
            commands::sidecar_fetch_cancel,
            commands::proxy_api_request,
            sidecar_socket::sidecar_socket_open,
            sidecar_socket::sidecar_socket_send,
            sidecar_socket::sidecar_socket_close,
            sidecar_stream::sidecar_stream_open,
            sidecar_stream::sidecar_stream_cancel,
            commands::restart_sidecar,
            commands::get_ollama_status,
            commands::restart_ollama,
            native_file::pick_open_file_grant,
            native_file::pick_save_file_grant,
            native_file::create_staging_file_grant,
            native_file::append_file_grant_chunk,
            native_file::seal_file_grant,
            native_file::discard_file_grant,
            native_file::upload_file_grant,
            native_file::cancel_file_transfer,
            native_file::download_file_grant,
            native_file::copy_file_grant,
            native_file::render_artifact_to_grant,
            provider_credentials::get_llm_config_with_credentials,
            provider_credentials::apply_llm_config_with_credentials,
            provider_credentials::read_provider_api_key,
            print_coordinator::execute_print_job,
            commands::open_about,
            commands::set_autostart,
            commands::is_autostart_enabled,
        ])
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                let app = window.app_handle().clone();
                let window_label = window.label().to_owned();
                let paths = paths.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) =
                        native_file::issue_native_drop_grants(app, window_label, paths).await
                    {
                        log::warn!("native drop capability issuance failed: {}", error);
                    }
                });
            }
            tauri::WindowEvent::Destroyed if window.label() == "main" => {
                window::stop_background_engines();
            }
            _ => {}
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
                let _ = code;
                if crate::window::handle_system_quit_request(app_handle)
                    != crate::window::LifecycleDecision::Exit
                {
                    api.prevent_exit();
                }
            }
            _ => {}
        }
    });
}
