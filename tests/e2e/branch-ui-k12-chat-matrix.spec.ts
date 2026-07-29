import { expect, test, type Browser, type Page, type Route, type TestInfo } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const REFERENCE_URL =
  process.env.HEX_UI_REFERENCE_URL?.trim() || 'http://127.0.0.1:16070/app.html'
const CURRENT_SOURCE_URL =
  process.env.HEX_UI_IMPLEMENTATION_URL?.trim() || 'http://127.0.0.1:16061'
const AGENT = 'k12-chat-matrix-ming'
const SESSION = 'k12-chat-matrix-session'
const MESSAGE = 'k12-chat-matrix-message'
const DISPATCH = 'k12-chat-matrix-dispatch'
const NOW = '2026-07-29T11:32:00+08:00'
const EVIDENCE_ROOT = path.resolve('test-results/branch-ui-fidelity/evidence/k12-chat-matrix')
const PIXEL_DIFF_TOOL = path.resolve('tests/e2e/tools/visual_pixel_diff.py')
const PIXEL_THRESHOLD = 8

test.use({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  colorScheme: 'light',
  reducedMotion: 'reduce',
})

type ReferenceMode =
  | 'empty'
  | 'entry'
  | 'progress'
  | 'failure'
  | 'recognized-tips'
  | 'photo-grade'
  | 'blank-worksheet'
  | 'artwork-processing'
  | 'artwork-result'
  | 'unrendered-writing'

type ImplementationMode =
  | 'empty'
  | 'routing'
  | 'homework-confirmation'
  | 'homework-processing'
  | 'homework-failure'
  | 'homework-tips'
  | 'homework-completed'
  | 'blank-worksheet'
  | 'writing-conflict'
  | 'writing-processing'
  | 'writing-result'
  | 'artwork-processing'
  | 'artwork-result'

type EvidenceClassification = 'COMPARABLE' | 'NOT_COMPARABLE'

interface MatrixState {
  name: string
  title: string
  referenceMode: ReferenceMode
  implementationMode: ImplementationMode
  classification: EvidenceClassification
  reason: string
  referenceSelector?: string
  implementationSelector?: string
}

interface PixelDiffReport {
  width: number
  height: number
  threshold: number
  changed_pixels: number
  total_pixels: number
  changed_pixel_ratio: number
  changed_bbox: [number, number, number, number] | null
}

const questions = [
  {
    problem_id: 'problem-1',
    problem_kind: 'standalone',
    page_asset_id: 'asset://chat-matrix/page-1.png',
    source_number_path: ['一', '1'],
    display_label: '一、1',
    question: '4 ÷ 0.5 = 8',
    raw_transcription: '4 ÷ 0.5 = 8',
    canonical_markdown: '4 \\div 0.5 = 8',
    canonical_valid: true,
    canonical_version: 1,
    knowledge_points: ['小数除法'],
    answer_state: 'present',
    student_answer: '8',
    answer_canonical_valid: true,
    confirmation_required: false,
    confirmed_version: 1,
    bbox: { x: 0.12, y: 0.13, w: 0.55, h: 0.09 },
  },
  {
    problem_id: 'problem-2',
    problem_kind: 'standalone',
    page_asset_id: 'asset://chat-matrix/page-1.png',
    source_number_path: ['一', '2'],
    display_label: '一、2',
    question: '10 × 0.01 = 0.1',
    raw_transcription: '10 × 0.01 = 0.1',
    canonical_markdown: '10 \\times 0.01 = 0.1',
    canonical_valid: true,
    canonical_version: 1,
    knowledge_points: ['小数乘法'],
    answer_state: 'present',
    student_answer: '0.1',
    answer_canonical_valid: true,
    confirmation_required: true,
    confirmation_reasons: ['decimal_point'],
    confirmed_version: 0,
    bbox: { x: 0.12, y: 0.26, w: 0.55, h: 0.09 },
  },
]

const problemProgress = [
  {
    problem_id: 'problem-1',
    source_number_path: ['一', '1'],
    display_label: '一、1',
    source_state: 'ready',
    anchor_state: 'located',
    operation_state: 'completed',
    disposition_state: 'result',
    result_projection: null,
    published_revision: 1,
    input_revision: 1,
    command_available: true,
  },
  {
    problem_id: 'problem-2',
    source_number_path: ['一', '2'],
    display_label: '一、2',
    source_state: 'awaiting_resolution',
    anchor_state: 'located',
    operation_state: 'prepared',
    disposition_state: 'open',
    result_projection: null,
    published_revision: 0,
    input_revision: 1,
    command_available: true,
  },
]

const matrices: MatrixState[] = [
  {
    name: '01-header-three-tabs',
    title: '辅导助手身份与三 Tab',
    referenceMode: 'empty',
    implementationMode: 'empty',
    classification: 'COMPARABLE',
    reason: '同一孩子、年级和「辅导/学习档案/学情」三段身份头，可直接比较。',
    referenceSelector: '#chatTutorView .chat-top.k12hd',
    implementationSelector: '.k12enh-tabs',
  },
  {
    name: '02-tutor-empty-and-task-entry',
    title: '辅导空会话与图片任务入口',
    referenceMode: 'entry',
    implementationMode: 'empty',
    classification: 'NOT_COMPARABLE',
    reason:
      '原型只提供带演示照片消息且处于 operation lock 的静态会话，没有可切换的真实空会话 fixture；实现为空会话 composer。',
  },
  {
    name: '03-image-routing',
    title: '图片意图识别处理中',
    referenceMode: 'artwork-processing',
    implementationMode: 'routing',
    classification: 'NOT_COMPARABLE',
    reason:
      '原型 artwork 模拟会在定时器中立即进入已识别作品，缺少可冻结的 unknown/routing 权威画面。',
    implementationSelector: '[data-testid="image-task-routing-progress"]',
  },
  {
    name: '04-homework-recognition-confirmation',
    title: '识题确认与 OCR 高风险片段',
    referenceMode: 'progress',
    implementationMode: 'homework-confirmation',
    classification: 'NOT_COMPARABLE',
    reason:
      '原型静态任务为 4 题渐进题源冲突；实现 fixture 为 2 题小数点确认，事实集不相同，禁止把像素比判为 PASS。',
    referenceSelector: '[data-k12-task-shell]',
    implementationSelector: '[data-testid="recognize-guard"]',
  },
  {
    name: '05-homework-progress-and-source-resolver',
    title: '逐题处理中与题源处理',
    referenceMode: 'progress',
    implementationMode: 'homework-processing',
    classification: 'NOT_COMPARABLE',
    reason:
      '两侧均为同类渐进处理语义，但原型 4 题/题组与实现 2 题 fixture 不同，像素差只作漂移定位。',
    referenceSelector: '.k12-source-issue-resolver',
    implementationSelector: '[data-testid="recognize-pipeline"]',
  },
  {
    name: '06-homework-failed-retryable',
    title: '作业阶段可重试失败',
    referenceMode: 'failure',
    implementationMode: 'homework-failure',
    classification: 'NOT_COMPARABLE',
    reason:
      '失败语义可达，但原型失败是静态演示切换、实现来自服务端 retryable 投影，题目 fixture 不同。',
    referenceSelector: '#k12StageError',
    implementationSelector: '[data-testid="recognize-stage-error"]',
  },
  {
    name: '07-tutoring-tips-inline',
    title: '识题确认后的内联辅导要点',
    referenceMode: 'recognized-tips',
    implementationMode: 'homework-tips',
    classification: 'NOT_COMPARABLE',
    reason:
      '原型辅导要点绑定 3 道简易方程演示；实现完成态绑定 2 道小数题，来源段落可比但事实不完全相同。',
    referenceSelector: '#k12-recognized .guide',
    implementationSelector: '[data-testid="tutoring-tips"]',
  },
  {
    name: '08-photo-grade-result',
    title: '已作答作业原图批改结果',
    referenceMode: 'photo-grade',
    implementationMode: 'homework-completed',
    classification: 'NOT_COMPARABLE',
    reason:
      '原型批改结果是 3 题练习册 P52；实现 fixture 是 2 题，不能建立同 fixture 的逐像素通过结论。',
    referenceSelector: '#k12-batch .grade-result',
    implementationSelector: '[data-testid="photo-grade-overlay"]',
  },
  {
    name: '09-final-artifact-actions',
    title: '最终产物与打印/PDF/发送动作',
    referenceMode: 'photo-grade',
    implementationMode: 'homework-completed',
    classification: 'NOT_COMPARABLE',
    reason:
      '两侧动作 exact-set 可观察，但最终产物内容和题目 fixture 不同；只记录结构与样式证据。',
    referenceSelector: '#k12-batch .grade-result__actions',
    implementationSelector: '[data-testid="image-task-final-artifact"]',
  },
  {
    name: '10-blank-worksheet-parent-guide',
    title: '空白卷家长讲题指南',
    referenceMode: 'blank-worksheet',
    implementationMode: 'blank-worksheet',
    classification: 'COMPARABLE',
    reason: '两侧都使用 4.5×2 与 15−5.7 的同题、同顺序、同七项家长指南 fixture。',
    referenceSelector: '[data-parent-teaching-guide]',
    implementationSelector: '[data-testid="blank-worksheet-parent-guide"]',
  },
  {
    name: '11-writing-ocr-conflict',
    title: '作文 OCR 最小冲突确认',
    referenceMode: 'unrendered-writing',
    implementationMode: 'writing-conflict',
    classification: 'NOT_COMPARABLE',
    reason:
      '原型只有 data-writing-confirmation 契约声明，没有可渲染的作文 OCR 冲突权威实例；实现状态可达，参考侧不可构造。',
    implementationSelector: '[data-testid="creative-conflict-guard"]',
  },
  {
    name: '12-writing-feedback-processing',
    title: '作文点评处理中',
    referenceMode: 'unrendered-writing',
    implementationMode: 'writing-processing',
    classification: 'NOT_COMPARABLE',
    reason:
      '原型只有写作 result-surface 声明，没有可冻结的写作点评处理中画面。',
    implementationSelector: '[data-testid="writing-feedback-progress"]',
  },
  {
    name: '13-writing-feedback-result',
    title: '作文点评最终结果',
    referenceMode: 'unrendered-writing',
    implementationMode: 'writing-result',
    classification: 'NOT_COMPARABLE',
    reason:
      '原型没有会话内可渲染写作点评结果，只声明 writing-feedback；不得用作品档案页替代。',
    implementationSelector: '[data-testid="writing-result-surface"]',
  },
  {
    name: '14-artwork-feedback-processing',
    title: '美术作品点评处理中',
    referenceMode: 'artwork-processing',
    implementationMode: 'artwork-processing',
    classification: 'COMPARABLE',
    reason: '两侧均为「已识别出：美术作品 · 正在生成作品点评」同一公开状态。',
    referenceSelector: '[data-artwork-review-output]',
    implementationSelector: '[data-testid="artwork-feedback-progress"]',
  },
  {
    name: '15-artwork-feedback-result',
    title: '美术作品点评最终结果',
    referenceMode: 'artwork-result',
    implementationMode: 'artwork-result',
    classification: 'NOT_COMPARABLE',
    reason:
      '两侧均有五段作品点评，但原型定时器 fixture 与实现 API fixture 的可见证据正文不完全相同。',
    referenceSelector: '[data-artwork-review-output]',
    implementationSelector: '[data-testid="artwork-result-surface"]',
  },
]

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function homeworkDispatch(
  stage: string,
  options: {
    confirmation?: 'pending' | 'confirmed'
    status?: 'routing' | 'awaiting_confirmation' | 'routed' | 'failed'
    retryable?: boolean
    final?: boolean
  } = {},
) {
  const final = options.final === true
  return {
    dispatch_id: DISPATCH,
    task_intent: 'completed_homework',
    status: options.status ?? 'routed',
    provider_display_name: 'HexClaw-GPT',
    model_id: 'gpt-5.6-sol',
    retryable: options.retryable ?? false,
    automatic_budget_seconds: 300,
    automatic_started_at: 1785295800,
    automatic_deadline_at: 1785296100,
    automatic_remaining_seconds: final ? 0 : 258,
    operation_deadline_at: 1785296400,
    intent_evidence: ['answer_regions_present'],
    intent_confidence: 0.99,
    confirmation_candidates: [],
    target: { type: 'homework_submission', id: 'submission-chat-matrix' },
    target_projection: {
      kind: 'homework',
      stage,
      confirmation_state: options.confirmation ?? (final ? 'confirmed' : 'pending'),
      anchor_state: 'located',
      recognition: { questions, subject: '数学' },
      structure_version: 2,
      problems: final
        ? problemProgress.map((problem) => ({
            ...problem,
            source_state: 'ready',
            operation_state: 'completed',
            disposition_state: 'result',
            published_revision: 1,
          }))
        : problemProgress,
      coverage: final
        ? { state: 'full', total: 2, processed: 2, skipped: 0 }
        : { state: 'incomplete', total: 2, processed: 1, skipped: 0 },
      projection_revision: 8,
      final_artifact: final
        ? {
            artifact_id: 'artifact-chat-matrix',
            agent_name: AGENT,
            job_id: 'job-chat-matrix',
            structure_version: 2,
            coverage_status: 'complete',
            total_count: 2,
            published_count: 2,
            skipped_count: 0,
            ordered_current_digests_json: '["sha256:p1","sha256:p2"]',
            canonical_markdown: '# 整页批改完成\n\n共 2 题。',
            artifact_digest: 'sha256:artifact-chat-matrix',
            summary_invocation_id: 'invocation-chat-matrix',
            title: '整页批改完成',
            created_at: 1785295900,
            updated_at: 1785295901,
          }
        : null,
    },
    progress: { operation: 'homework', state: stage },
    version: 8,
    created_at: 1785295800,
    updated_at: final ? 1785295901 : 1785295842,
  }
}

function homeworkTipsDispatch() {
  return {
    ...homeworkDispatch('completed', { final: true }),
    target_projection: {
      kind: 'homework',
      stage: 'completed',
      confirmation_state: 'confirmed',
      anchor_state: 'located',
      recognition: { questions, subject: '数学' },
    },
  }
}

function blankWorksheetDispatch() {
  return {
    dispatch_id: DISPATCH,
    task_intent: 'blank_worksheet',
    status: 'routed',
    provider_display_name: 'HexClaw-GPT',
    model_id: 'gpt-5.6-sol',
    intent_evidence: ['no_answer_regions'],
    intent_confidence: 0.99,
    confirmation_candidates: [],
    target: { type: 'homework_submission', id: 'submission-blank-matrix' },
    target_projection: {
      kind: 'homework',
      stage: 'completed',
      confirmation_state: 'confirmed',
      anchor_state: 'located',
      recognition: {
        subject: '数学',
        questions: [
          {
            problem_id: 'blank-1',
            problem_kind: 'standalone',
            page_asset_id: 'asset://chat-matrix/blank.png',
            question: '4.5 × 2',
            raw_transcription: '4.5 × 2',
            canonical_markdown: '4.5 \\times 2',
            canonical_valid: true,
            canonical_version: 1,
            knowledge_points: ['小数乘法'],
            student_answer: '',
            answer_canonical_valid: true,
            answer_state: 'blank',
            confirmation_required: false,
            confirmed_version: 1,
          },
          {
            problem_id: 'blank-2',
            problem_kind: 'standalone',
            page_asset_id: 'asset://chat-matrix/blank.png',
            question: '15 − 5.7',
            raw_transcription: '15 − 5.7',
            canonical_markdown: '15 - 5.7',
            canonical_valid: true,
            canonical_version: 1,
            knowledge_points: ['小数减法'],
            student_answer: '',
            answer_canonical_valid: true,
            answer_state: 'blank',
            confirmation_required: false,
            confirmed_version: 1,
          },
        ],
      },
    },
    progress: { operation: 'homework', state: 'completed' },
    version: 3,
    created_at: 1785295800,
    updated_at: 1785295901,
  }
}

function creativeDispatch(
  intent: 'writing' | 'artwork',
  state: 'awaiting_confirmation' | 'feedback_pending' | 'feedback_ready',
) {
  const writing = intent === 'writing'
  return {
    dispatch_id: DISPATCH,
    task_intent: intent,
    status: 'routed',
    provider_display_name: 'HexClaw-GPT',
    model_id: 'gpt-5.6-sol',
    intent_evidence: [writing ? 'long_form_handwriting' : 'artwork_visual_evidence'],
    intent_confidence: 0.99,
    confirmation_candidates: [],
    target: { type: 'creative_work_intake', id: 'intake-chat-matrix' },
    target_projection: {
      kind: 'creative',
      intake_id: 'intake-chat-matrix',
      work_type: writing ? 'writing' : 'art',
      status: state === 'awaiting_confirmation' ? 'awaiting_confirmation' : 'promoted',
      ...(state === 'awaiting_confirmation'
        ? {
            canonical_version: 7,
            canonical_content: '我的好爸色',
            conflicts: [
              {
                segment_id: 'segment-1',
                raw_text: '爸色',
                canonical_text: '爸色',
                reason: 'low_confidence',
              },
            ],
          }
        : {
            work: {
              work_id: writing ? 'work-writing-matrix' : 'work-art-matrix',
              display_name: writing ? '《我的好爸爸》' : '《雨后的校园》',
            },
          }),
    },
    progress:
      state === 'awaiting_confirmation'
        ? { operation: 'writing_ocr', state: 'awaiting_confirmation' }
        : { operation: 'promotion', state },
    version: 4,
    created_at: 1785295800,
    updated_at: 1785295901,
  }
}

function dispatchFor(mode: ImplementationMode) {
  if (mode === 'routing') {
    return {
      dispatch_id: DISPATCH,
      task_intent: 'unknown',
      status: 'routing',
      provider_display_name: 'HexClaw-GPT',
      model_id: 'gpt-5.6-sol',
      intent_evidence: [],
      intent_confidence: 0,
      confirmation_candidates: [],
      progress: { operation: 'classification', state: 'routing' },
      version: 1,
      created_at: 1785295800,
      updated_at: 1785295800,
    }
  }
  if (mode === 'homework-confirmation') {
    return homeworkDispatch('awaiting_confirmation', {
      status: 'awaiting_confirmation',
      confirmation: 'pending',
    })
  }
  if (mode === 'homework-processing') {
    return homeworkDispatch('assessing', { confirmation: 'confirmed' })
  }
  if (mode === 'homework-failure') {
    return homeworkDispatch('failed_retryable', {
      status: 'failed',
      confirmation: 'confirmed',
      retryable: true,
    })
  }
  if (mode === 'homework-tips') return homeworkTipsDispatch()
  if (mode === 'homework-completed') return homeworkDispatch('completed', { final: true })
  if (mode === 'blank-worksheet') return blankWorksheetDispatch()
  if (mode === 'writing-conflict') return creativeDispatch('writing', 'awaiting_confirmation')
  if (mode === 'writing-processing') return creativeDispatch('writing', 'feedback_pending')
  if (mode === 'writing-result') return creativeDispatch('writing', 'feedback_ready')
  if (mode === 'artwork-processing') return creativeDispatch('artwork', 'feedback_pending')
  if (mode === 'artwork-result') return creativeDispatch('artwork', 'feedback_ready')
  return null
}

function completedHomeworkResult() {
  return {
    dispatch_id: DISPATCH,
    task_intent: 'completed_homework',
    status: 'routed',
    result: {
      kind: 'completed_homework',
      payload: {
        mode: 'grade',
        task_intent: 'completed_homework',
        result_surface: 'annotated_homework',
        items: questions.map((question, index) => ({
          question,
          status: index === 0 ? 'correct' : 'wrong',
          result_kind: 'assessment',
          grade: {
            solution: index === 0 ? '8' : '0.1',
            verdict: index === 0 ? 'agree' : 'disagree',
            evidence_type: 'numeric_exec',
            badge: 'verified-strong',
            out_of_scope: false,
            record_created: index === 1,
            solve_only: false,
            ...(index === 1
              ? {
                  wrong_step: '小数点位置需要重新核对。',
                  error_cause: '小数位数判断错误。',
                }
              : {}),
          },
          ...(index === 1
            ? {
                parent_guide: {
                  answer: '0.1',
                  full_solution_steps: ['先把 0.01 看作百分之一。'],
                  grade_level_method: '按小数乘法位值理解。',
                  likely_mistakes: ['漏写小数点。'],
                  parent_teaching_sequence: ['让孩子先说 10 个百分之一是多少。'],
                  follow_up_questions: ['100 × 0.01 等于多少？'],
                  checking_method: '用 0.1 ÷ 10 反算。',
                },
              }
            : {}),
        })),
        markdown: '# 批改完成',
        image_warning: '',
        annotated_image: {
          mime: 'image/png',
          data_base64:
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgQIAHJDzWQAAAABJRU5ErkJggg==',
          digest: 'sha256:annotated-chat-matrix',
        },
      },
    },
  }
}

function blankWorksheetResult() {
  const guide = (
    answer: string,
    steps: string[],
    method: string,
    mistake: string,
    parent: string,
    follow: string,
    checking: string,
  ) => ({
    answer,
    full_solution_steps: steps,
    grade_level_method: method,
    likely_mistakes: [mistake],
    parent_teaching_sequence: [parent],
    follow_up_questions: [follow],
    checking_method: checking,
  })
  return {
    dispatch_id: DISPATCH,
    task_intent: 'blank_worksheet',
    status: 'routed',
    result: {
      kind: 'blank_worksheet',
      payload: {
        mode: 'solve',
        task_intent: 'blank_worksheet',
        result_surface: 'parent_teaching_guide',
        items: [
          {
            question: blankWorksheetDispatch().target_projection.recognition.questions[0],
            status: 'blank_solved',
            result_kind: 'parent_teaching_guide',
            parent_guide: guide(
              '9',
              ['先算 45 × 2 = 90', '按一个小数位点回小数点，得到 9'],
              '先按整数乘法算，再数小数位。',
              '忘记点回小数点。',
              '先让孩子算 45 × 2，再自己点小数点。',
              '0.45 × 2 的小数点应放在哪里？',
              '用 9 ÷ 2 反算。',
            ),
          },
          {
            question: blankWorksheetDispatch().target_projection.recognition.questions[1],
            status: 'blank_solved',
            result_kind: 'parent_teaching_guide',
            parent_guide: guide(
              '9.3',
              ['把 15 写成 15.0', '小数点对齐后计算 15.0 − 5.7 = 9.3'],
              '小数加减法先对齐小数点。',
              '把最右边数字对齐。',
              '先问 15 可以怎样写成小数，再对齐小数点。',
              '为什么要对齐小数点？',
              '用 9.3 + 5.7 反算。',
            ),
          },
        ],
        markdown: '',
        image_warning: '',
      },
    },
  }
}

function creativeResult(intent: 'writing' | 'artwork') {
  const writing = intent === 'writing'
  const markdown = writing
    ? '## 可见证据\n\n- 文章围绕爸爸展开。\n\n## 先这样肯定\n\n主题清楚。\n\n## 家长可以这样问或讲\n\n可以问最想保留哪一句。\n\n## 下一次只试一个点\n\n补充一个具体细节。\n\n## 说明\n\n只依据当前原稿。'
    : '## 可见证据\n\n- 主体位于画面中央。\n\n## 先这样肯定\n\n主体安排清楚。\n\n## 家长可以这样问或讲\n\n可以问最想保留哪一处。\n\n## 下一次只试一个点\n\n加强明暗差别。\n\n## 说明\n\n只依据当前图片。'
  return {
    dispatch_id: DISPATCH,
    task_intent: intent,
    status: 'routed',
    result: {
      kind: intent,
      payload: {
        intake: { intake_id: 'intake-chat-matrix', status: 'promoted' },
        work: {
          work_id: writing ? 'work-writing-matrix' : 'work-art-matrix',
          display_name: writing ? '《我的好爸爸》' : '《雨后的校园》',
        },
        feedback: {
          generation_id: `generation-${intent}-matrix`,
          structured_feedback: {
            feedback_id: `feedback-${intent}-matrix`,
            version_id: `version-${intent}-matrix`,
            feedback_type: writing ? 'writing' : 'art',
            evidence_refs: ['asset-ref:sha256:chat-matrix'],
            observations: [
              {
                dimension: writing ? '主题' : '构图',
                evidence: writing ? '文章围绕爸爸展开。' : '主体位于画面中央。',
              },
            ],
            source_snapshot: {
              source: 'ai',
              method_ref: `${intent}-feedback@1.0.0`,
              capability: `${intent}_feedback`,
            },
            limitations: writing ? '只依据当前原稿。' : '只依据当前图片。',
            suggestions: writing
              ? ['主题清楚。', '可以问最想保留哪一句。', '补充一个具体细节。']
              : ['主体安排清楚。', '可以问最想保留哪一处。', '加强明暗差别。'],
            projection_markdown: markdown,
          },
          projection_markdown: markdown,
        },
      },
    },
  }
}

function resultFor(mode: ImplementationMode) {
  if (mode === 'homework-completed' || mode === 'homework-tips') {
    return completedHomeworkResult()
  }
  if (mode === 'blank-worksheet') return blankWorksheetResult()
  if (mode === 'writing-result') return creativeResult('writing')
  if (mode === 'artwork-result') return creativeResult('artwork')
  return null
}

async function installCurrentSourceFixture(page: Page, mode: ImplementationMode) {
  const hasTask = mode !== 'empty'
  const dispatch = dispatchFor(mode)
  const result = resultFor(mode)
  await page.addInitScript(
    ({ agent, session, message, dispatchId, bindTask }) => {
      localStorage.clear()
      sessionStorage.clear()
      localStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      sessionStorage.setItem('hexclaw:welcomeRedirectDone', '1')
      localStorage.setItem('hexclaw_lastSessionId', session)
      localStorage.setItem('hexclaw_sessionAgents', JSON.stringify({ [session]: agent }))
      localStorage.setItem('hc-theme', 'light')
      if (bindTask) {
        localStorage.setItem(
          'hexclaw.k12.image-task-bindings.v2',
          JSON.stringify({
            version: 2,
            bindings: [
              {
                source_session_id: session,
                agent_id: agent,
                source_message_id: message,
                dispatch_id: dispatchId,
              },
            ],
          }),
        )
      }
    },
    { agent: AGENT, session: SESSION, message: MESSAGE, dispatchId: DISPATCH, bindTask: hasTask },
  )

  await page.route('http://localhost:11434/**', (route) =>
    json(route, { models: [], version: 'k12-chat-matrix' }),
  )
  await page.route('**/_hexclaw/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const apiPath = url.pathname.replace(/^\/_hexclaw/, '')
    const method = request.method()

    if (apiPath === '/api/v1/config' && method === 'GET') {
      return json(route, {
        general: { language: 'zh-CN', welcomeCompleted: true },
        knowledge: { enabled: true },
        llm: { default: '', providers: {}, routing: { enabled: false }, cache: {} },
      })
    }
    if (apiPath === '/api/v1/config/llm' && method === 'GET') {
      return json(route, {
        default: '',
        providers: {},
        routing: { enabled: false },
        cache: { enabled: false },
      })
    }
    if (apiPath === '/api/v1/ollama/status') {
      return json(route, { running: false, associated: false, models: [] })
    }
    if (apiPath === '/api/v1/agents' && method === 'GET') {
      return json(route, {
        agents: [
          {
            name: AGENT,
            display_name: '小明的辅导助手',
            description: '五年级下 · 各学科教材独立绑定',
            provider: '',
            model: '',
            metadata: {
              scenario: 'k12-tutor',
              avatar: '🎓',
              'k12.child_name': '小明',
              'k12.learner_id': 'learner-chat-matrix',
              'k12.grade_term': '五年级下',
              'k12.textbook_edition': '人教版',
              'k12.textbook_edition.math': '人教版',
            },
          },
        ],
        total: 1,
        default: AGENT,
      })
    }
    if (apiPath === '/api/v1/agents/rules') return json(route, { rules: [], total: 0 })
    if (apiPath === '/api/v1/roles') return json(route, { roles: [], total: 0 })
    if (apiPath === '/api/v1/skills') return json(route, { skills: [], total: 0 })
    if (apiPath === '/api/v1/streams/active') return json(route, { streams: [], total: 0 })
    if (apiPath === '/api/v1/sessions' && method === 'GET') {
      return json(route, {
        sessions: [
          {
            id: SESSION,
            title: '小明的辅导助手',
            agent_id: AGENT,
            created_at: NOW,
            updated_at: NOW,
            message_count: hasTask ? 1 : 0,
          },
        ],
        total: 1,
      })
    }
    if (apiPath === `/api/v1/sessions/${SESSION}/messages`) {
      return json(route, {
        messages: hasTask
          ? [
              {
                id: MESSAGE,
                role: 'user',
                content: '请处理这张作业或作品图片',
                timestamp: NOW,
                created_at: NOW,
              },
            ]
          : [],
        total: hasTask ? 1 : 0,
      })
    }
    if (apiPath === `/api/v1/sessions/${SESSION}/artifacts`) {
      return json(route, { artifacts: [], total: 0 })
    }
    if (apiPath === '/api/k12/view-descriptor') {
      return json(route, {
        header_tabs: ['辅导', '学习档案', '学情'],
        message_badges: [],
        composer_placeholder: '',
        composer_chips: ['自动识别学科', '渐进提示', '识题校验'],
        record_collections: [],
        side_panels: [],
        actions: [],
        i18n_keys: [],
        schema_version: 1,
      })
    }
    if (apiPath === `/api/k12/image-tasks/${DISPATCH}` && method === 'GET' && dispatch) {
      return json(route, { dispatch })
    }
    if (apiPath === `/api/k12/image-tasks/${DISPATCH}/result` && method === 'GET' && result) {
      return json(route, result)
    }
    if (apiPath === '/api/k12/tutoring-tips' && method === 'POST') {
      return json(route, {
        knowledge_points: ['小数乘法'],
        sections: [
          {
            title: '这页在练什么',
            content: '这页练习小数乘除法，先看清小数点。',
            source_label: '📖 依据课本',
          },
          {
            title: '小明要留意',
            content: '上次在小数点位置上出现过一次错误。',
            source_label: '🧠 学情信号',
          },
          {
            title: '每道题怎么带',
            content: '先让孩子说出每个数位表示什么，不直接给答案。',
            source_label: '🤖 AI 归纳·供参考',
          },
        ],
      })
    }
    if (apiPath === '/api/k12/insight-report' && method === 'GET') {
      return json(route, {
        trend: { total: 0, mastered: 0, reviewing: 0, retried: 0, archived: 0 },
        weak_top3: [],
        consecutive_fail_kps: [],
        month_new_mistakes: 0,
        review_completion_rate: -1,
        suggestion: '',
      })
    }
    if (apiPath === '/api/k12/study-time' && method === 'GET') {
      return json(route, { days: [], total_records: 0, total_minutes: 0, note: '' })
    }
    if (apiPath === '/api/k12/curriculum-progress' && method === 'GET') {
      return json(route, {
        progress: {
          progress_id: 'progress-chat-matrix',
          agent: AGENT,
          subject: 'math',
          revision: 1,
          textbook_binding_id: 'pep-5b',
          textbook_edition: '人教版',
          textbook_version: '2022',
          title: '义务教育教科书数学',
          volume: '五年级下册',
          unit_id: 'unit-4',
          unit_title: '第4单元「分数的意义和性质」',
          verified_page_from: 45,
          verified_page_to: 62,
          page_verification_status: 'verified',
          segment_refs: ['segment-45-62'],
          evidence_source: 'parent_confirmed',
          confirmed_at: NOW,
          created_at: NOW,
          updated_at: NOW,
        },
      })
    }
    if (apiPath === '/api/k12/weekly-practice/settings' && method === 'GET') {
      return json(route, {
        agent: AGENT,
        revision: 1,
        timezone: 'Asia/Shanghai',
        due_review_enabled: true,
        textbook_consolidation_enabled: false,
        textbook_consolidation_tier: 'standard',
        arithmetic_warmup_enabled: false,
        arithmetic_minutes: 2,
        created_at: NOW,
        updated_at: NOW,
      })
    }
    if (apiPath === '/api/k12/weekly-practice/plans/history' && method === 'GET') {
      return json(route, { items: [], next_cursor: null })
    }
    if (apiPath === '/api/k12/creative-works' && method === 'GET') {
      return json(route, { items: [] })
    }
    if (
      apiPath === '/api/k12/mistakes' ||
      apiPath === '/api/k12/review-queue' ||
      apiPath === '/api/k12/accumulation' ||
      apiPath === '/api/k12/accumulations' ||
      apiPath === '/api/k12/practice-sets'
    ) {
      return json(route, { items: [] })
    }
    if (apiPath.startsWith('/api/k12/')) return json(route, { items: [] })
    if (apiPath.startsWith('/api/v1/')) return json(route, { items: [], total: 0 })
    return json(route, {})
  })
}

async function freezeVisualState(page: Page) {
  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
      html { scroll-behavior: auto !important; }
    `,
  })
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
  })
  await page.mouse.move(1, 1)
}

async function openReference(page: Page, mode: ReferenceMode) {
  await page.goto(REFERENCE_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    const api = window as typeof window & { goK12Learner?: (learner: string) => void }
    api.goK12Learner?.('ming')
  })
  await expect(page.locator('#chatTutorView .chat-top.k12hd')).toBeVisible()
  await page.evaluate((referenceMode) => {
    const thread = document.querySelector<HTMLElement>('#k12ThreadMing')
    if (!thread) return
    document
      .querySelectorAll<HTMLElement>('[data-prototype-only]')
      .forEach((node) => (node.style.display = 'none'))
    for (const child of [...thread.children]) {
      if (child instanceof HTMLElement) child.style.display = 'none'
    }
    const show = (node: Element | null, display = 'block') => {
      if (node instanceof HTMLElement) node.style.display = display
    }
    const children = [...thread.children]

    if (referenceMode === 'entry') {
      show(children[0])
    } else if (
      referenceMode === 'progress' ||
      referenceMode === 'failure' ||
      referenceMode === 'photo-grade'
    ) {
      show(children[0])
      show(children[1])
    } else if (referenceMode === 'recognized-tips') {
      show(document.querySelector('#k12-recognized'))
    } else if (referenceMode === 'blank-worksheet') {
      const template = document.querySelector<HTMLTemplateElement>('#k12BlankWorksheetTemplate')
      const fragment = template?.content.cloneNode(true)
      if (fragment) thread.appendChild(fragment)
    }

    if (referenceMode === 'failure') {
      const api = window as typeof window & { simulateK12StageFailure?: () => void }
      api.simulateK12StageFailure?.()
    }
    if (referenceMode === 'photo-grade') {
      show(document.querySelector('#k12-batch'))
    }
    if (referenceMode === 'artwork-processing' || referenceMode === 'artwork-result') {
      const api = window as typeof window & { startK12ArtworkReview?: () => void }
      api.startK12ArtworkReview?.()
    }
  }, mode)

  if (mode === 'artwork-processing') {
    await page.waitForTimeout(700)
  } else if (mode === 'artwork-result') {
    await page.waitForTimeout(1800)
  }
}

async function openCurrentSource(page: Page, mode: ImplementationMode) {
  await installCurrentSourceFixture(page, mode)
  await page.goto(
    `${CURRENT_SOURCE_URL}/chat?role=${AGENT}&roleTitle=${encodeURIComponent('小明的辅导助手')}`,
    { waitUntil: 'domcontentloaded' },
  )
  await expect(page.locator('.k12enh-tabs')).toBeVisible({ timeout: 20_000 })
  if (mode !== 'empty') {
    await expect(page.getByTestId('recognize-guard')).toBeVisible({ timeout: 20_000 })
  }
}

const geometrySelectors = {
  reference: [
    '.chat-top.k12hd',
    '.k12hd__id',
    '.k12tabs',
    '#k12ViewChat',
    '#k12Thread',
    '#k12ThreadMing > .msg:visible',
    '[data-k12-task-shell]:visible',
    '.k12-pipeline:visible',
    '.k12-source-issue-resolver:visible',
    '#k12-recognized .guide:visible',
    '#k12-batch .grade-result:visible',
    '[data-parent-teaching-guide]:visible',
    '[data-artwork-review-output]:visible',
    '#k12ViewChat > .chat-input',
  ],
  implementation: [
    '.k12enh-tabs',
    '.k12enh-id',
    '.k12enh-seg',
    '#k12-enh-view-chat',
    '.hc-chat__messages',
    '[data-testid="k12-photo-assistant-message"]:visible',
    '[data-testid="recognize-guard"]:visible',
    '[data-testid="recognize-pipeline"]:visible',
    '[data-testid="tutoring-tips"]:visible',
    '[data-testid="photo-grade-overlay"]:visible',
    '[data-testid="blank-worksheet-parent-guide"]:visible',
    '[data-testid="creative-conflict-guard"]:visible',
    '[data-testid$="-feedback-progress"]:visible',
    '[data-testid$="-result-surface"]:visible',
    '[data-testid="image-task-final-artifact"]:visible',
    '.hc-composer',
  ],
} as const

async function collectGeometry(page: Page, selectors: readonly string[]) {
  const output: Record<string, unknown[]> = {}
  for (const selector of selectors) {
    output[selector] = await page.locator(selector).evaluateAll((nodes) =>
      nodes.map((node) => {
        const element = node as HTMLElement
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id,
          className: element.className,
          testId: element.dataset.testid ?? '',
          text: element.innerText.replace(/\s+/g, ' ').trim().slice(0, 360),
          rect: {
            x: Number(rect.x.toFixed(2)),
            y: Number(rect.y.toFixed(2)),
            width: Number(rect.width.toFixed(2)),
            height: Number(rect.height.toFixed(2)),
          },
          style: {
            display: style.display,
            position: style.position,
            boxSizing: style.boxSizing,
            backgroundColor: style.backgroundColor,
            backgroundImage: style.backgroundImage,
            color: style.color,
            border: style.border,
            borderRadius: style.borderRadius,
            boxShadow: style.boxShadow,
            padding: style.padding,
            margin: style.margin,
            gap: style.gap,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            overflowX: style.overflowX,
            overflowY: style.overflowY,
          },
        }
      }),
    )
  }
  return output
}

async function scrollEvidenceIntoView(page: Page, selector?: string) {
  if (!selector) return false
  const locator = page.locator(selector).first()
  const visible = await locator.isVisible().catch(() => false)
  if (visible) {
    await locator.scrollIntoViewIfNeeded()
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  }
  return visible
}

async function captureState(
  browser: Browser,
  state: MatrixState,
  testInfo: TestInfo,
) {
  const project = testInfo.project.name || 'chromium'
  const outputDir = path.join(EVIDENCE_ROOT, project, state.name)
  await mkdir(outputDir, { recursive: true })
  const referencePath = path.join(outputDir, 'reference.png')
  const currentSourcePath = path.join(outputDir, 'current-source.png')
  const diffPath = path.join(outputDir, 'pixel-diff.png')
  const geometryPath = path.join(outputDir, 'geometry-style.json')
  const ratioPath = path.join(outputDir, 'ratio.json')
  const statusPath = path.join(outputDir, 'status.json')

  const referencePage = await browser.newPage()
  const currentSourcePage = await browser.newPage()
  let referenceTargetVisible = false
  let currentSourceTargetVisible = false
  let runtimeError = ''
  try {
    await openReference(referencePage, state.referenceMode)
    await openCurrentSource(currentSourcePage, state.implementationMode)
    if (state.implementationSelector) {
      await currentSourcePage
        .locator(state.implementationSelector)
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
        .catch(() => {})
    }
    await Promise.all([freezeVisualState(referencePage), freezeVisualState(currentSourcePage)])

    referenceTargetVisible = await scrollEvidenceIntoView(
      referencePage,
      state.referenceSelector,
    )
    currentSourceTargetVisible = await scrollEvidenceIntoView(
      currentSourcePage,
      state.implementationSelector,
    )

    const [referenceGeometry, currentSourceGeometry] = await Promise.all([
      collectGeometry(referencePage, geometrySelectors.reference),
      collectGeometry(currentSourcePage, geometrySelectors.implementation),
    ])

    await Promise.all([
      referencePage.screenshot({ path: referencePath, animations: 'disabled' }),
      currentSourcePage.screenshot({ path: currentSourcePath, animations: 'disabled' }),
    ])
    await writeFile(
      geometryPath,
      JSON.stringify(
        {
          viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
          locale: 'zh-CN',
          timezone: 'Asia/Shanghai',
          colorScheme: 'light',
          reference: referenceGeometry,
          currentSource: currentSourceGeometry,
        },
        null,
        2,
      ),
    )
  } catch (cause) {
    runtimeError = cause instanceof Error ? cause.stack || cause.message : String(cause)
    if (!(await referencePage.isClosed())) {
      await referencePage.screenshot({ path: referencePath, animations: 'disabled' }).catch(() => {})
    }
    if (!(await currentSourcePage.isClosed())) {
      await currentSourcePage
        .screenshot({ path: currentSourcePath, animations: 'disabled' })
        .catch(() => {})
    }
  } finally {
    await Promise.all([referencePage.close(), currentSourcePage.close()])
  }

  let diffReport: PixelDiffReport | null = null
  try {
    const { stdout } = await execFileAsync('python3', [
      PIXEL_DIFF_TOOL,
      referencePath,
      currentSourcePath,
      diffPath,
      String(PIXEL_THRESHOLD),
    ])
    diffReport = JSON.parse(stdout.trim()) as PixelDiffReport
    await writeFile(ratioPath, JSON.stringify(diffReport, null, 2))
  } catch (cause) {
    runtimeError ||= cause instanceof Error ? cause.stack || cause.message : String(cause)
    await writeFile(ratioPath, JSON.stringify({ error: runtimeError }, null, 2))
  }

  const missingExpectedSurface =
    (!!state.referenceSelector && !referenceTargetVisible) ||
    (!!state.implementationSelector && !currentSourceTargetVisible)
  const status =
    runtimeError || missingExpectedSurface
      ? 'BLOCKED'
      : state.classification === 'NOT_COMPARABLE'
        ? 'NOT_COMPARABLE'
        : diffReport && diffReport.changed_pixel_ratio <= 0.001
          ? 'MATCH'
          : 'DRIFT'
  await writeFile(
    statusPath,
    JSON.stringify(
      {
        name: state.name,
        title: state.title,
        status,
        classification: state.classification,
        reason: state.reason,
        referenceMode: state.referenceMode,
        currentSourceMode: state.implementationMode,
        expectedSurfaces: {
          reference: state.referenceSelector ?? null,
          currentSource: state.implementationSelector ?? null,
          referenceVisible: referenceTargetVisible,
          currentSourceVisible: currentSourceTargetVisible,
        },
        pixelDiff: diffReport,
        runtimeError: runtimeError || null,
        passClaimAllowed: status === 'MATCH',
      },
      null,
      2,
    ),
  )

  expect
    .soft(runtimeError, `${state.name} evidence capture must not crash; see ${statusPath}`)
    .toBe('')
  expect
    .soft(missingExpectedSurface, `${state.name} expected surface must be visible; see ${statusPath}`)
    .toBe(false)
  expect.soft(diffReport, `${state.name} must emit a pixel ratio; see ${ratioPath}`).not.toBeNull()
}

test.describe('feat/v0.5.0-k12-parent-tutor · K12 chat authoritative state matrix', () => {
  test('captures reference/current-source/diff/geometry for every reachable or explicitly blocked state', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(15 * 60_000)
    for (const state of matrices) {
      await test.step(state.name, async () => {
        await captureState(browser, state, testInfo)
      })
    }
  })
})
