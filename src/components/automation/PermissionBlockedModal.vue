<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, ShieldAlert } from 'lucide-vue-next'
import {
  listAutonomyDecisions,
  createAutonomyGrant,
  type AutonomyDecision,
  type AutonomyTaskStatus,
} from '@/api/autonomy'
import { resumeCronJob } from '@/api/tasks'
import { updateWebhookEnabled } from '@/api/webhook'
import { useToast } from '@/composables/useToast'
import { translateOpenIdentifier } from '@/utils/open-i18n-label'

/**
 * 阻断处理弹窗 —— 从任务卡「去开启」进入的定向修复路径。
 *
 * 展示这个任务被拦在哪个能力上（决策日志事实口径 + 预检预估口径），
 * 推荐处理从窄到宽：任务级授权（推荐，授权后顺手启用）优先；
 * 来源级全局开关归设置页矩阵，不在这里放宽。
 */
const props = defineProps<{
  open: boolean
  task: AutonomyTaskStatus | null
}>()

const emit = defineEmits<{
  close: []
  resolved: []
}>()

const { t, te } = useI18n()
const toast = useToast()

const decisions = ref<AutonomyDecision[]>([])
const loadingDecisions = ref(false)
const granting = ref(false)

function categoryLabel(key: string): string {
  return translateOpenIdentifier(t, te, 'autonomy.category', key)
}

/** 需要授权的条目：预检需决定项 ∪ 决策日志里被拦的具体工具。 */
const grantEntries = computed(() => {
  const set = new Set<string>(props.task?.needs_decision ?? [])
  for (const d of decisions.value) {
    if (d.decision === 'pending' && d.tool) set.add(d.tool)
  }
  if (props.task?.last_block?.tool) set.add(props.task.last_block.tool)
  return [...set]
})

watch(
  () => [props.open, props.task?.task_ref] as const,
  async ([open, taskRef]) => {
    if (!open || !taskRef) return
    loadingDecisions.value = true
    try {
      const res = await listAutonomyDecisions({ task_ref: taskRef, limit: 10 })
      decisions.value = res?.decisions ?? []
    } catch {
      decisions.value = []
    } finally {
      loadingDecisions.value = false
    }
  },
  { immediate: true },
)

/** 仅授权本任务（推荐）：写任务级授权，随后顺手启用（cron resume / webhook enable）。 */
async function grantAndEnable() {
  const task = props.task
  if (!task || granting.value) return
  if (grantEntries.value.length === 0) {
    toast.error(t('autonomy.blocked.nothingToGrant', '没有可授权的能力条目'))
    return
  }
  granting.value = true
  try {
    await createAutonomyGrant({
      task_ref: task.task_ref,
      source: task.kind,
      entries: grantEntries.value,
      note: t('autonomy.blocked.grantNote', '从阻断处理授权'),
    })
    // 授权后顺手启用：cron 暂停任务 resume；webhook 未启用端点 enable。
    if (task.kind === 'cron' && task.status === 'paused') {
      await resumeCronJob(task.task_ref.replace(/^cron:/, ''))
    } else if (task.kind === 'webhook' && !task.enabled) {
      await updateWebhookEnabled(task.name, true)
    }
    toast.success(t('autonomy.blocked.granted', '已授权并启用，下次触发生效'))
    emit('resolved')
  } catch (e: unknown) {
    toast.error((e as Error)?.message || t('autonomy.blocked.grantFailed', '授权失败'))
  } finally {
    granting.value = false
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="open && task"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm"
        data-testid="permission-blocked-modal"
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
            <h2 class="text-[15px] font-semibold m-0 flex items-center gap-2" :style="{ color: 'var(--hc-text-primary)' }">
              <ShieldAlert :size="16" class="perm-blocked__icon" />
              {{ t('autonomy.blocked.title', { name: task.name }) }}
            </h2>
            <button
              class="p-1 rounded-md hover:bg-white/5"
              :style="{ color: 'var(--hc-text-muted)' }"
              @click="emit('close')"
            >
              <X :size="17" />
            </button>
          </div>

          <div class="perm-blocked__body">
            <p class="perm-blocked__desc">
              {{ t('autonomy.blocked.desc', '任务在授权前暂停：转审批不是拒绝，授权后下次触发照常执行，不会静默越权。') }}
            </p>

            <div class="perm-blocked__section">
              <div class="perm-blocked__section-title">{{ t('autonomy.blocked.needsTitle', '待授权能力') }}</div>
              <div class="perm-blocked__chips">
                <span
                  v-for="entry in grantEntries"
                  :key="entry"
                  class="perm-blocked__chip"
                  data-testid="blocked-entry"
                >{{ categoryLabel(entry) }}</span>
                <span v-if="grantEntries.length === 0" class="perm-blocked__muted">
                  {{ t('autonomy.blocked.noEntries', '暂无记录 —— 触发一次后这里会给出被拦的具体能力') }}
                </span>
              </div>
            </div>

            <div class="perm-blocked__section">
              <div class="perm-blocked__section-title">{{ t('autonomy.blocked.logTitle', '权限决策日志（本地持久化）') }}</div>
              <div v-if="loadingDecisions" class="perm-blocked__muted">{{ t('autonomy.blocked.loading', '加载中…') }}</div>
              <div v-else-if="decisions.length === 0" class="perm-blocked__muted">
                {{ t('autonomy.blocked.noLog', '该任务还没有权限决策记录') }}
              </div>
              <div v-else class="perm-blocked__log">
                <div v-for="d in decisions" :key="d.id" class="perm-blocked__log-row" data-testid="decision-row">
                  <span class="perm-blocked__log-time">{{ formatTime(d.at) }}</span>
                  <span class="perm-blocked__log-text">{{ d.tool }}<template v-if="d.capability"> · {{ categoryLabel(d.capability) }}</template></span>
                  <span
                    class="perm-blocked__pill"
                    :class="{
                      'perm-blocked__pill--ok': d.decision === 'allow',
                      'perm-blocked__pill--warn': d.decision === 'pending',
                      'perm-blocked__pill--danger': d.decision === 'deny',
                    }"
                  >{{ t(`autonomy.decision.${d.decision}`, d.decision) }}</span>
                </div>
              </div>
            </div>
          </div>

          <div
            class="flex items-center justify-end gap-2 px-5 py-3.5 border-t"
            :style="{ borderColor: 'var(--hc-border)' }"
          >
            <button class="hc-btn hc-btn-ghost" :disabled="granting" @click="emit('close')">
              {{ t('autonomy.blocked.later', '稍后处理') }}
            </button>
            <button
              class="hc-btn hc-btn-primary"
              data-testid="grant-and-enable"
              :disabled="granting || grantEntries.length === 0"
              @click="grantAndEnable"
            >
              {{ t('autonomy.blocked.grantAndEnable', '仅授权本任务并启用（推荐）') }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.perm-blocked__icon { color: var(--hc-warning, #e69500); }
.perm-blocked__body { padding: 16px 20px; display: flex; flex-direction: column; gap: 14px; max-height: 70vh; overflow-y: auto; }
.perm-blocked__desc { margin: 0; font-size: 13px; color: var(--hc-text-secondary); }
.perm-blocked__section { display: flex; flex-direction: column; gap: 6px; }
.perm-blocked__section-title { font-size: 12px; font-weight: 700; color: var(--hc-text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
.perm-blocked__chips { display: flex; gap: 6px; flex-wrap: wrap; }
.perm-blocked__chip {
  display: inline-flex; align-items: center; min-height: 22px; padding: 2px 8px;
  border: 0.5px solid rgba(240, 180, 41, 0.35); border-radius: 7px;
  background: rgba(240, 180, 41, 0.12); color: var(--hc-warning, #e69500); font-size: 11.5px;
}
.perm-blocked__muted { font-size: 12px; color: var(--hc-text-muted); }
.perm-blocked__log { display: flex; flex-direction: column; }
.perm-blocked__log-row {
  display: flex; align-items: center; gap: 8px; min-width: 0;
  padding: 7px 0; border-top: 1px solid var(--hc-divider, rgba(63,143,212,0.1));
}
.perm-blocked__log-row:first-child { border-top: 0; }
.perm-blocked__log-time { flex-shrink: 0; font-size: 11px; color: var(--hc-text-muted); }
.perm-blocked__log-text { flex: 1; min-width: 0; font-size: 12px; color: var(--hc-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.perm-blocked__pill { flex-shrink: 0; font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 7px; }
.perm-blocked__pill--ok { background: rgba(40, 167, 69, 0.12); color: var(--hc-success, #28a745); }
.perm-blocked__pill--warn { background: rgba(240, 180, 41, 0.14); color: var(--hc-warning, #e69500); }
.perm-blocked__pill--danger { background: rgba(255, 59, 48, 0.1); color: var(--hc-error, #ff3b30); }
.modal-enter-active { transition: opacity 0.2s ease-out; }
.modal-leave-active { transition: opacity 0.15s ease-in; }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
