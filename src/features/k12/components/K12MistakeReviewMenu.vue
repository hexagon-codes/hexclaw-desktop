<script setup lang="ts">
import { ref, watch } from 'vue'

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
    class="rl-btn mistake-suppress-visible"
    :disabled="busy"
    data-testid="mistake-suppress-review"
    @click="askSuppress"
  >
    不再复习
  </button>
  <div v-else-if="!suppressed" class="mistake-more">
    <button
      type="button"
      class="rl-btn mistake-more__trigger"
      aria-label="更多错题操作"
      aria-haspopup="menu"
      :aria-expanded="menuOpen"
      :disabled="busy"
      @click="menuOpen = !menuOpen"
    >
      …
    </button>
    <div v-if="menuOpen" class="mistake-more__menu" role="menu">
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
  white-space: nowrap;
}
.mistake-more__trigger {
  min-width: 30px;
  font-size: 18px;
}
.mistake-more__menu {
  position: absolute;
  z-index: var(--hc-z-popover, 9200);
  top: calc(100% + 4px);
  right: 0;
  min-width: 132px;
  padding: 4px;
  border: 0.5px solid var(--hc-border);
  border-radius: 10px;
  background: var(--hc-bg-elevated);
  box-shadow: var(--hc-shadow-float);
}
.mistake-more__menu button {
  width: 100%;
  border: 0;
  border-radius: 7px;
  padding: 8px 10px;
  background: transparent;
  color: var(--hc-text-primary);
  text-align: left;
  cursor: pointer;
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
