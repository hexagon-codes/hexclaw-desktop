<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Copy, RefreshCw, Trash2, X } from 'lucide-vue-next'

import { getAgents } from '@/api/agents'
import { setClipboard } from '@/api/desktop'
import {
  createK12Webhook,
  deleteK12Webhook,
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
import { K12_SCENARIO_ID } from '../descriptor'

const toast = useToast()

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

const currentAgent = computed(() =>
  agents.value.find((agent) => agent.name === selectedAgentId.value),
)
const currentLearnerId = computed(
  () => currentAgent.value?.metadata?.['k12.learner_id'] || currentAgent.value?.name || '',
)

const editorOpen = ref(false)
const editorMode = ref<'create' | 'edit'>('create')
const editingName = ref('')
const formName = ref('')
const formEvents = ref<K12WebhookEventType[]>(['k12.submission.requested.v1'])
const formWorkflows = ref('')

const secretResult = ref<{ title: string; name: string; secret: string } | null>(null)
const historyName = ref('')
const receipts = ref<K12WebhookReceipt[]>([])
let historyTimer: ReturnType<typeof setTimeout> | undefined
let bindingsRequestGeneration = 0
let historyRequestGeneration = 0

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
  const agentID = selectedAgentId.value
  const requestGeneration = ++bindingsRequestGeneration
  if (!agentID) {
    bindings.value = []
    loading.value = false
    return
  }
  loading.value = true
  error.value = ''
  try {
    const result = await getK12Webhooks(agentID)
    if (requestGeneration !== bindingsRequestGeneration || selectedAgentId.value !== agentID) return
    bindings.value = result.k12_bindings ?? []
  } catch (cause) {
    if (requestGeneration !== bindingsRequestGeneration || selectedAgentId.value !== agentID) return
    bindings.value = []
    error.value = (cause as Error)?.message || '读取 K12 Webhook 失败'
  } finally {
    if (requestGeneration === bindingsRequestGeneration && selectedAgentId.value === agentID) {
      loading.value = false
    }
  }
}

function onAgentChanged() {
  // Child switching is an ownership boundary: never leave another Tutor's
  // one-time secret or edit form visible in the newly selected scope.
  secretResult.value = null
  editorOpen.value = false
  void loadBindings()
}

function openCreate() {
  editorMode.value = 'create'
  editingName.value = ''
  formName.value = ''
  formEvents.value = ['k12.submission.requested.v1']
  formWorkflows.value = ''
  editorOpen.value = true
}

function openEdit(binding: K12WebhookBinding) {
  editorMode.value = 'edit'
  editingName.value = binding.name
  formName.value = binding.name
  formEvents.value = [...binding.allowed_events]
  formWorkflows.value = (binding.allowed_workflows ?? []).join(', ')
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
  const agentID = selectedAgentId.value
  const learnerID = currentLearnerId.value
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
  const agentID = selectedAgentId.value
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

async function rotateSecret(binding: K12WebhookBinding) {
  if (busy.value) return
  const agentID = selectedAgentId.value
  busy.value = `rotate:${binding.name}`
  try {
    const result = await rotateK12WebhookSecret(binding.name, agentID)
    if (selectedAgentId.value === agentID) {
      secretResult.value = { title: 'Secret 已轮换', name: binding.name, secret: result.secret }
    }
    await loadBindings()
  } catch (cause) {
    toast.error((cause as Error)?.message || '轮换 Secret 失败')
  } finally {
    busy.value = ''
  }
}

async function removeBinding(binding: K12WebhookBinding) {
  if (busy.value) return
  const agentID = selectedAgentId.value
  busy.value = `delete:${binding.name}`
  try {
    await deleteK12Webhook(binding.name, agentID)
    await loadBindings()
    if (selectedAgentId.value === agentID) toast.success('K12 Webhook 已删除')
  } catch (cause) {
    toast.error((cause as Error)?.message || '删除 K12 Webhook 失败')
  } finally {
    busy.value = ''
  }
}

function clearHistoryPoll() {
  if (historyTimer) clearTimeout(historyTimer)
  historyTimer = undefined
}

async function loadHistory(binding: K12WebhookBinding) {
  clearHistoryPoll()
  const agentID = selectedAgentId.value
  const requestGeneration = ++historyRequestGeneration
  historyName.value = binding.name
  try {
    const result = await getK12WebhookReceipts(binding.name, agentID)
    if (
      requestGeneration !== historyRequestGeneration ||
      selectedAgentId.value !== agentID ||
      historyName.value !== binding.name
    ) {
      return
    }
    receipts.value = result.receipts ?? []
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
  const agentID = selectedAgentId.value
  busy.value = `retry:${receipt.receipt_id}`
  try {
    await retryK12WebhookReceipt(binding.name, agentID, receipt.receipt_id)
    if (selectedAgentId.value !== agentID || historyName.value !== binding.name) return
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

onMounted(() => void loadAgents())
onBeforeUnmount(() => {
  bindingsRequestGeneration++
  historyRequestGeneration++
  clearHistoryPoll()
})
</script>

<template>
  <section class="k12wh" data-testid="k12-webhook-panel">
    <header class="k12wh__header">
      <div>
        <h3>K12 Webhook</h3>
        <p>
          绑定到指定孩子的辅导实例；服务端解析 owner，仅接受 HMAC、时间窗与 nonce 校验后的 direct
          事件。
        </p>
      </div>
      <button
        data-testid="k12-webhook-create-open"
        :disabled="!selectedAgentId"
        @click="openCreate"
      >
        新建绑定
      </button>
    </header>

    <label class="k12wh__agent">
      <span>孩子 / 辅导实例</span>
      <select v-model="selectedAgentId" data-testid="k12-webhook-agent" @change="onAgentChanged">
        <option v-for="agent in agents" :key="agent.name" :value="agent.name">
          {{ agent.metadata?.['k12.child_name'] || agent.display_name }}
        </option>
      </select>
    </label>

    <p v-if="agents.length === 0 && !error" class="k12wh__empty">请先创建一个 K12 辅导实例。</p>
    <div v-if="error" class="k12wh__error" role="alert">
      <span>{{ error }}</span>
      <button data-testid="k12-webhook-retry" @click="loadAgents">重试</button>
    </div>
    <p v-if="loading" class="k12wh__empty">读取绑定中…</p>
    <p v-else-if="selectedAgentId && bindings.length === 0" class="k12wh__empty">
      这个孩子还没有 K12 Webhook。
    </p>

    <article
      v-for="binding in bindings"
      :key="binding.binding_id"
      class="k12wh__card"
      :data-testid="`k12-webhook-row-${binding.name}`"
    >
      <div class="k12wh__summary">
        <div>
          <strong>{{ binding.name }}</strong>
          <span class="k12wh__badge">{{ binding.status }}</span>
          <span class="k12wh__badge">仅直连</span>
          <p>{{ webhookUrlFor(binding.name) }}</p>
          <small
            >Secret v{{ binding.secret_version }} · {{ binding.allowed_events.join(' · ') }}</small
          >
        </div>
        <div class="k12wh__actions">
          <button
            :data-testid="`k12-webhook-toggle-${binding.name}`"
            @click="toggleBinding(binding)"
          >
            {{ binding.status === 'enabled' ? '停用' : '启用' }}
          </button>
          <button :data-testid="`k12-webhook-edit-${binding.name}`" @click="openEdit(binding)">
            编辑
          </button>
          <button
            :data-testid="`k12-webhook-rotate-${binding.name}`"
            @click="rotateSecret(binding)"
          >
            轮换 Secret
          </button>
          <button
            :data-testid="`k12-webhook-history-${binding.name}`"
            @click="loadHistory(binding)"
          >
            Receipt
          </button>
          <button
            :data-testid="`k12-webhook-delete-${binding.name}`"
            aria-label="删除"
            @click="removeBinding(binding)"
          >
            <Trash2 :size="14" />
          </button>
        </div>
      </div>
      <div v-if="historyName === binding.name" class="k12wh__history">
        <div class="k12wh__history-title">
          <strong>执行回执</strong>
          <button aria-label="刷新 Receipt" @click="loadHistory(binding)">
            <RefreshCw :size="13" />
          </button>
        </div>
        <p v-if="receipts.length === 0">暂无 Receipt</p>
        <div v-for="receipt in receipts" :key="receipt.receipt_id" class="k12wh__receipt">
          <span>{{ receipt.status }}</span>
          <code>{{
            receipt.job_or_execution_ref || receipt.failure_kind || receipt.receipt_id
          }}</code>
          <button
            v-if="receipt.status === 'failed' && receipt.retryable"
            :data-testid="`k12-webhook-retry-receipt-${receipt.receipt_id}`"
            :disabled="busy === `retry:${receipt.receipt_id}`"
            @click="retryReceipt(binding, receipt)"
          >
            {{ busy === `retry:${receipt.receipt_id}` ? '重新派发中…' : '重新派发' }}
          </button>
        </div>
      </div>
    </article>

    <div v-if="editorOpen" class="k12wh__modal" role="dialog" aria-modal="true">
      <div class="k12wh__dialog">
        <header>
          <strong>{{ editorMode === 'create' ? '新建 K12 Webhook' : `编辑 ${editingName}` }}</strong
          ><button @click="editorOpen = false"><X :size="16" /></button>
        </header>
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
        <button
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

    <div v-if="secretResult" class="k12wh__modal" role="dialog" aria-modal="true">
      <div class="k12wh__dialog">
        <header>
          <strong>{{ secretResult.title }}</strong
          ><button data-testid="k12-webhook-secret-close" @click="secretResult = null">
            <X :size="16" />
          </button>
        </header>
        <p>签名 Secret 仅本次显示，请立即保存；页面关闭后只能轮换，无法找回。</p>
        <div class="k12wh__secret">
          <code>{{ secretResult.secret }}</code
          ><button @click="copy(secretResult.secret)"><Copy :size="14" />复制</button>
        </div>
        <div class="k12wh__secret">
          <code>{{ webhookUrlFor(secretResult.name) }}</code
          ><button @click="copy(webhookUrlFor(secretResult.name))">
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
.k12wh__header,
.k12wh__summary,
.k12wh__history-title,
.k12wh__dialog header,
.k12wh__secret {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}
.k12wh__header h3,
.k12wh__header p,
.k12wh__summary p {
  margin: 0;
}
.k12wh__header p,
.k12wh__summary p,
.k12wh__empty,
.k12wh__dialog p,
small {
  color: var(--hc-text-muted);
  font-size: 12px;
}
.k12wh button,
.k12wh select,
.k12wh input {
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
.k12wh__card {
  border: 1px solid var(--hc-border);
  border-radius: 12px;
  padding: 14px;
  background: var(--hc-bg-card);
}
.k12wh__badge {
  display: inline-block;
  margin-left: 7px;
  padding: 2px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--hc-accent) 14%, transparent);
  font-size: 11px;
}
.k12wh__actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.k12wh__history {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--hc-border);
}
.k12wh__receipt {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  font-size: 12px;
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
.k12wh__dialog fieldset {
  display: grid;
  gap: 8px;
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
  .k12wh__summary,
  .k12wh__header {
    align-items: stretch;
    flex-direction: column;
  }
  .k12wh__actions {
    justify-content: flex-start;
  }
}
</style>
