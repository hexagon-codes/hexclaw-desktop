<script setup lang="ts">
import { ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'

const props = defineProps<{
  modelValue: boolean
  bodyId: string
  triggerTestId?: string
  panelTestId?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const triggerRef = ref<HTMLButtonElement | null>(null)

function toggle() {
  emit('update:modelValue', !props.modelValue)
}

function focus() {
  triggerRef.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <section class="hc-settings-disclosure" :class="{ 'hc-settings-disclosure--open': modelValue }">
    <div class="hc-settings-disclosure__head" @click="toggle">
      <button
        ref="triggerRef"
        type="button"
        class="hc-settings-disclosure__trigger"
        :data-testid="triggerTestId"
        :aria-expanded="modelValue"
        :aria-controls="bodyId"
        @click.stop="toggle"
      >
        <span v-if="$slots.icon" class="hc-settings-disclosure__icon" aria-hidden="true">
          <slot name="icon" />
        </span>
        <span class="hc-settings-disclosure__title">
          <slot name="title" />
        </span>
        <span v-if="$slots.summary" class="hc-settings-disclosure__summary">
          <slot name="summary" />
        </span>
        <span v-if="$slots.status" class="hc-settings-disclosure__status">
          <slot name="status" />
        </span>
        <ChevronDown
          v-if="!$slots.actions"
          :size="13"
          class="hc-settings-disclosure__chevron"
          :class="{ 'hc-settings-disclosure__chevron--open': modelValue }"
          aria-hidden="true"
        />
      </button>

      <span v-if="$slots.actions" class="hc-settings-disclosure__actions" @click.stop @keydown.stop>
        <slot name="actions" />
      </span>

      <ChevronDown
        v-if="$slots.actions"
        :size="13"
        class="hc-settings-disclosure__chevron"
        :class="{ 'hc-settings-disclosure__chevron--open': modelValue }"
        aria-hidden="true"
      />
    </div>

    <div
      v-show="modelValue"
      :id="bodyId"
      class="hc-settings-disclosure__panel"
      :data-testid="panelTestId"
    >
      <slot />
    </div>
    <slot name="after" />
  </section>
</template>

<style scoped>
.hc-settings-disclosure {
  width: 100%;
  min-width: 0;
  color: var(--hc-text-primary);
}

.hc-settings-disclosure__head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 32px;
  color: var(--hc-text-muted);
  cursor: pointer;
  transition: color 0.15s var(--hc-ease-smooth, ease);
}

.hc-settings-disclosure__head:hover {
  color: var(--hc-text-secondary);
}

.hc-settings-disclosure__trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  min-height: 32px;
  flex: 1;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.hc-settings-disclosure__trigger:focus-visible {
  border-radius: 6px;
  outline: 2px solid var(--hc-accent);
  outline-offset: 3px;
}

.hc-settings-disclosure__icon {
  display: grid;
  width: 13px;
  height: 13px;
  place-items: center;
  flex: none;
  color: currentColor;
}

.hc-settings-disclosure__icon :deep(svg) {
  width: 13px;
  height: 13px;
}

.hc-settings-disclosure__title {
  color: var(--hc-text-primary);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.hc-settings-disclosure__summary {
  min-width: 0;
  max-width: 45%;
  margin-inline-start: auto;
  overflow: hidden;
  color: var(--hc-text-muted);
  font-size: 11.5px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hc-settings-disclosure__status,
.hc-settings-disclosure__actions {
  display: inline-flex;
  align-items: center;
  flex: none;
}

.hc-settings-disclosure__actions {
  gap: 6px;
}

.hc-settings-disclosure__chevron {
  flex: none;
  color: currentColor;
  pointer-events: none;
  transition: transform 0.18s var(--hc-ease-out, ease-out);
}

.hc-settings-disclosure__trigger > .hc-settings-disclosure__chevron {
  margin-inline-start: auto;
}

.hc-settings-disclosure__chevron--open {
  transform: rotate(180deg);
}

.hc-settings-disclosure__panel {
  min-width: 0;
  margin-top: 10px;
  padding: 14px;
  border: 0.5px solid var(--hc-border);
  border-radius: var(--hc-radius-lg, 14px);
  background: var(--hc-bg-card);
}

@container (max-width: 520px) {
  .hc-settings-disclosure__summary {
    max-width: 36%;
  }
}

@container (max-width: 420px) {
  .hc-settings-disclosure__summary {
    max-width: 28%;
  }
}

@container (max-width: 360px) {
  .hc-settings-disclosure__summary {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .hc-settings-disclosure__head,
  .hc-settings-disclosure__chevron {
    transition: none;
  }
}
</style>
