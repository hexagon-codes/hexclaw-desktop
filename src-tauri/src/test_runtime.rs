use std::path::{Path, PathBuf};
use std::process::Command;

pub const TEST_MODE_ENV: &str = "HEXCLAW_TEST_MODE";
pub const TEST_HOME_ENV: &str = "HEXCLAW_TEST_HOME";
pub const TEST_SIDECAR_PORT_ENV: &str = "HEXCLAW_SIDECAR_PORT";

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
    let home = PathBuf::from(home);
    if !home.is_absolute() {
        return Err(format!("{TEST_HOME_ENV} must be an absolute path"));
    }

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
    ] {
        std::fs::create_dir_all(path)
            .map_err(|err| format!("failed to create test sandbox {}: {err}", path.display()))?;
    }
    Ok(())
}

pub fn render_test_config(ctx: &TestRunContext) -> String {
    let sqlite_path = ctx.home.join(".hexclaw").join("data.db");
    let sqlite_path = serde_json::to_string(&sqlite_path.to_string_lossy())
        .expect("serializing a filesystem path cannot fail");
    format!(
        "server:\n  host: 127.0.0.1\n  port: {}\n\
storage:\n  driver: sqlite\n  sqlite:\n    path: {}\n\
heartbeat:\n  enabled: false\n\
mcp:\n  enabled: false\n\
skills:\n  enabled: false\n\
voice:\n  enabled: false\n\
skill:\n  sandbox:\n    enabled: false\n  builtin:\n    search: false\n    weather: false\n    browser: false\n    code_exec: false\n    file_ops: false\n",
        ctx.sidecar_port, sqlite_path
    )
}

pub fn write_test_config(ctx: &TestRunContext) -> Result<(), String> {
    ensure_sandbox_dirs(ctx)?;
    let path = ctx.config_path();
    std::fs::write(&path, render_test_config(ctx))
        .map_err(|err| format!("failed to write test config {}: {err}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|err| format!("failed to protect test config {}: {err}", path.display()))?;
    }
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
        let ctx =
            parse_test_run_context(Some("1"), Some("/tmp/hexclaw-test/run-42"), Some("16061"))
                .expect("valid test context")
                .expect("test context enabled");

        assert_eq!(ctx.home, PathBuf::from("/tmp/hexclaw-test/run-42"));
        assert_eq!(ctx.sidecar_port, 16061);
        assert_eq!(
            ctx.config_path(),
            PathBuf::from("/tmp/hexclaw-test/run-42/.hexclaw/hexclaw.yaml")
        );
        assert_eq!(
            ctx.artifact_dir(),
            PathBuf::from("/tmp/hexclaw-test/run-42/artifacts")
        );
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
