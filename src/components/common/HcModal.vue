<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  width?: number
  busy?: boolean
  initialFocus?: string
}>(), { width: 600, busy: false, initialFocus: '' })
const emit = defineEmits<{ close: [] }>()
const dialogRef = ref<HTMLElement | null>(null)
let returnFocus: HTMLElement | null = null

function restoreFocus() {
  const target = returnFocus
  returnFocus = null
  if (target?.isConnected) nextTick(() => target.focus())
}
watch(() => props.open, (open, wasOpen) => {
  if (!open) { if (wasOpen) restoreFocus(); return }
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  nextTick(() => {
    if (!props.open || !dialogRef.value) return
    const target = props.initialFocus ? dialogRef.value.querySelector<HTMLElement>(props.initialFocus) : null
    ;(target ?? dialogRef.value).focus()
  })
}, { immediate: true, flush: 'sync' })

function close() { if (!props.busy) emit('close') }
function handleKeydown(event: KeyboardEvent) {
  // 下拉菜单先消费 Escape，表单模态层仅处理未被内层处理的事件。
  if (event.defaultPrevented) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
  if (event.key !== 'Tab' || !dialogRef.value) return
  const dialog = dialogRef.value
  const nodes = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')]
    .filter(node => node.getClientRects().length > 0 && !node.closest('[inert]'))
  const first = nodes[0], last = nodes[nodes.length - 1]
  if (!first || !last) { event.preventDefault(); dialog.focus(); return }
  const active = document.activeElement
  if (event.shiftKey && (active === first || !dialog.contains(active))) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && (active === last || !dialog.contains(active))) { event.preventDefault(); first.focus() }
}
onBeforeUnmount(restoreFocus)
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="hc-modal-overlay" @click.self="close" @keydown="handleKeydown">
      <section ref="dialogRef" class="hc-modal" :style="{ width: `${width}px` }" role="dialog" aria-modal="true" :aria-label="title" :aria-busy="busy" tabindex="-1">
        <header class="hc-modal__head"><h2>{{ title }}</h2><button type="button" class="hc-modal__close" :disabled="busy" aria-label="Close" @click="close"><X :size="18" /></button></header>
        <div class="hc-modal__body"><slot /></div>
        <footer v-if="$slots.footer" class="hc-modal__footer"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.hc-modal-overlay{position:fixed;inset:0;z-index:var(--hc-z-modal);display:flex;align-items:flex-start;justify-content:center;box-sizing:border-box;padding-top:11vh;background:rgba(8,18,32,.4);backdrop-filter:blur(3px) saturate(120%)}
.hc-modal{display:flex;flex-direction:column;max-width:calc(100vw - 32px);max-height:calc(100dvh - 80px);border:1px solid var(--hc-border);border-radius:16px;background:var(--hc-bg-elevated);box-shadow:var(--hc-shadow-float);outline:none}
.hc-modal__head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid var(--hc-border);flex:none}
.hc-modal__head h2{margin:0;font-size:15px;font-weight:600;line-height:22.5px;color:var(--hc-text-primary)}
.hc-modal__close{display:grid;place-items:center;width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:var(--hc-text-muted);cursor:pointer}
.hc-modal__close:hover{background:var(--hc-bg-hover);color:var(--hc-text-primary)}
.hc-modal__close:focus-visible{outline:2px solid var(--hc-accent);outline-offset:2px}
.hc-modal__body{min-height:0;overflow-y:auto;padding:20px 22px}
.hc-modal__footer{display:flex;justify-content:flex-end;gap:8px;padding:14px 18px;border-top:1px solid var(--hc-border);flex:none}
.hc-modal__footer :deep(.hc-btn){min-height:36px;padding:8px 14px;border-width:1px;border-radius:10px;font-size:13px;line-height:18px}
.hc-modal__footer :deep(.hc-btn-primary){background:#2879b9;color:#fff;box-shadow:0 6px 18px rgba(95,179,234,.28)}
</style>
