<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { EyeOff } from 'lucide-vue-next'
import { invoke } from '@tauri-apps/api/core'
import { backendContext, backendPanelOpen, flushBackendDrafts, type BackendContext } from '@/services/backend-context'
import { useAppStore } from '@/stores/app'
import { useChatStore } from '@/stores/chat'
import { setClipboard } from '@/api/desktop'

const app = useAppStore()
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
const currentLabel = computed(() => backendContext.value?.kind === 'remote' ? '远端服务' : '本机服务')
const connectLabel = computed(() => pending.value === 'connect' ? '正在连接…' : same.value && app.sidecarReady ? '正在使用' : same.value ? '重新连接' : remote.value ? '连接并切换' : '切换到本机')

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
watch([backendPanelOpen, kind, () => address.value.trim().replace(/\/+$/, ''), () => savedCandidate.value?.connectionId], async ([open, target, _address, connectionId], _previous, onCleanup) => {
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
    feedback.value = 'Unable to read remote access token.'; failed.value = true
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
    feedback.value = 'Unable to read local access token.'; failed.value = true
  } finally {
    if (revision === localTokenRevision) localTokenLoading.value = false
  }
})

async function copyLocalToken() {
  if (!localToken.value || localTokenLoading.value) return
  const revision = localTokenRevision
  localCopied.value = false
  if (feedback.value === 'Copy failed. Please try again.') {
    feedback.value = ''; failed.value = false
  }
  try {
    await setClipboard(localToken.value, { localOnly: true })
    if (revision === localTokenRevision) localCopied.value = true
  } catch {
    if (revision !== localTokenRevision) return
    feedback.value = 'Copy failed. Please try again.'; failed.value = true
  }
}

async function connect(test: boolean) {
  if (!valid.value || pending.value) return
  const revision = editRevision
  pending.value = test ? 'test' : 'connect'; failed.value = false
  const candidate = { kind: kind.value, apiBase: address.value.trim(), apiToken: remote.value && token.value !== savedRemoteToken.value ? token.value || undefined : undefined }
  try {
    if (!test) await flushBackendDrafts()
    await invoke<BackendContext>(test ? 'test_backend_connection' : 'activate_backend_connection', { candidate })
    if (revision !== editRevision) return
    feedback.value = test ? '连接测试通过，当前服务未切换。' : '已连接。'
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
        <div class="modal-h"><b id="backend-dialog-title">后端服务</b><button class="x" aria-label="关闭" :disabled="!!pending" @click="backendPanelOpen = false">✕</button></div>
        <div class="modal-b"><div class="backend-page" data-backend-page>
          <div class="backend-current-card"><div class="backend-current-card__top">
            <div class="backend-current-card__identity"><span class="backend-live-dot" :class="{ 'backend-live-dot--disconnected': !app.sidecarReady }" /><div><span class="backend-eyebrow">当前使用</span><strong data-backend-current-title>{{ currentLabel }}</strong><span class="backend-current-meta">{{ backendContext?.kind === 'remote' ? backendContext.apiBase : 'HexClaw 后端服务' }} · <span class="backend-version" :class="{ 'backend-version--pending': !app.backendVersion }" data-backend-version>{{ app.backendVersion ? (app.backendVersion.startsWith('v') ? app.backendVersion : 'v' + app.backendVersion) : '版本待检查' }}</span> · {{ !app.sidecarReady ? '等待连接' : backendContext?.kind === 'remote' ? 'API v1' : '自动管理' }}</span></div></div>
            <span class="backend-status-pill" :class="{ 'backend-status-pill--warning': !app.sidecarReady }">{{ app.sidecarReady ? '已连接' : '未连接' }}</span>
          </div></div>
          <div class="sec-label">选择要连接的服务</div>
          <div class="backend-location-grid" role="radiogroup" aria-label="HexClaw 服务运行位置">
            <button v-for="option in (['local', 'remote'] as const)" :key="option" class="backend-location-card" :class="{ 'is-active': kind === option }" role="radio" :aria-checked="kind === option" :disabled="!!pending" @click="kind = option">
              <span class="backend-location-card__icon"><svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><template v-if="option === 'local'"><rect x="3" y="3" width="18" height="13" rx="2" /><path d="M8 21h8M12 16v5" /></template><template v-else><rect x="4" y="3" width="16" height="7" rx="2" /><rect x="4" y="14" width="16" height="7" rx="2" /><path d="M8 6.5h.01M8 17.5h.01" /></template></svg></span><span class="backend-location-card__copy"><strong>{{ option === 'local' ? '本机服务' : '远端服务' }}</strong><span>{{ option === 'local' ? '在此设备运行，由 HexClaw 自动管理' : '服务器持续运行，随时在钉钉辅导' }}</span></span><span class="backend-location-card__check" aria-hidden="true">✓</span>
            </button>
          </div>
          <div v-if="!remote" class="backend-local-panel">
            <label class="backend-field"><span>访问令牌</span>
              <span class="backend-secret-wrap backend-secret-wrap--copy">
                <input class="minput" :value="localToken" :type="localVisible ? 'text' : 'password'" readonly aria-label="本机访问令牌" aria-describedby="backend-local-token-hint" autocomplete="off" spellcheck="false" :disabled="localTokenLoading" />
                <button type="button" class="backend-secret-toggle" :aria-label="localVisible ? '隐藏访问令牌' : '显示访问令牌'" :aria-pressed="localVisible" :disabled="!localToken || !!pending" @click="localVisible = !localVisible"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /><path v-show="localVisible" d="m3 3 18 18" /></svg></button>
                <button type="button" class="backend-secret-copy" :aria-label="localCopied ? 'Copied' : '复制访问令牌'" :title="localCopied ? 'Copied' : '复制访问令牌'" :disabled="!localToken || !!pending" @click="copyLocalToken"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><template v-if="localCopied"><path d="m9 12 2 2 4-4" /><rect x="3" y="3" width="18" height="18" rx="2" /></template><template v-else><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></template></svg></button>
              </span>
              <span id="backend-local-token-hint" class="backend-field-hint">由 HexClaw 自动生成并保存</span>
            </label>
          </div>
          <div v-if="remote" class="backend-remote-panel"><div class="backend-form-grid">
            <label class="backend-field"><span>服务地址 *</span><input v-model="address" class="minput" placeholder="https://your-hexclaw.example.com" required spellcheck="false" autocomplete="url" :disabled="!!pending" /></label>
            <label class="backend-field"><span>访问令牌 *</span><span class="backend-secret-wrap"><input v-model="token" class="minput" :type="visible ? 'text' : 'password'" :placeholder="savedCandidate?.hasToken ? '已保存访问令牌' : '输入访问令牌'" :required="!savedCandidate?.hasToken" aria-label="远端访问令牌" aria-describedby="backend-token-hint" autocomplete="off" spellcheck="false" :disabled="!!pending || remoteTokenLoading" /><button type="button" class="backend-secret-toggle" :aria-label="visible ? '隐藏访问令牌' : '显示访问令牌'" :aria-pressed="visible" :disabled="!!pending || remoteTokenLoading" @click="visible = !visible"><EyeOff v-if="visible" :size="15" /><svg v-else width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg></button></span><span id="backend-token-hint" class="backend-field-hint">填写远端 HexClaw 服务配置的访问令牌。</span></label>
          </div></div>
          <div v-if="feedback || !same" class="backend-inline-status" :class="{ 'is-warn': failed, 'is-ok': feedback && !failed }" role="status" aria-live="polite">{{ feedback || '连接前将检查服务和 API 兼容性。' }}</div>
          <p v-if="changesService && chat.observedRunningTaskCount > 0" class="backend-switch-note" data-service-active-task>原服务有 {{ chat.observedRunningTaskCount }} 项任务正在处理。任务继续留在原服务；请保持原服务和模型运行。切回可查看同一结果。</p>
          <div v-if="remote" class="backend-trust-callout">会话、学习记录、模型和钉钉连接由远端服务管理。<br />切换不迁移数据；服务器与模型持续可用时，电脑关机不影响钉钉辅导。</div>
          <p v-else-if="backendContext?.kind === 'remote'" class="backend-switch-note">切换后显示本机数据与配置，远端数据仍保留在原服务。</p>
        </div></div>
        <div class="modal-f"><span class="backend-footer-note">{{ remote ? '测试连接不会切换当前服务' : '' }}</span><button class="btn btn-ghost" :disabled="!!pending" @click="backendPanelOpen = false">{{ same && app.sidecarReady ? '关闭' : '取消' }}</button><button v-if="remote" class="btn" :disabled="!valid || !!pending" @click="connect(true)">{{ pending === 'test' ? '测试中…' : '测试连接' }}</button><button class="btn btn-primary" :disabled="!valid || !!pending || (same && app.sidecarReady)" @click="connect(false)">{{ connectLabel }}</button></div>
      </div>
    </div>
  </Teleport>
</template>
<style scoped src="./backend-service.css"></style>
