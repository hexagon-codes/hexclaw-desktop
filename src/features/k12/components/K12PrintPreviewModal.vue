<script setup lang="ts">
defineProps<{
  open: boolean
  title: string
  pdfUrl: string
  printing?: boolean
}>()

const emit = defineEmits<{
  close: []
  print: []
}>()
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="k12-print-preview__overlay" @click.self="emit('close')">
      <section
        class="k12-print-preview"
        role="dialog"
        aria-modal="true"
        :aria-label="`${title}打印预览`"
        data-testid="k12-print-preview"
      >
        <header class="k12-print-preview__head">
          <div>
            <b>{{ title }}</b>
            <span>打印预览</span>
          </div>
          <button
            type="button"
            class="k12-print-preview__close"
            :disabled="printing"
            aria-label="关闭打印预览"
            data-testid="k12-print-preview-close"
            @click="emit('close')"
          >
            ×
          </button>
        </header>
        <div class="k12-print-preview__body">
          <iframe
            class="k12-print-preview__pdf"
            :src="pdfUrl"
            :title="`${title} PDF 预览`"
            data-testid="k12-print-preview-pdf"
          />
        </div>
        <footer class="k12-print-preview__foot">
          <button type="button" class="hc-btn" :disabled="printing" @click="emit('close')">取消</button>
          <button
            type="button"
            class="hc-btn hc-btn-primary"
            :disabled="printing"
            data-testid="k12-print-preview-print"
            @click="emit('print')"
          >
            {{ printing ? '正在打开系统打印…' : '打印' }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.k12-print-preview__overlay {
  position: fixed;
  z-index: var(--hc-z-modal);
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, #081220 42%, transparent);
  backdrop-filter: blur(4px);
}
.k12-print-preview { width: min(920px, 100%); height: min(820px, 92vh); display: grid; grid-template-rows: auto minmax(0, 1fr) auto; overflow: hidden; border: .5px solid var(--hc-border); border-radius: 16px; background: var(--hc-bg-elevated); box-shadow: var(--hc-shadow-float); }
.k12-print-preview__head, .k12-print-preview__foot { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-color: var(--hc-border); }
.k12-print-preview__head { border-bottom: .5px solid var(--hc-border); }
.k12-print-preview__head div { display: grid; gap: 2px; }
.k12-print-preview__head b { color: var(--hc-text-primary); font-size: 15px; }
.k12-print-preview__head span { color: var(--hc-text-muted); font-size: 12px; }
.k12-print-preview__close { width: 28px; height: 28px; border: 0; border-radius: 8px; background: transparent; color: var(--hc-text-muted); font: inherit; font-size: 20px; cursor: pointer; }
.k12-print-preview__close:hover { background: var(--hc-bg-hover); color: var(--hc-text-primary); }
.k12-print-preview__body { min-height: 0; padding: 18px; background: var(--hc-bg-main); }
.k12-print-preview__pdf { width: 100%; height: 100%; border: 0; border-radius: 8px; background: #fff; }
.k12-print-preview__foot { justify-content: flex-end; gap: 10px; border-top: .5px solid var(--hc-border); }
</style>
