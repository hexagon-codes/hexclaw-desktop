<script setup lang="ts">
import { ref, onMounted } from 'vue'

import { Plus, Trash2, Globe, AlertCircle } from 'lucide-vue-next'
import { getWebhooks, createWebhook, deleteWebhook } from '@/api/webhook'
import type { Webhook, WebhookType, WebhookEvent } from '@/api/webhook'
import { useToast } from '@/composables/useToast'

const toast = useToast()

const webhooks = ref<Webhook[]>([])
const loading = ref(false)
const showCreate = ref(false)
const creating = ref(false)
const deletingIds = ref<Set<string>>(new Set())
const loadError = ref('')
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

const eventTypes: { key: WebhookEvent; label: string }[] = [
  { key: 'task_complete', label: 'Task Complete' },
  { key: 'agent_complete', label: 'Agent Complete' },
  { key: 'error', label: 'Error' },
]

async function loadWebhooks() {
  const requestGen = ++loadRequestGen
  loading.value = true
  loadError.value = ''
  try {
    const res = await getWebhooks()
    if (requestGen !== loadRequestGen) return
    webhooks.value = res?.webhooks ?? []
  } catch (e) {
    if (requestGen !== loadRequestGen) return
    webhooks.value = []
    loadError.value = (e as Error)?.message || 'Load failed'
    console.error('Failed to load webhooks:', e)
  } finally {
    if (requestGen === loadRequestGen) {
      loading.value = false
    }
  }
}

async function onCreateWebhook() {
  if (creating.value) return
  if (!form.value.name || !form.value.url) {
    toast.error('Name and URL are required')
    return
  }
  creating.value = true
  try {
    await createWebhook(form.value)
    toast.success(`Webhook "${form.value.name}" created`)
    closeCreateForm()
    await loadWebhooks()
  } catch (e: unknown) {
    toast.error((e as Error)?.message || 'Create failed')
  } finally {
    creating.value = false
  }
}

async function onDeleteWebhook(webhook: Webhook) {
  if (deletingIds.value.has(webhook.id)) return
  deletingIds.value = new Set([...deletingIds.value, webhook.id])
  try {
    await deleteWebhook(webhook.id)
    toast.success(`Webhook "${webhook.name}" deleted`)
    await loadWebhooks()
  } catch (e: unknown) {
    toast.error((e as Error)?.message || 'Delete failed')
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

defineExpose({ loadWebhooks })
</script>

<template>
  <div class="webhook-panel">
    <!-- Header -->
    <div class="webhook-panel__header">
      <span class="webhook-panel__count">{{ webhooks.length }} webhooks</span>
      <button class="hc-btn hc-btn-primary hc-btn-sm" @click="showCreate ? closeCreateForm() : openCreateForm()">
        <Plus :size="14" />
        Add Webhook
      </button>
    </div>

    <!-- Create Form -->
    <div v-if="showCreate" class="webhook-panel__form">
      <div class="hc-form-group">
        <label>Name</label>
        <input v-model="form.name" class="hc-input" placeholder="my-webhook" />
      </div>
      <div class="hc-form-group">
        <label>Type</label>
        <select v-model="form.type" class="hc-input">
          <option v-for="wt in webhookTypes" :key="wt.key" :value="wt.key">{{ wt.label }}</option>
        </select>
      </div>
      <div class="hc-form-group">
        <label>URL</label>
        <input v-model="form.url" class="hc-input" placeholder="https://..." />
      </div>
      <div class="hc-form-group">
        <label>Events</label>
        <div class="webhook-panel__events">
          <label v-for="et in eventTypes" :key="et.key" class="webhook-panel__event-label">
            <input type="checkbox" :checked="form.events.includes(et.key)" @change="toggleEvent(et.key)" />
            {{ et.label }}
          </label>
        </div>
      </div>
      <div class="webhook-panel__form-actions">
        <button class="hc-btn hc-btn-ghost hc-btn-sm" @click="closeCreateForm">Cancel</button>
        <button class="hc-btn hc-btn-primary hc-btn-sm" :disabled="creating" @click="onCreateWebhook">Create</button>
      </div>
    </div>

    <!-- List -->
    <div v-if="loading" class="webhook-panel__loading">Loading...</div>
    <div v-else-if="loadError" class="webhook-panel__error">
      <AlertCircle :size="32" />
      <p>{{ loadError }}</p>
    </div>
    <div v-else-if="webhooks.length === 0" class="webhook-panel__empty">
      <AlertCircle :size="32" />
      <p>No webhooks configured</p>
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
.webhook-panel__count { font-size: 13px; color: var(--text-secondary); }
.webhook-panel__form { background: var(--bg-secondary); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
.webhook-panel__form .hc-form-group { margin-bottom: 12px; }
.webhook-panel__form .hc-form-group label { display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; }
.webhook-panel__form-actions { display: flex; gap: 8px; justify-content: flex-end; }
.webhook-panel__events { display: flex; gap: 12px; flex-wrap: wrap; }
.webhook-panel__event-label { display: flex; align-items: center; gap: 4px; font-size: 13px; }
.webhook-panel__list { display: flex; flex-direction: column; gap: 8px; }
.webhook-panel__item { display: grid; grid-template-columns: 1fr auto; gap: 4px 8px; padding: 12px; background: var(--bg-secondary); border-radius: 8px; position: relative; }
.webhook-panel__item-info { display: flex; align-items: center; gap: 8px; }
.webhook-panel__item-name { font-weight: 500; font-size: 14px; }
.webhook-panel__item-type { font-size: 11px; padding: 2px 6px; background: var(--bg-tertiary); border-radius: 4px; color: var(--text-secondary); }
.webhook-panel__item-url { grid-column: 1 / -1; font-size: 12px; color: var(--text-secondary); font-family: monospace; overflow: hidden; text-overflow: ellipsis; }
.webhook-panel__item-events { display: flex; gap: 4px; grid-column: 1 / -1; }
.webhook-panel__event-tag { font-size: 11px; padding: 1px 6px; background: var(--accent-muted); border-radius: 4px; }
.webhook-panel__delete { position: absolute; top: 8px; right: 8px; }
.webhook-panel__empty { text-align: center; padding: 40px; color: var(--text-tertiary); }
.webhook-panel__loading { text-align: center; padding: 40px; color: var(--text-tertiary); }
.webhook-panel__error { text-align: center; padding: 40px; color: var(--hc-error, #dc2626); }
</style>
