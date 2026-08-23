<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Copy, RefreshCw, X } from 'lucide-vue-next'

import { getAgents } from '@/api/agents'
import { setClipboard } from '@/api/desktop'
import {
  createK12Webhook,
  getK12WebhookReceipts,
  getK12Webhooks,
  retryK12WebhookReceipt,
  rotateK12WebhookSecret,
  updateK12Webhook,
  webhookUrlFor,
  type K12WebhookBinding,
  type K12WebhookEventType,
  type K12WebhookReceipt,
} from '@/api/webhook'
import type { AgentConfig } from '@/types'
import { useToast } from '@/composables/useToast'
import { userVisibleAgents } from '@/utils/imChannelBinding'
import HcClearableField from '@/components/common/HcClearableField.vue'
import HcSelect from '@/components/common/HcSelect.vue'
import { K12_SCENARIO_ID } from '../descriptor'

const toast = useToast()
const emit = defineEmits<{ contentChange: [hasContent: boolean] }>()

const agents = ref<AgentConfig[]>([])
const selectedAgentId = ref('')
const bindings = ref<K12WebhookBinding[]>([])
const loading = ref(false)
const busy = ref('')
const error = ref('')

const eventOptions: Array<{ value: K12WebhookEventType; label: string; testid: string }> = [
  {
    value: 'k12.submission.requested.v1',
    label: '作业文字/已上传图片提交',
    testid: 'k12-webhook-event-submission',
  },
  {
    value: 'k12.practice_return.requested.v1',
    label: '练习卷作答回传',
    testid: 'k12-webhook-event-return',
  },
  {
    value: 'k12.workflow_run.requested.v1',
    label: '运行白名单工作流',
    testid: 'k12-webhook-event-workflow',
  },
]

const agentOptions = computed(() =>
  agents.value.map((agent) => ({
    value: agent.name,
    label: agent.metadata?.['k12.child_name'] || agent.display_name,
  })),
)

function agentTargetLabel(agentID: string, learnerID = ''): string {
  const agent = agents.value.find((item) => item.name === agentID)
  if (!agent) return [agentID, learnerID].filter(Boolean).join(' · ')
  const displayName = agent.display_name?.trim()
  if (displayName) return displayName
  const label = agent.metadata?.['k12.child_name'] || agent.name
  const grade = agent.metadata?.['k12.grade_term']
  return [label, typeof grade === 'string' ? grade.trim() : ''].filter(Boolean).join(' · ')
}

function bindingTarget(binding: K12WebhookBinding): string {
  return agentTargetLabel(binding.agent_id, binding.learner_id)
}

type ReceiptCardFacts = {
  latest: K12WebhookReceipt
  nonceReplayCount: number
  retryableFailureCount: number
}

function bindingReceiptKey(binding: Pick<K12WebhookBinding, 'agent_id' | 'name'>): string {
  return `${binding.agent_id}::${binding.name}`
}

function receiptStatusLabel(status: K12WebhookReceipt['status']): string {
  switch (status) {
    case 'accepted':
      return '200 accepted'
    case 'succeeded':
      return '200 succeeded'
    case 'processing':
      return '202 processing'
    default:
      return status
  }
}

function receiptAgeLabel(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return '时间未知'
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000))
  if (elapsedMinutes < 1) return '刚刚'
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours} 小时前`
  return `${Math.floor(elapsedHours / 24)} 天前`
}

function projectReceiptFacts(receiptList: K12WebhookReceipt[]): ReceiptCardFacts | null {
  if (receiptList.length === 0) return null
  const sorted = [...receiptList].sort((left, right) => {
    const rightTime = Date.parse(right.created_at || right.updated_at || '')
    const leftTime = Date.parse(left.created_at || left.updated_at || '')
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0)
  })
  const latest = sorted[0]
  if (!latest) return null
  return {
    latest,
    nonceReplayCount: receiptList.filter((item) => item.failure_kind === 'nonce_replay').length,
    retryableFailureCount: receiptList.filter(
      (item) => item.status === 'failed' && item.retryable === true,
    ).length,
  }
}

const editorOpen = ref(false)
const editorMode = ref<'create' | 'edit'>('create')
const editingName = ref('')
const formName = ref('')
const formAgentId = ref('')
const formEvents = ref<K12WebhookEventType[]>(['k12.submission.requested.v1'])
const formWorkflows = ref('')

const secretResult = ref<{ title: string; name: string; secret: string } | null>(null)
const rotateTarget = ref<K12WebhookBinding | null>(null)
const historyName = ref('')
const receipts = ref<K12WebhookReceipt[]>([])
const cardReceiptFacts = ref<Record<string, ReceiptCardFacts>>({})
let historyTimer: ReturnType<typeof setTimeout> | undefined
let bindingsRequestGeneration = 0
let historyRequestGeneration = 0

const historyBinding = computed(() =>
  bindings.value.find((binding) => binding.name === historyName.value),
)

function isK12Agent(agent: AgentConfig): boolean {
  return agent.metadata?.scenario === K12_SCENARIO_ID
}

async function loadAgents() {
  try {
    const result = await getAgents()
    agents.value = userVisibleAgents(result.agents ?? []).filter(isK12Agent)
    if (!agents.value.some((agent) => agent.name === selectedAgentId.value)) {
      selectedAgentId.value = agents.value[0]?.name ?? ''
    }
    await loadBindings()
  } catch (cause) {
    error.value = (cause as Error)?.message || '读取辅导实例失败'
  }
}

async function loadBindings() {
  clearHistoryPoll()
  historyRequestGeneration++
  historyName.value = ''
  receipts.value = []
  cardReceiptFacts.value = {}
  const requestGeneration = ++bindingsRequestGeneration
  const agentSnapshot = [...agents.value]
  if (agentSnapshot.length === 0) {
    bindings.value = []
    loading.value = false
    return
  }
  loading.value = true
  error.value = ''
  try {
    const results = await Promise.all(
      agentSnapshot.map(async (agent) => {
        const result = await getK12Webhooks(agent.name)
        return (result.k12_bindings ?? []).map((binding) => ({
          ...binding,
          agent_id: binding.agent_id || agent.name,
          learner_id: binding.learner_id || agent.metadata?.['k12.learner_id'] || '',
        }))
      }),
    )
    if (requestGeneration !== bindingsRequestGeneration) return
    const nextBindings = results.flat()
    bindings.value = nextBindings
    void loadReceiptFacts(nextBindings, requestGeneration)
  } catch (cause) {
    if (requestGeneration !== bindingsRequestGeneration) return
    bindings.value = []
    error.value = (cause as Error)?.message || '读取 K12 Webhook 失败'
  } finally {
    if (requestGeneration === bindingsRequestGeneration) {
      loading.value = false
    }
  }
}

async function loadReceiptFacts(nextBindings: K12WebhookBinding[], requestGeneration: number) {
  if (nextBindings.length === 0) return
  try {
    const entries = await Promise.all(
      nextBindings.map(async (binding) => {
        const result = await getK12WebhookReceipts(binding.name, binding.agent_id)
        return [
          bindingReceiptKey(binding),
          projectReceiptFacts(result.receipts ?? []),
        ] as const
      }),
    )
    if (requestGeneration !== bindingsRequestGeneration) return
    cardReceiptFacts.value = Object.fromEntries(
      entries.filter((entry): entry is [string, ReceiptCardFacts] => entry[1] !== null),
    )
  } catch (cause) {
    if (requestGeneration === bindingsRequestGeneration) {
      toast.error((cause as Error)?.message || '读取 K12 Receipt 汇总失败')
    }
  }
}

function receiptFactsFor(binding: K12WebhookBinding): ReceiptCardFacts | null {
  return cardReceiptFacts.value[bindingReceiptKey(binding)] ?? null
}

function openCreate() {
  editorMode.value = 'create'
  editingName.value = ''
  formName.value = ''
  formEvents.value = ['k12.submission.requested.v1']
  formWorkflows.value = ''
  formAgentId.value = selectedAgentId.value || agents.value[0]?.name || ''
  editorOpen.value = true
}

function openEdit(binding: K12WebhookBinding) {
  editorMode.value = 'edit'
  editingName.value = binding.name
  formName.value = binding.name
  formEvents.value = [...binding.allowed_events]
  formWorkflows.value = (binding.allowed_workflows ?? []).join(', ')
  formAgentId.value = binding.agent_id
  editorOpen.value = true
}

function toggleEvent(value: K12WebhookEventType, checked: boolean) {
  const next = formEvents.value.filter((item) => item !== value)
  if (checked) next.push(value)
  formEvents.value = eventOptions
    .map((option) => option.value)
    .filter((item) => next.includes(item))
}

function workflowIDs(): string[] {
  return [
    ...new Set(
      formWorkflows.value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ]
}

async function submitEditor() {
  const name = formName.value.trim()
  const workflows = workflowIDs()
  const agentID = formAgentId.value
  const learnerID =
    agents.value.find((agent) => agent.name === agentID)?.metadata?.['k12.learner_id'] || ''
  if (!name || formEvents.value.length === 0) {
    toast.error('名称和至少一个允许事件必填')
    return
  }
  if (formEvents.value.includes('k12.workflow_run.requested.v1') && workflows.length === 0) {
    toast.error('允许工作流事件时必须填写 workflow@version 白名单')
    return
  }
  busy.value = 'editor'
  try {
    if (editorMode.value === 'create') {
      const result = await createK12Webhook({
        name,
        agentId: agentID,
        learnerId: learnerID,
        allowedEvents: formEvents.value,
        allowedWorkflows: workflows,
      })
      if (selectedAgentId.value === agentID) {
        secretResult.value = { title: 'K12 Webhook 已创建', name, secret: result.secret }
      }
    } else {
      await updateK12Webhook(editingName.value, agentID, {
        allowed_events: formEvents.value,
        allowed_workflows: workflows,
      })
      if (selectedAgentId.value === agentID) toast.success('允许事件已更新')
    }
    editorOpen.value = false
    await loadBindings()
  } catch (cause) {
    toast.error((cause as Error)?.message || '保存 K12 Webhook 失败')
  } finally {
    busy.value = ''
  }
}

async function toggleBinding(binding: K12WebhookBinding) {
  if (busy.value) return
  const agentID = binding.agent_id
  busy.value = `toggle:${binding.name}`
  try {
    await updateK12Webhook(binding.name, agentID, {
      enabled: binding.status !== 'enabled',
    })
    await loadBindings()
  } catch (cause) {
    toast.error((cause as Error)?.message || '切换 K12 Webhook 失败')
  } finally {
    busy.value = ''
  }
}

function requestRotateSecret(binding: K12WebhookBinding) {
  if (busy.value) return
  rotateTarget.value = binding
}

async function confirmRotateSecret() {
  const binding = rotateTarget.value
  if (!binding || busy.value) return
  const agentID = binding.agent_id
  busy.value = `rotate:${binding.name}`
  try {
    const result = await rotateK12WebhookSecret(binding.name, agentID)
    if (selectedAgentId.value === agentID) {
      rotateTarget.value = null
      secretResult.value = { title: 'Secret 已轮换', name: binding.name, secret: result.secret }
    }
    await loadBindings()
  } catch (cause) {
    toast.error((cause as Error)?.message || '轮换 Secret 失败')
  } finally {
    busy.value = ''
  }
}

function clearHistoryPoll() {
  if (historyTimer) clearTimeout(historyTimer)
  historyTimer = undefined
}

function closeHistory() {
  clearHistoryPoll()
  historyRequestGeneration++
  historyName.value = ''
  receipts.value = []
}

async function loadHistory(binding: K12WebhookBinding) {
  clearHistoryPoll()
  const agentID = binding.agent_id
  const requestGeneration = ++historyRequestGeneration
  if (historyName.value !== binding.name) receipts.value = []
  historyName.value = binding.name
  try {
    const result = await getK12WebhookReceipts(binding.name, agentID)
    if (
      requestGeneration !== historyRequestGeneration ||
      historyBinding.value?.agent_id !== agentID ||
      historyName.value !== binding.name
    ) {
      return
    }
    receipts.value = result.receipts ?? []
    const facts = projectReceiptFacts(receipts.value)
    const nextFacts = { ...cardReceiptFacts.value }
    if (facts) nextFacts[bindingReceiptKey(binding)] = facts
    else delete nextFacts[bindingReceiptKey(binding)]
    cardReceiptFacts.value = nextFacts
    if (receipts.value.some((item) => item.status === 'accepted' || item.status === 'processing')) {
      historyTimer = setTimeout(() => void loadHistory(binding), 1000)
    }
  } catch (cause) {
    if (requestGeneration === historyRequestGeneration && selectedAgentId.value === agentID) {
      toast.error((cause as Error)?.message || '读取 Receipt 历史失败')
    }
  }
}

async function retryReceipt(binding: K12WebhookBinding, receipt: K12WebhookReceipt) {
  if (busy.value || receipt.status !== 'failed' || !receipt.retryable) return
  const agentID = binding.agent_id
  busy.value = `retry:${receipt.receipt_id}`
  try {
    await retryK12WebhookReceipt(binding.name, agentID, receipt.receipt_id)
    if (historyBinding.value?.agent_id !== agentID || historyName.value !== binding.name) return
    toast.success('Receipt 已重新派发')
    await loadHistory(binding)
  } catch (cause) {
    toast.error((cause as Error)?.message || 'Receipt 重新派发失败')
  } finally {
    busy.value = ''
  }
}

async function copy(value: string) {
  try {
    await setClipboard(value)
    toast.success('已复制')
  } catch {
    toast.error('复制失败，请手动复制')
  }
}

onMounted(() => {
  // 本面板拥有绑定列表和 K12 专属空态；即使零绑定，也不能再叠加通用 Webhook 空态。
  emit('contentChange', true)
  void loadAgents()
})
onBeforeUnmount(() => {
  emit('contentChange', false)
  bindingsRequestGeneration++
  historyRequestGeneration++
  clearHistoryPoll()
})
</script>

<template>
  <section class="k12wh k12wh--embedded" data-testid="k12-webhook-panel">
    <header class="k12wh__toolbar">
      <button
        class="k12wh__button k12wh__button--primary"
        data-testid="k12-webhook-create-open"
        :disabled="!selectedAgentId"
        @click="openCreate"
      >
        新建绑定
      </button>
    </header>

    <div v-if="error" class="k12wh__error" role="alert">
      <span>{{ error }}</span>
      <button
        class="k12wh__button k12wh__button--ghost"
        data-testid="k12-webhook-retry"
        @click="loadAgents"
      >
        重试
      </button>
    </div>
    <p v-if="loading" class="k12wh__empty">读取绑定中…</p>
    <p v-else-if="bindings.length === 0" class="k12wh__empty">暂无 K12 Webhook 绑定。</p>

    <article
      v-for="binding in bindings"
      :key="binding.binding_id"
      class="k12wh__card k12-webhook-card"
      :data-testid="`k12-webhook-row-${binding.name}`"
    >
      <div class="k12wh__top">
        <div class="k12wh__logo">K12</div>
        <div class="k12wh__identity">
          <div class="k12wh__name">K12 批改与回传事件</div>
          <div class="k12wh__meta">绑定：{{ bindingTarget(binding) }}</div>
        </div>
        <span class="k12wh__spacer"></span>
        <span
          class="k12wh__status"
          :class="{ 'k12wh__status--enabled': binding.status === 'enabled' }"
          >{{ binding.status === 'enabled' ? '启用' : '未启用' }}</span
        >
      </div>

      <div class="k12wh__resource k12wh__signature">
        <b>签名</b>
        <span class="k12wh__spacer"
          >HMAC-SHA256 · Secret {{ binding.has_secret ? '已配置' : '未配置' }} · 重放窗口 5
          分钟</span
        >
        <button
          class="k12wh__button k12wh__button--ghost"
          :data-testid="`k12-webhook-rotate-${binding.name}`"
          :disabled="Boolean(busy)"
          @click="requestRotateSecret(binding)"
        >
          轮换密钥
        </button>
      </div>

      <div class="k12wh__events" aria-label="允许事件">
        <code v-for="event in binding.allowed_events" :key="event" class="k12wh__event">{{
          event
        }}</code>
      </div>

      <div
        v-if="receiptFactsFor(binding)"
        class="k12wh__receipt-facts task-meta"
        :data-testid="`k12-webhook-receipt-facts-${binding.name}`"
      >
        <span
          >最近回执：{{ receiptAgeLabel(receiptFactsFor(binding)!.latest.created_at) }} ·
          {{ receiptStatusLabel(receiptFactsFor(binding)!.latest.status) }}</span
        >
        <span>nonce 重放：{{ receiptFactsFor(binding)!.nonceReplayCount }} 次已拒绝</span>
        <span>失败投递：{{ receiptFactsFor(binding)!.retryableFailureCount }} 条可重试</span>
      </div>

      <div class="k12wh__actions">
        <button
          class="k12wh__button"
          :data-testid="`k12-webhook-history-${binding.name}`"
          @click="loadHistory(binding)"
        >
          事件与回执
        </button>
        <button
          class="k12wh__button"
          :data-testid="`k12-webhook-edit-${binding.name}`"
          @click="openEdit(binding)"
        >
          编辑绑定
        </button>
        <button
          class="k12wh__button k12wh__button--ghost"
          :data-testid="`k12-webhook-toggle-${binding.name}`"
          :disabled="Boolean(busy)"
          @click="toggleBinding(binding)"
        >
          {{ binding.status === 'enabled' ? '暂停' : '启用' }}
        </button>
      </div>
    </article>

    <div
      v-if="historyBinding"
      class="k12wh__modal"
      data-testid="k12-webhook-history-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="k12-webhook-history-title"
    >
      <div class="k12wh__dialog">
        <div class="k12wh__history-title">
          <strong id="k12-webhook-history-title">K12 Webhook · 事件与回执</strong>
          <span class="k12wh__history-tools">
            <button aria-label="刷新 Receipt" @click="loadHistory(historyBinding)">
              <RefreshCw :size="13" />
            </button>
            <button aria-label="关闭" @click="closeHistory"><X :size="16" /></button>
          </span>
        </div>
        <div class="k12wh__notice">
          <b>{{ bindingTarget(historyBinding) }}</b> · 只接受绑定白名单内的 direct 事件；owner
          由服务端绑定解析。
        </div>
        <div class="k12wh__history">
          <p v-if="receipts.length === 0">暂无 Receipt</p>
          <div v-for="receipt in receipts" :key="receipt.receipt_id" class="k12wh__receipt">
            <span>{{ receipt.status }}</span>
            <code>{{
              receipt.job_or_execution_ref || receipt.failure_kind || receipt.receipt_id
            }}</code>
            <button
              v-if="receipt.status === 'failed' && receipt.retryable"
              class="k12wh__button k12wh__button--ghost"
              :data-testid="`k12-webhook-retry-receipt-${receipt.receipt_id}`"
              :disabled="busy === `retry:${receipt.receipt_id}`"
              @click="retryReceipt(historyBinding, receipt)"
            >
              {{ busy === `retry:${receipt.receipt_id}` ? '重新派发中…' : '重新派发' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="rotateTarget"
      class="k12wh__modal"
      data-testid="k12-webhook-rotate-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="k12-webhook-rotate-title"
    >
      <div class="k12wh__dialog">
        <header>
          <strong id="k12-webhook-rotate-title">轮换 K12 Webhook 密钥</strong>
          <button aria-label="关闭" @click="rotateTarget = null"><X :size="16" /></button>
        </header>
        <div class="k12wh__notice">
          新密钥只在轮换完成后显示一次；当前后端会立即停用旧密钥，请先确认接收方可以同步更新。
        </div>
        <div class="k12wh__dialog-actions">
          <button class="k12wh__button k12wh__button--ghost" @click="rotateTarget = null">
            取消
          </button>
          <button
            class="k12wh__button k12wh__button--primary"
            data-testid="k12-webhook-rotate-confirm"
            :disabled="busy.startsWith('rotate:')"
            @click="confirmRotateSecret"
          >
            {{ busy.startsWith('rotate:') ? '轮换中…' : '确认轮换' }}
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="editorOpen"
      class="k12wh__modal"
      data-testid="k12-webhook-editor-dialog"
      role="dialog"
      aria-modal="true"
    >
      <div class="k12wh__dialog k12wh__dialog--editor">
        <header>
          <strong>{{ editorMode === 'create' ? '新建 K12 Webhook' : `编辑 ${editingName}` }}</strong
          ><button type="button" aria-label="关闭" @click="editorOpen = false">
            <X :size="16" />
          </button>
        </header>
        <div class="k12wh__editor-body">
          <label v-if="editorMode === 'create'" data-testid="k12-webhook-editor-agent">
            绑定对象
            <HcSelect
              :model-value="formAgentId"
              :options="agentOptions"
              aria-label="绑定对象"
              @update:model-value="formAgentId = $event"
            />
          </label>
          <p v-else>绑定对象：{{ agentTargetLabel(formAgentId) }}</p>
          <label>
            名称
            <HcClearableField>
              <input
                v-model="formName"
                data-testid="k12-webhook-name"
                :disabled="editorMode === 'edit'"
              />
            </HcClearableField>
          </label>
          <fieldset>
            <legend>允许事件</legend>
            <label v-for="option in eventOptions" :key="option.value">
              <input
                type="checkbox"
                :data-testid="option.testid"
                :checked="formEvents.includes(option.value)"
                @change="toggleEvent(option.value, ($event.target as HTMLInputElement).checked)"
              />
              {{ option.label }}
            </label>
          </fieldset>
          <label v-if="formEvents.includes('k12.workflow_run.requested.v1')">
            Workflow 白名单（workflow@version，逗号分隔）
            <HcClearableField>
              <input v-model="formWorkflows" data-testid="k12-webhook-workflows" />
            </HcClearableField>
          </label>
          <p>新绑定默认 disabled；Secret 由服务端生成，创建后仅显示一次。</p>
        </div>
        <div class="k12wh__dialog-actions k12wh__editor-footer">
          <button
            type="button"
            class="k12wh__button k12wh__button--ghost"
            data-testid="k12-webhook-editor-cancel"
            @click="editorOpen = false"
          >
            取消
          </button>
          <button
            type="button"
            class="k12wh__button k12wh__button--primary"
            :data-testid="
              editorMode === 'create' ? 'k12-webhook-create-submit' : 'k12-webhook-edit-submit'
            "
            :disabled="busy === 'editor'"
            @click="submitEditor"
          >
            保存
          </button>
        </div>
      </div>
    </div>

    <div v-if="secretResult" class="k12wh__modal" role="dialog" aria-modal="true">
      <div class="k12wh__dialog">
        <header>
          <strong>{{ secretResult.title }}</strong
          ><button
            class="k12wh__modal-close"
            data-testid="k12-webhook-secret-close"
            @click="secretResult = null"
          >
            <X :size="16" />
          </button>
        </header>
        <p>签名 Secret 仅本次显示，请立即保存；页面关闭后只能轮换，无法找回。</p>
        <div class="k12wh__secret">
          <code>{{ secretResult.secret }}</code
          ><button class="k12wh__copy" @click="copy(secretResult.secret)">
            <Copy :size="14" />复制
          </button>
        </div>
        <div class="k12wh__secret">
          <code>{{ webhookUrlFor(secretResult.name) }}</code
          ><button class="k12wh__copy" @click="copy(webhookUrlFor(secretResult.name))">
            <Copy :size="14" />复制端点
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.k12wh {
  display: grid;
  gap: 14px;
  color: var(--hc-text-primary);
}
.k12wh--embedded {
  display: contents;
}
.k12wh--embedded .k12wh__toolbar {
  display: none;
}
.k12wh__toolbar,
.k12wh__history-title,
.k12wh__dialog header,
.k12wh__secret {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}
.k12wh__toolbar {
  align-items: end;
}
.k12wh__empty,
.k12wh__dialog p,
small {
  color: var(--hc-text-muted);
  font-size: 12px;
}
.k12wh button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background 0.15s var(--hc-ease-out),
    box-shadow 0.2s var(--hc-ease-out),
    transform 0.12s var(--hc-ease-out),
    border-color 0.15s var(--hc-ease-out);
}
.k12wh button:hover {
  background: var(--hc-bg-hover);
}
.k12wh button:active {
  transform: scale(0.97);
}
.k12wh button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}
.k12wh button:disabled {
  cursor: default;
  opacity: 0.55;
  transform: none;
  box-shadow: none;
}
.k12wh input:not([type='checkbox']) {
  border: 1px solid var(--hc-border);
  border-radius: 8px;
  background: var(--hc-bg-elevated);
  color: inherit;
  padding: 7px 10px;
}
.k12wh__agent,
.k12wh__dialog > label {
  display: grid;
  gap: 6px;
  font-size: 13px;
}
.k12wh__agent {
  width: min(320px, 100%);
}
.k12wh__card {
  border: 0.5px solid var(--hc-border);
  border-radius: 14px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: var(--hc-bg-card);
  box-shadow: var(--hc-shadow-sm);
  transition:
    border-color 0.15s var(--hc-ease-out),
    box-shadow 0.2s var(--hc-ease-out),
    transform 0.15s var(--hc-ease-out);
}
.k12wh__card:hover {
  border-color: var(--hc-border-hl);
  box-shadow: var(--hc-shadow-md);
  transform: translateY(-2px);
}
.k12-webhook-card {
  border-color: color-mix(in srgb, var(--hc-accent) 42%, var(--hc-border));
  background: linear-gradient(145deg, var(--hc-accent-subtle), var(--hc-bg-card) 45%);
}
.k12wh__top {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.k12wh__logo {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  border-radius: 10px;
  background: var(--hc-bg-input);
  font-size: 18px;
}
.k12wh__identity {
  min-width: 0;
}
.k12wh__name {
  font-size: 14px;
  font-weight: 600;
}
.k12wh__meta {
  margin-top: 1px;
  overflow: hidden;
  color: var(--hc-text-secondary);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.k12wh__spacer {
  flex: 1;
  min-width: 0;
}
.k12wh__status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  padding: 3px 9px;
  border-radius: 7px;
  background: var(--hc-bg-active);
  color: var(--hc-text-muted);
  font-size: 12px;
  white-space: nowrap;
}
.k12wh__status::before {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--hc-text-muted);
  content: '';
}
.k12wh__status--enabled {
  background: rgb(50 213 131 / 14%);
  color: var(--hc-success);
}
.k12wh__status--enabled::before {
  background: var(--hc-success);
}
.k12wh__resource {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 9px 10px;
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  background: var(--hc-bg-card);
  color: var(--hc-text-secondary);
  font-size: 12px;
}
.k12wh__resource b {
  color: var(--hc-text-primary);
}
.k12wh__signature > .k12wh__spacer {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.k12wh__events,
.k12wh__facts,
.k12wh__receipt-facts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
  color: var(--hc-text-secondary);
  font-size: 12px;
}
.k12wh__event {
  display: inline-flex;
  align-items: center;
  justify-self: start;
  padding: 2px 6px;
  border-radius: 5px;
  background: var(--hc-bg-input);
  color: var(--hc-text-secondary);
  font-family: 'SF Mono', Menlo, monospace;
  font-size: 9.5px;
}
.k12wh--embedded .k12wh__event {
  justify-self: stretch;
}
.k12wh__button--ghost {
  padding: 6px 8px;
  border-color: transparent;
  background: transparent;
  color: var(--hc-text-secondary);
  font-weight: 500;
  box-shadow: none;
}
.k12wh button.k12wh__button--ghost {
  padding: 6px 8px;
  border-color: transparent;
  background: transparent;
  color: var(--hc-text-secondary);
  font-weight: 500;
  line-height: 18px;
  box-shadow: none;
}
.k12wh--embedded .k12wh__signature button.k12wh__button--ghost {
  height: 32px;
  box-sizing: border-box;
}
.k12wh--embedded .k12wh__actions button {
  line-height: 18px;
}
.k12wh__button--primary {
  border-color: transparent;
  background: linear-gradient(180deg, #5fb3ea 0%, #4a9de0 100%);
  color: #fff;
  box-shadow: 0 6px 18px rgb(95 179 234 / 28%);
}
.k12wh__button--primary:hover {
  background: linear-gradient(180deg, #67b8ec 0%, #4f9fe1 100%);
}
.k12wh__actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.k12wh--embedded .k12wh__actions {
  height: 36px;
}
.k12wh--embedded .k12wh__actions button {
  height: 36px;
  box-sizing: border-box;
}
.k12wh__history-tools,
.k12wh__dialog-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.k12wh__history-tools button {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  padding: 0;
  border-color: transparent;
  background: transparent;
}
.k12wh__notice {
  padding: 11px 13px;
  border: 0.5px solid var(--hc-border);
  border-radius: 12px;
  background: var(--hc-bg-card);
  color: var(--hc-text-secondary);
  font-size: 12.5px;
  line-height: 1.55;
}
.k12wh__notice b {
  color: var(--hc-text-primary);
}
.k12wh__dialog-actions {
  justify-content: flex-end;
}
.k12wh__history {
  display: grid;
  gap: 8px;
}
.k12wh__receipt {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 9px 10px;
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  background: var(--hc-bg-card);
  font-size: 12px;
}
.k12wh__receipt code {
  overflow: hidden;
  color: var(--hc-text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.k12wh__error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--hc-danger, #dc3545);
}
.k12wh__modal {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgb(0 0 0 / 45%);
}
.k12wh__dialog {
  width: min(560px, 100%);
  max-height: 85vh;
  overflow: auto;
  display: grid;
  gap: 14px;
  padding: 18px;
  border: 1px solid var(--hc-border);
  border-radius: 14px;
  background: var(--hc-bg-elevated);
  box-shadow: 0 18px 60px rgb(0 0 0 / 28%);
}
.k12wh__dialog--editor {
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
}
.k12wh__editor-body {
  display: grid;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  gap: 14px;
  overflow-y: auto;
}
.k12wh__editor-body > label {
  display: grid;
  min-width: 0;
  gap: 7px;
}
.k12wh__editor-body input:not([type='checkbox']) {
  display: block;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
}
.k12wh__editor-footer {
  padding-top: 14px;
  border-top: 1px solid var(--hc-border);
}
.k12wh__dialog fieldset {
  display: grid;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--hc-border);
  border-radius: 10px;
}
.k12wh__dialog fieldset label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.k12wh__secret {
  align-items: stretch;
}
.k12wh__secret code {
  flex: 1;
  overflow-wrap: anywhere;
  padding: 9px;
  border-radius: 8px;
  background: var(--hc-bg-sunken);
}
@media (max-width: 720px) {
  .k12wh__toolbar,
  .k12wh__resource {
    align-items: stretch;
    flex-direction: column;
  }
  .k12wh__agent {
    width: 100%;
  }
  .k12wh__events,
  .k12wh__facts,
  .k12wh__receipt-facts {
    grid-template-columns: 1fr;
  }
}
</style>
