<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'

import { Trash2, Globe, Webhook as WebhookIcon, PowerOff, X } from 'lucide-vue-next'
import { getWebhooks, createWebhook, deleteWebhook } from '@/api/webhook'
import type { Webhook, WebhookType, WebhookEvent } from '@/api/webhook'
import { useToast } from '@/composables/useToast'
import HcSelect from '@/components/common/HcSelect.vue'

const { t } = useI18n()
const toast = useToast()

const webhooks = ref<Webhook[]>([])
const loading = ref(false)
const showCreate = ref(false)
const creating = ref(false)
const deletingIds = ref<Set<string>>(new Set())
const loadError = ref('')
/** 后端 webhook.enabled=false 时 /api/v1/webhooks 路由不注册（404），按"功能未启用"处理 */
const featureDisabled = ref(false)
let loadRequestGen = 0

// Create form
const form = ref({
  name: '',
  type: 'custom' as WebhookType,
  url: '',
  events: ['task_complete'] as WebhookEvent[],
})

function resetCreateForm() {
  form.value = { name: '', type: 'custom', url: '', events: ['task_complete'] }
}

function openCreateForm() {
  resetCreateForm()
  showCreate.value = true
}

function closeCreateForm() {
  showCreate.value = false
  resetCreateForm()
}

const webhookTypes: { key: WebhookType; label: string }[] = [
  { key: 'custom', label: 'Custom HTTP' },
  { key: 'feishu', label: 'Feishu' },
  { key: 'dingtalk', label: 'DingTalk' },
  { key: 'wecom', label: 'WeCom' },
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

const eventTypes: { key: WebhookEvent; labelKey: string }[] = [
  { key: 'task_complete', labelKey: 'webhooks.eventTaskComplete' },
  { key: 'agent_complete', labelKey: 'webhooks.eventAgentComplete' },
  { key: 'error', labelKey: 'webhooks.eventError' },
]

async function loadWebhooks() {
  const requestGen = ++loadRequestGen
  loading.value = true
  loadError.value = ''
  featureDisabled.value = false
  try {
    const res = await getWebhooks()
    if (requestGen !== loadRequestGen) return
    webhooks.value = res?.webhooks ?? []
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
  if (!form.value.name || !form.value.url) {
    toast.error(t('webhooks.nameUrlRequired'))
    return
  }
  creating.value = true
  try {
    await createWebhook(form.value)
    toast.success(t('webhooks.created', { name: form.value.name }))
    closeCreateForm()
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
    await deleteWebhook(webhook.id)
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

function toggleEvent(event: WebhookEvent) {
  const idx = form.value.events.indexOf(event)
  if (idx >= 0) {
    form.value.events.splice(idx, 1)
  } else {
    form.value.events.push(event)
  }
}

onMounted(loadWebhooks)

defineExpose({ loadWebhooks, openCreateForm })
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

            <div class="px-5 py-4 webhook-modal__body">
              <div class="hc-form-group">
                <label>{{ t('webhooks.name') }}</label>
                <input v-model="form.name" class="hc-input" placeholder="my-webhook" />
              </div>
              <div class="hc-form-group">
                <label>{{ t('webhooks.type') }}</label>
                <HcSelect v-model="formType" :options="webhookTypeOptions" />
              </div>
              <div class="hc-form-group">
                <label>{{ t('webhooks.url') }}</label>
                <input v-model="form.url" class="hc-input" placeholder="https://..." />
              </div>
              <div class="hc-form-group">
                <label>{{ t('webhooks.events') }}</label>
                <div class="webhook-panel__events">
                  <label v-for="et in eventTypes" :key="et.key" class="webhook-panel__event-label">
                    <input type="checkbox" :checked="form.events.includes(et.key)" @change="toggleEvent(et.key)" />
                    {{ t(et.labelKey) }}
                  </label>
                </div>
              </div>
            </div>

            <div
              class="flex items-center justify-end gap-2 px-5 py-3.5 border-t webhook-modal__actions"
              :style="{ borderColor: 'var(--hc-border)' }"
            >
              <button class="hc-btn hc-btn-ghost" @click="closeCreateForm">{{ t('webhooks.cancel') }}</button>
              <button class="hc-btn hc-btn-primary" :disabled="creating" @click="onCreateWebhook">
                {{ t('webhooks.create') }}
              </button>
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
      <div v-for="wh in webhooks" :key="wh.id" class="webhook-panel__item">
        <div class="webhook-panel__item-info">
          <Globe :size="14" />
          <span class="webhook-panel__item-name">{{ wh.name }}</span>
          <span class="webhook-panel__item-type">{{ wh.type }}</span>
        </div>
        <div class="webhook-panel__item-url">{{ wh.url }}</div>
        <div class="webhook-panel__item-events">
          <span v-for="ev in wh.events" :key="ev" class="webhook-panel__event-tag">{{ ev }}</span>
        </div>
        <button class="hc-btn hc-btn-ghost hc-btn-sm webhook-panel__delete" :disabled="deletingIds.has(wh.id)" @click="onDeleteWebhook(wh)">
          <Trash2 :size="14" />
        </button>
      </div>
    </div>
  </div>
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
.webhook-panel__item-url { grid-column: 1 / -1; font-size: 12px; color: var(--hc-text-secondary); font-family: ui-monospace, 'SF Mono', monospace; overflow: hidden; text-overflow: ellipsis; }
.webhook-panel__item-events { display: flex; gap: 4px; grid-column: 1 / -1; }
.webhook-panel__event-tag { font-size: 11px; padding: 1px 6px; background: var(--hc-accent-subtle); color: var(--hc-accent); border-radius: 4px; }
.webhook-panel__delete { position: absolute; top: 8px; right: 8px; }
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
