<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import TitleBar from './TitleBar.vue'
import Sidebar from './Sidebar.vue'
import { useAppStore } from '@/stores/app'

const appStore = useAppStore()

onMounted(() => {
  appStore.startHealthCheck()
})

onUnmounted(() => {
  appStore.stopHealthCheck()
})
</script>

<template>
  <div class="h-screen flex flex-col overflow-hidden" :style="{ background: 'var(--hc-bg-main)' }">
    <TitleBar />
    <div class="flex-1 flex overflow-hidden">
      <Sidebar />
      <main class="flex-1 overflow-hidden">
        <slot />
      </main>
    </div>
  </div>
</template>
