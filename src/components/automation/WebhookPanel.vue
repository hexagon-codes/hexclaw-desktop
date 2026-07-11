<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'

import { Trash2, Globe, Webhook as WebhookIcon, PowerOff, Power, X, Copy, ShieldAlert, ShieldCheck } from 'lucide-vue-next'
import { getWebhooks, createWebhook, deleteWebhook, webhookUrlFor, updateWebhookEnabled } from '@/api/webhook'
import type { Webhook, WebhookType } from '@/api/webhook'
import { getCronJobs } from '@/api/tasks'
import type { CronJob } from '@/types/task'
import {
  preflightAutonomy, createAutonomyGrant, getAutonomySummary,
  type PreflightResult, type AutonomyTaskStatus,
} from '@/api/autonomy'
import { useToast } from '@/composables/useToast'
import { setClipboard } from '@/api/desktop'
import HcSelect from '@/components/common/HcSelect.vue'
import PermissionBlockedModal from '@/components/automation/PermissionBlockedModal.vue'

const { t } = useI18n()
const toast = useToast()

// 顶栏搜索词（由 AutomationView 透传）：按 webhook 名过滤可见项。
const props = withDefaults(defineProps<{ search?: string }>(), { search: '' })

const webhooks = ref<Webhook[]>([])
const filteredWebhooks = computed(() => {
  const q = props.search.trim().toLowerCase()
  if (!q) return webhooks.value
  return webhooks.value.filter((wh) => (wh.name ?? '').toLowerCase().includes(q))
})
const loading = ref(false)
const showCreate = ref(false)
const creating = ref(false)
const deletingIds = ref<Set<string>>(new Set())
const loadError = ref('')
/** 后端 webhook.enabled=false 时 /api/v1/webhooks 路由不注册（404），按"功能未启用"处理 */
const featureDisabled = ref(false)
let loadRequestGen = 0

// Create form —— 对齐后端 RegisterWebhookRequest{name,type,prompt,secret,job_id}
const form = ref({
  name: '',
  type: 'generic' as WebhookType,
  prompt: '',
  secret: '',
  // §13.3(1) 绑定 cron job：非空 → 事件触发该 job 而非跑 prompt（jobId 经 createWebhook → job_id）。
  jobId: '',
})

function resetCreateForm() {
  form.value = { name: '', type: 'generic', prompt: '', secret: '', jobId: '' }
  createdResult.value = null
  createdPreflight.value = null
}

// ── 创建结果态（原型「Webhook · 待启用端点」）────────────────────────
// 创建即得端点、默认未启用：先复制 URL/Secret 配对端、验签，授权后一键启用。
const createdResult = ref<{ id: string; name: string; url: string; enabled: boolean; secret?: string } | null>(null)
const createdPreflight = ref<PreflightResult | null>(null)
const enabling = ref(false)
const togglingIds = ref<Set<string>>(new Set())
// webhook id → 权限状态（!all_clear 的行显示待授权徽章）
const permissionStatuses = ref<Map<string, AutonomyTaskStatus>>(new Map())
const blockedOpen = ref(false)
const blockedTask = ref<AutonomyTaskStatus | null>(null)

async function loadPermissionStatuses() {
  try {
    const res = await getAutonomySummary()
    const map = new Map<string, AutonomyTaskStatus>()
    for (const status of res?.tasks ?? []) {
      if (status.kind === 'webhook') map.set(status.task_ref.replace(/^webhook:/, ''), status)
    }
    permissionStatuses.value = map
  } catch {
    permissionStatuses.value = new Map()
  }
}

function permissionPending(wh: Webhook): AutonomyTaskStatus | undefined {
  const status = permissionStatuses.value.get(wh.id)
  return status && !status.all_clear ? status : undefined
}

function openBlockedModal(wh: Webhook) {
  blockedTask.value = permissionStatuses.value.get(wh.id) ?? null
  blockedOpen.value = true
}

async function onBlockedResolved() {
  blockedOpen.value = false
  await loadWebhooks()
}

/** 创建结果态里被拦/需授权的能力条目。 */
const createdNeeds = computed(() => createdPreflight.value?.needs_decision ?? [])

/** 授权并启用：需授权条目写任务级授权（仅本 Webhook）→ PATCH enabled=true。 */
async function grantAndEnableCreated() {
  const res = createdResult.value
  if (!res || enabling.value) return
  enabling.value = true
  try {
    if (createdNeeds.value.length > 0) {
      await createAutonomyGrant({
        task_ref: `webhook:${res.id}`,
        source: 'webhook',
        entries: createdNeeds.value,
        note: t('autonomy.approval.grantNote', '创建流任务级授权'),
      })
    }
    await updateWebhookEnabled(res.name, true)
    toast.success(t('autonomy.webhook.enabled', 'Webhook 已授权并启用'))
    closeCreateForm()
    await loadWebhooks()
  } catch (e: unknown) {
    toast.error((e as Error)?.message || t('autonomy.webhook.enableFailed', '启用失败'))
  } finally {
    enabling.value = false
  }
}

/** 完成但保持未启用：端点已可验签，稍后从列表启用。 */
async function finishKeepDisabled() {
  closeCreateForm()
  await loadWebhooks()
}

/** 列表行启停切换。 */
async function toggleWebhookEnabled(wh: Webhook) {
  if (togglingIds.value.has(wh.id)) return
  togglingIds.value = new Set([...togglingIds.value, wh.id])
  try {
    await updateWebhookEnabled(wh.name, !wh.enabled)
    await loadWebhooks()
  } catch (e: unknown) {
    toast.error((e as Error)?.message || t('autonomy.webhook.toggleFailed', '切换启用状态失败'))
  } finally {
    const next = new Set(togglingIds.value)
    next.delete(wh.id)
    togglingIds.value = next
  }
}

async function copyText(text: string, okMsg: string) {
  try {
    await setClipboard(text)
    toast.success(okMsg)
  } catch {
    toast.error(t('webhooks.copyFailed', '复制失败，请手动复制'))
  }
}

// 可绑定的 cron job 列表（best-effort 载入，失败不阻塞建 webhook）。
const cronJobs = ref<CronJob[]>([])
const jobOptions = computed(() => [
  { value: '', label: t('webhooks.jobNone', '不绑定任务（执行处理指令）') },
  ...cronJobs.value.map((j) => ({ value: j.id, label: j.name })),
])
const formJobId = computed<string>({
  get: () => form.value.jobId,
  set: (v) => {
    form.value.jobId = v
  },
})

function openCreateForm() {
  resetCreateForm()
  showCreate.value = true
}

function closeCreateForm() {
  showCreate.value = false
  resetCreateForm()
}

// 类型与后端 webhook.go 一致：generic / github / gitlab（入站事件 webhook）
const webhookTypes: { key: WebhookType; label: string }[] = [
  { key: 'generic', label: 'Generic JSON' },
  { key: 'github', label: 'GitHub' },
  { key: 'gitlab', label: 'GitLab' },
]

// HcSelect 选项投影（value 一律 string，与 WebhookType 字面量一致）
const webhookTypeOptions = computed(() =>
  webhookTypes.map((wt) => ({ value: wt.key, label: wt.label })),
)
// HcSelect v-model 包装：value 为 string，写回时收窄为 WebhookType
const formType = computed<string>({
  get: () => form.value.type,
  set: (v) => {
    form.value.type = v as WebhookType
  },
})

/** 复制某个 webhook 的真实接收 URL（后端按 name 生成）。 */
async function copyWebhookUrl(name: string) {
  try {
    await setClipboard(webhookUrlFor(name))
    toast.success(t('webhooks.copied', '已复制 Webhook URL'))
  } catch {
    toast.error(t('webhooks.copyFailed', '复制失败，请手动复制'))
  }
}

async function loadWebhooks() {
  const requestGen = ++loadRequestGen
  loading.value = true
  loadError.value = ''
  featureDisabled.value = false
  try {
    const res = await getWebhooks()
    if (requestGen !== loadRequestGen) return
    webhooks.value = res?.webhooks ?? []
    void loadPermissionStatuses()
  } catch (e) {
    if (requestGen !== loadRequestGen) return
    webhooks.value = []
    const status = (e as { status?: number })?.status
    if (status === 404) {
      featureDisabled.value = true
    } else {
      loadError.value = (e as Error)?.message || t('webhooks.loadFailed')
      console.error('Failed to load webhooks:', e)
    }
  } finally {
    if (requestGen === loadRequestGen) {
      loading.value = false
    }
  }
}

async function onCreateWebhook() {
  if (creating.value) return
  // name 必填；prompt 仅在「未绑定 cron job」时必填——绑定 job 时事件直接触发该 job，prompt 无意义。
  if (!form.value.name.trim()) {
    toast.error(t('webhooks.namePromptRequired', '名称和处理指令为必填'))
    return
  }
  if (!form.value.jobId && !form.value.prompt.trim()) {
    toast.error(t('webhooks.namePromptRequired', '名称和处理指令为必填'))
    return
  }
  creating.value = true
  try {
    const res = await createWebhook(form.value)
    toast.success(t('webhooks.created', { name: form.value.name }))
    // 创建即得端点、默认未启用：进入结果态（URL/Secret/预检/启用），不直接关窗。
    createdResult.value = {
      id: res.id,
      name: res.name,
      url: webhookUrlFor(res.name),
      enabled: res.enabled ?? false,
      secret: res.secret,
    }
    try {
      createdPreflight.value = await preflightAutonomy({
        source: 'webhook',
        task_ref: `webhook:${res.id}`,
        // FS-4：绑 job 的 webhook 触发跑 job 的 SourcePrompt，让后端据 cron_job_id 解析真实能力面；
        // 未绑 job 时仍发本表单 prompt。
        ...(form.value.jobId ? { cron_job_id: form.value.jobId } : { prompt: form.value.prompt }),
      })
    } catch {
      createdPreflight.value = null
    }
    await loadWebhooks()
  } catch (e: unknown) {
    toast.error((e as Error)?.message || t('webhooks.createFailed'))
  } finally {
    creating.value = false
  }
}

async function onDeleteWebhook(webhook: Webhook) {
  if (deletingIds.value.has(webhook.id)) return
  deletingIds.value = new Set([...deletingIds.value, webhook.id])
  try {
    // 后端按 name 删（DELETE /api/v1/webhooks/{name}）；传 id 会静默 no-op（bug 2026-06-22）
    await deleteWebhook(webhook.name)
    toast.success(t('webhooks.deleted', { name: webhook.name }))
    await loadWebhooks()
  } catch (e: unknown) {
    toast.error((e as Error)?.message || t('webhooks.deleteFailed'))
  } finally {
    const next = new Set(deletingIds.value)
    next.delete(webhook.id)
    deletingIds.value = next
  }
}

async function loadCronJobs() {
  try {
    const res = await getCronJobs()
    cronJobs.value = res?.jobs ?? []
  } catch {
    // 取不到 cron 列表不阻塞建 webhook，仅「绑定任务」下拉为空
    cronJobs.value = []
  }
}

onMounted(() => {
  loadWebhooks()
  loadCronJobs()
})

defineExpose({ loadWebhooks, openCreateForm, form })
</script>

<template>
  <div class="webhook-panel">
    <!-- Header：Webhook 计数（仅 count>0 显示；为 0 时下方空状态已足够，不重复提示） -->
    <div v-if="!featureDisabled && webhooks.length > 0" class="webhook-panel__header">
      <span class="webhook-panel__count">{{ t('webhooks.count', { count: webhooks.length }) }}</span>
    </div>

    <!-- 新建 Webhook 弹窗（居中模态，与 Agent / Prompt 等弹窗一致） -->
    <Teleport to="body">
      <Transition name="modal">
        <div
          v-if="showCreate"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm"
          @click.self="closeCreateForm"
        >
          <div
            class="w-full max-w-md rounded-2xl border flex flex-col overflow-hidden"
            :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
          >
            <div
              class="flex items-center justify-between px-5 py-4 border-b"
              :style="{ borderColor: 'var(--hc-border)' }"
            >
              <h2 class="text-[15px] font-semibold m-0" :style="{ color: 'var(--hc-text-primary)' }">
                {{ t('webhooks.create') }}
              </h2>
              <button
                class="p-1 rounded-md hover:bg-white/5"
                :style="{ color: 'var(--hc-text-muted)' }"
                @click="closeCreateForm"
              >
                <X :size="17" />
              </button>
            </div>

            <!-- 结果态：创建即得端点、默认未启用（原型「Webhook · 待启用端点」） -->
            <div v-if="createdResult" class="px-5 py-4 webhook-modal__body" data-testid="webhook-created-result">
              <div class="webhook-result__status">
                <span class="webhook-result__pill">{{ t('autonomy.webhook.pendingEnable', '未启用 · 可验签 · 不派发') }}</span>
              </div>
              <div class="hc-form-group">
                <label>{{ t('autonomy.webhook.endpoint', '接收端点（复制到对端服务）') }}</label>
                <div class="webhook-result__copyrow">
                  <code>{{ createdResult.url }}</code>
                  <button class="webhook-panel__copy" @click="copyText(createdResult.url, t('webhooks.copied', '已复制 Webhook URL'))">
                    <Copy :size="13" />
                  </button>
                </div>
              </div>
              <div v-if="createdResult.secret" class="hc-form-group">
                <label>{{ t('autonomy.webhook.generatedSecret', '签名 Secret（仅本次显示，请立即复制）') }}</label>
                <div class="webhook-result__copyrow">
                  <code>{{ createdResult.secret }}</code>
                  <button class="webhook-panel__copy" @click="copyText(createdResult.secret!, t('autonomy.webhook.secretCopied', '已复制 Secret'))">
                    <Copy :size="13" />
                  </button>
                </div>
              </div>
              <p class="webhook-panel__url-note">
                {{ t('autonomy.webhook.testNote', '真实事件返回 423 仅记录不派发；对端配置后可加 ?test=1 发测试事件验签。') }}
              </p>
              <div v-if="createdNeeds.length" class="webhook-result__needs">
                <div class="webhook-result__needs-head">
                  <ShieldAlert :size="13" />
                  <span>{{ t('autonomy.webhook.needsTitle', '启用前需授权的能力') }}</span>
                </div>
                <div class="webhook-result__chips">
                  <span v-for="c in createdNeeds" :key="c" class="webhook-result__chip">{{ t(`autonomy.category.${c}`, c) }}</span>
                </div>
              </div>
              <div v-else class="webhook-result__needs webhook-result__needs--ok">
                <ShieldCheck :size="13" />
                <span>{{ t('autonomy.webhook.allClear', '预估能力全部自动放行，可直接启用') }}</span>
              </div>
            </div>

            <div v-else class="px-5 py-4 webhook-modal__body">
              <div class="hc-form-group">
                <label>{{ t('webhooks.name') }}</label>
                <input v-model="form.name" class="hc-input" placeholder="my-webhook" />
              </div>
              <div class="hc-form-group">
                <label>{{ t('webhooks.type') }}</label>
                <HcSelect v-model="formType" :options="webhookTypeOptions" />
              </div>
              <div class="hc-form-group" data-testid="webhook-job-select">
                <label>{{ t('webhooks.bindJob', '绑定任务（可选）') }}</label>
                <HcSelect v-model="formJobId" :options="jobOptions" />
                <p v-if="form.jobId" class="webhook-panel__url-note" style="margin-top:6px">
                  {{ t('webhooks.bindJobNote', '事件到达时将触发该定时任务，下方处理指令可留空。') }}
                </p>
              </div>
              <div v-if="!form.jobId" class="hc-form-group">
                <label>{{ t('webhooks.prompt', '处理指令') }}</label>
                <textarea
                  v-model="form.prompt"
                  class="hc-input"
                  rows="3"
                  :placeholder="t('webhooks.promptPlaceholder', '事件到达时执行的 Agent 指令，如「把事件内容汇总并通知我」')"
                ></textarea>
              </div>
              <div class="hc-form-group">
                <label>{{ t('webhooks.secret', '签名 Secret（可选）') }}</label>
                <input v-model="form.secret" class="hc-input" :placeholder="t('webhooks.secretPlaceholder', '用于校验请求签名，可留空')" />
              </div>
              <p class="webhook-panel__url-note">
                {{ t('webhooks.urlAutoNote', '创建后系统会生成接收 URL，配置到外部服务即可触发。') }}
              </p>
            </div>

            <div
              class="flex items-center justify-end gap-2 px-5 py-3.5 border-t webhook-modal__actions"
              :style="{ borderColor: 'var(--hc-border)' }"
            >
              <template v-if="createdResult">
                <button class="hc-btn hc-btn-ghost" data-testid="keep-disabled" :disabled="enabling" @click="finishKeepDisabled">
                  {{ t('autonomy.webhook.keepDisabled', '完成（保持未启用）') }}
                </button>
                <button class="hc-btn hc-btn-primary" data-testid="grant-and-enable" :disabled="enabling" @click="grantAndEnableCreated">
                  {{ t('autonomy.webhook.grantAndEnable', '授权并启用') }}
                </button>
              </template>
              <template v-else>
                <button class="hc-btn hc-btn-ghost" @click="closeCreateForm">{{ t('webhooks.cancel') }}</button>
                <button class="hc-btn hc-btn-primary" :disabled="creating" @click="onCreateWebhook">
                  {{ t('webhooks.create') }}
                </button>
              </template>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- List -->
    <div v-if="loading" class="webhook-panel__loading">{{ t('webhooks.loading') }}</div>
    <div v-else-if="featureDisabled" class="webhook-panel__disabled">
      <PowerOff :size="32" />
      <p class="webhook-panel__disabled-title">{{ t('webhooks.disabledTitle') }}</p>
      <p class="webhook-panel__disabled-desc">{{ t('webhooks.disabledDesc') }}</p>
      <code class="webhook-panel__disabled-code">~/.hexclaw/hexclaw.yaml → webhook.enabled: true</code>
    </div>
    <div v-else-if="loadError" class="webhook-panel__error">
      <PowerOff :size="32" />
      <p>{{ loadError }}</p>
    </div>
    <!-- 空态：对齐原型「暂无 Webhook / 创建 Webhook 接收外部事件触发任务」 -->
    <div v-else-if="webhooks.length === 0" class="webhook-panel__empty">
      <div class="webhook-panel__empty-icon"><WebhookIcon :size="32" /></div>
      <h3 class="webhook-panel__empty-title">{{ t('webhooks.emptyTitle') }}</h3>
      <p class="webhook-panel__empty-desc">{{ t('webhooks.emptyDesc') }}</p>
    </div>
    <div v-else class="webhook-panel__list">
      <div v-for="wh in filteredWebhooks" :key="wh.id" class="webhook-panel__item">
        <div class="webhook-panel__item-info">
          <Globe :size="14" />
          <span class="webhook-panel__item-name">{{ wh.name }}</span>
          <span class="webhook-panel__item-type">{{ wh.type }}</span>
          <span v-if="!wh.enabled" class="webhook-panel__item-disabled">{{ t('autonomy.webhook.itemPending', '未启用') }}</span>
          <button
            v-if="permissionPending(wh)"
            class="webhook-panel__perm-badge"
            data-testid="perm-badge"
            @click.stop="openBlockedModal(wh)"
          >
            <ShieldAlert :size="11" />
            {{ t('autonomy.badge.pending', '待授权') }} · {{ t('autonomy.badge.open', '去开启') }}
          </button>
          <button
            class="webhook-panel__toggle"
            data-testid="toggle-enabled"
            :disabled="togglingIds.has(wh.id)"
            :title="wh.enabled ? t('autonomy.webhook.disable', '停用') : t('autonomy.webhook.enable', '启用')"
            @click.stop="toggleWebhookEnabled(wh)"
          >
            <Power v-if="!wh.enabled" :size="13" />
            <PowerOff v-else :size="13" />
            {{ wh.enabled ? t('autonomy.webhook.disable', '停用') : t('autonomy.webhook.enable', '启用') }}
          </button>
        </div>
        <!-- 真实接收 URL（后端按 name 生成）+ 复制 -->
        <div class="webhook-panel__item-url">
          <code>{{ webhookUrlFor(wh.name) }}</code>
          <button class="webhook-panel__copy" :title="t('webhooks.copyUrl', '复制 URL')" @click="copyWebhookUrl(wh.name)">
            <Copy :size="13" />
          </button>
        </div>
        <div class="webhook-panel__item-meta">
          <span class="webhook-panel__item-prompt">{{ wh.prompt }}</span>
          <span class="webhook-panel__item-count">{{ t('webhooks.eventCount', { count: wh.event_count ?? 0 }) }}</span>
        </div>
        <button class="hc-btn hc-btn-ghost hc-btn-sm webhook-panel__delete" :disabled="deletingIds.has(wh.id)" @click="onDeleteWebhook(wh)">
          <Trash2 :size="14" />
        </button>
      </div>
    </div>
  </div>
  <PermissionBlockedModal
    :open="blockedOpen"
    :task="blockedTask"
    @close="blockedOpen = false"
    @resolved="onBlockedResolved"
  />
</template>

<style scoped>
.webhook-panel { padding: 16px; }
.webhook-panel__header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.webhook-panel__count { font-size: 13px; color: var(--hc-text-secondary); }
/* 新建 Webhook 弹窗正文（表单字段纵向排列） */
.webhook-modal__body { display: flex; flex-direction: column; gap: 12px; max-height: 70vh; overflow-y: auto; }
.webhook-modal__body .hc-form-group label { display: block; font-size: 12px; color: var(--hc-text-secondary); margin-bottom: 4px; }
/* 弹窗淡入/淡出（对齐 Agent / Prompt 弹窗） */
.modal-enter-active { transition: opacity 0.2s ease-out; }
.modal-leave-active { transition: opacity 0.15s ease-in; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
.webhook-panel__events { display: flex; gap: 12px; flex-wrap: wrap; }
.webhook-panel__event-label { display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--hc-text-secondary); }
.webhook-panel__list { display: flex; flex-direction: column; gap: 8px; }
.webhook-panel__item { display: grid; grid-template-columns: 1fr auto; gap: 4px 8px; padding: 12px; background: var(--hc-bg-card); border: 0.5px solid var(--hc-border); border-radius: 8px; position: relative; }
.webhook-panel__item-info { display: flex; align-items: center; gap: 8px; color: var(--hc-text-primary); }
.webhook-panel__item-name { font-weight: 500; font-size: 14px; }
.webhook-panel__item-type { font-size: 11px; padding: 2px 6px; background: var(--hc-bg-active); border-radius: 4px; color: var(--hc-text-secondary); }
.webhook-panel__item-disabled { font-size: 11px; padding: 2px 6px; background: var(--hc-bg-input); border-radius: 4px; color: var(--hc-text-muted); }
.webhook-panel__item-url { grid-column: 1 / -1; display: flex; align-items: center; gap: 6px; min-width: 0; }
.webhook-panel__item-url code { flex: 1; min-width: 0; font-size: 12px; color: var(--hc-text-secondary); font-family: ui-monospace, 'SF Mono', monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.webhook-panel__copy { flex-shrink: 0; display: inline-flex; padding: 3px; border: none; background: transparent; color: var(--hc-text-muted); cursor: pointer; border-radius: 4px; }
.webhook-panel__copy:hover { color: var(--hc-accent); background: var(--hc-bg-hover); }
.webhook-panel__item-meta { display: flex; align-items: center; gap: 8px; grid-column: 1 / -1; min-width: 0; }
.webhook-panel__item-prompt { flex: 1; min-width: 0; font-size: 12px; color: var(--hc-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.webhook-panel__item-count { flex-shrink: 0; font-size: 11px; color: var(--hc-text-muted); }
.webhook-panel__url-note { font-size: 12px; color: var(--hc-text-muted); margin: 2px 0 0; }
.webhook-panel__delete { position: absolute; top: 8px; right: 8px; }
.webhook-panel__toggle {
  display: inline-flex; align-items: center; gap: 4px; cursor: pointer;
  font-size: 11px; padding: 2px 8px; border-radius: 6px;
  border: 0.5px solid var(--hc-border); background: var(--hc-bg-input); color: var(--hc-text-secondary);
}
.webhook-panel__toggle:hover { background: var(--hc-bg-hover); color: var(--hc-text-primary); }
.webhook-panel__toggle:disabled { opacity: 0.6; cursor: default; }
.webhook-panel__perm-badge {
  display: inline-flex; align-items: center; gap: 4px; cursor: pointer;
  font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
  border: 0.5px solid rgba(240, 180, 41, 0.35);
  background: rgba(240, 180, 41, 0.12); color: var(--hc-warning, #e69500);
}
.webhook-panel__perm-badge:hover { background: rgba(240, 180, 41, 0.2); }
.webhook-result__status { display: flex; }
.webhook-result__pill {
  display: inline-flex; align-items: center; font-size: 11.5px; font-weight: 600;
  padding: 3px 9px; border-radius: 7px;
  background: rgba(240, 180, 41, 0.14); color: var(--hc-warning, #e69500);
}
.webhook-result__copyrow {
  display: flex; align-items: center; gap: 6px; min-width: 0;
  padding: 8px 10px; border: 1px dashed var(--hc-border-hl, rgba(95,179,234,0.32));
  border-radius: 8px; background: var(--hc-bg-input);
}
.webhook-result__copyrow code {
  flex: 1; min-width: 0; font-size: 12px; color: var(--hc-text-primary);
  font-family: ui-monospace, 'SF Mono', monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.webhook-result__needs { display: flex; flex-direction: column; gap: 6px; }
.webhook-result__needs--ok { flex-direction: row; align-items: center; gap: 6px; font-size: 12.5px; color: var(--hc-success, #28a745); }
.webhook-result__needs-head { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; color: var(--hc-warning, #e69500); }
.webhook-result__chips { display: flex; gap: 6px; flex-wrap: wrap; }
.webhook-result__chip {
  display: inline-flex; align-items: center; min-height: 22px; padding: 2px 8px;
  border: 0.5px solid rgba(240, 180, 41, 0.35); border-radius: 7px;
  background: rgba(240, 180, 41, 0.12); color: var(--hc-warning, #e69500); font-size: 11.5px;
}
.webhook-panel__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 72px 20px;
  gap: 6px;
}
.webhook-panel__empty-icon {
  width: 84px;
  height: 84px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--hc-bg-card);
  border: 0.5px solid var(--hc-border);
  color: var(--hc-text-muted);
  margin-bottom: 8px;
}
.webhook-panel__empty-title { font-size: 15px; font-weight: 600; color: var(--hc-text-primary); margin: 2px 0 0; }
.webhook-panel__empty-desc { font-size: 13px; color: var(--hc-text-muted); margin: 0; max-width: 440px; }
/* flex 居中列：块级 SVG 图标随文字一起水平居中（仅 text-align:center 会把块级 svg 甩到左侧） */
.webhook-panel__disabled {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 56px 20px;
  color: var(--hc-text-secondary);
}
.webhook-panel__disabled-title { margin-top: 12px; font-size: 14px; font-weight: 600; color: var(--hc-text-primary); }
.webhook-panel__disabled-desc { margin-top: 4px; font-size: 12.5px; color: var(--hc-text-muted); }
.webhook-panel__disabled-code {
  display: inline-block; margin-top: 10px; padding: 4px 10px;
  border-radius: 6px; background: var(--hc-bg-input); border: 0.5px solid var(--hc-border);
  font-size: 11.5px; font-family: ui-monospace, 'SF Mono', monospace; color: var(--hc-text-secondary);
}
.webhook-panel__loading { text-align: center; padding: 40px; color: var(--hc-text-muted); }
.webhook-panel__error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
  padding: 40px;
  color: var(--hc-error, #dc2626);
}
</style>
