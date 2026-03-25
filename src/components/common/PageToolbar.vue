<script setup lang="ts">
defineProps<{
  searchPlaceholder?: string
}>()

const emit = defineEmits<{
  search: [value: string]
}>()

function onInput(e: Event) {
  emit('search', (e.target as HTMLInputElement).value)
}
</script>

<template>
  <div class="hc-toolbar hc-vibrancy">
    <div class="hc-toolbar__left">
      <slot name="tabs" />
      <div v-if="searchPlaceholder" class="hc-toolbar__search">
        <input
          type="text"
          class="hc-toolbar__search-input"
          :placeholder="searchPlaceholder"
          @input="onInput"
        />
      </div>
      <slot name="center" />
    </div>
    <div class="hc-toolbar__right">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.hc-toolbar {
  height: 42px;
  border-bottom: 1px solid var(--hc-divider);
  background: var(--hc-bg-panel);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 14px;
  flex-shrink: 0;
  position: relative;
  z-index: 1;
}

.hc-toolbar__left,
.hc-toolbar__right {
  display: flex;
  gap: 10px;
  align-items: center;
}

.hc-toolbar__left {
  flex: 1;
  min-width: 0;
}

.hc-toolbar__search {
  min-width: 200px;
  max-width: 320px;
  flex: 1;
}

.hc-toolbar__search-input {
  width: 100%;
  height: 28px;
  border-radius: 8px;
  border: 1px solid var(--hc-border);
  background: var(--hc-bg-input);
  color: var(--hc-text-primary);
  padding: 0 12px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.hc-toolbar__search-input:focus {
  border-color: var(--hc-accent);
  box-shadow: 0 0 0 3px var(--hc-accent-subtle);
}

.hc-toolbar__search-input::placeholder {
  color: var(--hc-text-muted);
}
</style>
