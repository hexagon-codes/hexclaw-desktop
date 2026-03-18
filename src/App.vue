<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppLayout from '@/components/layout/AppLayout.vue'
import ToastProvider from '@/components/common/ToastProvider.vue'
import ErrorBoundary from '@/components/common/ErrorBoundary.vue'
import { useShortcuts } from '@/composables/useShortcuts'
import { useTheme } from '@/composables/useTheme'

const route = useRoute()
const router = useRouter()
const isBlankLayout = computed(() => route.meta.layout === 'blank')

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
})
onUnmounted(() => {
  unlistenNavigate?.()
})
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
