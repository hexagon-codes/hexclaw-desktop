<script setup lang="ts">
/**
 * 设置页「家庭学习档案」备份/恢复（features/k12 · M2-20260710，对齐原型 app.html:2095）。
 *
 * 经 scenarioRegistry.settingsExtension 缝注入 SettingsView（通用层零 K12 词，AP-1）。
 * 每个 K12 实例（孩子）一行——档案/错题本以 agent 为隔离键，备份天然按孩子分档；
 * 点「一键备份 / 恢复」复用错题本同款 K12BackupModal（.hexbak 导出/导入）。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAgentsStore } from '@/stores/agents'
import { K12_SCENARIO_ID } from '../descriptor'
import K12BackupModal from './K12BackupModal.vue'

const { t } = useI18n()
const agents = useAgentsStore()

onMounted(() => {
  if (!agents.registeredAgents.length) void agents.loadAgents()
})

const kids = computed(() =>
  agents.registeredAgents.filter(
    (a) => a.metadata?.scenario === K12_SCENARIO_ID || a.metadata?.template === K12_SCENARIO_ID,
  ),
)

const backupFor = ref<{ name: string; display: string } | null>(null)
</script>

<template>
  <div class="k12sb">
    <div
      v-for="kid in kids"
      :key="kid.name"
      class="k12sb__row"
      data-testid="k12-settings-backup-row"
    >
      <span class="k12sb__label">
        {{ t('k12.settingsBackup.label') }}
        <span class="k12sb__name">{{ kid.display_name || kid.name }}</span>
      </span>
      <span class="k12sb__sp" />
      <button
        class="k12sb__btn"
        @click="backupFor = { name: kid.name, display: kid.display_name || kid.name }"
      >{{ t('k12.settingsBackup.action') }}</button>
    </div>
    <p v-if="!kids.length" class="k12sb__empty">{{ t('k12.settingsBackup.empty') }}</p>

    <K12BackupModal
      v-if="backupFor"
      :agent-id="backupFor.name"
      :agent-name="backupFor.display"
      @close="backupFor = null"
    />
  </div>
</template>

<style scoped>
.k12sb { display: flex; flex-direction: column; }
.k12sb__row {
  display: flex; align-items: center; gap: 16px; min-height: 44px;
  border-top: 1px solid var(--hc-border-subtle, var(--hc-border));
}
.k12sb__row:first-child { border-top: none; }
.k12sb__label { font-size: 13px; font-weight: 500; color: var(--hc-text-primary); }
.k12sb__name { color: var(--hc-text-secondary); font-weight: 400; margin-inline-start: 6px; }
.k12sb__sp { flex: 1; }
.k12sb__btn {
  font-size: 12.5px; padding: 6px 11px; border-radius: 8px; cursor: pointer;
  border: 0.5px solid var(--hc-border); background: var(--hc-bg-input); color: var(--hc-text-primary);
}
.k12sb__btn:hover { background: var(--hc-bg-hover); }
.k12sb__empty { font-size: 12px; color: var(--hc-text-muted); margin: 8px 0 0; }
</style>
