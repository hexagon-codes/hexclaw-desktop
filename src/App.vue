<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import AppLayout from '@/components/layout/AppLayout.vue'
import ToastProvider from '@/components/common/ToastProvider.vue'
import ErrorBoundary from '@/components/common/ErrorBoundary.vue'
import { useShortcuts } from '@/composables/useShortcuts'
import { useTheme } from '@/composables/useTheme'
import { useAutoUpdate } from '@/composables/useAutoUpdate'
import { useToast } from '@/composables/useToast'

const route = useRoute()
const router = useRouter()
const isBlankLayout = computed(() => route.meta.layout === 'blank')
const { t } = useI18n()
const toast = useToast()
const { checkForUpdate } = useAutoUpdate()

const toastRef = ref<InstanceType<typeof ToastProvider>>()

// 注册应用内快捷键 (⌘1~7 切页, ⌘N 新对话, ⌘, 设置)
useShortcuts()
// 初始化主题
useTheme()

// 全局 toast
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__hcToast = toastRef
}

// 监听 Tauri 托盘导航事件 (替代不安全的 window.eval)
let unlistenNavigate: (() => void) | null = null
onMounted(async () => {
  try {
    const { listen } = await import('@tauri-apps/api/event')
    unlistenNavigate = await listen<string>('navigate', (event) => {
      router.push(event.payload)
    })
  } catch {
    // 非 Tauri 环境 (浏览器开发模式)
  }

  const updateResult = await checkForUpdate()
  if (updateResult.status === 'available' && updateResult.version) {
    toast.info(t('about.updateAvailableToast', { version: updateResult.version }))
  }
})
onUnmounted(() => {
  unlistenNavigate?.()
})
</script>

<template>
  <ErrorBoundary>
    <AppLayout v-if="!isBlankLayout">
      <RouterView v-slot="{ Component, route: viewRoute }">
        <component :is="Component" :key="viewRoute.path" />
      </RouterView>
    </AppLayout>
    <RouterView v-else />
  </ErrorBoundary>
  <ToastProvider ref="toastRef" />
</template>
