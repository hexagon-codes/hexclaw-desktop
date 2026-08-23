import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@/i18n/locales/zh-CN'
import k12Zh from '../i18n/zh-CN'
import RecognizeGuardPanel from '../views/RecognizeGuardPanel.vue'

const h = vi.hoisted(() => ({
  upload: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  getResult: vi.fn(),
  confirm: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
  tutoringTips: vi.fn(),
  sourceAction: vi.fn(),
}))

vi.mock('@/api/k12', () => ({
  k12ListMistakes: vi.fn(),
  k12ReviewQueue: vi.fn(),
  k12MarkMastered: vi.fn(),
  k12DeleteMistake: vi.fn(),
  k12TutoringTips: (...args: unknown[]) => h.tutoringTips(...args),
  k12AddGrounding: vi.fn(),
  k12Grade: vi.fn(),
  k12RecordMistake: vi.fn(),
  k12Solve: vi.fn(),
  k12InsightReport: vi.fn(),
  k12ListAccumulation: vi.fn(),
  k12UploadAsset: (...args: unknown[]) => h.upload(...args),
  k12CreateImageTask: (...args: unknown[]) => h.create(...args),
  k12GetImageTask: (...args: unknown[]) => h.get(...args),
  k12GetImageTaskResult: (...args: unknown[]) => h.getResult(...args),
  k12ConfirmImageTask: (...args: unknown[]) => h.confirm(...args),
  k12RetryImageTask: (...args: unknown[]) => h.retry(...args),
  k12CancelImageTask: (...args: unknown[]) => h.cancel(...args),
  k12SubmitImageTaskProblemSourceAction: (...args: unknown[]) => h.sourceAction(...args),
  k12ColdStart: vi.fn(),
  k12TutorTurn: vi.fn(),
  k12BindIM: vi.fn(),
  k12ProvisionCron: vi.fn(),
}))

function i18n() {
  return createI18n({
    legacy: false,
    locale: 'zh-CN',
    fallbackLocale: 'zh-CN',
    messages: { 'zh-CN': { ...zhCN, k12: k12Zh }, zh: { ...zhCN, k12: k12Zh } },
  })
}

function recognizedQuestion(
  problemId: string,
  label: string,
  path: string[],
  extra: Record<string, unknown> = {},
) {
  return {
    problem_id: problemId,
    source_number_path: path,
    display_label: label,
    question: `${label} 题目`,
    canonical_markdown: `${label} 题目`,
    knowledge_points: ['小数计算'],
    answer_state: 'present',
    student_answer: '8',
    confirmation_required: false,
    ...extra,
  }
}

function problemProgress(
  problemId: string,
  label: string,
  path: string[],
  extra: Record<string, unknown> = {},
) {
  return {
    problem_id: problemId,
    source_number_path: path,
    display_label: label,
    source_state: 'ready',
    anchor_state: 'located',
    operation_state: 'published',
    disposition_state: 'result',
    result_projection: { assessment_status: 'correct' },
    published_revision: 1,
    ...extra,
  }
}

interface DispatchOptions {
  problems: Array<Record<string, unknown>>
  questions: Array<Record<string, unknown>>
  coverage?: {
    state: 'full' | 'with_skips' | 'incomplete'
    total: number
    processed: number
    skipped: number
  }
  stage?: string
  finalArtifact?: Record<string, unknown> | null
}

function imageTaskDispatch(options: DispatchOptions) {
  const coverage = options.coverage ?? {
    state: 'incomplete' as const,
    total: options.problems.length,
    processed: options.problems.filter((problem) => problem.disposition_state === 'result').length,
    skipped: options.problems.filter((problem) => problem.disposition_state === 'skipped_by_parent')
      .length,
  }
  return {
    created: true,
    dispatch: {
      dispatch_id: 'dispatch-progressive-wave-2',
      task_intent: 'completed_homework',
      status: 'routed',
      intent_evidence: ['answer_regions_present'],
      intent_confidence: 0.99,
      confirmation_candidates: [],
      target: { type: 'homework_submission', id: 'submission-progressive-wave-2' },
      target_projection: {
        kind: 'homework',
        stage: options.stage ?? 'assessing',
        confirmation_state: 'confirmed',
        anchor_state: 'located',
        structure_version: 2,
        recognition: { subject: '数学', questions: options.questions },
        problems: options.problems,
        coverage,
        projection_revision: 8,
        final_artifact: options.finalArtifact ?? null,
      },
      progress: { operation: 'homework', state: options.stage ?? 'assessing' },
      version: 8,
      created_at: 1,
      updated_at: 2,
    },
  }
}

function completedResult(questions: Array<Record<string, unknown>>) {
  return {
    dispatch_id: 'dispatch-progressive-wave-2',
    task_intent: 'completed_homework',
    status: 'routed',
    result: {
      kind: 'completed_homework',
      payload: {
        mode: 'grade',
        task_intent: 'completed_homework',
        result_surface: 'annotated_homework',
        items: questions.map((question) => ({
          question,
          status: 'correct',
          result_kind: 'assessment',
          grade: {
            solution: '8',
            verdict: 'agree',
            evidence_type: 'numeric_exec',
            badge: 'verified-strong',
            out_of_scope: false,
            record_created: false,
            solve_only: false,
          },
        })),
        markdown: '# 批改完成',
        image_warning: '',
        annotated_image: {
          mime: 'image/png',
          data_base64: 'QU5OT1RBVEVE',
          digest: 'sha256:annotated-wave-2',
        },
      },
    },
  }
}

const wrappers: Array<ReturnType<typeof mount>> = []

async function renderTask(
  snapshot: ReturnType<typeof imageTaskDispatch>,
  options: { completedResult?: ReturnType<typeof completedResult> } = {},
) {
  h.create.mockResolvedValue(snapshot)
  h.get.mockResolvedValue({ dispatch: snapshot.dispatch })
  if (options.completedResult) h.getResult.mockResolvedValue(options.completedResult)

  const wrapper = mount(RecognizeGuardPanel, {
    props: {
      agentId: 'mingming',
      grade: '五年级下',
      sessionId: 'session-progressive-wave-2',
      requestId: 'message-progressive-wave-2',
      initialImage: 'data:image/png;base64,QUJD',
    },
    global: { plugins: [createPinia(), i18n()] },
    attachTo: document.body,
  })
  wrappers.push(wrapper)
  await flushPromises()
  await flushPromises()
  return wrapper
}

function buttonByName(root: Element, name: string): HTMLButtonElement | null {
  return (
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.replace(/\s+/g, ' ').trim() === name,
    ) ?? null
  )
}

function slotByLabel(root: Element, label: string): HTMLElement {
  const slot = [...root.querySelectorAll<HTMLElement>('[role="listitem"]')].find((candidate) =>
    candidate.textContent?.includes(label),
  )
  if (!slot) throw new Error(`missing progressive slot: ${label}`)
  return slot
}

describe('BUG-20260726-031 · SourceIssueResolver and final artifact Wave 2', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    Object.values(h).forEach((spy) => spy.mockReset())
    h.upload.mockResolvedValue({ asset_id: 'asset://mingming/photo.png', size: 3 })
    h.get.mockReturnValue(new Promise(() => {}))
    h.tutoringTips.mockResolvedValue({
      knowledge_points: ['小数计算'],
      sections: [
        { title: '这页在练什么', content: '小数计算。', source_label: '📖 依据课本' },
        { title: '孩子要留意', content: '注意小数点。', source_label: '🧠 学情信号' },
        {
          title: '每道题怎么带',
          content: '先读题。',
          source_label: '🤖 AI 归纳·供参考',
        },
      ],
    })
  })

  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
  })

  it('C02 渐进 TaskShell 从 result_projection.assessment_status 投影紫色过程问题', async () => {
    const question = recognizedQuestion('problem-process', '四. 15', ['四', '15'])
    const wrapper = await renderTask(
      imageTaskDispatch({
        questions: [question],
        problems: [
          problemProgress('problem-process', '四. 15', ['四', '15'], {
            result_projection: { assessment_status: 'correct_with_process_issue' },
          }),
        ],
      }),
    )

    const slot = slotByLabel(wrapper.element, '四. 15')
    expect(slot.classList).toContain('is-process')
    expect(slot.getAttribute('data-assessment-status')).toBe('correct_with_process_issue')
    expect(slot.querySelector('.rec-problem-progress__status')?.textContent?.trim()).toBe('⚠')
    expect(slot.querySelector('.rec-problem-progress__state')?.textContent?.trim()).toBe('过程问题')
    expect(slot.querySelector('.rec-problem-progress__body small')?.textContent).toContain(
      '最终答案正确 · 过程需关注',
    )
    expect(slot.textContent).not.toContain('已程序验算')
  })

  it('PROG-004/006/019 exposes the one shared source action exact-set only while resolvable, then only resume after skip', async () => {
    const questions = [
      recognizedQuestion('problem-ready', '一. 1', ['一', '1']),
      recognizedQuestion('problem-awaiting', '一. 2', ['一', '2'], {
        confirmation_required: true,
        confirmation_reasons: ['source_conflict'],
      }),
      recognizedQuestion('problem-unknown', '一. 3', ['一', '3']),
      recognizedQuestion('problem-skipped', '一. 4', ['一', '4']),
    ]
    const wrapper = await renderTask(
      imageTaskDispatch({
        questions,
        problems: [
          problemProgress('problem-ready', '一. 1', ['一', '1']),
          problemProgress('problem-awaiting', '一. 2', ['一', '2'], {
            source_state: 'awaiting_resolution',
            anchor_state: 'degraded',
            operation_state: 'prepared',
            disposition_state: 'open',
            result_projection: null,
            published_revision: 0,
          }),
          problemProgress('problem-unknown', '一. 3', ['一', '3'], {
            operation_state: 'outcome_unknown',
            disposition_state: 'open',
            result_projection: null,
          }),
          problemProgress('problem-skipped', '一. 4', ['一', '4'], {
            source_state: 'awaiting_resolution',
            operation_state: 'skipped',
            disposition_state: 'skipped_by_parent',
            result_projection: null,
          }),
        ],
      }),
    )

    const root = wrapper.get('[data-testid="recognize-guard"]').element
    const awaiting = slotByLabel(root, '一. 2')
    const resolver = awaiting.querySelector<HTMLElement>('[data-source-issue-resolver]')
    expect(resolver, 'awaiting_resolution must use the shared resolver').not.toBeNull()
    for (const action of ['纠正识别', '重新选择区域', '重新拍摄', '跳过这题']) {
      const button = buttonByName(resolver!, action)
      expect(button, `${action} must be present`).not.toBeNull()
      expect(button!.disabled, `${action} must be enabled for awaiting_resolution`).toBe(false)
    }
    expect(buttonByName(resolver!, '恢复处理')).toBeNull()

    for (const label of ['一. 1', '一. 3']) {
      const slot = slotByLabel(root, label)
      const unsafe = [...slot.querySelectorAll<HTMLButtonElement>('button')].filter(
        (button) =>
          ['纠正识别', '重新选择区域', '重新拍摄', '跳过这题'].includes(
            button.textContent?.trim() ?? '',
          ) && !button.disabled,
      )
      expect(
        unsafe,
        `${label} is not awaiting_resolution and must expose no enabled source mutation`,
      ).toHaveLength(0)
    }

    const skipped = slotByLabel(root, '一. 4')
    expect(buttonByName(skipped, '恢复处理')?.disabled).toBe(false)
    expect(buttonByName(skipped, '跳过这题')).toBeNull()
  })

  it('PROG-005/006 keeps public-stem actions at group scope and skips all dependent children atomically', async () => {
    const questions = [
      recognizedQuestion('problem-1', '一. 1', ['一', '1']),
      recognizedQuestion('stem-3', '三、公共题干', ['三'], {
        problem_kind: 'compound_parent',
        answer_state: 'blank',
        student_answer: '',
        confirmation_required: true,
        confirmation_reasons: ['source_conflict'],
      }),
      recognizedQuestion('problem-3-1', '三、1', ['三', '1'], {
        problem_kind: 'compound_child',
        parent_problem_id: 'stem-3',
      }),
      recognizedQuestion('problem-3-2', '三、2', ['三', '2'], {
        problem_kind: 'compound_child',
        parent_problem_id: 'stem-3',
      }),
    ]
    const dependency = {
      parent_problem_id: 'stem-3',
      dependency_group_id: 'group-3',
      source_state: 'awaiting_resolution',
      operation_state: 'prepared',
      disposition_state: 'open',
      result_projection: null,
      published_revision: 0,
      input_revision: 1,
    }
    h.sourceAction.mockResolvedValue({
      command_receipt_id: 'receipt-group-3-skip',
      dispatch_id: 'dispatch-progressive-wave-2',
      problem_id: 'problem-3-1',
      action: 'skip',
      structure_version: 2,
      input_revision: 1,
      progressive_snapshot: {
        structure_version: 2,
        snapshot_revision: 9,
        problem_progress: [
          {
            problem_id: 'problem-1',
            status: 'correct',
            input_revision: 1,
            published_revision: 1,
            current_disposition: 'current',
          },
          {
            problem_id: 'problem-3-1',
            status: 'skipped',
            input_revision: 1,
            published_revision: 1,
            current_disposition: 'current',
          },
          {
            problem_id: 'problem-3-2',
            status: 'skipped',
            input_revision: 1,
            published_revision: 1,
            current_disposition: 'current',
          },
        ],
        coverage: {
          total: 3,
          published: 1,
          skipped: 2,
          awaiting: 0,
          failed: 0,
          status: 'complete',
          projection_revision: 9,
        },
      },
    })
    const wrapper = await renderTask(
      imageTaskDispatch({
        questions,
        problems: [
          problemProgress('problem-1', '一. 1', ['一', '1']),
          problemProgress('problem-3-1', '三、1', ['三', '1'], dependency),
          problemProgress('problem-3-2', '三、2', ['三', '2'], dependency),
        ],
      }),
    )

    const root = wrapper.get('[data-testid="recognize-guard"]').element
    const group = root.querySelector<HTMLElement>('[data-problem-group-id="group-3"]')
    expect(group, 'public stem must have one group projection').not.toBeNull()
    expect(group!.querySelectorAll('[data-source-issue-resolver]')).toHaveLength(1)
    expect(root.querySelectorAll('[data-source-issue-resolver]')).toHaveLength(1)
    const groupResolver = group!.querySelector<HTMLElement>('[data-source-issue-resolver]')
    expect(
      groupResolver?.parentElement,
      'the resolver must be the full-width sibling of the progress-slot card',
    ).toBe(group)
    expect(
      groupResolver?.previousElementSibling?.classList.contains('rec-problem-progress__slot'),
    ).toBe(true)

    const children = [
      group!.querySelector<HTMLElement>('[data-problem-id="problem-3-1"]'),
      group!.querySelector<HTMLElement>('[data-problem-id="problem-3-2"]'),
    ]
    expect(children.every(Boolean)).toBe(true)
    for (const child of children) {
      expect(child!.querySelector('[data-source-issue-resolver]')).toBeNull()
    }

    buttonByName(group!, '跳过第 3 题组')!.click()
    await flushPromises()
    const dialog = group!.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('三、1 和三、2')
    expect(dialog?.textContent).toContain('不会写入错题、复习或学情')
    buttonByName(dialog!, '确认跳过 2 题')!.click()
    await flushPromises()
    expect(wrapper.emitted('sourceIssueIntent')?.[0]?.[0]).toMatchObject({
      action: 'skip',
      problem_ids: ['problem-3-1', 'problem-3-2'],
      dependency_group_id: 'group-3',
    })
    expect(h.sourceAction).toHaveBeenCalledWith(
      'dispatch-progressive-wave-2',
      'problem-3-1',
      {
        action: 'skip',
        structure_version: 2,
        expected_input_revision: 1,
        payload: {},
      },
      expect.any(String),
      expect.anything(),
    )
    for (const child of children) {
      expect(child!.textContent).toContain('已跳过 · 未判断对错')
      expect(child!.textContent).not.toContain('✓')
    }
  })

  it('PROG-007/023 renders an honest with_skips final state and never exposes full TutoringTips', async () => {
    const questions = [
      recognizedQuestion('problem-1', '一. 1', ['一', '1']),
      recognizedQuestion('problem-2', '一. 2', ['一', '2']),
      recognizedQuestion('problem-3-1', '三、1', ['三', '1']),
      recognizedQuestion('problem-3-2', '三、2', ['三', '2']),
    ]
    const problems = [
      problemProgress('problem-1', '一. 1', ['一', '1']),
      problemProgress('problem-2', '一. 2', ['一', '2']),
      problemProgress('problem-3-1', '三、1', ['三', '1'], {
        operation_state: 'skipped',
        disposition_state: 'skipped_by_parent',
        result_projection: null,
      }),
      problemProgress('problem-3-2', '三、2', ['三', '2'], {
        operation_state: 'skipped',
        disposition_state: 'skipped_by_parent',
        result_projection: null,
      }),
    ]
    const artifact = {
      artifact_id: 'artifact-with-skips',
      artifact_digest: 'sha256:canonical-with-skips',
      kind: 'completed_homework',
      title: '整页批改完成 · 有 2 题跳过',
      coverage: { state: 'with_skips', total: 4, processed: 2, skipped: 2 },
    }
    const snapshot = imageTaskDispatch({
      questions,
      problems,
      coverage: { state: 'with_skips', total: 4, processed: 2, skipped: 2 },
      stage: 'completed',
      finalArtifact: artifact,
    })
    const wrapper = await renderTask(snapshot, {
      completedResult: completedResult(questions.slice(0, 2)),
    })

    const shell = wrapper.get('[data-testid="recognize-guard"]')
    expect(shell.text()).toContain('处理完成 · 有跳过')
    expect(shell.text()).toContain('整页批改完成 · 有 2 题跳过')
    expect(shell.text()).toContain('共 4 题 · 已处理 2 题 · 2 题由家长跳过')
    expect(shell.text()).toContain('本次有 2 题跳过，未生成完整辅导要点。')
    expect(shell.find('[data-testid="tutoring-tips"]').exists()).toBe(false)
    expect(h.tutoringTips).not.toHaveBeenCalled()

    for (const label of ['三、1', '三、2']) {
      const skipped = shell.element.querySelector<HTMLElement>(
        `[data-problem-id="${label === '三、1' ? 'problem-3-1' : 'problem-3-2'}"]`,
      )
      expect(skipped?.textContent).toContain('已跳过 · 未判断对错')
      expect(skipped?.textContent).not.toContain('✓')
    }
  })

  it('PROG-016/025 keeps print, PDF and formal IM absent for partial state and inside the same TaskShell for final only', async () => {
    const questions = [
      recognizedQuestion('problem-1', '一. 1', ['一', '1']),
      recognizedQuestion('problem-2', '一. 2', ['一', '2']),
    ]
    const partial = await renderTask(
      imageTaskDispatch({
        questions,
        problems: [
          problemProgress('problem-1', '一. 1', ['一', '1']),
          problemProgress('problem-2', '一. 2', ['一', '2'], {
            operation_state: 'assessing',
            disposition_state: 'open',
            result_projection: null,
            published_revision: 0,
          }),
        ],
      }),
    )
    const partialShell = partial.get('[data-testid="recognize-guard"]').element
    for (const action of ['打印', '导出 PDF', '发送到手机']) {
      expect(
        buttonByName(partialShell, action),
        `${action} must not consume partial results`,
      ).toBeNull()
    }
    partial.unmount()

    const finalArtifact = {
      artifact_id: 'artifact-final-only',
      artifact_digest: 'sha256:canonical-final-only',
      kind: 'completed_homework',
      title: '整页批改完成',
      coverage: { state: 'full', total: 2, processed: 2, skipped: 0 },
    }
    const final = await renderTask(
      imageTaskDispatch({
        questions,
        problems: [
          problemProgress('problem-1', '一. 1', ['一', '1']),
          problemProgress('problem-2', '一. 2', ['一', '2']),
        ],
        coverage: { state: 'full', total: 2, processed: 2, skipped: 0 },
        stage: 'completed',
        finalArtifact,
      }),
      { completedResult: completedResult(questions) },
    )

    expect(final.findAll('[data-testid="recognize-guard"]')).toHaveLength(1)
    const finalShell = final.get('[data-testid="recognize-guard"]').element
    const tutoringTips = final.get('[data-testid="tutoring-tips"]')
    expect(
      tutoringTips.get<HTMLButtonElement>('[data-testid="tutoring-tips-send"]').element.disabled,
    ).toBe(false)
    for (const action of ['打印', '导出 PDF']) {
      const button = buttonByName(finalShell, action)
      expect(
        button,
        `${action} must be exposed only by the final canonical artifact`,
      ).not.toBeNull()
      expect(button!.disabled).toBe(false)
      expect(button!.closest('[data-testid="recognize-guard"]')).toBe(finalShell)
    }
    const sendButtons = Array.from(finalShell.querySelectorAll('button')).filter(
      (button) => button.textContent?.trim() === '发送到手机',
    )
    expect(sendButtons).toHaveLength(1)
    expect(sendButtons[0]).toBe(
      tutoringTips.get<HTMLButtonElement>('[data-testid="tutoring-tips-send"]').element,
    )
    expect(final.get('[data-testid="final-artifact-actions"]').text()).not.toContain('发送到手机')
  })
})
