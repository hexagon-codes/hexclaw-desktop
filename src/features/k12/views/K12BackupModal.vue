<script setup lang="ts">
/**
 * 家庭学习档案备份/恢复（features/k12）· M4-1。
 * 导出：家庭学习档案 → 带版本的 .hexbak。恢复：预览源/目标 → 监护人确认
 * → 服务端同 Tutor restore 或跨 Tutor restore-as → snapshot/journal/显式回退。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import {
  k12Backup,
  k12Restore,
  k12RestoreAs,
  k12RollbackRestoreAs,
  type HexbakArchive,
  type K12RestoreAsResp,
} from '@/api/k12'
import { download as saveArchive } from '../export'

const props = defineProps<{ agentId: string; agentName: string; targetChildName?: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const { t } = useI18n()
const toast = useToast()

const pendingArchive = ref<HexbakArchive | null>(null)
const restoredCount = ref<number | null>(null)
const restoreSnapshot = ref<HexbakArchive | null>(null)
const restoreMigration = ref<K12RestoreAsResp | null>(null)
const guardianConfirmed = ref(false)
const importError = ref('')
const exportError = ref('')
const busy = ref(false)
const isRestoreAs = computed(() =>
  Boolean(pendingArchive.value && pendingArchive.value.agent_name !== props.agentId),
)
const sourceChildName = computed(
  () => pendingArchive.value?.profile?.child_name || pendingArchive.value?.agent_name || '',
)
const canRestore = computed(() =>
  Boolean(pendingArchive.value && !busy.value && (!isRestoreAs.value || guardianConfirmed.value)),
)
const dialogRef = ref<HTMLElement | null>(null)
const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
const focusableSelector = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function restoreOpeningFocus() {
  if (!returnFocus?.isConnected) return
  void nextTick(() => returnFocus.focus())
}

function requestClose() {
  emit('close')
  restoreOpeningFocus()
}

function dialogFocusable(): HTMLElement[] {
  return Array.from(dialogRef.value?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])
}

function onDialogKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    requestClose()
    return
  }
  if (event.key !== 'Tab') return
  const focusable = dialogFocusable()
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!first || !last) {
    event.preventDefault()
    dialogRef.value?.focus()
    return
  }
  if (
    event.shiftKey &&
    (document.activeElement === first || !dialogRef.value?.contains(document.activeElement))
  ) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

onMounted(async () => {
  await nextTick()
  const preferred = dialogRef.value?.querySelector<HTMLElement>(
    'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])',
  )
  ;(preferred ?? dialogRef.value)?.focus()
})
onBeforeUnmount(restoreOpeningFocus)

// 导出：真实 GET /api/k12/backup（服务端全量归档 + checksum）→ 下载 .hexbak
async function doExport() {
  busy.value = true
  exportError.value = ''
  try {
    const archive = await k12Backup(props.agentId)
    const file = `${props.agentName}_学习档案.hexbak`
    const saved = await saveArchive(
      file,
      JSON.stringify(archive, null, 2),
      'application/octet-stream',
    )
    if (saved) toast.success(t('k12.backup.exported', { file }))
  } catch (e) {
    exportError.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    await handleFile(file)
  } finally {
    // 允许修正归档后再次选择同一路径；否则浏览器不会再次触发 change。
    input.value = ''
  }
}
async function onDrop(e: DragEvent) {
  const file = e.dataTransfer?.files?.[0]
  if (file) await handleFile(file)
}

// 选文件只做客户端结构预览；checksum 的真实性由确认后的服务端 restore 校验。
async function handleFile(file: File) {
  importError.value = ''
  pendingArchive.value = null
  restoredCount.value = null
  restoreSnapshot.value = null
  restoreMigration.value = null
  guardianConfirmed.value = false
  busy.value = true
  try {
    const archive = parseArchive(JSON.parse(await file.text()))
    pendingArchive.value = archive
  } catch (e) {
    importError.value = e instanceof Error ? e.message : t('k12.backup.errorBadFile')
  } finally {
    busy.value = false
  }
}

function parseArchive(value: unknown): HexbakArchive {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(t('k12.backup.errorBadFile'))
  const archive = value as Partial<HexbakArchive>
  if (
    !Number.isInteger(archive.version) ||
    typeof archive.exported_at !== 'number' ||
    !Number.isFinite(archive.exported_at) ||
    typeof archive.agent_name !== 'string' ||
    !archive.agent_name.trim() ||
    !Array.isArray(archive.records) ||
    (archive.assets !== undefined && !Array.isArray(archive.assets)) ||
    (archive.creative_work_ocr !== undefined && !Array.isArray(archive.creative_work_ocr)) ||
    (archive.problem_attempts !== undefined && !Array.isArray(archive.problem_attempts)) ||
    typeof archive.checksum !== 'string' ||
    !archive.checksum.trim()
  )
    throw new Error(t('k12.backup.errorBadFile'))
  return archive as HexbakArchive
}

async function confirmRestore() {
  const archive = pendingArchive.value
  if (!archive || !canRestore.value) return
  busy.value = true
  importError.value = ''
  try {
    if (archive.agent_name !== props.agentId) {
      const res = await k12RestoreAs({
        archive,
        source_agent: archive.agent_name,
        target_agent: props.agentId,
        guardian_confirmed: guardianConfirmed.value,
        // 与原 archive checksum + target 绑定：用户在超时/重启后重试仍是同一命令。
        idempotency_key: `restore-as:${props.agentId}:${archive.checksum}`,
      })
      restoredCount.value = res.restored
      restoreSnapshot.value = res.snapshot ?? null
      restoreMigration.value = res
    } else {
      // 同 Tutor 保留 v1/v2/v3 旧 restore 兼容通道，不改写 archive。
      const res = await k12Restore(archive)
      restoredCount.value = res.restored
      restoreSnapshot.value = res.snapshot
    }
    pendingArchive.value = null
    toast.success(t('k12.backup.restored', { count: restoredCount.value }))
  } catch (e) {
    importError.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function rollbackMigration() {
  const migration = restoreMigration.value
  if (!migration || migration.status !== 'completed' || busy.value) return
  busy.value = true
  importError.value = ''
  try {
    restoreMigration.value = await k12RollbackRestoreAs(migration.migration_id, {
      target_agent: props.agentId,
      guardian_confirmed: true,
    })
    toast.success(t('k12.backup.rollbackDone'))
  } catch (e) {
    importError.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function saveSnapshot() {
  if (!restoreSnapshot.value) return
  const file = `${props.agentName}_恢复前快照.hexbak`
  importError.value = ''
  try {
    const saved = await saveArchive(
      file,
      JSON.stringify(restoreSnapshot.value, null, 2),
      'application/octet-stream',
    )
    if (saved) toast.success(t('k12.backup.exported', { file }))
  } catch (e) {
    importError.value = e instanceof Error ? e.message : String(e)
  }
}
</script>

<template>
  <div class="k12bk-overlay" @click.self="requestClose">
    <div
      ref="dialogRef"
      class="k12bk"
      role="dialog"
      aria-modal="true"
      aria-labelledby="k12-backup-title"
      tabindex="-1"
      @keydown="onDialogKeydown"
    >
      <div class="k12bk__head">
        <b id="k12-backup-title">{{ t('k12.backup.title') }}</b>
        <button class="k12bk__x" :aria-label="t('k12.backup.close')" @click="requestClose">
          ✕
        </button>
      </div>
      <div class="k12bk__body">
        <p class="k12bk__intro">{{ t('k12.backup.intro') }}</p>

        <div class="k12bk__field">
          <span>{{ t('k12.backup.exportLabel') }}</span>
          <button class="k12bk__btn k12bk__btn--primary" :disabled="busy" @click="doExport">
            {{ t('k12.backup.exportBtn') }}
          </button>
          <p v-if="exportError" class="k12bk__err" data-testid="backup-export-error">
            {{ exportError }}
          </p>
        </div>

        <div class="k12bk__field">
          <span>{{ t('k12.backup.restoreLabel') }}</span>
          <label class="k12bk__drop" @dragover.prevent @drop.prevent="onDrop">
            {{ t('k12.backup.dropHint') }}
            <input
              type="file"
              accept=".hexbak,application/json"
              class="k12bk__file"
              @change="onFile"
            />
          </label>
          <p v-if="pendingArchive" class="k12bk__preview" data-testid="backup-restore-preview">
            {{
              t('k12.backup.previewCount', {
                count: pendingArchive.records.length,
                source: pendingArchive.agent_name,
                target: agentId,
              })
            }}
          </p>
          <section v-if="pendingArchive" class="k12bk__scope" data-testid="backup-restore-scope">
            <div>
              <b>{{ t('k12.backup.sourceTutor') }}</b
              ><span>{{ pendingArchive.agent_name }} · {{ sourceChildName }}</span>
            </div>
            <div>
              <b>{{ t('k12.backup.targetTutor') }}</b
              ><span>{{ agentId }} · {{ targetChildName || agentName }}</span>
            </div>
            <div>
              <b>{{ t('k12.backup.impactScope') }}</b
              ><span>{{
                t('k12.backup.impactDetail', {
                  count: pendingArchive.records.length,
                  assetCount: pendingArchive.assets?.length ?? 0,
                })
              }}</span>
            </div>
            <p v-if="isRestoreAs">{{ t('k12.backup.restoreAsWarning') }}</p>
            <label v-if="isRestoreAs" class="k12bk__guardian">
              <input
                v-model="guardianConfirmed"
                data-testid="backup-restore-guardian"
                type="checkbox"
              />
              <span>{{ t('k12.backup.guardianConfirm') }}</span>
            </label>
          </section>
          <p v-if="restoredCount !== null" class="k12bk__preview">
            {{ t('k12.backup.restored', { count: restoredCount }) }}
          </p>
          <div v-if="restoreSnapshot" class="k12bk__snapshot" data-testid="backup-restore-snapshot">
            <span>{{ t('k12.backup.snapshotReady') }}</span>
            <button class="k12bk__btn" @click="saveSnapshot">
              {{ t('k12.backup.saveSnapshot') }}
            </button>
          </div>
          <section
            v-if="restoreMigration"
            class="k12bk__migration"
            data-testid="backup-restore-migration"
          >
            <b>{{ t('k12.backup.migrationResult') }} · {{ restoreMigration.status }}</b>
            <span>{{ t('k12.backup.migrationId') }}: {{ restoreMigration.migration_id }}</span>
            <span
              >{{ t('k12.backup.originalDigest') }}:
              {{ restoreMigration.original_archive_digest }}</span
            >
            <span
              >{{ t('k12.backup.snapshotDigest') }}: {{ restoreMigration.snapshot_digest }}</span
            >
            <span>{{
              t('k12.backup.journalEntries', { count: restoreMigration.journal_entries })
            }}</span>
            <button
              v-if="restoreMigration.status === 'completed'"
              class="k12bk__btn"
              data-testid="backup-restore-rollback"
              :disabled="busy"
              @click="rollbackMigration"
            >
              {{ t('k12.backup.rollback') }}
            </button>
          </section>
          <p v-if="importError" class="k12bk__err" data-testid="backup-import-error">
            {{ importError }}
          </p>
        </div>
      </div>
      <div class="k12bk__foot">
        <button class="k12bk__btn" @click="requestClose">{{ t('k12.backup.close') }}</button>
        <button
          v-if="pendingArchive"
          class="k12bk__btn k12bk__btn--primary"
          data-testid="backup-restore-confirm"
          :disabled="!canRestore"
          @click="confirmRestore"
        >
          {{ busy ? t('k12.backup.restoring') : t('k12.backup.confirmRestore') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.k12bk-overlay {
  /* modal 层（9100）——统一走令牌，须低于 popover（9200）以免遮罩盖住内部下拉（BUG-20260708）。 */
  position: fixed;
  inset: 0;
  z-index: var(--hc-z-modal);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 11vh;
  background: rgba(8, 18, 32, 0.4);
  backdrop-filter: blur(3px) saturate(120%);
  -webkit-backdrop-filter: blur(3px) saturate(120%);
}
.k12bk {
  width: 478px;
  max-width: 92vw;
  background: var(--hc-bg-elevated);
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  box-shadow: var(--hc-shadow-float);
  overflow: hidden;
}
.k12bk__head {
  display: flex;
  align-items: center;
  padding: 16px 18px;
  border-bottom: 0.5px solid var(--hc-border);
  font-size: 15px;
}
.k12bk__x {
  margin-left: auto;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--hc-text-muted);
  cursor: pointer;
}
.k12bk__x:hover {
  background: var(--hc-bg-hover);
  color: var(--hc-text-primary);
}
.k12bk__body {
  padding: 18px;
  max-height: 62vh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.k12bk__intro {
  margin: 0;
  font-size: 12.5px;
  color: var(--hc-text-secondary);
  background: var(--hc-bg-card);
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  padding: 10px 12px;
}
.k12bk__field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.k12bk__field > span {
  font-size: 13px;
  color: var(--hc-text-primary);
}
.k12bk__drop {
  border: 1px dashed var(--hc-border);
  border-radius: 12px;
  padding: 22px;
  text-align: center;
  color: var(--hc-text-muted);
  cursor: pointer;
  font-size: 12.5px;
  position: relative;
}
.k12bk__file {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.k12bk__preview {
  margin: 0;
  font-size: 12.5px;
  color: var(--hc-text-secondary);
}
.k12bk__scope,
.k12bk__migration {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 11px 12px;
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  background: var(--hc-bg-card);
  font-size: 12px;
  color: var(--hc-text-secondary);
  overflow-wrap: anywhere;
}
.k12bk__scope > div {
  display: grid;
  grid-template-columns: 82px 1fr;
  gap: 8px;
}
.k12bk__scope b,
.k12bk__migration b {
  color: var(--hc-text-primary);
}
.k12bk__scope p {
  margin: 2px 0;
  color: var(--hc-warning, #b76300);
}
.k12bk__guardian {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  color: var(--hc-text-primary);
  cursor: pointer;
}
.k12bk__guardian input {
  margin-top: 2px;
}
.k12bk__migration .k12bk__btn {
  align-self: flex-start;
  margin-top: 3px;
}
.k12bk__snapshot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  color: var(--hc-text-secondary);
}
.k12bk__pending {
  color: var(--hc-text-muted);
  font-size: 11.5px;
}
.k12bk__err {
  margin: 0;
  font-size: 12.5px;
  color: var(--hc-error);
}
.k12bk__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 18px;
  border-top: 0.5px solid var(--hc-border);
}
.k12bk__btn {
  padding: 8px 14px;
  border-radius: 10px;
  font-size: 13px;
  cursor: pointer;
  border: 0.5px solid var(--hc-border);
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
}
.k12bk__btn--primary {
  background: linear-gradient(180deg, #5fb3ea 0%, #4a9de0 100%);
  color: #fff;
  border-color: transparent;
  align-self: flex-start;
}
.k12bk__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
