<script setup lang="ts">
/**
 * 家庭学习档案备份/恢复（features/k12）· M4-1。
 * 导出：错题本记录 → .hexbak（版本头 + checksum）。恢复：本地结构预览 → 明确确认 → 服务端校验并幂等合并。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { k12Backup, k12Restore, type HexbakArchive } from '@/api/k12'

const props = defineProps<{ agentId: string; agentName: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const { t } = useI18n()
const toast = useToast()

const pendingArchive = ref<HexbakArchive | null>(null)
const restoredCount = ref<number | null>(null)
const restoreSnapshot = ref<HexbakArchive | null>(null)
const importError = ref('')
const busy = ref(false)
const targetMatches = computed(() => pendingArchive.value?.agent_name === props.agentId)

function download(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

// 导出：真实 GET /api/k12/backup（服务端全量归档 + checksum）→ 下载 .hexbak
async function doExport() {
  busy.value = true
  try {
    const archive = await k12Backup(props.agentId)
    const file = `${props.agentName}_学习档案.hexbak`
    download(file, JSON.stringify(archive, null, 2))
    toast.success(t('k12.backup.exported', { file }))
  } catch (e) {
    importError.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) await handleFile(file)
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
  busy.value = true
  try {
    const archive = parseArchive(JSON.parse(await file.text()))
    pendingArchive.value = archive
    // 当前服务端没有 target_agent。只改 header 会让 records 的 agent scope 与 checksum 不一致，
    // 因此跨 agent 归档明确阻断，不伪装成可安全迁移。
    if (archive.agent_name !== props.agentId) {
      importError.value = t('k12.backup.targetMismatch', { source: archive.agent_name, target: props.agentId })
    }
  } catch (e) {
    importError.value = e instanceof Error ? e.message : t('k12.backup.errorBadFile')
  } finally {
    busy.value = false
  }
}

function parseArchive(value: unknown): HexbakArchive {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('k12.backup.errorBadFile'))
  const archive = value as Partial<HexbakArchive>
  if (
    !Number.isInteger(archive.version)
    || typeof archive.exported_at !== 'number'
    || !Number.isFinite(archive.exported_at)
    || typeof archive.agent_name !== 'string'
    || !archive.agent_name.trim()
    || !Array.isArray(archive.records)
    || typeof archive.checksum !== 'string'
    || !archive.checksum.trim()
  ) throw new Error(t('k12.backup.errorBadFile'))
  return archive as HexbakArchive
}

async function confirmRestore() {
  const archive = pendingArchive.value
  if (!archive || !targetMatches.value || busy.value) return
  busy.value = true
  importError.value = ''
  try {
    // agent_name 已等于当前 agent，原样交给服务端以保留 records/checksum 一致性。
    const res = await k12Restore(archive)
    restoredCount.value = res.restored
    restoreSnapshot.value = res.snapshot
    pendingArchive.value = null
    toast.success(t('k12.backup.restored', { count: res.restored }))
  } catch (e) {
    importError.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

function saveSnapshot() {
  if (!restoreSnapshot.value) return
  download(`${props.agentName}_恢复前快照.hexbak`, JSON.stringify(restoreSnapshot.value, null, 2))
}
</script>

<template>
  <div class="k12bk-overlay" @click.self="emit('close')">
    <div class="k12bk" role="dialog" aria-modal="true">
      <div class="k12bk__head">
        <b>{{ t('k12.backup.title') }}</b>
        <button class="k12bk__x" :aria-label="t('k12.backup.close')" @click="emit('close')">✕</button>
      </div>
      <div class="k12bk__body">
        <p class="k12bk__intro">{{ t('k12.backup.intro') }}</p>

        <div class="k12bk__field">
          <span>{{ t('k12.backup.exportLabel') }}</span>
          <button class="k12bk__btn k12bk__btn--primary" :disabled="busy" @click="doExport">{{ t('k12.backup.exportBtn') }}</button>
        </div>

        <div class="k12bk__field">
          <span>{{ t('k12.backup.restoreLabel') }}</span>
          <label class="k12bk__drop" @dragover.prevent @drop.prevent="onDrop">
            {{ t('k12.backup.dropHint') }}
            <input type="file" accept=".hexbak,application/json" class="k12bk__file" @change="onFile" />
          </label>
          <p v-if="pendingArchive" class="k12bk__preview" data-testid="backup-restore-preview">
            {{ t('k12.backup.previewCount', { count: pendingArchive.records.length, source: pendingArchive.agent_name, target: agentId }) }}
          </p>
          <p v-if="restoredCount !== null" class="k12bk__preview">{{ t('k12.backup.restored', { count: restoredCount }) }}</p>
          <div v-if="restoreSnapshot" class="k12bk__snapshot" data-testid="backup-restore-snapshot">
            <span>{{ t('k12.backup.snapshotReady') }}</span>
            <button class="k12bk__btn" @click="saveSnapshot">{{ t('k12.backup.saveSnapshot') }}</button>
          </div>
          <p v-if="importError" class="k12bk__err">{{ importError }}</p>
        </div>
      </div>
      <div class="k12bk__foot">
        <button class="k12bk__btn" @click="emit('close')">{{ t('k12.backup.close') }}</button>
        <button
          v-if="pendingArchive"
          class="k12bk__btn k12bk__btn--primary"
          data-testid="backup-restore-confirm"
          :disabled="busy || !targetMatches"
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
  position: fixed; inset: 0; z-index: var(--hc-z-modal);
  display: flex; align-items: flex-start; justify-content: center; padding-top: 11vh;
  background: rgba(8, 18, 32, 0.4);
  backdrop-filter: blur(3px) saturate(120%); -webkit-backdrop-filter: blur(3px) saturate(120%);
}
.k12bk {
  width: 478px; max-width: 92vw; background: var(--hc-bg-elevated);
  border: 0.5px solid var(--hc-border); border-radius: 16px; box-shadow: var(--hc-shadow-float); overflow: hidden;
}
.k12bk__head { display: flex; align-items: center; padding: 16px 18px; border-bottom: 0.5px solid var(--hc-border); font-size: 15px; }
.k12bk__x { margin-left: auto; width: 28px; height: 28px; border-radius: 8px; border: none; background: transparent; color: var(--hc-text-muted); cursor: pointer; }
.k12bk__x:hover { background: var(--hc-bg-hover); color: var(--hc-text-primary); }
.k12bk__body { padding: 18px; display: flex; flex-direction: column; gap: 16px; }
.k12bk__intro {
  margin: 0; font-size: 12.5px; color: var(--hc-text-secondary);
  background: var(--hc-bg-card); border: 0.5px solid var(--hc-border); border-radius: 10px; padding: 10px 12px;
}
.k12bk__field { display: flex; flex-direction: column; gap: 8px; }
.k12bk__field > span { font-size: 13px; color: var(--hc-text-primary); }
.k12bk__drop {
  border: 1px dashed var(--hc-border); border-radius: 12px; padding: 22px; text-align: center;
  color: var(--hc-text-muted); cursor: pointer; font-size: 12.5px; position: relative;
}
.k12bk__file { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.k12bk__preview { margin: 0; font-size: 12.5px; color: var(--hc-text-secondary); }
.k12bk__snapshot { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 12px; color: var(--hc-text-secondary); }
.k12bk__pending { color: var(--hc-text-muted); font-size: 11.5px; }
.k12bk__err { margin: 0; font-size: 12.5px; color: var(--hc-error); }
.k12bk__foot { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 18px; border-top: 0.5px solid var(--hc-border); }
.k12bk__btn {
  padding: 8px 14px; border-radius: 10px; font-size: 13px; cursor: pointer;
  border: 0.5px solid var(--hc-border); background: var(--hc-bg-input); color: var(--hc-text-primary);
}
.k12bk__btn--primary { background: linear-gradient(180deg, #5fb3ea 0%, #4a9de0 100%); color: #fff; border-color: transparent; align-self: flex-start; }
.k12bk__btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
