<script setup lang="ts">
import { nextTick, onBeforeUnmount, watch, type ComponentPublicInstance } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, X } from 'lucide-vue-next'
import HcClearableField from '@/components/common/HcClearableField.vue'

// 画像和普通记忆共享输入交互，保存与错误状态仍由调用页面持有。
const props = defineProps<{ saving: boolean }>()
const model = defineModel<string>({ required: true })
const emit = defineEmits<{ save: []; cancel: [] }>()
const { t } = useI18n()
let editField: HTMLTextAreaElement | null = null
let editResizeObserver: ResizeObserver | null = null

// 多行编辑随内容和可用宽度增长，高度上限内始终保留保存与取消入口。
function resizeEditField() {
  if (!editField) return
  editField.style.height = 'auto'
  editField.style.height = `${Math.min(320, editField.scrollHeight + 2)}px`
}

function setEditField(element: Element | ComponentPublicInstance | null) {
  const field = element instanceof HTMLTextAreaElement ? element : null
  if (field === editField) return
  editResizeObserver?.disconnect()
  editField = field
  if (!field) return
  let previousWidth = -1
  editResizeObserver = new ResizeObserver(([entry]) => {
    if (entry && entry.contentRect.width !== previousWidth) {
      previousWidth = entry.contentRect.width
      resizeEditField()
    }
  })
  editResizeObserver.observe(field)
  void nextTick(() => { resizeEditField(); field.focus() })
}

watch(model, resizeEditField, { flush: 'post' })
onBeforeUnmount(() => editResizeObserver?.disconnect())

function onEditKeydown(event: KeyboardEvent) {
  if (props.saving || event.isComposing || event.keyCode === 229) return
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    emit('save')
  } else if (event.key === 'Escape') {
    event.preventDefault()
    emit('cancel')
  }
}
</script>
<template>
  <div class="hc-memory-entry-editor">
                <HcClearableField class="flex-1">
                  <textarea
                    :ref="setEditField"
                    v-model="model"
                    data-testid="memory-edit-input"
                    rows="3"
                    class="hc-memory-editor rounded-lg border px-2 py-1 text-sm leading-relaxed outline-none"
                    :aria-label="t('common.edit')"
                    :disabled="saving"
                    :style="{
                      background: 'var(--hc-bg-input)',
                      color: 'var(--hc-text-primary)',
                    }"
                    @keydown="onEditKeydown"
                  />
                </HcClearableField>
                <button
                  class="p-1 rounded shrink-0 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                  :style="{ color: 'var(--hc-success, #10b981)' }"
                  :disabled="saving || !model.trim()"
                  :aria-label="t('common.save')"
                  @click="emit('save')"
                >
                  <Check :size="14" />
                </button>
                <button
                  class="p-1 rounded shrink-0 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                  :style="{ color: 'var(--hc-text-muted)' }"
                  :disabled="saving"
                  :aria-label="t('common.cancel')"
                  @click="emit('cancel')"
                >
                  <X :size="14" />
                </button>
  </div>
</template>
<style scoped>
.hc-memory-entry-editor { display:flex; align-items:flex-start; gap:12px; flex:1; min-width:0; }
.hc-memory-editor {
  border-color: var(--hc-border);
  min-height: 78.25px;
  max-height: 320px;
  resize: none;
  overflow-y: auto;
  overflow-wrap: anywhere;
}

.hc-memory-editor:focus-visible {
  border-color: var(--hc-accent);
  outline: none;
  box-shadow: none;
}

</style>
