<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { NotificationConfig } from '@/types/settings'

const { t } = useI18n()

const props = defineProps<{ notification: NotificationConfig }>()
const emit = defineEmits<{ patch: [Partial<NotificationConfig>] }>()

function toggleSystem() {
  emit('patch', { system_enabled: !props.notification.system_enabled })
}

function toggleSound() {
  emit('patch', { sound_enabled: !props.notification.sound_enabled })
}

function toggleAgentComplete() {
  emit('patch', { agent_complete: !props.notification.agent_complete })
}

function toggleCron() {
  emit('patch', { cron_notify: !props.notification.cron_notify })
}

function toggleDnd() {
  emit('patch', { dnd_enabled: !props.notification.dnd_enabled })
}
</script>

<template>
  <div class="hc-settings-section-wrap">
    <div class="hc-settings-section">
      <div class="hc-settings-section__title">{{ t('settings.notification.preferences', '通知偏好') }}</div>
      <div class="hc-settings-row">
        <div>
          <div class="hc-settings-row__label">{{ t('settings.notification.desktop', '桌面通知') }}</div>
          <div class="hc-settings-row__desc">{{ t('settings.notification.desktopDesc', '当对话完成或任务执行结束时，发送系统通知') }}</div>
        </div>
        <div class="hc-toggle" :class="{ 'hc-toggle--on': notification.system_enabled }" role="switch" :aria-checked="notification.system_enabled" @click="toggleSystem" />
      </div>
      <div class="hc-settings-row">
        <div>
          <div class="hc-settings-row__label">{{ t('settings.notification.sound', '声音提示') }}</div>
          <div class="hc-settings-row__desc">{{ t('settings.notification.soundDesc', '完成通知附带声音提示') }}</div>
        </div>
        <div class="hc-toggle" :class="{ 'hc-toggle--on': notification.sound_enabled }" role="switch" :aria-checked="notification.sound_enabled" @click="toggleSound" />
      </div>
      <div class="hc-settings-row">
        <div>
          <div class="hc-settings-row__label">{{ t('settings.notification.taskNotify', '自动化任务通知') }}</div>
          <div class="hc-settings-row__desc">{{ t('settings.notification.taskNotifyDesc', '自动化任务成功、失败时推送通知') }}</div>
        </div>
        <div class="hc-toggle" :class="{ 'hc-toggle--on': notification.agent_complete }" role="switch" :aria-checked="notification.agent_complete" @click="toggleAgentComplete" />
      </div>
      <div class="hc-settings-row">
        <div>
          <div class="hc-settings-row__label">{{ t('settings.notification.cronReminder', 'Cron 提醒') }}</div>
          <div class="hc-settings-row__desc">{{ t('settings.notification.cronReminderDesc', '定时任务执行前后发送通知') }}</div>
        </div>
        <div class="hc-toggle" :class="{ 'hc-toggle--on': notification.cron_notify }" role="switch" :aria-checked="!!notification.cron_notify" @click="toggleCron" />
      </div>
    </div>
    <div class="hc-settings-section">
      <div class="hc-settings-section__title">{{ t('settings.notification.dnd', '勿扰模式') }}</div>
      <div class="hc-settings-row">
        <div>
          <div class="hc-settings-row__label">{{ t('settings.notification.dndToggle', '启用勿扰时段') }}</div>
          <div class="hc-settings-row__desc">{{ t('settings.notification.dndDesc', '在指定时段内静默所有通知') }}</div>
        </div>
        <div class="hc-toggle" :class="{ 'hc-toggle--on': notification.dnd_enabled }" role="switch" :aria-checked="!!notification.dnd_enabled" @click="toggleDnd" />
      </div>
      <div class="hc-settings-row">
        <div>
          <div class="hc-settings-row__label">{{ t('settings.notification.dndRange', '时段范围') }}</div>
          <div class="hc-settings-row__desc">22:00 – 08:00 {{ notification.dnd_enabled ? '✓' : t('settings.notification.notEnabled', '未启用') }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hc-settings-section-wrap { padding: 16px; }
.hc-settings-section { margin-bottom: 24px; }
.hc-settings-section__title {
  font-size: 13px; font-weight: 700; color: var(--hc-text-primary);
  margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--hc-border);
}
.hc-settings-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 0; border-bottom: 1px solid rgba(0,0,0,0.03);
}
.hc-settings-row__label { font-size: 13px; color: var(--hc-text-primary); }
.hc-settings-row__desc { font-size: 11px; color: var(--hc-text-muted); margin-top: 2px; }
.hc-toggle {
  width: 36px; height: 20px; border-radius: 10px;
  background: var(--hc-border); position: relative; cursor: pointer;
  transition: background 0.2s; flex-shrink: 0;
}
.hc-toggle--on { background: var(--hc-accent); }
.hc-toggle::after {
  content: ''; width: 16px; height: 16px; border-radius: 50%;
  background: #fff; position: absolute; top: 2px; left: 2px;
  transition: transform 0.2s;
}
.hc-toggle--on::after { transform: translateX(16px); }
</style>
