import type { ModelCapability } from '@/types/settings'

export type DisplayModelCapability = ModelCapability | 'tools' | 'thinking'

export const MODEL_CAPABILITY_DISPLAY: Record<
  DisplayModelCapability,
  { icon: string; label: string; title: string }
> = {
  text: { icon: '💬', label: '文本', title: '文本对话' },
  vision: { icon: '👁', label: '视觉', title: '视觉理解' },
  video: { icon: '🎬', label: '视频', title: '视频理解' },
  audio: { icon: '🎤', label: '音频', title: '音频处理' },
  code: { icon: '💻', label: '代码', title: '代码专项' },
  image_generation: { icon: '🎨', label: '绘图', title: '图像生成' },
  video_generation: { icon: '📹', label: '视频生成', title: '视频生成' },
  embedding: { icon: '◈', label: 'Embedding', title: '向量嵌入' },
  tools: { icon: '🔧', label: '工具', title: '工具调用' },
  thinking: { icon: '🧠', label: '推理', title: '推理能力' },
}
