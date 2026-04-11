<script setup lang="ts">
import { ref, watch } from 'vue'
import SearchInput from '@/components/common/SearchInput.vue'

const props = defineProps<{
  searchPlaceholder?: string
  searchValue?: string
}>()

const emit = defineEmits<{
  search: [value: string]
  'search-submit': []
}>()

const internalSearch = ref(props.searchValue ?? '')

watch(
  () => props.searchValue,
  (value) => {
    if (value !== undefined && value !== internalSearch.value) {
      internalSearch.value = value
    }
  },
)

function onSearchInput(value: string) {
  internalSearch.value = value
  emit('search', value)
}
</script>

<template>
  <div class="hc-toolbar hc-vibrancy">
    <div class="hc-toolbar__left">
      <slot name="tabs" />
      <div v-if="searchPlaceholder" class="hc-toolbar__search">
        <SearchInput
          class="hc-toolbar__search-control"
          :model-value="internalSearch"
          :fluid="true"
          :placeholder="searchPlaceholder"
          @update:model-value="onSearchInput"
          @submit="emit('search-submit')"
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
</style>
