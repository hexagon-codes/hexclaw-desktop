<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import TitleBar from './TitleBar.vue'
import Sidebar from './Sidebar.vue'
import CommandPalette from '@/components/common/CommandPalette.vue'
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
  <div class="hc-app">
    <TitleBar />
    <div class="hc-app__body">
      <Sidebar />
      <main class="hc-app__content">
        <slot />
      </main>
    </div>
    <CommandPalette />
  </div>
</template>

<style scoped>
.hc-app {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--hc-bg-main);
}

.hc-app__body {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.hc-app__content {
  flex: 1;
  overflow: hidden;
  position: relative;
  min-width: 0;
}
</style>
