<script setup lang="ts">
/**
 * 家庭学习档案备份/恢复（features/k12）· M4-1。
 * 导出：错题本记录 → .hexbak（版本头 + checksum）。恢复：解析 + 完整性校验 + 幂等合并预览。
 * 后端全量 .hexbak 端点未就绪 → 恢复先校验预览，合并落地待引擎支持（诚实标注）。
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@/composables/useToast'
import { k12Backup, k12Restore, type HexbakArchive } from '@/api/k12'

const props = defineProps<{ agentId: string; agentName: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const { t } = useI18n()
const toast = useToast()

const preview = ref<{ count: number } | null>(null)
const importError = ref('')
const busy = ref(false)

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

// 恢复：解析 .hexbak → POST /api/k12/restore（checksum 不符后端 400）
async function handleFile(file: File) {
  importError.value = ''
  preview.value = null
  busy.value = true
  try {
    const archive = JSON.parse(await file.text()) as HexbakArchive
    const res = await k12Restore(archive)
    preview.value = { count: res.restored }
    toast.success(t('k12.backup.previewCount', { count: res.restored }))
  } catch (e) {
    importError.value = e instanceof Error ? e.message : t('k12.backup.errorBadFile')
  } finally {
    busy.value = false
  }
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
          <button class="k12bk__btn k12bk__btn--primary" @click="doExport">{{ t('k12.backup.exportBtn') }}</button>
        </div>

        <div class="k12bk__field">
          <span>{{ t('k12.backup.restoreLabel') }}</span>
          <label class="k12bk__drop" @dragover.prevent @drop.prevent="onDrop">
            {{ t('k12.backup.dropHint') }}
            <input type="file" accept=".hexbak,application/json" class="k12bk__file" @change="onFile" />
          </label>
          <p v-if="preview" class="k12bk__preview">
            {{ t('k12.backup.restored', { count: preview.count }) }}
          </p>
          <p v-if="importError" class="k12bk__err">{{ importError }}</p>
        </div>
      </div>
      <div class="k12bk__foot">
        <button class="k12bk__btn" @click="emit('close')">{{ t('k12.backup.close') }}</button>
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
.k12bk__pending { color: var(--hc-text-muted); font-size: 11.5px; }
.k12bk__err { margin: 0; font-size: 12.5px; color: var(--hc-error); }
.k12bk__foot { display: flex; justify-content: flex-end; padding: 14px 18px; border-top: 0.5px solid var(--hc-border); }
.k12bk__btn {
  padding: 8px 14px; border-radius: 10px; font-size: 13px; cursor: pointer;
  border: 0.5px solid var(--hc-border); background: var(--hc-bg-input); color: var(--hc-text-primary);
}
.k12bk__btn--primary { background: linear-gradient(180deg, #5fb3ea 0%, #4a9de0 100%); color: #fff; border-color: transparent; align-self: flex-start; }
</style>
