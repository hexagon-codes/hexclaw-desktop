<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, ShieldCheck, ShieldAlert } from 'lucide-vue-next'
import type { PreflightResult } from '@/api/autonomy'

/**
 * 创建流审批弹窗 —— 条件式向导的例外路径。
 *
 * 只有静默预检命中「需审批」能力时才出现（全绿一步创建不经过这里）。
 * 三选一从窄到宽：任务级授权（推荐）/ 先创建触发时再处理 / 保存为暂停。
 * 「写全局矩阵」不在创建流提供 —— 全局默认属于设置页治理。
 */
const props = withDefaults(
  defineProps<{
    open: boolean
    taskName: string
    source: 'cron' | 'webhook' | 'workflow'
    preflight: PreflightResult | null
    busy?: boolean
    /** 可用的处理方式：cron 创建流三选一；workflow 已保存场景只有 grant/later。 */
    modes?: Array<'grant' | 'later' | 'paused'>
  }>(),
  { modes: () => ['grant', 'later', 'paused'] },
)

const emit = defineEmits<{
  close: []
  choose: [mode: 'grant' | 'later' | 'paused']
}>()

const { t } = useI18n()

/** 类别 → 本地化标签（未知类别/具体工具名原样显示）。 */
function categoryLabel(key: string): string {
  return t(`autonomy.category.${key}`, key)
}

/** 已自动放行的预估能力（绿色被动告知，不需要决定）。 */
const autoCategories = computed(() => {
  const pf = props.preflight
  if (!pf) return []
  const states = new Map(pf.capabilities.map((c) => [c.category, c.state]))
  return pf.estimated.filter((c) => states.get(c) === 'auto' || states.get(c) === 'granted')
})

/** 需要用户决定的能力/工具（琥珀警示）。 */
const needs = computed(() => props.preflight?.needs_decision ?? [])
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm"
        data-testid="permission-approval-modal"
        @click.self="emit('close')"
      >
        <div
          class="w-full max-w-lg rounded-2xl border flex flex-col overflow-hidden"
          :style="{ background: 'var(--hc-bg-elevated)', borderColor: 'var(--hc-border)' }"
        >
          <div
            class="flex items-center justify-between px-5 py-4 border-b"
            :style="{ borderColor: 'var(--hc-border)' }"
          >
            <h2 class="text-[15px] font-semibold m-0" :style="{ color: 'var(--hc-text-primary)' }">
              {{ t('autonomy.approval.title', '需要你决定：本任务命中需审批能力') }}
            </h2>
            <button
              class="p-1 rounded-md hover:bg-white/5"
              :style="{ color: 'var(--hc-text-muted)' }"
              @click="emit('close')"
            >
              <X :size="17" />
            </button>
          </div>

          <div class="perm-approval__body">
            <p class="perm-approval__task">
              {{ t('autonomy.approval.taskLine', { name: taskName }) }}
            </p>

            <div v-if="autoCategories.length" class="perm-approval__row">
              <div class="perm-approval__row-head">
                <ShieldCheck :size="14" class="perm-approval__icon-ok" />
                <span>{{ t('autonomy.approval.autoTitle', '已按当前 Profile 自动放行（无需审批）') }}</span>
              </div>
              <div class="perm-approval__chips">
                <span v-for="c in autoCategories" :key="c" class="perm-approval__chip">{{ categoryLabel(c) }}</span>
              </div>
            </div>

            <div class="perm-approval__row">
              <div class="perm-approval__row-head">
                <ShieldAlert :size="14" class="perm-approval__icon-warn" />
                <span>{{ t('autonomy.approval.needsTitle', '需要你决定') }}</span>
              </div>
              <div class="perm-approval__chips">
                <span
                  v-for="c in needs"
                  :key="c"
                  class="perm-approval__chip perm-approval__chip--warn"
                  data-testid="needs-chip"
                >{{ categoryLabel(c) }}</span>
              </div>
            </div>

            <p class="perm-approval__note">
              {{ t('autonomy.approval.estimateNote', '能力清单为预估：漏判由运行时拦下兜底，多判不会产生任何授权。') }}
            </p>

            <div class="perm-approval__options">
              <button
                class="perm-approval__option perm-approval__option--primary"
                data-testid="choose-grant"
                :disabled="busy"
                @click="emit('choose', 'grant')"
              >
                <b>{{ t('autonomy.approval.grantTitle', '仅授权本任务（推荐）') }}</b>
                <span>{{ t('autonomy.approval.grantDesc', '生成任务级授权：只对这个任务放行上述能力，不改全局默认；删除任务即回收。') }}</span>
              </button>
              <button
                v-if="props.modes.includes('later')"
                class="perm-approval__option"
                data-testid="choose-later"
                :disabled="busy"
                @click="emit('choose', 'later')"
              >
                <b>{{ t('autonomy.approval.laterTitle', '暂不授权') }}</b>
                <span>{{ t('autonomy.approval.laterDesc', '触发时命中未授权能力会被拦下并进入「待处理」，不会静默越权，也不会静默失败。') }}</span>
              </button>
              <button
                v-if="props.modes.includes('paused')"
                class="perm-approval__option"
                data-testid="choose-paused"
                :disabled="busy"
                @click="emit('choose', 'paused')"
              >
                <b>{{ t('autonomy.approval.pausedTitle', '保存为暂停任务') }}</b>
                <span>{{ t('autonomy.approval.pausedDesc', '冻结任务意图不入调度，稍后在任务卡上完成授权并启用。') }}</span>
              </button>
            </div>
          </div>

          <div
            class="flex items-center justify-end gap-2 px-5 py-3.5 border-t"
            :style="{ borderColor: 'var(--hc-border)' }"
          >
            <button class="hc-btn hc-btn-ghost" :disabled="busy" @click="emit('close')">
              {{ t('autonomy.approval.back', '返回编辑') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.perm-approval__body { padding: 16px 20px; display: flex; flex-direction: column; gap: 12px; max-height: 70vh; overflow-y: auto; }
.perm-approval__task { margin: 0; font-size: 13px; color: var(--hc-text-secondary); }
.perm-approval__row { display: flex; flex-direction: column; gap: 6px; }
.perm-approval__row-head { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 600; color: var(--hc-text-primary); }
.perm-approval__icon-ok { color: var(--hc-success, #28a745); }
.perm-approval__icon-warn { color: var(--hc-warning, #e69500); }
.perm-approval__chips { display: flex; gap: 6px; flex-wrap: wrap; }
.perm-approval__chip {
  display: inline-flex; align-items: center; min-height: 22px; padding: 2px 8px;
  border: 0.5px solid var(--hc-border); border-radius: 7px;
  background: var(--hc-bg-input); color: var(--hc-text-secondary); font-size: 11.5px;
}
.perm-approval__chip--warn {
  border-color: rgba(240, 180, 41, 0.35); background: rgba(240, 180, 41, 0.12); color: var(--hc-warning, #e69500);
}
.perm-approval__note { margin: 0; font-size: 12px; color: var(--hc-text-muted); }
.perm-approval__options { display: flex; flex-direction: column; gap: 8px; }
.perm-approval__option {
  display: flex; flex-direction: column; gap: 2px; text-align: start; cursor: pointer;
  padding: 11px 12px; border: 0.5px solid var(--hc-border); border-radius: 10px;
  background: var(--hc-bg-card); transition: border-color 0.15s ease, background 0.15s ease;
}
.perm-approval__option:hover { background: var(--hc-bg-hover); }
.perm-approval__option:disabled { opacity: 0.6; cursor: default; }
.perm-approval__option--primary { border-color: var(--hc-border-hl, rgba(95,179,234,0.32)); background: var(--hc-accent-subtle, rgba(95,179,234,0.14)); }
.perm-approval__option b { font-size: 13px; color: var(--hc-text-primary); }
.perm-approval__option span { font-size: 12px; color: var(--hc-text-secondary); }
.modal-enter-active { transition: opacity 0.2s ease-out; }
.modal-leave-active { transition: opacity 0.15s ease-in; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
