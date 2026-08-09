import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = process.cwd()
const read = (path) => readFileSync(join(root, path), 'utf8')

test('DESKTOP-UNSIGNED-CASK-CRED-001: Provider startup uses owner YAML and never accesses Keychain', () => {
  const coordinator = read('src-tauri/src/provider_credentials.rs')
  const providerSecrets = read('src/stores/settings-provider-secrets.ts')
  const startup = coordinator.slice(
    coordinator.indexOf('pub async fn get_llm_config_with_credentials'),
    coordinator.indexOf('/// Hydrates only a newly supplied secret'),
  )

  assert.doesNotMatch(startup, /hydrate_saved_credentials|credential_vault::read_secret/)
  assert.doesNotMatch(coordinator, /credential_vault::(?:read_secret|write_secret|remove_secret)/)
  assert.doesNotMatch(providerSecrets, /credentialPresent\(/)
  assert.doesNotMatch(providerSecrets, /(?:putCredential|deleteCredential|loadSecureValue|saveSecureValue)/)
  assert.doesNotMatch(providerSecrets, /(?:localStorage|sessionStorage|secure\.dat)/)
  assert.match(coordinator, /get_config\(&client\)\.await/)
  assert.match(coordinator, /put_config\(&client, &config, &request_id\)/)
})

test('DESKTOP-UNSIGNED-CASK-CRED-003: Native coordinator has no second persistence path', () => {
  const coordinator = read('src-tauri/src/provider_credentials.rs')

  assert.doesNotMatch(coordinator, /PENDING_CONFIG_FILE|PendingConfigMutation|write_pending|load_pending/)
  assert.match(coordinator, /credentials\/hydrate/)
  assert.match(coordinator, /credentials\/dehydrate/)
  assert.match(coordinator, /provider-credentials\/reserve/)
  assert.doesNotMatch(coordinator, /(?:credential_vault|keyring)::/)
})
