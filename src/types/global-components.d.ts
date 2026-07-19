declare module 'vue' {
  export interface GlobalComponents {
    HcClearableField: typeof import('@/components/common/HcClearableField.vue')['default']
  }
}

export {}
