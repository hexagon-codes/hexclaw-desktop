<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import { backendContext, flushBackendDrafts, readModelSettingsReturn, saveModelSettingsReturn, type BackendContext } from '@/services/backend-context'
import { useSettingsStore } from '@/stores/settings'
import { getLLMConfig } from '@/api/config'
import { getVersion } from '@/api/system'
import { isTauri } from '@/utils/platform'
import { dismissSplash } from '@/utils/splash'

interface Readiness { context: BackendContext; version: string; defaultModel: string }
interface SetupCompletion { kind: 'local' | 'remote'; apiBase: string; backendId: string }
const completionKey = 'hexclaw:backend-setup-completion'
const router = useRouter()
const settings = useSettingsStore()
const dialog = ref<HTMLElement>()
const step = ref(0)
const kind = ref<'local' | 'remote'>(backendContext.value?.kind ?? 'local')
const address = ref(backendContext.value?.kind === 'remote' ? backendContext.value.apiBase : '')
const token = ref('')
const saved = ref<BackendContext[]>([])
const checking = ref(false)
const finishing = ref(false)
const failure = ref('')
const result = ref<Readiness | null>(null)
let revision = 0
const savedToken = computed(() => saved.value.some(record => record.kind === 'remote' && record.hasToken && record.apiBase.replace(/\/+$/, '') === address.value.trim().replace(/\/+$/, '')))
const valid = computed(() => kind.value === 'local' || (/^https?:\/\/[^\s]+$/.test(address.value.trim()) && (!!token.value.trim() || savedToken.value)))
const service = computed(() => kind.value === 'local' ? '此设备上的本机服务' : address.value.trim())
const failureMessage = computed(() => `${failure.value}\n目标：${service.value}\n尚未切换，当前仍使用${backendContext.value?.kind === 'remote' ? '远端服务' : '本机服务'}。返回上一步可修改地址或令牌。`)
const action = computed(() => failure.value ? '重新检查' : checking.value ? '检查中…' : result.value?.defaultModel ? '继续原任务' : '配置模型服务')

async function check() {
  if (!valid.value || finishing.value) return
  const current = ++revision
  step.value = 1
  checking.value = true
  failure.value = ''
  result.value = null
  try {
    let checked: Readiness
    if (isTauri()) {
      checked = await invoke<Readiness>('inspect_backend_readiness', { candidate: { kind: kind.value, apiBase: address.value.trim(), apiToken: token.value || undefined } })
    } else {
      if (kind.value !== 'local') throw new Error('Remote connections require the desktop app')
      const [config, version] = await Promise.all([getLLMConfig(), getVersion()])
      const provider = config.providers[config.default]
      checked = { context: backendContext.value ?? { connectionId: 'local', backendId: '', configRevision: 0, activationGeneration: 0, kind: 'local', apiBase: '', wsBase: '', hasToken: false }, version: version.version, defaultModel: provider?.enabled !== false ? provider?.model ?? '' : '' }
    }
    if (current === revision) result.value = checked
  } catch (error) {
    if (current === revision) failure.value = String(error)
  } finally {
    if (current === revision) checking.value = false
  }
}
function back() { ++revision; step.value = 0; result.value = null; failure.value = ''; checking.value = false }
async function continueTask() {
  sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  await settings.loadConfig({ force: true })
  const original = readModelSettingsReturn()
  if (settings.config?.llm.defaultModel) {
    await router.replace(original?.path ?? '/chat')
  } else {
    if (!original) saveModelSettingsReturn({ path: '/chat', sessionId: null, agentRole: '', chatMode: 'chat' })
    await router.replace('/settings')
  }
}
async function finish() {
  if (!result.value || checking.value || finishing.value) return
  finishing.value = true
  failure.value = ''
  try {
    await flushBackendDrafts()
    const current = backendContext.value
    const checked = result.value.context
    if (!isTauri() || (current?.kind === checked.kind && current.apiBase === checked.apiBase && current.backendId === checked.backendId && !token.value)) {
      await continueTask()
      return
    }
    // 只留下非秘密完成意图；跨服务重载后从目标服务自己的任务作用域恢复。
    const completion: SetupCompletion = { kind: kind.value, apiBase: checked.apiBase, backendId: checked.backendId }
    sessionStorage.setItem(completionKey, JSON.stringify(completion))
    await invoke('activate_backend_connection', { candidate: { kind: kind.value, apiBase: address.value.trim(), apiToken: token.value || undefined } })
    token.value = ''
  } catch (error) {
    sessionStorage.removeItem(completionKey)
    failure.value = String(error)
    finishing.value = false
  }
}
async function cancel() {
  if (finishing.value) return
  ++revision
  sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
  await router.replace(readModelSettingsReturn()?.path ?? '/chat')
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') { void cancel(); return }
  if (event.key !== 'Tab') return
  const items = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') ?? [])].filter(item => item.getClientRects().length)
  if (!items.length) return
  if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1]?.focus() }
  else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0]?.focus() }
}
onMounted(async () => {
  dismissSplash()
  window.addEventListener('keydown', onKey)
  if (isTauri()) {
    try { saved.value = await invoke<BackendContext[]>('get_backend_connections') }
    catch (error) { failure.value = String(error) }
  }
  const pending = sessionStorage.getItem(completionKey)
  sessionStorage.removeItem(completionKey)
  if (pending) {
    try {
      const expected = JSON.parse(pending) as SetupCompletion
      const current = backendContext.value
      if (current?.kind === expected.kind && current.apiBase === expected.apiBase && current.backendId === expected.backendId) {
        await continueTask()
        return
      }
    } catch (error) { failure.value = String(error) }
  }
  await nextTick()
  dialog.value?.focus()
})
onBeforeUnmount(() => { ++revision; token.value = ''; window.removeEventListener('keydown', onKey) })
</script>

<template>
  <div class="backend-overlay" @click.self="cancel">
    <div ref="dialog" class="modal wiz" role="dialog" aria-modal="true" aria-labelledby="setup-title" tabindex="-1">
      <div class="modal-h"><b id="setup-title">首次配置向导</b><button class="x" aria-label="关闭" :disabled="finishing" @click="cancel">✕</button></div>
      <div class="wiz-steps"><template v-for="(label, index) in ['选择服务', '检查并开始']" :key="label"><div class="wiz-step" :class="{ done: index < step, on: index === step }"><span class="n">{{ index < step ? '✓' : index + 1 }}</span>{{ label }}</div><div v-if="index === 0" class="wiz-line" :class="{ done: step > 0 }" /></template></div>
      <div class="wiz-body">
        <div v-if="step === 0" class="wiz-pane on">
          <div class="wiz-h">选择后端服务</div>
          <p class="wiz-sub">帮助家长看懂错在哪、知道怎么讲、持续跟进复习。<br />先连接服务，再继续你的第一项任务。</p>
          <div role="radiogroup" aria-label="首次配置的后端服务">
            <button v-for="option in (['local', 'remote'] as const)" :key="option" type="button" class="wiz-opt" :class="{ sel: kind === option }" role="radio" :aria-checked="kind === option" @click="kind = option">
              <span class="ico"><svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><template v-if="option === 'local'"><rect x="3" y="3" width="18" height="13" rx="2" /><path d="M8 21h8M12 16v5" /></template><template v-else><rect x="4" y="3" width="16" height="7" rx="2" /><rect x="4" y="14" width="16" height="7" rx="2" /><path d="M8 6.5h.01M8 17.5h.01" /></template></svg></span>
              <span class="wiz-copy"><span class="t">{{ option === 'local' ? '本机服务' : '远端服务' }}</span><span class="d">{{ option === 'local' ? '在此设备运行，由 HexClaw 自动管理' : '服务器持续运行，随时在钉钉辅导' }}</span></span><svg class="ck ic-sm" aria-hidden="true" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg>
            </button>
          </div>
          <div v-if="kind === 'remote'" class="wiz-remote">
            <label class="mfield"><span>服务地址 *</span><input v-model="address" class="minput" placeholder="https://your-hexclaw.example.com" required spellcheck="false" autocomplete="url" /></label>
            <label class="mfield"><span>访问令牌 *</span><input v-model="token" type="password" class="minput" :placeholder="savedToken ? '已保存访问令牌' : '输入访问令牌'" :required="!savedToken" aria-describedby="setup-token-hint" autocomplete="off" /><span id="setup-token-hint" class="backend-field-hint">填写远端 HexClaw 服务配置的访问令牌。</span></label>
            <p class="wiz-scope">会话、学习记录、模型和钉钉连接由远端服务管理。<br />切换不迁移数据；服务器与模型持续可用时，电脑关机不影响钉钉辅导。</p>
          </div>
        </div>
        <div v-else class="wiz-pane on">
          <div class="wiz-h">检查服务与模型</div><p class="wiz-sub">服务连接和默认模型分别检查。</p>
          <div aria-live="polite">
            <div v-if="failure" class="backend-inline-status is-warn" role="status">{{ failureMessage }}</div>
            <div v-else-if="checking" class="wiz-check"><span class="wiz-spin" /><div>正在检查 {{ service }}</div></div>
            <template v-else-if="result">
              <div class="wiz-check"><div><b>后端服务已连接</b><div class="wiz-check-detail">{{ service }} · {{ result.version }} · API v1</div></div><span class="st success">✓</span></div>
              <div class="wiz-check"><div><b>{{ result.defaultModel ? '默认模型已选好' : '尚未配置默认模型' }}</b><div class="wiz-check-detail">{{ result.defaultModel || '服务已连接。配置模型后回到原任务，已填写的内容会保留。' }}</div></div><span class="st" :class="result.defaultModel ? 'success' : 'muted'">{{ result.defaultModel ? '✓' : '待配置' }}</span></div>
            </template>
          </div>
        </div>
      </div>
      <div class="wiz-f"><template v-if="step === 0"><div class="sp" /><button class="btn" @click="cancel">取消</button><button class="btn btn-primary" :disabled="!valid" @click="check">下一步</button></template><template v-else><button class="btn btn-ghost" :disabled="finishing" @click="back">上一步</button><div class="sp" /><button class="btn btn-primary" :disabled="checking || finishing || (!failure && !result)" @click="failure ? check() : finish()">{{ action }}</button></template></div>
    </div>
  </div>
</template>
<style scoped src="../components/settings/backend-service.css"></style>
<style scoped>
  .wiz{width:560px;max-width:94vw}
  .wiz-steps{display:flex;align-items:center;padding:16px 22px 4px}
  .wiz-step{display:inline-flex;align-items:center;gap:8px;color:var(--hc-text-muted);font-size:12.5px;white-space:nowrap}
  .wiz-step .n{width:23px;height:23px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:600;
      background:var(--hc-bg-active);color:var(--hc-text-secondary);flex-shrink:0;transition:.2s}
  .wiz-step.on{color:var(--hc-text-primary)}
  .wiz-step.on .n{background:var(--hc-accent);color:#fff}
  .wiz-step.done{color:var(--hc-text-secondary)}.wiz-step.done .n{background:var(--hc-success);color:#fff}
  .wiz-line{flex:1;height:2px;background:var(--hc-divider);margin:0 10px;border-radius:1px;min-width:16px}
  .wiz-line.done{background:var(--hc-success)}
  .wiz-body{padding:10px 22px 6px;min-height:236px}
  .wiz-pane{display:none}.wiz-pane.on{display:block;animation:hcfade .18s ease}
  .wiz-h{font-size:17px;font-weight:600;margin:6px 0 3px}
  .wiz-sub{font-size:13px;color:var(--hc-text-secondary);margin:0 0 16px;line-height:1.5}
  .wiz-opt{display:flex;align-items:center;gap:12px;width:100%;padding:13px 14px;border:.5px solid var(--hc-border);border-radius:12px;
      background:var(--hc-bg-card);color:inherit;font:inherit;text-align:left;cursor:pointer;margin-bottom:10px;transition:border-color .15s,background .15s,box-shadow .15s}
  .wiz-opt:hover{background:var(--hc-bg-hover)}
  .wiz-opt.sel{border-color:var(--hc-accent);background:var(--hc-accent-subtle);box-shadow:0 0 0 3px var(--hc-accent-subtle)}
  .wiz-opt .ico{width:40px;height:40px;border-radius:10px;display:grid;place-items:center;font-size:20px;background:var(--hc-bg-input);flex-shrink:0}
  .wiz-opt .wiz-copy{display:block;min-width:0}
  .wiz-opt .t{display:block;font-size:14px;font-weight:600}
  .wiz-opt .d{display:block;font-size:12px;color:var(--hc-text-secondary);margin-top:2px}
  .wiz-opt .ck{margin-left:auto;color:var(--hc-accent);opacity:0;flex-shrink:0;transition:opacity .15s}
  .wiz-opt.sel .ck{opacity:1}
  .wiz-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .wiz-grid .wiz-opt{margin-bottom:0}
  .wiz-check{display:flex;align-items:center;gap:11px;padding:12px 14px;border-radius:11px;background:var(--hc-bg-card);
      border:.5px solid var(--hc-border);margin-bottom:9px;font-size:13.5px}
  .wiz-check .st{margin-left:auto;font-size:12px;white-space:nowrap}
  .wiz-spin{width:15px;height:15px;border:2px solid var(--hc-border);border-top-color:var(--hc-accent);border-radius:50%;
      animation:wizspin .7s linear infinite;flex-shrink:0}
  @keyframes wizspin{to{transform:rotate(360deg)}}
  .wiz-f{display:flex;align-items:center;gap:10px;padding:14px 22px;border-top:.5px solid var(--hc-border)}
  .wiz-f .sp{flex:1}


.wiz{max-height:calc(89vh - 16px);display:flex;flex-direction:column;color:var(--hc-text-primary)}
.wiz-body{overflow:auto;min-height:min(236px,calc(89vh - 187px));flex:0 1 auto;padding-bottom:6px}
.modal-h,.wiz-f,.wiz-steps{flex-shrink:0}
.modal-h b,.wiz-h{letter-spacing:-.01em}
.modal-h .x{font:13.3333px Arial;padding:1px 6px}
.ic-sm{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.wiz-remote{margin-top:12px}
.mfield{display:block;margin-bottom:15px;font-size:14px;color:var(--hc-text-primary)}
.mfield>span:first-child{display:block;margin-bottom:6px;font-size:13px}
.mfield>.backend-field-hint{display:block}
.wiz-scope{font-size:12px;line-height:1.6;color:var(--hc-text-secondary);margin:8px 0 0}
.wiz-check-detail{font-size:12px;color:var(--hc-text-secondary);margin-top:4px}
.success{color:var(--hc-success)}
.muted{color:var(--hc-text-muted)}
.wiz-opt:hover{transform:translateY(-1px)}
.wiz-opt.sel:hover{transform:none}
</style>
