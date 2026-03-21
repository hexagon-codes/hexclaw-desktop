import { type Ref } from 'vue'
import type ToastProvider from '@/components/common/ToastProvider.vue'

type ToastInstance = InstanceType<typeof ToastProvider>

function getToast(): ToastInstance | undefined {
  const ref = (window as unknown as Record<string, Ref<ToastInstance | undefined>>).__hcToast
  return ref?.value
}

export function useToast() {
  return {
    success: (msg: string) => getToast()?.success(msg),
    error: (msg: string) => getToast()?.error(msg),
    warning: (msg: string) => getToast()?.warning(msg),
    info: (msg: string) => getToast()?.info(msg),
  }
}
