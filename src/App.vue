<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import AppLayout from '@/components/layout/AppLayout.vue'
import ToastProvider from '@/components/common/ToastProvider.vue'
import ErrorBoundary from '@/components/common/ErrorBoundary.vue'
import { useShortcuts } from '@/composables/useShortcuts'
import { useTheme } from '@/composables/useTheme'

const route = useRoute()
const isBlankLayout = computed(() => route.meta.layout === 'blank')

const toastRef = ref<InstanceType<typeof ToastProvider>>()

// 注册应用内快捷键 (⌘1~7 切页, ⌘N 新对话, ⌘, 设置)
useShortcuts()
// 初始化主题
useTheme()

// 全局 toast
if (typeof window !== 'undefined') {
  ;(window as any).__hcToast = toastRef
}
</script>

<template>
  <ErrorBoundary>
    <AppLayout v-if="!isBlankLayout">
      <RouterView v-slot="{ Component }">
        <Transition name="page" mode="out-in">
          <component :is="Component" />
        </Transition>
      </RouterView>
    </AppLayout>
    <RouterView v-else />
  </ErrorBoundary>
  <ToastProvider ref="toastRef" />
</template>
