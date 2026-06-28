<script setup lang="ts">
import MarkdownRenderer from './MarkdownRenderer.vue'
import ToolCallCard from './ToolCallCard.vue'
import type { ContentBlock, ToolCall } from '@/types/chat'

/**
 * 按**有序内容块流**渲染一个 assistant 回合：text 与 tool 调用按真实执行序交错
 * （text → 工具卡 → text → 工具卡 …），修复多步 ReAct 被压平成「全文本在前、全工具在后」。
 *
 * 分工：blocks 提供**顺序**；富数据（status/耗时/结果）走扁平 tool_calls，tool_use 块按 id 取。
 * thinking 块不在此渲染（reasoning 走消息级独立思考块）；tool_result 块折叠进对应工具卡，不单独渲染。
 */
const props = defineProps<{ blocks: ContentBlock[]; toolCalls?: ToolCall[] }>()

/** tool_use 块 → 完整 ToolCall（优先扁平 tool_calls 的富数据，回退块自身字段）。 */
function toolCallFor(block: Extract<ContentBlock, { type: 'tool_use' }>): ToolCall {
  const hit = props.toolCalls?.find((t) => t.id === block.id)
  return hit ?? { id: block.id, name: block.name, arguments: block.input }
}
</script>

<template>
  <div class="hc-blocks">
    <template v-for="(b, i) in blocks" :key="i">
      <MarkdownRenderer v-if="b.type === 'text' && b.text" :content="b.text" />
      <ToolCallCard v-else-if="b.type === 'tool_use'" :call="toolCallFor(b)" />
    </template>
  </div>
</template>

<style scoped>
.hc-blocks {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
