/**
 * cron 编译 SSE 4 阶段进度的文案 + 进度百分比。
 *
 * 集中复用：TasksView 创建任务对话框、ChatView 自动化卡片都引用。
 * stage 集合与后端 cron.ProgressStage 对齐（参考 src/api/tasks.ts）。
 */
import { useI18n } from 'vue-i18n'
import type { CronCompileStage } from '@/api/tasks'

export function useCronCompileLabel() {
  const { t } = useI18n()

  function stageLabel(stage: CronCompileStage): string {
    switch (stage) {
      case 'analyzing':   return t('tasks.stageAnalyzing',  '解析需求…')
      case 'calling_llm': return t('tasks.stageCallingLLM', '调用 LLM 生成脚本…')
      case 'validating':  return t('tasks.stageValidating', '校验脚本安全性…')
      case 'persisting':  return t('tasks.stagePersisting', '保存任务…')
      default: return stage
    }
  }

  function stageProgress(stage: CronCompileStage): number {
    switch (stage) {
      case 'analyzing':   return 15
      case 'calling_llm': return 60
      case 'validating':  return 85
      case 'persisting':  return 95
      default: return 0
    }
  }

  return { stageLabel, stageProgress }
}
