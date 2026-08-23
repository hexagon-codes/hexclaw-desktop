<script setup lang="ts">
import { computed, ref } from 'vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'

type DialogStateId =
  | 'shared-confirm-dialog'
  | 'skills-uninstall'
  | 'memory-delete-one'
  | 'quick-chat-clear'
  | 'notifications-clear'

interface DialogFixture {
  id: DialogStateId
  label: string
  title: string
  message: string
  confirmText: string
}

const fixtures: DialogFixture[] = [
  {
    id: 'shared-confirm-dialog',
    label: '共享 ConfirmDialog',
    title: '确认操作',
    message: '此操作不可撤销，确定要继续吗？',
    confirmText: '删除',
  },
  {
    id: 'skills-uninstall',
    label: 'Skills 卸载',
    title: '卸载 Skill？',
    message: '将卸载「翻译润色」，此操作不可撤销。',
    confirmText: '卸载',
  },
  {
    id: 'memory-delete-one',
    label: 'Memory 单条删除',
    title: '删除记忆',
    message: '确定要删除这条记忆吗？此操作不可撤销。',
    confirmText: '删除',
  },
  {
    id: 'quick-chat-clear',
    label: 'Quick Chat 清空',
    title: '清空聊天？',
    message: '此操作不可撤销。',
    confirmText: '清空',
  },
  {
    id: 'notifications-clear',
    label: '通知中心清空',
    title: '清空通知？',
    message: '此操作不可撤销。',
    confirmText: '清空',
  },
]

const activeId = ref<DialogStateId | null>(null)
const cancelCount = ref(0)
const confirmCount = ref(0)
const activeFixture = computed(() => fixtures.find((fixture) => fixture.id === activeId.value))

function openDialog(id: DialogStateId) {
  activeId.value = id
}

function cancelDialog() {
  cancelCount.value += 1
  activeId.value = null
}

function confirmDialog() {
  confirmCount.value += 1
  activeId.value = null
}
</script>

<template>
  <main
    class="confirm-dialog-harness"
    :data-active-state="activeId ?? ''"
    :data-cancel-count="cancelCount"
    :data-confirm-count="confirmCount"
  >
    <h1>ConfirmDialog current-source consumer harness</h1>
    <button
      v-for="fixture in fixtures"
      :key="fixture.id"
      type="button"
      class="hc-btn"
      :data-open-state="fixture.id"
      @click="openDialog(fixture.id)"
    >
      {{ fixture.label }}
    </button>

    <ConfirmDialog
      :open="activeFixture !== undefined"
      :confirmation-key="activeFixture?.id"
      :title="activeFixture?.title"
      :message="activeFixture?.message"
      :confirm-text="activeFixture?.confirmText"
      cancel-text="取消"
      danger
      @confirm="confirmDialog"
      @cancel="cancelDialog"
    />
  </main>
</template>

<style scoped>
.confirm-dialog-harness {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  padding: 72px;
  background: var(--hc-bg-gradient);
}

.confirm-dialog-harness h1 {
  margin: 0 0 12px;
  color: var(--hc-text-primary);
  font-size: 18px;
}
</style>
