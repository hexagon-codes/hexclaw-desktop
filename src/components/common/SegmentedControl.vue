<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'

interface Segment {
  key: string
  label: string
  count?: number // 可选计数后缀，渲染为 .segc 徽标（锚点 prototype .seg .segc）
}

const props = defineProps<{
  segments: Segment[]
  modelValue: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

// 滑动指示器：跟随激活 tab 平滑位移（spring 动效），磨砂轨道上的白胶囊。
const listRef = ref<HTMLElement>()
const btnRefs = ref<(HTMLElement | null)[]>([])
const indicator = ref({ left: 0, width: 0, ready: false })

function setBtnRef(el: unknown, i: number) {
  btnRefs.value[i] = (el as HTMLElement) ?? null
}

const activeIndex = computed(() => props.segments.findIndex((s) => s.key === props.modelValue))

function updateIndicator() {
  const btn = btnRefs.value[activeIndex.value]
  const list = listRef.value
  if (!btn || !list) {
    indicator.value.ready = false
    return
  }
  // offsetLeft 自边框盒原点起算，绝对定位子元素 left:0 起于内边距盒（差 clientLeft=边框宽），故扣除。
  indicator.value = {
    left: btn.offsetLeft - list.clientLeft,
    width: btn.offsetWidth,
    ready: true,
  }
}

watch(() => props.modelValue, () => nextTick(updateIndicator))
watch(
  () => props.segments.map((s) => `${s.label}${s.count ?? ''}`).join('|'),
  () => nextTick(updateIndicator),
)

let ro: ResizeObserver | null = null
onMounted(() => {
  nextTick(updateIndicator)
  if (typeof ResizeObserver !== 'undefined' && listRef.value) {
    ro = new ResizeObserver(() => updateIndicator())
    ro.observe(listRef.value)
  }
})
onBeforeUnmount(() => ro?.disconnect())
</script>

<template>
  <div ref="listRef" class="hc-segmented" role="tablist">
    <!-- 滑动指示器（激活胶囊）：随激活 tab spring 位移 -->
    <span
      v-show="indicator.ready"
      class="hc-segmented__indicator"
      :style="{ transform: `translateX(${indicator.left}px)`, width: `${indicator.width}px` }"
      aria-hidden="true"
    />
    <button
      v-for="(seg, i) in segments"
      :key="seg.key"
      :ref="(el) => setBtnRef(el, i)"
      type="button"
      role="tab"
      :aria-selected="modelValue === seg.key"
      :data-testid="`segmented-${seg.key}`"
      class="hc-segmented__btn"
      :class="{ 'hc-segmented__btn--active': modelValue === seg.key }"
      @click="emit('update:modelValue', seg.key)"
    >
      {{ seg.label }}
      <span v-if="seg.count != null" class="hc-segmented__count">{{ seg.count }}</span>
    </button>
  </div>
</template>

<style scoped>
.hc-segmented {
  position: relative;
  display: inline-flex;
  gap: 2px;
  border-radius: 11px;
  padding: 3px;
  /* 磨砂轨道：微染灰底（不再"白压白"），让激活胶囊浮出来 */
  background: var(--hc-bg-input);
  border: 1px solid var(--hc-border);
  flex-shrink: 0;
  min-width: 0;
  overflow: hidden;
}

/* 滑动指示器：白胶囊 + 柔阴影 + 细描边，spring 位移 */
.hc-segmented__indicator {
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 0;
  border-radius: 8px;
  background: var(--hc-bg-elevated);
  box-shadow: var(--hc-shadow-sm), inset 0 0 0 0.5px var(--hc-border);
  transition:
    transform 0.32s cubic-bezier(0.34, 1.4, 0.5, 1),
    width 0.32s cubic-bezier(0.34, 1.4, 0.5, 1);
  pointer-events: none;
  z-index: 0;
}

.hc-segmented__btn {
  position: relative;
  z-index: 1;
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--hc-text-muted);
  border: none;
  background: transparent;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: color 0.15s var(--hc-ease-out);
  white-space: nowrap;
  flex-shrink: 0;
}

/* 非激活 tab：hover 时文字提亮（轻反馈） */
.hc-segmented__btn:hover:not(.hc-segmented__btn--active) {
  color: var(--hc-text-secondary);
}

/* 激活 tab：品牌色文字（告别"全白"，强化选中信号） */
.hc-segmented__btn--active {
  color: var(--hc-accent);
  font-weight: 600;
}

/* 计数后缀（锚点 prototype .segc）：激活时随品牌色，弱化 */
.hc-segmented__count {
  margin-left: 1px;
  font-size: 10.5px;
  font-weight: 400;
  opacity: 0.62;
}
</style>
