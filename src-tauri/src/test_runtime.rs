use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

pub const TEST_MODE_ENV: &str = "HEXCLAW_TEST_MODE";
pub const TEST_HOME_ENV: &str = "HEXCLAW_TEST_HOME";
pub const TEST_SIDECAR_PORT_ENV: &str = "HEXCLAW_SIDECAR_PORT";
pub const TEST_LLM_CONFIG_MODE_ENV: &str = "HEXCLAW_TEST_LLM_CONFIG_MODE";
pub const TEST_PROFILE_CATCHUP_ENV: &str = "HEXCLAW_TEST_PROFILE_CATCHUP";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TestLLMConfigMode {
    Missing,
    ExplicitEmpty,
}

fn test_llm_config_mode(value: Option<&str>) -> Result<TestLLMConfigMode, String> {
    match value.unwrap_or("missing") {
        "missing" => Ok(TestLLMConfigMode::Missing),
        "explicit-empty" => Ok(TestLLMConfigMode::ExplicitEmpty),
        invalid => Err(format!(
            "{TEST_LLM_CONFIG_MODE_ENV} must be missing or explicit-empty, got {invalid:?}"
        )),
    }
}

fn test_profile_catchup_enabled(value: Option<&str>) -> Result<bool, String> {
    match value.unwrap_or("0") {
        "0" => Ok(false),
        "1" => Ok(true),
        invalid => Err(format!(
            "{TEST_PROFILE_CATCHUP_ENV} must be 0 or 1, got {invalid:?}"
        )),
    }
}

static SYSTEM_USER_HOME: OnceLock<Option<PathBuf>> = OnceLock::new();

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TestRunContext {
    pub home: PathBuf,
    pub sidecar_port: u16,
}

impl TestRunContext {
    pub fn config_path(&self) -> PathBuf {
        self.home.join(".hexclaw").join("hexclaw.yaml")
    }

    pub fn artifact_dir(&self) -> PathBuf {
        self.home.join("artifacts")
    }

    #[cfg(target_os = "macos")]
    pub fn shell_config_dir(&self) -> PathBuf {
        self.home.join("Library").join("Application Support")
    }

    #[cfg(target_os = "macos")]
    pub fn shell_data_dir(&self) -> PathBuf {
        self.shell_config_dir()
    }

    #[cfg(target_os = "macos")]
    pub fn shell_cache_dir(&self) -> PathBuf {
        self.home.join("Library").join("Caches")
    }

    #[cfg(target_os = "macos")]
    pub fn shell_log_dir(&self) -> PathBuf {
        self.home.join("Library").join("Logs")
    }

    #[cfg(target_os = "windows")]
    pub fn shell_config_dir(&self) -> PathBuf {
        self.home.join("AppData").join("Roaming")
    }

    #[cfg(target_os = "windows")]
    pub fn shell_data_dir(&self) -> PathBuf {
        self.shell_config_dir()
    }

    #[cfg(target_os = "windows")]
    pub fn shell_cache_dir(&self) -> PathBuf {
        self.home.join("AppData").join("Local")
    }

    #[cfg(target_os = "windows")]
    pub fn shell_log_dir(&self) -> PathBuf {
        self.shell_cache_dir().join("Logs")
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    pub fn shell_config_dir(&self) -> PathBuf {
        self.home.join(".config")
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    pub fn shell_data_dir(&self) -> PathBuf {
        self.home.join(".local").join("share")
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    pub fn shell_cache_dir(&self) -> PathBuf {
        self.home.join(".cache")
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    pub fn shell_log_dir(&self) -> PathBuf {
        self.home.join(".local").join("state").join("logs")
    }
}

fn system_user_home() -> Option<&'static Path> {
    SYSTEM_USER_HOME
        .get_or_init(discover_system_user_home)
        .as_deref()
}

#[cfg(unix)]
fn discover_system_user_home() -> Option<PathBuf> {
    use std::ffi::{CStr, OsStr};
    use std::os::unix::ffi::OsStrExt;

    // SAFETY: getpwuid returns either null or a process-global passwd entry.
    // Copy pw_dir into an owned PathBuf before returning it.
    unsafe {
        let passwd = libc::getpwuid(libc::getuid());
        if passwd.is_null() || (*passwd).pw_dir.is_null() {
            return None;
        }

        let home = CStr::from_ptr((*passwd).pw_dir);
        Some(PathBuf::from(OsStr::from_bytes(home.to_bytes())))
    }
}

#[cfg(not(unix))]
fn discover_system_user_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn protected_user_paths(home: &Path) -> [PathBuf; 4] {
    [
        home.join(".hexclaw"),
        home.join("Library")
            .join("Application Support")
            .join("com.hexclaw.desktop"),
        home.join("Library")
            .join("Application Support")
            .join("com.hexclaw.desktop.mock"),
        home.join("Library")
            .join("Application Support")
            .join("com.everyday-items.hexclaw"),
    ]
}

fn resolve_existing_ancestor(requested: &Path) -> Result<PathBuf, String> {
    let mut cursor = requested;
    let mut missing_tail = Vec::<OsString>::new();
    let resolved_ancestor = loop {
        match std::fs::canonicalize(cursor) {
            Ok(path) => break path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = cursor.file_name().ok_or_else(|| {
                    format!(
                        "failed to find an existing ancestor for {TEST_HOME_ENV} {}",
                        requested.display()
                    )
                })?;
                missing_tail.push(name.to_os_string());
                cursor = cursor.parent().ok_or_else(|| {
                    format!(
                        "failed to find an existing ancestor for {TEST_HOME_ENV} {}",
                        requested.display()
                    )
                })?;
            }
            Err(error) => {
                return Err(format!(
                    "failed to resolve {TEST_HOME_ENV} {}: {error}",
                    requested.display()
                ))
            }
        }
    };

    Ok(missing_tail
        .into_iter()
        .rev()
        .fold(resolved_ancestor, |path, component| path.join(component)))
}

fn resolve_safe_test_home(raw: &str) -> Result<PathBuf, String> {
    let requested = PathBuf::from(raw);
    if !requested.is_absolute() {
        return Err(format!("{TEST_HOME_ENV} must be an absolute path"));
    }
    if requested
        .components()
        .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(format!(
            "{TEST_HOME_ENV} must be a canonical path without . or .. components"
        ));
    }

    let resolved = resolve_existing_ancestor(&requested)?;
    if resolved.parent().is_none() {
        return Err(format!("{TEST_HOME_ENV} cannot be a filesystem root"));
    }
    if let Some(user_home) = system_user_home() {
        let canonical_user_home =
            std::fs::canonicalize(user_home).unwrap_or_else(|_| user_home.to_path_buf());
        if canonical_user_home.starts_with(&resolved) || resolved.starts_with(&canonical_user_home) {
            return Err(format!(
                "{TEST_HOME_ENV} cannot be the real user home, an ancestor, or a descendant"
            ));
        }
        if protected_user_paths(&canonical_user_home).iter().any(|path| {
            let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
            resolved.starts_with(&path) || path.starts_with(&resolved)
        }) {
            return Err(format!(
                "{TEST_HOME_ENV} cannot overlap a real HexClaw user-data path"
            ));
        }
    }
    Ok(resolved)
}

pub fn parse_test_run_context(
    test_mode: Option<&str>,
    test_home: Option<&str>,
    sidecar_port: Option<&str>,
) -> Result<Option<TestRunContext>, String> {
    if test_mode != Some("1") {
        return Ok(None);
    }

    let home = test_home
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{TEST_HOME_ENV} is required when {TEST_MODE_ENV}=1"))?;
    let home = resolve_safe_test_home(home)?;

    let raw_port = sidecar_port
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{TEST_SIDECAR_PORT_ENV} is required when {TEST_MODE_ENV}=1"))?;
    let port = raw_port
        .parse::<u16>()
        .map_err(|_| format!("{TEST_SIDECAR_PORT_ENV} must be a valid TCP port"))?;
    if port < 1024 {
        return Err(format!(
            "{TEST_SIDECAR_PORT_ENV} must be an unprivileged port"
        ));
    }

    Ok(Some(TestRunContext {
        home,
        sidecar_port: port,
    }))
}

pub fn current() -> Result<Option<TestRunContext>, String> {
    let mode = std::env::var(TEST_MODE_ENV).ok();
    let home = std::env::var(TEST_HOME_ENV).ok();
    let port = std::env::var(TEST_SIDECAR_PORT_ENV).ok();
    parse_test_run_context(mode.as_deref(), home.as_deref(), port.as_deref())
}

pub fn is_enabled() -> bool {
    std::env::var(TEST_MODE_ENV).ok().as_deref() == Some("1")
}

pub fn should_start_managed_ollama_for(test_mode: Option<&str>) -> bool {
    test_mode != Some("1")
}

pub fn should_start_managed_ollama() -> bool {
    let mode = std::env::var(TEST_MODE_ENV).ok();
    should_start_managed_ollama_for(mode.as_deref())
}

pub fn ensure_sandbox_dirs(ctx: &TestRunContext) -> Result<(), String> {
    for path in [
        &ctx.home,
        &ctx.home.join("tmp"),
        ctx.config_path().parent().unwrap_or(Path::new(".")),
        &ctx.artifact_dir(),
        &ctx.shell_config_dir(),
        &ctx.shell_data_dir(),
        &ctx.shell_cache_dir(),
        &ctx.shell_log_dir(),
    ] {
        std::fs::create_dir_all(path)
            .map_err(|err| format!("failed to create test sandbox {}: {err}", path.display()))?;
    }
    Ok(())
}

pub fn prepare_shell_path_isolation() -> Result<Option<TestRunContext>, String> {
    let Some(ctx) = current()? else {
        return Ok(None);
    };
    ensure_sandbox_dirs(&ctx)?;

    std::env::set_var("HOME", &ctx.home);
    std::env::set_var("USERPROFILE", &ctx.home);
    std::env::set_var("TMPDIR", ctx.home.join("tmp"));
    std::env::set_var("TEMP", ctx.home.join("tmp"));
    std::env::set_var("TMP", ctx.home.join("tmp"));
    std::env::set_var("XDG_CONFIG_HOME", ctx.shell_config_dir());
    std::env::set_var("XDG_DATA_HOME", ctx.shell_data_dir());
    std::env::set_var("XDG_CACHE_HOME", ctx.shell_cache_dir());
    std::env::set_var("XDG_STATE_HOME", ctx.shell_log_dir());
    std::env::set_var("APPDATA", ctx.shell_config_dir());
    std::env::set_var("LOCALAPPDATA", ctx.shell_cache_dir());
    #[cfg(target_os = "macos")]
    std::env::set_var("CFFIXED_USER_HOME", &ctx.home);

    Ok(Some(ctx))
}

pub fn render_test_config(ctx: &TestRunContext) -> String {
    render_test_config_with_llm_mode(ctx, TestLLMConfigMode::Missing)
}

fn render_test_config_with_llm_mode(ctx: &TestRunContext, llm_mode: TestLLMConfigMode) -> String {
    let sqlite_path = ctx.home.join(".hexclaw").join("data.db");
    let sqlite_path = serde_json::to_string(&sqlite_path.to_string_lossy())
        .expect("serializing a filesystem path cannot fail");
    let mut yaml = format!(
        "server:\n  host: 127.0.0.1\n  port: {}\n\
storage:\n  driver: sqlite\n  sqlite:\n    path: {}\n\
heartbeat:\n  enabled: false\n\
mcp:\n  enabled: false\n\
skills:\n  enabled: false\n\
voice:\n  enabled: false\n\
skill:\n  sandbox:\n    enabled: false\n  builtin:\n    search: false\n    weather: false\n    browser: false\n    code_exec: false\n    file_ops: false\n",
        ctx.sidecar_port, sqlite_path
    );
    if llm_mode == TestLLMConfigMode::ExplicitEmpty {
        yaml.push_str("llm:\n  providers: {}\n");
    }
    yaml
}

pub fn write_test_config(ctx: &TestRunContext) -> Result<(), String> {
    ensure_sandbox_dirs(ctx)?;
    let path = ctx.config_path();
    let llm_mode = test_llm_config_mode(std::env::var(TEST_LLM_CONFIG_MODE_ENV).ok().as_deref())?;
    std::fs::write(&path, render_test_config_with_llm_mode(ctx, llm_mode))
        .map_err(|err| format!("failed to write test config {}: {err}", path.display()))?;
    if test_profile_catchup_enabled(std::env::var(TEST_PROFILE_CATCHUP_ENV).ok().as_deref())? {
        prepare_profile_catchup_fixture(ctx)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|err| format!("failed to protect test config {}: {err}", path.display()))?;
    }
    Ok(())
}

fn prepare_profile_catchup_fixture(ctx: &TestRunContext) -> Result<(), String> {
    let memory_dir = ctx.home.join(".hexclaw").join("memory");
    let global_dir = memory_dir.join("_global");
    std::fs::create_dir_all(&global_dir)
        .map_err(|err| format!("failed to create profile catch-up fixture directory: {err}"))?;
    std::fs::write(
        global_dir.join("MEMORY.md"),
        concat!(
            "- [09:00] [fact:manual] 用户偏好用中文交流。\n",
            "- [09:01] [fact:manual] 用户的项目使用本地测试。\n",
            "- [09:02] [fact:manual] 用户习惯先验证后再提交。\n",
        ),
    )
    .map_err(|err| format!("failed to write profile catch-up facts: {err}"))?;
    std::fs::write(
        memory_dir.join(".phase_state.json"),
        "{\n  \"profile\": \"2000-01-01T00:00:00Z\"\n}\n",
    )
    .map_err(|err| format!("failed to write profile catch-up clock: {err}"))?;
    Ok(())
}

pub fn configure_child_command(command: &mut Command, ctx: &TestRunContext) {
    // Test mode starts from an empty environment. A denylist inevitably misses
    // credentials such as AWS_ACCESS_KEY_ID, GOOGLE_APPLICATION_CREDENTIALS,
    // and AZURE_CLIENT_SECRET. The caller adds only runtime-specific values
    // (for example its enriched PATH and resource directory) after this step.
    command
        .env_clear()
        .env("HOME", &ctx.home)
        .env("USERPROFILE", &ctx.home)
        .env("TMPDIR", ctx.home.join("tmp"))
        .env("TEMP", ctx.home.join("tmp"))
        .env("TMP", ctx.home.join("tmp"))
        .env(TEST_MODE_ENV, "1")
        .env(TEST_HOME_ENV, &ctx.home)
        .env(TEST_SIDECAR_PORT_ENV, ctx.sidecar_port.to_string())
        .env("NO_PROXY", "*")
        .env("no_proxy", "*");

    #[cfg(target_os = "windows")]
    for key in ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_run_context_requires_exact_opt_in() {
        assert!(parse_test_run_context(None, None, None)
            .expect("disabled context should be valid")
            .is_none());
        assert!(
            parse_test_run_context(Some("true"), Some("/tmp/hexclaw-test"), Some("16061"))
                .expect("non-exact opt-in must stay disabled")
                .is_none()
        );
        assert!(should_start_managed_ollama_for(None));
        assert!(should_start_managed_ollama_for(Some("true")));
        assert!(!should_start_managed_ollama_for(Some("1")));
    }

    #[test]
    fn test_run_context_requires_an_absolute_isolated_home() {
        let missing = parse_test_run_context(Some("1"), None, Some("16061"))
            .expect_err("enabled test mode without a home must fail closed");
        assert!(missing.contains("HEXCLAW_TEST_HOME"));

        let relative = parse_test_run_context(Some("1"), Some("relative/home"), Some("16061"))
            .expect_err("relative test home could escape the run sandbox");
        assert!(relative.contains("absolute"));
    }

    #[test]
    fn test_run_context_rejects_invalid_or_privileged_ports() {
        for port in [None, Some("abc"), Some("0"), Some("443"), Some("65536")] {
            assert!(
                parse_test_run_context(Some("1"), Some("/tmp/hexclaw-test"), port).is_err(),
                "port {port:?} must be rejected"
            );
        }
    }

    #[test]
    fn test_run_context_derives_all_mutable_paths_from_the_sandbox() {
        let expected_home =
            resolve_existing_ancestor(Path::new("/tmp/hexclaw-test/run-42"))
                .expect("canonical test home");
        let ctx =
            parse_test_run_context(Some("1"), Some("/tmp/hexclaw-test/run-42"), Some("16061"))
                .expect("valid test context")
                .expect("test context enabled");

        assert_eq!(ctx.home, expected_home);
        assert_eq!(ctx.sidecar_port, 16061);
        assert_eq!(ctx.config_path(), ctx.home.join(".hexclaw/hexclaw.yaml"));
        assert_eq!(ctx.artifact_dir(), ctx.home.join("artifacts"));
    }

    #[test]
    fn test_runtime_config_is_loopback_only_and_disables_background_egress() {
        let ctx = TestRunContext {
            home: PathBuf::from("/tmp/hexclaw-test/run-42"),
            sidecar_port: 16061,
        };
        let yaml = render_test_config(&ctx);

        assert!(yaml.contains("host: 127.0.0.1"));
        assert!(yaml.contains("port: 16061"));
        assert!(yaml.contains("/tmp/hexclaw-test/run-42/.hexclaw/data.db"));
        assert!(yaml.contains("heartbeat:\n  enabled: false"));
        assert!(yaml.contains("mcp:\n  enabled: false"));
        assert!(yaml.contains("skills:\n  enabled: false"));
        assert!(yaml.contains("voice:\n  enabled: false"));
    }

    #[test]
    fn test_runtime_explicit_empty_llm_mode_is_an_explicit_empty_provider_map() {
        let ctx = TestRunContext {
            home: PathBuf::from("/tmp/hexclaw-test/run-42"),
            sidecar_port: 16061,
        };

        let yaml = render_test_config_with_llm_mode(&ctx, TestLLMConfigMode::ExplicitEmpty);
        assert!(yaml.contains("llm:\n  providers: {}\n"));
        assert!(!yaml.contains("llm:\n  providers:\n"));
        assert_eq!(
            test_llm_config_mode(Some("explicit-empty")).expect("explicit empty mode"),
            TestLLMConfigMode::ExplicitEmpty
        );
        assert!(test_llm_config_mode(Some("provider-from-host")).is_err());
    }

    #[test]
    fn test_runtime_profile_catchup_fixture_has_three_facts_and_an_overdue_clock() {
        let root = std::env::temp_dir().join(format!(
            "hexclaw-profile-catchup-fixture-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let ctx = TestRunContext {
            home: root.clone(),
            sidecar_port: 16061,
        };

        prepare_profile_catchup_fixture(&ctx).expect("write profile catch-up fixture");
        let memory = std::fs::read_to_string(root.join(".hexclaw/memory/_global/MEMORY.md"))
            .expect("read profile facts");
        assert_eq!(memory.matches("[fact:manual]").count(), 3);
        assert_eq!(
            std::fs::read_to_string(root.join(".hexclaw/memory/.phase_state.json"))
                .expect("read profile clock"),
            "{\n  \"profile\": \"2000-01-01T00:00:00Z\"\n}\n"
        );
        assert!(test_profile_catchup_enabled(Some("1")).expect("enabled"));
        assert!(test_profile_catchup_enabled(Some("true")).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn test_runtime_removes_secrets_and_proxy_inheritance_from_child_command() {
        let ctx = TestRunContext {
            home: PathBuf::from("/tmp/hexclaw-test/run-42"),
            sidecar_port: 16061,
        };
        let mut command = std::process::Command::new("hexclaw");
        command
            .env("OPENAI_API_KEY", "must-not-leak")
            .env("HTTPS_PROXY", "http://real-proxy.invalid")
            .env("AWS_ACCESS_KEY_ID", "aws-must-not-leak")
            .env(
                "GOOGLE_APPLICATION_CREDENTIALS",
                "/real/google-credentials.json",
            )
            .env("AZURE_CLIENT_SECRET", "azure-must-not-leak")
            .env("SSH_AUTH_SOCK", "/real/ssh-agent.sock")
            .env("UNRELATED_PARENT_SETTING", "must-not-be-inherited");

        configure_child_command(&mut command, &ctx);
        let values = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect::<std::collections::HashMap<_, _>>();

        assert_eq!(
            values.get("HOME"),
            Some(&Some(ctx.home.display().to_string()))
        );
        assert_eq!(values.get(TEST_MODE_ENV), Some(&Some("1".to_string())));
        assert!(!values.contains_key("OPENAI_API_KEY"));
        assert!(!values.contains_key("HTTPS_PROXY"));
        assert!(!values.contains_key("AWS_ACCESS_KEY_ID"));
        assert!(!values.contains_key("GOOGLE_APPLICATION_CREDENTIALS"));
        assert!(!values.contains_key("AZURE_CLIENT_SECRET"));
        assert!(!values.contains_key("SSH_AUTH_SOCK"));
        assert!(!values.contains_key("UNRELATED_PARENT_SETTING"));
        assert_eq!(values.get("NO_PROXY"), Some(&Some("*".to_string())));
        assert_eq!(
            values.get("TMPDIR"),
            Some(&Some(ctx.home.join("tmp").display().to_string()))
        );
    }
}

#[cfg(test)]
mod bug_20260727_003_test_home_isolation_regression {
    use super::parse_test_run_context;
    use std::{
        env,
        fs,
        path::PathBuf,
        process::Command,
    };

    fn isolated_root(label: &str) -> PathBuf {
        let root = env::temp_dir().join(format!(
            "hexclaw-bug-20260727-003-{label}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create isolated test root");
        root
    }

    #[test]
    fn bug_20260727_003_rejects_real_user_home_before_tauri_initialization() {
        let real_home = env::var("HOME").expect("real HOME must exist");

        let result = parse_test_run_context(Some("1"), Some(&real_home), Some("16121"));
        assert!(
            result.is_err(),
            "BUG-20260727-003: the real user HOME must fail closed as HEXCLAW_TEST_HOME"
        );
    }

    #[test]
    fn bug_20260727_003_rejects_any_descendant_of_the_system_user_home() {
        let real_home = PathBuf::from(env::var_os("HOME").expect("real HOME must exist"));
        let requested = real_home
            .join("bug-20260727-003-must-not-use-real-home")
            .to_string_lossy()
            .into_owned();

        let result = parse_test_run_context(Some("1"), Some(&requested), Some("16121"));
        assert!(
            result.is_err(),
            "BUG-20260727-003: a descendant of the system user home must fail closed"
        );
    }

    #[test]
    fn bug_20260727_003_preisolated_environment_home_remains_a_valid_test_home() {
        const CHILD_MARKER: &str = "HEXCLAW_BUG003_PREISOLATED_CHILD";
        if env::var_os(CHILD_MARKER).is_some() {
            let isolated_home = env::var("HOME").expect("preisolated child HOME");
            parse_test_run_context(Some("1"), Some(&isolated_home), Some("16121"))
                .expect("preisolated HOME must not be mistaken for the system account home")
                .expect("test context enabled");
            return;
        }

        let root = isolated_root("preisolated-environment");
        let status = Command::new(env::current_exe().expect("current Rust test executable"))
            .args([
                "--exact",
                "test_runtime::bug_20260727_003_test_home_isolation_regression::bug_20260727_003_preisolated_environment_home_remains_a_valid_test_home",
                "--test-threads=1",
            ])
            .env(CHILD_MARKER, "1")
            .env("HOME", &root)
            .env("CFFIXED_USER_HOME", &root)
            .status()
            .expect("spawn preisolated Rust child");
        let _ = fs::remove_dir_all(root);
        assert!(
            status.success(),
            "BUG-20260727-003: a harness-preisolated HOME must remain valid"
        );
    }

    #[cfg(unix)]
    #[test]
    fn bug_20260727_003_rejects_symlink_that_resolves_to_real_user_home() {
        use std::os::unix::fs::symlink;

        let real_home = PathBuf::from(env::var_os("HOME").expect("real HOME must exist"));
        let root = isolated_root("symlink");
        let link = root.join("test-home");
        symlink(&real_home, &link).expect("create HOME symlink");
        let link_string = link.to_string_lossy().into_owned();

        let result = parse_test_run_context(Some("1"), Some(&link_string), Some("16121"));
        let _ = fs::remove_dir_all(root);
        assert!(
            result.is_err(),
            "BUG-20260727-003: a symlink resolving to the real user HOME must fail closed"
        );
    }

    #[cfg(unix)]
    #[test]
    fn bug_20260727_003_rejects_missing_test_home_below_symlinked_real_home() {
        use std::os::unix::fs::symlink;

        let real_home = PathBuf::from(env::var_os("HOME").expect("real HOME must exist"));
        let root = isolated_root("symlink-parent");
        let link = root.join("parent");
        symlink(&real_home, &link).expect("create HOME parent symlink");
        let requested = link.join("not-created-test-home");
        let requested = requested.to_string_lossy().into_owned();

        let result = parse_test_run_context(Some("1"), Some(&requested), Some("16121"));
        let _ = fs::remove_dir_all(root);
        assert!(
            result.is_err(),
            "BUG-20260727-003: a missing test home below a symlinked real HOME must fail closed"
        );
    }

    #[test]
    fn bug_20260727_003_requires_canonical_absolute_test_home() {
        let root = isolated_root("canonical");
        let canonical = root.join("sandbox");
        let parent = root.join("parent");
        fs::create_dir_all(&canonical).expect("create canonical sandbox");
        fs::create_dir_all(&parent).expect("create parent");
        let non_canonical = parent.join("..").join("sandbox");
        let non_canonical = non_canonical.to_string_lossy().into_owned();

        let result = parse_test_run_context(Some("1"), Some(&non_canonical), Some("16121"));
        let _ = fs::remove_dir_all(root);
        assert!(
            result.is_err(),
            "BUG-20260727-003: non-canonical HEXCLAW_TEST_HOME must fail closed, not be silently accepted"
        );
    }

    #[test]
    fn bug_20260727_003_derives_every_shell_write_root_from_test_home() {
        let root = isolated_root("shell-roots");
        let root_string = root.to_string_lossy().into_owned();
        let ctx = parse_test_run_context(Some("1"), Some(&root_string), Some("16121"))
            .expect("safe test home")
            .expect("test mode context");

        super::ensure_sandbox_dirs(&ctx).expect("create isolated shell roots");
        for path in [
            ctx.config_path(),
            ctx.artifact_dir(),
            ctx.shell_config_dir(),
            ctx.shell_data_dir(),
            ctx.shell_cache_dir(),
            ctx.shell_log_dir(),
        ] {
            assert!(
                path.starts_with(&ctx.home),
                "BUG-20260727-003: {} escaped {}",
                path.display(),
                ctx.home.display()
            );
            let directory = if path.extension().is_some() {
                path.parent().expect("file parent")
            } else {
                path.as_path()
            };
            assert!(
                directory.is_dir(),
                "BUG-20260727-003: expected isolated directory {}",
                directory.display()
            );
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bug_20260727_003_shell_isolation_runs_before_tauri_builder() {
        let source = include_str!("lib.rs");
        let isolation = source
            .find("prepare_shell_path_isolation")
            .expect("BUG-20260727-003: lib::run must invoke the shell path isolator");
        let builder = source
            .find("tauri::Builder::default")
            .expect("Tauri builder marker");
        assert!(
            isolation < builder,
            "BUG-20260727-003: shell path isolation must run before Tauri builder/plugin initialization"
        );
    }
}
