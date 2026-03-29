<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Trash2, Copy } from 'lucide-vue-next'
import { getWebhooks, createWebhook, deleteWebhook } from '@/api/webhook'
import type { Webhook, WebhookType, WebhookEvent } from '@/api/webhook'
import { setClipboard } from '@/api/desktop'

const { t } = useI18n()

const webhooks = ref<Webhook[]>([])
const loading = ref(false)
const showCreate = ref(false)
const newName = ref('')
const newType = ref<WebhookType>('custom')
const newUrl = ref('')
const newEvents = ref<WebhookEvent[]>(['task_complete'])
const errorMsg = ref('')

async function load() {
  loading.value = true
  try {
    const result = await getWebhooks()
    webhooks.value = result.webhooks || []
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : 'Failed to load webhooks'
  } finally {
    loading.value = false
  }
}

async function handleCreate() {
  if (!newName.value.trim() || !newUrl.value.trim()) {
    errorMsg.value = t('webhooks.nameUrlRequired')
    return
  }
  try {
    await createWebhook({
      name: newName.value.trim(),
      type: newType.value,
      url: newUrl.value.trim(),
      events: newEvents.value,
    })
    showCreate.value = false
    newName.value = ''
    newUrl.value = ''
    await load()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : 'Create failed'
  }
}

async function handleDelete(name: string) {
  try {
    await deleteWebhook(name)
    await load()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : 'Delete failed'
  }
}

function copyUrl(url: string) {
  setClipboard(url)
}

onMounted(load)
</script>

<template>
  <div class="hc-webhooks">
    <!-- Error -->
    <div v-if="errorMsg" class="hc-webhooks__error" @click="errorMsg = ''">{{ errorMsg }}</div>

    <!-- Header -->
    <div class="hc-webhooks__header">
      <p class="hc-webhooks__desc">{{ t('webhooks.description') }}</p>
      <button class="hc-btn hc-btn-primary hc-btn-sm" @click="showCreate = !showCreate">
        <Plus :size="14" /> {{ t('webhooks.add') }}
      </button>
    </div>

    <!-- Create form -->
    <div v-if="showCreate" class="hc-webhooks__form">
      <input v-model="newName" class="hc-input" :placeholder="t('webhooks.namePlaceholder')" />
      <select v-model="newType" class="hc-input">
        <option value="custom">Custom</option>
        <option value="feishu">Feishu</option>
        <option value="dingtalk">DingTalk</option>
        <option value="wecom">WeCom</option>
      </select>
      <input v-model="newUrl" class="hc-input" placeholder="https://..." />
      <div class="hc-webhooks__form-actions">
        <button class="hc-btn hc-btn-ghost hc-btn-sm" @click="showCreate = false">{{ t('common.cancel') }}</button>
        <button class="hc-btn hc-btn-primary hc-btn-sm" @click="handleCreate">{{ t('common.create') }}</button>
      </div>
    </div>

    <!-- List -->
    <div v-if="loading" class="hc-webhooks__loading">{{ t('common.loading') }}</div>
    <div v-else-if="webhooks.length === 0" class="hc-webhooks__empty">{{ t('webhooks.empty') }}</div>
    <div v-else class="hc-webhooks__list">
      <div v-for="wh in webhooks" :key="wh.id" class="hc-webhooks__item">
        <div class="hc-webhooks__item-header">
          <span class="hc-webhooks__item-name">{{ wh.name }}</span>
          <span class="hc-webhooks__item-type">{{ wh.type }}</span>
        </div>
        <div class="hc-webhooks__item-url">
          <code>{{ wh.url }}</code>
          <button class="hc-btn-icon" @click="copyUrl(wh.url)" :title="t('common.copy')">
            <Copy :size="12" />
          </button>
        </div>
        <div class="hc-webhooks__item-events">
          <span v-for="ev in wh.events" :key="ev" class="hc-tag">{{ ev }}</span>
        </div>
        <div class="hc-webhooks__item-actions">
          <button class="hc-btn hc-btn-ghost hc-btn-sm hc-btn-danger-text" @click="handleDelete(wh.name)">
            <Trash2 :size="12" /> {{ t('common.delete') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hc-webhooks { padding: 16px 0; }
.hc-webhooks__error { padding: 8px 12px; border-radius: 6px; background: rgba(245,101,101,.1); color: var(--hc-error); font-size: 13px; margin-bottom: 12px; cursor: pointer; }
.hc-webhooks__header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.hc-webhooks__desc { font-size: 13px; color: var(--hc-text-secondary); }
.hc-webhooks__form { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--hc-border); border-radius: 8px; margin-bottom: 16px; }
.hc-webhooks__form-actions { display: flex; gap: 8px; justify-content: flex-end; }
.hc-webhooks__loading, .hc-webhooks__empty { font-size: 13px; color: var(--hc-text-muted); text-align: center; padding: 32px 0; }
.hc-webhooks__list { display: flex; flex-direction: column; gap: 8px; }
.hc-webhooks__item { padding: 12px; border: 1px solid var(--hc-border); border-radius: 8px; }
.hc-webhooks__item-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.hc-webhooks__item-name { font-weight: 500; font-size: 14px; }
.hc-webhooks__item-type { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--hc-bg-secondary); color: var(--hc-text-secondary); }
.hc-webhooks__item-url { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--hc-text-secondary); margin-bottom: 6px; }
.hc-webhooks__item-url code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hc-webhooks__item-events { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 8px; }
.hc-tag { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--hc-bg-secondary); color: var(--hc-text-muted); }
.hc-webhooks__item-actions { display: flex; justify-content: flex-end; }
</style>
