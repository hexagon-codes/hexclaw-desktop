<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    suppressed: boolean
    restorable?: boolean
    busy?: boolean
    display?: 'menu' | 'visible'
  }>(),
  { display: 'menu' },
)

const emit = defineEmits<{
  suppress: []
  restore: []
}>()

const menuOpen = ref(false)
const confirmOpen = ref(false)
const menuTrigger = ref<HTMLButtonElement | null>(null)
const menuElement = ref<HTMLElement | null>(null)
const menuPosition = ref<Record<string, string>>({})

watch(
  () => props.suppressed,
  () => {
    menuOpen.value = false
    confirmOpen.value = false
  },
)

function askSuppress() {
  menuOpen.value = false
  confirmOpen.value = true
}

async function toggleMenu() {
  menuOpen.value = !menuOpen.value
  if (!menuOpen.value) return
  await nextTick()

  const anchor = menuTrigger.value
  const menu = menuElement.value
  if (!anchor || !menu) return

  const anchorRect = anchor.getBoundingClientRect()
  const margin = 12
  const gap = 8
  const maxHeight = Math.min(300, Math.max(120, window.innerHeight - margin * 2))
  const width = menu.offsetWidth
  const height = menu.offsetHeight
  const left = Math.max(margin, Math.min(anchorRect.left, window.innerWidth - width - margin))
  const roomBelow = window.innerHeight - anchorRect.bottom - margin
  const roomAbove = anchorRect.top - margin
  const preferredTop =
    roomBelow >= height || roomBelow >= roomAbove
      ? anchorRect.bottom + gap
      : anchorRect.top - height - gap
  const top = Math.max(margin, Math.min(preferredTop, window.innerHeight - height - margin))

  menuPosition.value = {
    left: `${left}px`,
    top: `${top}px`,
    maxHeight: `${maxHeight}px`,
    overflowY: 'auto',
  }
}

function confirmSuppress() {
  confirmOpen.value = false
  emit('suppress')
}
</script>

<template>
  <button
    v-if="suppressed && restorable"
    type="button"
    class="rl-btn"
    :disabled="busy"
    data-testid="mistake-restore-review"
    @click="emit('restore')"
  >
    恢复复习
  </button>
  <button
    v-else-if="!suppressed && display === 'visible'"
    type="button"
    class="btn btn-ghost week-suppress-action mistake-suppress-visible"
    :disabled="busy"
    data-testid="mistake-suppress-review"
    @click="askSuppress"
  >
    不再复习
  </button>
  <div v-else-if="!suppressed" class="mistake-more">
    <button
      ref="menuTrigger"
      type="button"
      class="rl-btn mistake-more__trigger"
      aria-label="更多错题操作"
      aria-haspopup="menu"
      :aria-expanded="menuOpen"
      :disabled="busy"
      @click="toggleMenu"
    >
      …
    </button>
    <div
      v-if="menuOpen"
      ref="menuElement"
      class="mistake-more__menu"
      role="menu"
      :style="menuPosition"
    >
      <button type="button" role="menuitem" @click="askSuppress">不再复习</button>
    </div>
  </div>

  <Teleport to="body">
    <div v-if="confirmOpen" class="review-confirm__overlay" @click.self="confirmOpen = false">
      <section
        class="review-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="review-confirm-title"
      >
        <h2 id="review-confirm-title">不再复习这道题？</h2>
        <p>
          这道题将长期从本周该练和自动复习中排除。系统不会把它标记为已掌握，你可以随时在“不再复习”中恢复。
        </p>
        <footer>
          <button type="button" class="hc-btn" @click="confirmOpen = false">取消</button>
          <button
            type="button"
            class="hc-btn hc-btn-primary"
            :disabled="busy"
            data-testid="confirm-suppress-review"
            @click="confirmSuppress"
          >
            不再复习
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.mistake-more {
  position: relative;
}
.mistake-suppress-visible {
  height: 32px;
  padding: 6px 8px;
  border-radius: 10px;
  font-family: inherit;
  font-size: 13px;
  line-height: 18px;
  white-space: nowrap;
}
.mistake-more__trigger {
  width: 28px;
  min-width: 28px;
  padding: 0;
  font-size: 16px;
  letter-spacing: 1px;
}
.mistake-more__menu {
  position: fixed;
  z-index: var(--hc-z-popover, 9200);
  width: 170px;
  padding: 6px;
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  background: var(--hc-bg-elevated);
  color: var(--hc-text-primary);
  box-shadow: var(--hc-shadow-float);
  font-size: 14px;
  line-height: 1.5;
}
.mistake-more__menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: 0;
  border-radius: 7px;
  padding: 8px 10px;
  background: transparent;
  color: var(--hc-text-primary);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.mistake-more__menu button:hover {
  background: var(--hc-bg-hover);
}
.review-confirm__overlay {
  position: fixed;
  z-index: var(--hc-z-modal);
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, #081220 42%, transparent);
  backdrop-filter: blur(4px);
}
.review-confirm {
  width: min(440px, 100%);
  padding: 20px;
  border: 0.5px solid var(--hc-border);
  border-radius: 16px;
  background: var(--hc-bg-elevated);
  box-shadow: var(--hc-shadow-float);
}
.review-confirm h2 {
  margin: 0;
  font-size: 17px;
}
.review-confirm p {
  margin: 10px 0 18px;
  color: var(--hc-text-secondary);
  line-height: 1.65;
}
.review-confirm footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
