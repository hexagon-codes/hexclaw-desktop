/**
 * 审计单验证（20260709 · High）：K12 recognize/grade/tutoringTips 链路把 display name 当 API agent 发送。
 *
 * 后端契约：agent = agents.name（内部名，隔离键），非 display name
 * （scenarios/k12/API.md:147；apihttp/handler.go:218 用 req.Agent 作 AgentName）。
 *
 * 接线现状：ChatView scenarioCtx 传 agentId(内部名) + agentName(display_name)；
 * K12ChatEnhancement 只把 agentName 传进 RecognizeGuardPanel（该组件根本没有 agentId prop）→
 * grade / coldStart / 内联辅导要点全用 display name 当隔离键 → 错孩子作用域 / profile 查不到 /
 * 记录写错键。
 *
 * 断言的是**正确行为**（API 收到的 agent === agentId 内部名）——测试失败即证明 bug 存在。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import HcSelect from '@/components/common/HcSelect.vue'
import K12ChatEnhancement from '../views/K12ChatEnhancement.vue'
import RecognizeGuardPanel from '../views/RecognizeGuardPanel.vue'
import { K12_VIEW_DESCRIPTOR } from '../descriptor'

const AGENT_ID = 'k12-tutor-KKE5v8zQ' // agents.name（后端隔离键）
const DISPLAY_NAME = '小明的辅导老师' // display_name（仅供展示）

const {
  k12ColdStart,
  k12TutoringTips,
  k12UploadAsset,
  k12CreateImageTask,
  k12GetImageTask,
  k12GetImageTaskResult,
  k12ConfirmImageTask,
} = vi.hoisted(() => ({
  k12ColdStart: vi.fn().mockResolvedValue({ grade_term: '五年级上', inferred: true }),
  k12TutoringTips: vi
    .fn()
    .mockResolvedValue({ knowledge_points: ['20以内加法'], sections: [] }),
  k12UploadAsset: vi
    .fn()
    .mockResolvedValue({ asset_id: 'asset://k12-tutor-KKE5v8zQ/homework.png', size: 3 }),
  k12CreateImageTask: vi.fn(),
  k12GetImageTask: vi.fn(),
  k12GetImageTaskResult: vi.fn(),
  k12ConfirmImageTask: vi.fn(),
}))

const riskQuestion = {
  problem_id: 'problem-1',
  question: '1+1=?',
  canonical_markdown: '1+1=?',
  knowledge_points: ['20以内加法'],
  answer_state: 'present',
  student_answer: '2',
  answer_canonical_markdown: '2',
  confirmation_required: true,
  confirmation_reasons: ['evidence_conflict'],
}

function homeworkDispatch(
  stage: 'awaiting_confirmation' | 'completed',
  confirmationState: 'pending' | 'confirmed',
) {
  return {
    dispatch: {
      dispatch_id: 'dispatch-1',
      task_intent: 'completed_homework',
      status: 'routed',
      intent_evidence: ['answer_regions_present'],
      intent_confidence: 0.99,
      confirmation_candidates: [],
      target: { type: 'homework_submission', id: 'submission-1' },
      target_projection: {
        kind: 'homework',
        stage,
        confirmation_state: confirmationState,
        anchor_state: 'located',
        recognition: { questions: [riskQuestion], subject: '' },
      },
      progress: { operation: 'homework', state: stage },
      version: stage === 'completed' ? 3 : 2,
      created_at: 1,
      updated_at: 2,
    },
  }
}

function completedResult() {
  return {
    dispatch_id: 'dispatch-1',
    task_intent: 'completed_homework',
    status: 'routed',
    result: {
      kind: 'completed_homework',
      payload: {
        mode: 'grade',
        task_intent: 'completed_homework',
        result_surface: 'annotated_homework',
        items: [
          {
            question: riskQuestion,
            status: 'correct',
            result_kind: 'assessment',
            grade: {
              solution: '2',
              verdict: 'agree',
              evidence_type: 'numeric_exec',
              badge: 'verified-strong',
              out_of_scope: false,
              record_created: false,
            },
          },
        ],
        markdown: '# 批改完成',
        image_warning: '',
        annotated_image: {
          mime: 'image/png',
          data_base64: 'QU5OT1RBVEVE',
          digest: 'sha256:annotated',
        },
      },
    },
  }
}

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn().mockResolvedValue({ items: [] }),
  k12ReviewQueue: vi.fn().mockResolvedValue({ items: [] }),
  k12MarkMastered: vi.fn(),
  k12TutoringTips,
  k12UploadAsset,
  k12CreateImageTask,
  k12GetImageTask,
  k12GetImageTaskResult,
  k12ConfirmImageTask,
  k12RetryImageTask: vi.fn(),
  k12CancelImageTask: vi.fn(),
  k12ColdStart,
  k12InsightReport: vi.fn().mockResolvedValue({ trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 }, weak_top3: [], month_new_mistakes: 0, review_completion_rate: -1, consecutive_fail_kps: null, suggestion: '' }),
  k12StudyTime: vi.fn().mockResolvedValue({ days: [], total_records: 0, total_minutes: 0, note: '' }),
  k12ListAccumulation: vi.fn().mockResolvedValue({ items: [] }),
  k12GetViewDescriptor: vi.fn().mockResolvedValue({
    header_tabs: ['辅导', '错题本'], message_badges: [], composer_placeholder: '',
    composer_chips: [], record_collections: [], side_panels: [], actions: [], i18n_keys: [], schema_version: 1,
  }),
}))

vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }) }))

function i18n() {
  return createI18n({
    legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: zhCN },
  })
}

function render(metadata: Record<string, string>) {
  return mount(K12ChatEnhancement, {
    // 与 ChatView scenarioCtx 完全一致的传参形态：agentId=内部名，agentName=display_name
    props: {
      agentId: AGENT_ID,
      agentName: DISPLAY_NAME,
      sessionId: 'session-1',
      metadata,
      descriptor: K12_VIEW_DESCRIPTOR,
    },
    global: { plugins: [createPinia(), i18n()], stubs: { MarkdownRenderer: true } },
    attachTo: document.body,
  })
}

/** 打开识题面板 → 识题（公共前置动作）。BUG-20260711-E：手动 toggle 已删，
 *  入口=composer 图片自动改道（composerImage prop → 护栏自动 run）。 */
async function recognizeOnce(w: ReturnType<typeof render>) {
  await w.setProps({ composerImage: 'data:image/png;base64,Zm9v' })
  await flushPromises()
  expect(w.findComponent(RecognizeGuardPanel).find('[data-testid="rq-item"]').exists(), '前置：识题回显护栏出题').toBe(true)
}

describe('审计单-High-2：K12 grade/coldStart/tutoringTips 必须用 agents.name 作 API agent（非 display name）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    k12UploadAsset.mockResolvedValue({
      asset_id: 'asset://k12-tutor-KKE5v8zQ/homework.png',
      size: 3,
    })
    k12CreateImageTask.mockResolvedValue({
      created: true,
      ...homeworkDispatch('awaiting_confirmation', 'pending'),
    })
    k12ConfirmImageTask.mockResolvedValue(homeworkDispatch('completed', 'confirmed'))
    k12GetImageTask.mockResolvedValue(homeworkDispatch('completed', 'confirmed'))
    k12GetImageTaskResult.mockResolvedValue(completedResult())
    document.body.innerHTML = '<div id="hc-chat-scenario-inline"></div><div id="hc-chat-scenario-footer"></div><div id="hc-chat-scenario-composer-top"></div><div id="hc-chat-scenario-composer-actions"></div><div id="hc-chat-scenario-sidepanel"></div>'
  })

  it('★image-task：识题/批改 facade 的 agent 必须是 agentId（内部名），不得是 display name', async () => {
    const w = render({ 'k12.grade_term': '五年级上' })
    await recognizeOnce(w)

    expect(k12CreateImageTask).toHaveBeenCalledTimes(1)
    expect((k12CreateImageTask.mock.calls[0]![0] as { agent: string }).agent).toBe(AGENT_ID)

    w.findComponent(HcSelect).vm.$emit('update:modelValue', '数学')
    await flushPromises()
    const panel = w.findComponent(RecognizeGuardPanel)
    await panel.find('[data-testid="rq-confirm-0"]').setValue(true)
    await panel.find('[data-testid="recognize-confirm-all"]').trigger('click')
    await flushPromises()

    expect(k12ConfirmImageTask).toHaveBeenCalledTimes(1)
    const req = k12ConfirmImageTask.mock.calls[0]![1] as { agent: string }
    expect(
      req.agent,
      `image-task confirm 的 agent 应为 agents.name（隔离键），实际发送「${req.agent}」——display name 会写错孩子作用域`,
    ).toBe(AGENT_ID)
  })

  it('★tutoringTips（整体确认后内联辅导要点）：API agent 必须是 agentId（内部名）', async () => {
    const w = render({ 'k12.grade_term': '五年级上' })
    await recognizeOnce(w)

    expect(k12TutoringTips).not.toHaveBeenCalled()
    w.findComponent(HcSelect).vm.$emit('update:modelValue', '数学')
    await flushPromises()
    const panel = w.findComponent(RecognizeGuardPanel)
    await panel.find('[data-testid="rq-confirm-0"]').setValue(true)
    await panel.find('[data-testid="recognize-confirm-all"]').trigger('click')
    await flushPromises()
    expect(k12TutoringTips).toHaveBeenCalledTimes(1)
    const req = k12TutoringTips.mock.calls[0]![0] as { agent: string }
    expect(
      req.agent,
      `tutoring-tips 的 agent 应为 agents.name（隔离键），实际发送「${req.agent}」——display name 导致 profile 查找失败`,
    ).toBe(AGENT_ID)
  })

  it('★coldStart（无年级冷启动倒查建档）：k12ColdStart 的 agent 必须是 agentId（内部名）', async () => {
    const w = render({}) // 无 k12.grade_term → 冷启动入口出现
    await recognizeOnce(w)

    const infer = w.findComponent(RecognizeGuardPanel).find('[data-testid="coldstart-infer"]')
    expect(infer.exists(), '前置：无年级 + 已识题 → 冷启动倒查入口出现').toBe(true)
    await infer.trigger('click')
    await flushPromises()

    expect(k12ColdStart).toHaveBeenCalledTimes(1)
    const req = k12ColdStart.mock.calls[0]![0] as { agent: string }
    expect(
      req.agent,
      `coldStart 的 agent 应为 agents.name（隔离键），实际发送「${req.agent}」——display name 会把建档写到错误的键`,
    ).toBe(AGENT_ID)
  })
})
