use std::fs;

#[test]
fn bug_20260802_test_runtime_clears_environment_before_sidecar_capability_injection() {
    let source = fs::read_to_string("src/sidecar.rs").expect("read sidecar.rs");
    let configure = source
        .find("test_runtime::configure_child_command(&mut cmd, ctx)")
        .expect("test-runtime child configuration");
    let capability = source
        .find("cmd.env(SIDECAR_CAPABILITY_ENV, capability_token()?)")
        .expect("process-scoped Sidecar capability injection");

    assert!(
        configure < capability,
        "BUG-20260802-020: test-runtime env_clear must run before Rust injects the Sidecar capability"
    );
}
