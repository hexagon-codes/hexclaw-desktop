<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { EyeOff } from 'lucide-vue-next'
import { invoke } from '@tauri-apps/api/core'
import { backendContext, backendPanelOpen, flushBackendDrafts, type BackendContext } from '@/services/backend-context'
import { useAppStore } from '@/stores/app'
import { useChatStore } from '@/stores/chat'
import { setClipboard } from '@/api/desktop'
import { INPUT_LIMITS, inputLimitError } from '@/utils/input-limits'

const app = useAppStore()
const { t } = useI18n()
const chat = useChatStore()
const kind = ref<'local' | 'remote'>('local')
const address = ref('')
const token = ref('')
const visible = ref(false)
const savedRemoteToken = ref('')
const remoteTokenLoading = ref(false)
const localToken = ref('')
const localVisible = ref(false)
const localCopied = ref(false)
const localTokenLoading = ref(false)
let localTokenRevision = 0
const pending = ref<'test' | 'connect' | null>(null)
const feedback = ref('')
const failed = ref(false)
const dialog = ref<HTMLElement>()
const saved = ref<BackendContext[]>([])
let editRevision = 0
let previousFocus: HTMLElement | null = null
const remote = computed(() => kind.value === 'remote')
const savedCandidate = computed(() => saved.value.find((record) => record.kind === 'remote' && record.apiBase.replace(/\/+$/, '') === address.value.trim().replace(/\/+$/, '')))
const hasToken = computed(() => !!token.value.trim() || !!savedCandidate.value?.hasToken)
const valid = computed(() => !remote.value || (!remoteTokenLoading.value && /^https?:\/\/[^\s]+$/.test(address.value.trim()) && hasToken.value))
const same = computed(() => kind.value === backendContext.value?.kind && (!remote.value || (address.value.trim().replace(/\/+$/, '') === backendContext.value.apiBase.replace(/\/+$/, '') && (!token.value || token.value === savedRemoteToken.value))))
const changesService = computed(() => kind.value !== backendContext.value?.kind || (remote.value && address.value.trim().replace(/\/+$/, '') !== backendContext.value?.apiBase.replace(/\/+$/, '')))
const currentLabel = computed(() => t(backendContext.value?.kind === 'remote' ? 'settings.service.cloudTitle' : 'settings.service.localTitle'))
const currentHost = computed(() => {
  try { return new URL(backendContext.value?.apiBase ?? '').host } catch { return '—' }
})
const connectLabel = computed(() => t(pending.value === 'connect' ? 'settings.service.connecting' : same.value && !app.sidecarReady ? 'settings.service.reconnect' : 'settings.service.saveAndSwitch'))

watch([kind, address, token], () => { editRevision++; feedback.value = ''; failed.value = false })
watch(backendPanelOpen, async (open, _previous, onCleanup) => {
  let active = true
  onCleanup(() => { active = false })
  if (!open) { token.value = ''; previousFocus?.focus(); return }
  previousFocus = document.activeElement as HTMLElement | null
  saved.value = []; address.value = ''
  kind.value = backendContext.value?.kind ?? 'local'
  pending.value = null; token.value = ''; feedback.value = ''; visible.value = false
  try {
    const records = await invoke<BackendContext[]>('get_backend_connections')
    if (!active) return
    saved.value = records
    address.value = (saved.value.find((record) => record.kind === 'remote' && record.connectionId === backendContext.value?.connectionId) ?? saved.value.find((record) => record.kind === 'remote'))?.apiBase ?? ''
  } catch { if (!active) return; saved.value = [] }
  await nextTick(); dialog.value?.focus()
})

// 令牌属于对应地址的保存记录；换目标清空，迟到读取不能覆盖新的输入。
watch([backendPanelOpen, kind, () => address.value.trim().replace(/\/+$/, ''), () => savedCandidate.value?.connectionId], async ([open, target, , connectionId], _previous, onCleanup) => {
  let active = true
  token.value = ''; savedRemoteToken.value = ''; visible.value = false
  remoteTokenLoading.value = false
  onCleanup(() => { active = false; token.value = ''; savedRemoteToken.value = '' })
  if (!open || target !== 'remote' || !connectionId) return
  remoteTokenLoading.value = true
  try {
    const value = await invoke<string>('get_remote_backend_token', { connectionId })
    if (!active) return
    savedRemoteToken.value = value; token.value = value
  } catch {
    if (!active) return
    feedback.value = t('settings.service.remoteTokenReadFailed'); failed.value = true
  } finally {
    if (active) remoteTokenLoading.value = false
  }
})

// 令牌仅在本机面板局部持有；关闭、换目标和卸载后丢弃迟到的读取结果。
watch([backendPanelOpen, kind], async ([open, target], _previous, onCleanup) => {
  const revision = ++localTokenRevision
  localToken.value = ''; localVisible.value = false; localCopied.value = false
  localTokenLoading.value = false
  onCleanup(() => { ++localTokenRevision; localToken.value = '' })
  if (!open || target !== 'local') return
  localTokenLoading.value = true
  try {
    const value = await invoke<string>('get_local_backend_token')
    if (revision !== localTokenRevision) return
    localToken.value = value
  } catch {
    if (revision !== localTokenRevision) return
    feedback.value = t('settings.service.localTokenReadFailed'); failed.value = true
  } finally {
    if (revision === localTokenRevision) localTokenLoading.value = false
  }
})

async function copyLocalToken() {
  if (!localToken.value || localTokenLoading.value) return
  const revision = localTokenRevision
  localCopied.value = false
  if (feedback.value === t('settings.service.copyFailed')) {
    feedback.value = ''; failed.value = false
  }
  try {
    await setClipboard(localToken.value, { localOnly: true })
    if (revision === localTokenRevision) localCopied.value = true
  } catch {
    if (revision !== localTokenRevision) return
    feedback.value = t('settings.service.copyFailed'); failed.value = true
  }
}

async function connect(test: boolean) {
  if (!valid.value || pending.value) return
  const limitError = remote.value
    ? inputLimitError(address.value, t('settings.service.url'), INPUT_LIMITS.urlBytes, { unit: 'bytes', original: savedCandidate.value?.apiBase }) ||
      inputLimitError(token.value, t('settings.service.accessToken'), INPUT_LIMITS.secretBytes, { unit: 'bytes', original: savedRemoteToken.value })
    : ''
  if (limitError) { feedback.value = limitError; failed.value = true; return }
  const revision = editRevision
  pending.value = test ? 'test' : 'connect'; failed.value = false
  const candidate = { kind: kind.value, apiBase: address.value.trim(), apiToken: remote.value && token.value !== savedRemoteToken.value ? token.value || undefined : undefined }
  try {
    if (!test) await flushBackendDrafts()
    await invoke<BackendContext>(test ? 'test_backend_connection' : 'activate_backend_connection', { candidate })
    if (revision !== editRevision) return
    feedback.value = t(test ? 'settings.service.testPassed' : 'settings.service.connectedFeedback')
    if (!test) { token.value = ''; backendPanelOpen.value = false }
  } catch (error) {
    if (revision !== editRevision) return
    feedback.value = String(error); failed.value = true
  } finally { pending.value = null }
}
function onKey(event: KeyboardEvent) {
  if (!backendPanelOpen.value) return
  if (event.key === 'Escape' && !pending.value) { backendPanelOpen.value = false; return }
  if (event.key !== 'Tab') return
  const items = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') ?? [])].filter((item) => item.getClientRects().length)
  if (!items.length) return
  if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1]?.focus() }
  else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0]?.focus() }
}
window.addEventListener('keydown', onKey)
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div v-if="backendPanelOpen" class="backend-overlay" @click.self="!pending && (backendPanelOpen = false)">
      <div ref="dialog" class="modal backend-modal" role="dialog" aria-modal="true" aria-labelledby="backend-dialog-title" tabindex="-1">
        <div class="modal-h"><b id="backend-dialog-title">{{ t('settings.service.settings') }}</b><button class="x" :aria-label="t('common.close')" :disabled="!!pending" @click="backendPanelOpen = false">✕</button></div>
        <div class="modal-b"><div class="backend-page" data-backend-page>
          <div class="backend-current-card"><div class="backend-current-card__top">
            <div class="backend-current-card__identity"><span class="backend-live-dot" :class="{ 'backend-live-dot--disconnected': !app.sidecarReady }" /><div><span class="backend-eyebrow">{{ t('settings.service.current') }}</span><strong data-backend-current-title>{{ currentLabel }}</strong><span class="backend-current-meta"><span class="backend-version" :class="{ 'backend-version--pending': !app.backendVersion }" data-backend-version><bdi v-if="app.backendVersion" dir="ltr">{{ app.backendVersion.startsWith('v') ? app.backendVersion : 'v' + app.backendVersion }}</bdi><template v-else>{{ t('settings.service.versionPending') }}</template></span> · <bdi v-if="backendContext?.kind === 'remote'" dir="ltr">{{ currentHost }}</bdi><template v-else>{{ t('settings.service.lifecycle') }}</template></span></div></div>
            <span class="backend-status-pill" :class="{ 'backend-status-pill--warning': !app.sidecarReady }">{{ t(app.sidecarReady ? 'settings.system.connected' : 'settings.service.disconnected') }}</span>
          </div></div>
          <div class="sec-label">{{ t('settings.service.deployment') }}</div>
          <div class="backend-location-grid" role="radiogroup" :aria-label="t('settings.service.deployment')">
            <button v-for="option in (['local', 'remote'] as const)" :key="option" class="backend-location-card" :class="{ 'is-active': kind === option }" role="radio" :aria-checked="kind === option" :disabled="!!pending" @click="kind = option">
              <span class="backend-location-card__icon"><svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><template v-if="option === 'local'"><rect x="3" y="3" width="18" height="13" rx="2" /><path d="M8 21h8M12 16v5" /></template><template v-else><rect x="4" y="3" width="16" height="7" rx="2" /><rect x="4" y="14" width="16" height="7" rx="2" /><path d="M8 6.5h.01M8 17.5h.01" /></template></svg></span><span class="backend-location-card__copy"><strong>{{ t(option === 'local' ? 'settings.service.local' : 'settings.service.cloud') }}</strong><span>{{ t(option === 'local' ? 'settings.service.localDescription' : 'settings.service.cloudDescription') }}</span></span><span class="backend-location-card__check" aria-hidden="true">✓</span>
            </button>
          </div>
          <div v-if="!remote" class="backend-local-panel">
            <label class="backend-field"><span>{{ t('settings.service.accessToken') }}</span>
              <span class="backend-secret-wrap backend-secret-wrap--copy">
                <input class="minput" :value="localToken" :type="localVisible ? 'text' : 'password'" readonly dir="ltr" :aria-label="t('settings.service.localToken')" aria-describedby="backend-local-token-hint" autocomplete="off" spellcheck="false" :disabled="localTokenLoading" />
                <button type="button" class="backend-secret-toggle" :aria-label="t(localVisible ? 'settings.service.hideToken' : 'settings.service.showToken')" :aria-pressed="localVisible" :disabled="!localToken || !!pending" @click="localVisible = !localVisible"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /><path v-show="localVisible" d="m3 3 18 18" /></svg></button>
                <button type="button" class="backend-secret-copy" :aria-label="t(localCopied ? 'settings.service.copied' : 'settings.service.copyToken')" :title="t(localCopied ? 'settings.service.copied' : 'settings.service.copyToken')" :disabled="!localToken || !!pending" @click="copyLocalToken"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><template v-if="localCopied"><path d="m9 12 2 2 4-4" /><rect x="3" y="3" width="18" height="18" rx="2" /></template><template v-else><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></template></svg></button>
              </span>
              <span id="backend-local-token-hint" class="backend-field-hint">{{ t('settings.service.localTokenHint') }}</span>
            </label>
          </div>
          <div v-if="remote" class="backend-remote-panel"><div class="backend-form-grid">
            <label class="backend-field"><span>{{ t('settings.service.url') }} *</span><input v-model="address" dir="ltr" class="minput" placeholder="https://your-hexclaw.example.com" required spellcheck="false" autocomplete="url" :disabled="!!pending" /></label>
            <label class="backend-field"><span>{{ t('settings.service.accessToken') }} *</span><span class="backend-secret-wrap"><input v-model="token" dir="ltr" class="minput" :type="visible ? 'text' : 'password'" :placeholder="t(savedCandidate?.hasToken ? 'settings.service.savedToken' : 'settings.service.inputToken')" :required="!savedCandidate?.hasToken" :aria-label="t('settings.service.cloudToken')" aria-describedby="backend-token-hint" autocomplete="off" spellcheck="false" :disabled="!!pending || remoteTokenLoading" /><button type="button" class="backend-secret-toggle" :aria-label="t(visible ? 'settings.service.hideToken' : 'settings.service.showToken')" :aria-pressed="visible" :disabled="!!pending || remoteTokenLoading" @click="visible = !visible"><EyeOff v-if="visible" :size="15" /><svg v-else width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg></button></span><span id="backend-token-hint" class="backend-field-hint">{{ t('settings.service.cloudTokenHint') }}</span></label>
          </div></div>
          <div v-if="feedback || !same" class="backend-inline-status" :class="{ 'is-warn': failed, 'is-ok': feedback && !failed }" role="status" aria-live="polite">{{ feedback || t('settings.service.compatibility') }}</div>
          <p v-if="changesService && chat.observedRunningTaskCount > 0" class="backend-switch-note" data-service-active-task>{{ t('settings.service.activeTasks', { count: chat.observedRunningTaskCount }) }}</p>
          <div v-if="remote" class="backend-trust-callout">{{ t('settings.service.cloudSwitch') }}</div>
          <p v-else-if="backendContext?.kind === 'remote'" class="backend-switch-note">{{ t('settings.service.localSwitch') }}</p>
        </div></div>
        <div class="modal-f"><span class="backend-footer-note">{{ remote ? t('settings.service.testNoSwitch') : '' }}</span><button class="btn btn-ghost" :disabled="!!pending" @click="backendPanelOpen = false">{{ t(same && app.sidecarReady ? 'common.close' : 'common.cancel') }}</button><button v-if="remote" class="btn" :disabled="!valid || !!pending" @click="connect(true)">{{ t(pending === 'test' ? 'settings.llm.testing' : 'settings.llm.testConnection') }}</button><button class="btn btn-primary" :disabled="!valid || !!pending || (same && app.sidecarReady)" @click="connect(false)">{{ connectLabel }}</button></div>
      </div>
    </div>
  </Teleport>
</template>
<style scoped src="./backend-service.css"></style>
