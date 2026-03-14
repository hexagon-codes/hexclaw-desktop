<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import type { AgentRole } from '@/types'

const props = defineProps<{
  visible: boolean
  role?: AgentRole | null
}>()

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="visible" class="hc-modal-overlay" @click.self="emit('close')">
        <div class="hc-modal">
          <div class="hc-modal__header">
            <h2 class="hc-modal__title">角色详情</h2>
            <button class="hc-modal__close" @click="emit('close')">
              <X :size="17" />
            </button>
          </div>
          <div class="hc-modal__body" v-if="role">
            <div class="hc-field">
              <label class="hc-field__label">名称</label>
              <div class="hc-readonly">{{ role.name }}</div>
            </div>
            <div class="hc-field">
              <label class="hc-field__label">标题</label>
              <div class="hc-readonly">{{ role.title }}</div>
            </div>
            <div class="hc-field">
              <label class="hc-field__label">目标</label>
              <div class="hc-readonly">{{ role.goal }}</div>
            </div>
          </div>
          <div class="hc-modal__footer">
            <button class="hc-btn hc-btn-secondary" @click="emit('close')">{{ t('common.close') || '关闭' }}</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.hc-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
}

.hc-modal {
  width: 100%;
  max-width: 440px;
  border-radius: var(--hc-radius-xl);
  background: var(--hc-bg-elevated);
  border: 1px solid var(--hc-border);
  box-shadow: var(--hc-shadow-float);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.hc-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--hc-divider);
}

.hc-modal__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--hc-text-primary);
  margin: 0;
}

.hc-modal__close {
  padding: 4px;
  border-radius: var(--hc-radius-sm);
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
  display: flex;
}

.hc-modal__body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.hc-modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px;
  border-top: 1px solid var(--hc-divider);
}

.hc-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hc-field__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--hc-text-secondary);
}

.hc-readonly {
  font-size: 13px;
  color: var(--hc-text-primary);
  padding: 8px 12px;
  background: var(--hc-bg-main);
  border-radius: var(--hc-radius-md);
  border: 1px solid var(--hc-border);
}

.modal-enter-active { transition: opacity 0.2s ease-out; }
.modal-leave-active { transition: opacity 0.15s ease-in; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
