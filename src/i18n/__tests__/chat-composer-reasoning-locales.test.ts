import { describe, expect, it } from 'vitest'
import en from '@/i18n/locales/en'
import ugCN from '@/i18n/locales/ug-CN'
import zhCN from '@/i18n/locales/zh-CN'

const LOCALES: Record<string, unknown> = { 'zh-CN': zhCN, en, 'ug-CN': ugCN }

const COMPOSER_KEYS = [
  'skillPrompt',
  'skill',
  'prompt',
  'messageAriaLabel',
  'voiceRecording',
  'voiceDiscard',
  'voiceSendTranscript',
  'voiceTranscribingAndSending',
] as const

const REASONING_KEYS = [
  'trigger',
  'mode',
  'configureMode',
  'configureEffort',
  'unavailable',
  'modeAriaLabel',
  'settingsAriaLabel',
  'effort',
  'effortAriaLabel',
  'strategy',
  'defaultStrategy',
  'defaultStrategyHint',
  'selectStrategy',
  'inherit',
  'auto',
  'on',
  'off',
  'unsupported',
  'pending',
  'display',
  'agentPolicyNote',
  'effortOption',
] as const

const EFFORT_KEYS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const ASSISTANT_RUN_KEYS = [
  'generating',
  'preparing',
  'thinking',
  'thought',
  'ignored',
  'rejected',
  'unsupported',
] as const
const SOURCE_KEYS = ['builtinSkillNoModel'] as const

const EXPECTED = {
  'zh-CN': {
    source: { builtinSkillNoModel: '内置技能 · 未调用模型' },
    composer: {
      skillPrompt: '技能 / 提示词',
      skill: '技能',
      prompt: '提示词',
      messageAriaLabel: '消息内容',
      voiceRecording: '正在听…',
      voiceDiscard: '丢弃录音',
      voiceSendTranscript: '发送语音转写内容',
      voiceTranscribingAndSending: '录音已结束，正在转写并发送',
    },
    reasoning: {
      trigger: '思考',
      mode: '思考模式',
      configureMode: '配置思考模式',
      configureEffort: '配置思考模式和强度',
      unavailable: '当前模型未声明支持思考',
      modeAriaLabel: '开启思考模式',
      settingsAriaLabel: '思考设置',
      effort: '思考强度',
      effortAriaLabel: '思考强度',
      strategy: '思考策略',
      defaultStrategy: '默认思考策略',
      defaultStrategyHint: '用于新会话、未覆盖的智能体与自动化执行',
      selectStrategy: '选择执行时的思考策略',
      inherit: '跟随全局（默认）',
      auto: '自动（推荐）',
      on: '开启',
      off: '关闭',
      unsupported: '不支持思考',
      pending: '思考待检测',
      display: '思考 · {value}',
      agentPolicyNote: '默认跟随全局；会话中的临时选择优先，但不会回写智能体。',
      effortOption: {
        low: '低',
        medium: '中',
        high: '高',
        xhigh: '超高',
        max: '极致',
      },
    },
    assistantRun: {
      generating: '正在生成回答…',
      preparing: '正在准备回答…',
      thinking: '正在深度思考 · {duration}',
      thought: '思考了 {duration}',
      ignored: '深度思考未生效，已按普通模式回答',
      rejected: '无法启用深度思考',
      unsupported: '该模型不支持深度思考',
    },
  },
  en: {
    source: { builtinSkillNoModel: 'Built-in Skill · No model invoked' },
    composer: {
      skillPrompt: 'Skills / Prompts',
      skill: 'Skills',
      prompt: 'Prompts',
      messageAriaLabel: 'Message content',
      voiceRecording: 'Listening…',
      voiceDiscard: 'Discard recording',
      voiceSendTranscript: 'Send voice transcript',
      voiceTranscribingAndSending: 'Recording ended. Transcribing and sending…',
    },
    reasoning: {
      trigger: 'Thinking',
      mode: 'Thinking mode',
      configureMode: 'Configure thinking mode',
      configureEffort: 'Configure thinking mode and effort',
      unavailable: 'The current model does not declare thinking support',
      modeAriaLabel: 'Enable thinking mode',
      settingsAriaLabel: 'Thinking settings',
      effort: 'Thinking effort',
      effortAriaLabel: 'Thinking effort',
      strategy: 'Thinking strategy',
      defaultStrategy: 'Default thinking strategy',
      defaultStrategyHint:
        'Used for new conversations, agents without an override, and automated runs',
      selectStrategy: 'Choose the thinking strategy for this run',
      inherit: 'Follow global (default)',
      auto: 'Auto (recommended)',
      on: 'On',
      off: 'Off',
      unsupported: 'Thinking unsupported',
      pending: 'Thinking pending detection',
      display: 'Thinking · {value}',
      agentPolicyNote:
        "Follows the global default. A conversation's temporary selection takes precedence and does not write back to the agent.",
      effortOption: {
        low: 'Low',
        medium: 'Medium',
        high: 'High',
        xhigh: 'Extra high',
        max: 'Maximum',
      },
    },
    assistantRun: {
      generating: 'Generating answer…',
      preparing: 'Preparing answer…',
      thinking: 'Deep thinking · {duration}',
      thought: 'Thought for {duration}',
      ignored: 'Deep Think was not applied; answered in normal mode.',
      rejected: 'Unable to enable Deep Think',
      unsupported: 'This model does not support Deep Think',
    },
  },
  'ug-CN': {
    source: { builtinSkillNoModel: 'ئىچكى Skill · مودېل چاقىرىلمىدى' },
    composer: {
      skillPrompt: 'Skill / Prompt',
      skill: 'Skill',
      prompt: 'Prompt',
      messageAriaLabel: 'ئۇچۇر مەزمۇنى',
      voiceRecording: 'ئاڭلاۋاتىدۇ…',
      voiceDiscard: 'ئاۋاز خاتىرىسىنى تاشلىۋېتىش',
      voiceSendTranscript: 'ئاۋاز يېزىقچىلىقىنى ئەۋەتىش',
      voiceTranscribingAndSending:
        'ئاۋاز خاتىرىسى ئاخىرلاشتى، يېزىقچىلىققا ئايلاندۇرۇلۇپ ئەۋەتىلىۋاتىدۇ…',
    },
    reasoning: {
      trigger: 'ئويلاش',
      mode: 'ئويلاش ھالىتى',
      configureMode: 'ئويلاش ھالىتىنى تەڭشەش',
      configureEffort: 'ئويلاش ھالىتى ۋە كۈچىنى تەڭشەش',
      unavailable: 'نۆۋەتتىكى مودېل ئويلاشنى قوللايدىغانلىقىنى جاكارلىمىغان',
      modeAriaLabel: 'ئويلاش ھالىتىنى ئېچىش',
      settingsAriaLabel: 'ئويلاش تەڭشەكلىرى',
      effort: 'ئويلاش كۈچى',
      effortAriaLabel: 'ئويلاش كۈچى',
      strategy: 'ئويلاش ئىستراتېگىيەسى',
      defaultStrategy: 'سۈكۈتتىكى ئويلاش ئىستراتېگىيەسى',
      defaultStrategyHint:
        'يېڭى سۆھبەتلەر، قاپلانمىغان Agentلار ۋە ئاپتوماتىك ئىجرا ئۈچۈن ئىشلىتىلىدۇ',
      selectStrategy: 'بۇ قېتىملىق ئىجرا ئۈچۈن ئويلاش ئىستراتېگىيەسىنى تاللاڭ',
      inherit: 'ئومۇمىي سۈكۈتتىكىگە ئەگىشىش',
      auto: 'ئاپتوماتىك (تەۋسىيە)',
      on: 'ئېچىش',
      off: 'تاقاش',
      unsupported: 'ئويلاشنى قوللىمايدۇ',
      pending: 'ئويلاش تەكشۈرۈلىۋاتىدۇ',
      display: 'ئويلاش · {value}',
      agentPolicyNote:
        'ئومۇمىي سۈكۈتتىكىگە ئەگىشىدۇ؛ سۆھبەتتىكى ۋاقىتلىق تاللاش ئالدى بىلەن ئىشلىتىلىدۇ، ئەمما Agentقا قايتا يېزىلمەيدۇ.',
      effortOption: {
        low: 'تۆۋەن',
        medium: 'ئوتتۇرا',
        high: 'يۇقىرى',
        xhigh: 'ئىنتايىن يۇقىرى',
        max: 'ئەڭ يۇقىرى',
      },
    },
    assistantRun: {
      generating: 'جاۋاب ھاسىللىنىۋاتىدۇ…',
      preparing: 'جاۋاب تەييارلىنىۋاتىدۇ…',
      thinking: 'چوڭقۇر ئويلىنىۋاتىدۇ · {duration}',
      thought: 'ئويلاش ۋاقتى {duration}',
      ignored: 'چوڭقۇر ئويلاش كۈچكە ئىگە بولمىدى، ئادەتتىكى ھالەتتە جاۋاب بېرىلدى',
      rejected: 'چوڭقۇر ئويلاشنى قوزغىتىش مۇمكىن بولمىدى',
      unsupported: 'بۇ مودېل چوڭقۇر ئويلاشنى قوللىمايدۇ',
    },
  },
} as const

function resolve(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === 'object'
          ? (current as Record<string, unknown>)[key]
          : undefined,
      obj,
    )
}

function objectAt(obj: unknown, path: string): Record<string, unknown> {
  const value = resolve(obj, path)
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

describe('approved Composer, reasoning, and assistant-run copy has an exact three-locale contract', () => {
  for (const [locale, messages] of Object.entries(LOCALES)) {
    const expected = EXPECTED[locale as keyof typeof EXPECTED]

    it(`defines the approved Composer copy in ${locale}`, () => {
      const composer = objectAt(messages, 'chat.composer')
      expect(Object.fromEntries(COMPOSER_KEYS.map((key) => [key, composer[key]]))).toEqual(
        expected.composer,
      )
    })

    it(`defines the approved Footer source copy in ${locale}`, () => {
      const chat = objectAt(messages, 'chat')
      expect(Object.fromEntries(SOURCE_KEYS.map((key) => [key, chat[key]]))).toEqual(
        expected.source,
      )
    })

    it(`defines the exact reasoning control key set in ${locale}`, () => {
      const reasoning = objectAt(messages, 'chat.reasoning')
      expect(Object.keys(reasoning).sort()).toEqual([...REASONING_KEYS].sort())
      expect(reasoning).toEqual(expected.reasoning)
      expect(Object.keys(objectAt(messages, 'chat.reasoning.effortOption')).sort()).toEqual(
        [...EFFORT_KEYS].sort(),
      )
    })

    it(`defines the exact assistant-run key set in ${locale}`, () => {
      const assistantRun = objectAt(messages, 'chat.assistantRun')
      expect(Object.keys(assistantRun).sort()).toEqual([...ASSISTANT_RUN_KEYS].sort())
      expect(assistantRun).toEqual(expected.assistantRun)
    })
  }
})
