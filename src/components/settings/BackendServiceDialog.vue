<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Cloud, Monitor, Eye, EyeOff, X } from 'lucide-vue-next'
import { invoke } from '@tauri-apps/api/core'
import { backendContext, backendPanelOpen, type BackendContext } from '@/services/backend-context'
import { useAppStore } from '@/stores/app'

const app = useAppStore()
const kind = ref<'local' | 'remote'>('local')
const address = ref('')
const token = ref('')
const visible = ref(false)
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
const valid = computed(() => !remote.value || (/^https?:\/\/[^\s]+$/.test(address.value.trim()) && hasToken.value))
const same = computed(() => kind.value === backendContext.value?.kind && (!remote.value || (address.value.trim().replace(/\/+$/, '') === backendContext.value.apiBase.replace(/\/+$/, '') && !token.value)))
const currentLabel = computed(() => backendContext.value?.kind === 'remote' ? '远端服务' : '本机服务')
const connectLabel = computed(() => pending.value === 'connect' ? '正在连接…' : same.value && app.sidecarReady ? '正在使用' : same.value ? '重新连接' : remote.value ? '连接并切换' : '切换到本机')

watch([kind, address, token], () => { editRevision++; feedback.value = ''; failed.value = false })
watch(backendPanelOpen, async (open) => {
  if (!open) { token.value = ''; previousFocus?.focus(); return }
  previousFocus = document.activeElement as HTMLElement | null
  kind.value = backendContext.value?.kind ?? 'local'
  pending.value = null; token.value = ''; feedback.value = ''; visible.value = false
  try {
    saved.value = await invoke<BackendContext[]>('get_backend_connections')
    address.value = (saved.value.find((record) => record.kind === 'remote' && record.connectionId === backendContext.value?.connectionId) ?? saved.value.find((record) => record.kind === 'remote'))?.apiBase ?? ''
  } catch { saved.value = [] }
  await nextTick(); dialog.value?.focus()
})

async function connect(test: boolean) {
  if (!valid.value || pending.value) return
  const revision = editRevision
  pending.value = test ? 'test' : 'connect'; failed.value = false
  const candidate = { kind: kind.value, apiBase: address.value.trim(), apiToken: token.value || undefined }
  try {
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
  if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus() }
  else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus() }
}
window.addEventListener('keydown', onKey)
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div v-if="backendPanelOpen" class="backend-overlay" @click.self="!pending && (backendPanelOpen = false)">
      <div ref="dialog" class="modal backend-modal" role="dialog" aria-modal="true" aria-labelledby="backend-dialog-title" tabindex="-1">
        <div class="modal-h"><b id="backend-dialog-title">后端服务</b><button class="x" aria-label="关闭" :disabled="!!pending" @click="backendPanelOpen = false"><X :size="16" /></button></div>
        <div class="modal-b"><div class="backend-page" data-backend-page>
          <div class="backend-current-card"><div class="backend-current-card__top">
            <div class="backend-current-card__identity"><span class="backend-live-dot" :class="{ 'backend-live-dot--disconnected': !app.sidecarReady }" /><div><span class="backend-eyebrow">当前使用</span><strong data-backend-current-title>{{ currentLabel }}</strong><span class="backend-current-meta">{{ backendContext?.kind === 'remote' ? backendContext.apiBase : 'HexClaw 后端服务' }} · {{ backendContext?.kind === 'remote' ? 'API v1' : '自动管理' }}</span></div></div>
            <span class="backend-status-pill" :class="{ 'backend-status-pill--warning': !app.sidecarReady }">{{ app.sidecarReady ? '已连接' : '未连接' }}</span>
          </div></div>
          <div class="sec-label">选择要连接的服务</div>
          <div class="backend-location-grid" role="radiogroup" aria-label="HexClaw 服务运行位置">
            <button v-for="option in (['local', 'remote'] as const)" :key="option" class="backend-location-card" :class="{ 'is-active': kind === option }" role="radio" :aria-checked="kind === option" :disabled="!!pending" @click="kind = option">
              <span class="backend-location-card__icon"><component :is="option === 'local' ? Monitor : Cloud" :size="18" /></span><span class="backend-location-card__copy"><strong>{{ option === 'local' ? '本机服务' : '远端服务' }}</strong><span>{{ option === 'local' ? '在此设备运行，由 HexClaw 自动管理' : '服务器持续运行，随时在钉钉辅导' }}</span></span><span class="backend-location-card__check" aria-hidden="true">✓</span>
            </button>
          </div>
          <div v-if="remote" class="backend-remote-panel"><div class="backend-form-grid">
            <label class="backend-field"><span>服务地址 *</span><input v-model="address" class="minput" placeholder="https://your-hexclaw.example.com" required spellcheck="false" autocomplete="url" :disabled="!!pending" /></label>
            <label class="backend-field"><span>访问令牌 *</span><span class="backend-secret-wrap"><input v-model="token" class="minput" :type="visible ? 'text' : 'password'" :placeholder="savedCandidate?.hasToken ? '已保存访问令牌' : '输入访问令牌'" :required="!savedCandidate?.hasToken" aria-describedby="backend-token-hint" autocomplete="off" :disabled="!!pending" /><button class="backend-secret-toggle" :aria-label="visible ? '隐藏访问令牌' : '显示访问令牌'" @click="visible = !visible"><component :is="visible ? EyeOff : Eye" :size="16" /></button></span><span id="backend-token-hint" class="backend-field-hint">填写远端 HexClaw 服务配置的访问令牌。</span></label>
          </div></div>
          <div v-if="feedback || !same" class="backend-inline-status" :class="{ 'is-warn': failed, 'is-ok': feedback && !failed }" role="status" aria-live="polite">{{ feedback || '连接前将检查服务和 API 兼容性。' }}</div>
          <div v-if="remote" class="backend-trust-callout">会话、学习记录、模型和钉钉连接由远端服务管理。<br />切换不迁移数据；服务器与模型持续可用时，电脑关机不影响钉钉辅导。</div>
          <p v-else-if="backendContext?.kind === 'remote'" class="backend-switch-note">切换后显示本机数据与配置，远端数据仍保留在原服务。</p>
        </div></div>
        <div class="modal-f"><span class="backend-footer-note">{{ remote ? '测试连接不会切换当前服务' : '' }}</span><button class="btn btn-ghost" :disabled="!!pending" @click="backendPanelOpen = false">{{ same && app.sidecarReady ? '关闭' : '取消' }}</button><button v-if="remote" class="btn" :disabled="!valid || !!pending" @click="connect(true)">{{ pending === 'test' ? '测试中…' : '测试连接' }}</button><button class="btn btn-primary" :disabled="!valid || !!pending || (same && app.sidecarReady)" @click="connect(false)">{{ connectLabel }}</button></div>
      </div>
    </div>
  </Teleport>
</template>
<style scoped src="./backend-service.css"></style>
