<script setup lang="ts">
/**
 * SkillIcon —— 统一渲染 Skill 图标（emoji 或派生 lucide + 配色）。
 * 三处复用：命令面板 TemplatePopup、SkillsView 已装/市场卡。
 * 图标来源见 utils/skill-icon.ts（作者 icon 覆盖 → category/tags/name 派生）。
 */
import { computed, type Component } from 'vue'
import {
  Code, Search, Palette, PenLine, Table, TrendingUp, Scale, GraduationCap,
  Radio, Workflow, Shield, Zap, Puzzle, FileText, Bot, Sparkles, BarChart3,
  Presentation, Mic, Music, FlaskConical, Globe, Database, Image, Video,
  BookOpen, Calculator, Wand2,
} from 'lucide-vue-next'
import { resolveSkillIcon } from '@/utils/skill-icon'

const props = withDefaults(
  defineProps<{
    skill: { icon?: string; category?: string; tags?: string[]; name?: string; display_name?: string }
    size?: number
  }>(),
  { size: 16 },
)

// 注册表：把白名单 lucide 名映射到组件，未命中回退 Puzzle。
const REGISTRY: Record<string, Component> = {
  Code, Search, Palette, PenLine, Table, TrendingUp, Scale, GraduationCap,
  Radio, Workflow, Shield, Zap, Puzzle, FileText, Bot, Sparkles, BarChart3,
  Presentation, Mic, Music, FlaskConical, Globe, Database, Image, Video,
  BookOpen, Calculator, Wand2,
}

const desc = computed(() => resolveSkillIcon(props.skill))
const IconComp = computed<Component>(() => REGISTRY[desc.value.lucide] ?? Puzzle)
</script>

<template>
  <span
    v-if="desc.emoji"
    class="skill-icon skill-icon--emoji"
    :style="{ fontSize: size + 'px', lineHeight: 1 }"
    aria-hidden="true"
  >{{ desc.emoji }}</span>
  <component
    :is="IconComp"
    v-else
    :size="size"
    :style="{ color: desc.color }"
    class="skill-icon"
    aria-hidden="true"
  />
</template>

<style scoped>
.skill-icon {
  flex-shrink: 0;
}
.skill-icon--emoji {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
</style>
