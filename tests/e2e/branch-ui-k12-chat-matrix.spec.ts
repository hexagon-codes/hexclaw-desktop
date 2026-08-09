import { expect, test, type Browser, type Page, type Route, type TestInfo } from '@playwright/test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const REFERENCE_URL = process.env.HEX_UI_REFERENCE_URL?.trim() || 'http://127.0.0.1:16070/app.html'
const CURRENT_SOURCE_URL = process.env.HEX_UI_IMPLEMENTATION_URL?.trim() || 'http://127.0.0.1:16061'
const AGENT = 'k12-chat-matrix-ming'
const SESSION = 'k12-chat-matrix-session'
const MESSAGE = 'k12-chat-matrix-message'
const DISPATCH = 'k12-chat-matrix-dispatch'
const NOW = '2026-07-29T11:32:00+08:00'
const EVIDENCE_ROOT =
  process.env.HEX_UI_EVIDENCE_ROOT?.trim() || `/tmp/hexclaw-k12-chat-evidence-${process.pid}`
const REQUESTED_STATE = process.env.HEX_UI_STATE?.trim() || ''
const PIXEL_DIFF_TOOL = path.resolve('tests/e2e/tools/visual_pixel_diff.py')
const PIXEL_THRESHOLD = 8
const C02_FIXTURE = {
  path:
    process.env.HEX_K12_PHOTO_CLEAR?.trim() ||
    path.resolve(process.cwd(), '../hexclaw-docs/test/k12-test-批改作业.png'),
  sha256: '0c4b1a972319203b1483ffbce43e8835b1367be53edceea23c89368a2f2bc861',
  bytes: 2_178_059,
  width: 1086,
  height: 1448,
} as const
const C02_ASSET_ID = `asset://${AGENT}/${C02_FIXTURE.sha256}.png`

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
  | 'photo-process-issue'
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
  | 'homework-process-issue'
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

const C02_FACTS = [
  ['4 ÷ 0.5', '8', '小数除法'],
  ['10 × 0.01', '0.1', '小数乘法'],
  ['4.7 + 2.3', '7', '小数加法'],
  ['1.8 × 50', '90', '小数乘法'],
  ['3.25 + 0.75', '4', '小数加法'],
  ['5/7 − 1/5', '18/35', '异分母分数减法'],
  ['7 − 5/7', '6 又 2/7', '分数减法'],
  ['0.5 + 1/3', '5/6', '小数与分数加法'],
  ['4/5 + 2/5', '1 又 1/5', '同分母分数加法'],
  ['8.7 × 17.4 − 8.7 × 7.4', '87', '乘法分配律'],
  ['15.02 − 6.8 − 1.02', '7.2', '减法性质'],
  ['0.25 + 11/15 + 4/15 + 3/4', '2', '分数小数混合运算'],
  ['一个数的 3/8 是 24', '64', '分数除法'],
  ['8 的 1/4 的 4/5 是多少', '1 又 3/5', '分数乘法'],
  ['鱼塘周长是 300 米，求总产量', '11250', '长方形与平均产量'],
  ['找规律：5，6，12，14，23，（ ）', '29', '数列规律'],
] as const

const C02_BBOXES = Array.from({ length: 16 }, (_, index) => {
  if (index === 14) return { x: 0.2, y: 0.79, w: 0.23, h: 0.075 }
  if (index === 15) return { x: 0.75, y: 0.8, w: 0.22, h: 0.075 }
  const column = index % 3
  const row = Math.floor(index / 3)
  return {
    x: 0.08 + column * 0.29,
    y: 0.15 + row * 0.105,
    w: 0.2,
    h: 0.052,
  }
})

function c02Questions(pendingConfirmation = false) {
  return C02_FACTS.map(([question, answer, knowledgePoint], index) => ({
    problem_id: `problem-${index + 1}`,
    problem_kind: 'standalone',
    page_asset_id: C02_ASSET_ID,
    source_number_path: [String(index + 1)],
    display_label: `第 ${index + 1} 题`,
    source_section_path:
      index < 9
        ? ['一']
        : index < 12
          ? ['二']
          : index < 14
            ? ['三']
            : index === 14
              ? ['四']
              : ['五'],
    source_section_label:
      index < 9
        ? '一、直接写得数'
        : index < 12
          ? '二、计算下面各题，能简算的要简算'
          : index < 14
            ? '三、列式计算'
            : index === 14
              ? '四、应用题'
              : '五、思维题',
    system_section_ordinal: index + 1,
    system_display_label: `第 ${index + 1} 题`,
    question,
    raw_transcription: question,
    canonical_markdown: question,
    canonical_valid: true,
    canonical_version: 1,
    knowledge_points: [knowledgePoint],
    answer_state: 'present',
    student_answer: answer,
    answer_canonical_markdown: answer,
    answer_canonical_valid: true,
    confirmation_required: pendingConfirmation && index === 0,
    ...(pendingConfirmation && index === 0 ? { confirmation_reasons: ['decimal_point'] } : {}),
    confirmed_version: pendingConfirmation && index === 0 ? 0 : 1,
    bbox: C02_BBOXES[index],
  }))
}

function c02Guide(problemNumber: 15 | 16) {
  if (problemNumber === 15) {
    return {
      answer: '11250',
      full_solution_steps: ['先单独重算 300 ÷ 2 ÷ 2，再从这一步继续核对后续算式。'],
      grade_level_method: '逐行检查每个等式左右是否相等。',
      likely_mistakes: ['连续除法计算错误。'],
      parent_teaching_sequence: [
        '先让孩子只验这一行的两次除法，再从这一步重新核对后续算式；不要用已经正确的最终答案倒推过程。',
      ],
      follow_up_questions: ['300 ÷ 2 ÷ 2 应该是多少？'],
      checking_method: '将重算后的每一步代回原题条件检查。',
    }
  }
  return {
    answer: '29',
    full_solution_steps: ['先检查 42 = 18 × 2，标出冲突后从上一条可信算式重新推到 29。'],
    grade_level_method: '逐行做等号检查，不跳过矛盾算式。',
    likely_mistakes: ['等号两边不相等，过程与最终答案矛盾。'],
    parent_teaching_sequence: [
      '逐行做等号检查，先算出 18 × 2 = 36 并标出冲突，再请孩子从上一条可信算式重新写到最终答案。',
    ],
    follow_up_questions: ['18 × 2 与 42 相等吗？'],
    checking_method: '检查每个等号两边的值后，再独立验算答案 29。',
  }
}

function c02ProblemProgress(pendingConfirmation = false) {
  return c02Questions(pendingConfirmation).map((question, index) => ({
    problem_id: question.problem_id,
    status:
      pendingConfirmation && index === 0
        ? 'awaiting_source'
        : index >= 14
          ? 'correct_with_process_issue'
          : 'correct',
    input_revision: 1,
    published_revision: 1,
    current_disposition: 'current',
    page_asset_id: C02_ASSET_ID,
    source_width: C02_FIXTURE.width,
    source_height: C02_FIXTURE.height,
    source_region: null,
  }))
}

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
    name: '08b-photo-process-issue',
    title: 'C02 最终答案正确但过程有误',
    referenceMode: 'photo-process-issue',
    implementationMode: 'homework-process-issue',
    classification: 'COMPARABLE',
    reason:
      '两侧均使用 SHA-256 0c4b…c861 的同一 C02 原图、16 题、14 题正确、第 15/16 题为 correct_with_process_issue，可比较统计、批注、展开状态与家长讲法。',
    referenceSelector:
      '#k12-batch .grade-result[data-assessment-fixture="correct_with_process_issue-c02"]',
    implementationSelector:
      '[data-testid="photo-grade-overlay"][data-assessment-status="correct_with_process_issue"]',
  },
  {
    name: '09-final-artifact-actions',
    title: '最终产物与打印/PDF/发送动作',
    referenceMode: 'photo-grade',
    implementationMode: 'homework-completed',
    classification: 'NOT_COMPARABLE',
    reason: '两侧动作 exact-set 可观察，但最终产物内容和题目 fixture 不同；只记录结构与样式证据。',
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
    reason: '原型只有写作 result-surface 声明，没有可冻结的写作点评处理中画面。',
    implementationSelector: '[data-testid="writing-feedback-progress"]',
  },
  {
    name: '13-writing-feedback-result',
    title: '作文点评最终结果',
    referenceMode: 'unrendered-writing',
    implementationMode: 'writing-result',
    classification: 'NOT_COMPARABLE',
    reason: '原型没有会话内可渲染写作点评结果，只声明 writing-feedback；不得用作品档案页替代。',
    implementationSelector: '[data-testid="writing-result-surface"]',
  },
  {
    name: '14-artwork-feedback-processing',
    title: '美术作品点评处理中',
    referenceMode: 'artwork-processing',
    implementationMode: 'artwork-processing',
    classification: 'NOT_COMPARABLE',
    reason:
      '原型证据实际渲染为最终五段点评，实现证据为「已识别出：美术作品 · 正在生成作品点评」处理中状态；生命周期不等价。',
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

const selectedMatrices = REQUESTED_STATE
  ? matrices.filter((state) => state.name === REQUESTED_STATE)
  : matrices

if (REQUESTED_STATE && selectedMatrices.length !== 1) {
  throw new Error(`unknown K12 chat matrix state: ${REQUESTED_STATE}`)
}

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

function c02ProcessIssueDispatch(final = true) {
  const published = final ? 16 : 15
  return {
    dispatch_id: DISPATCH,
    task_intent: 'completed_homework',
    status: final ? 'routed' : 'awaiting_confirmation',
    provider_display_name: 'HexClaw-GPT',
    model_id: 'gpt-5.6-sol',
    retryable: false,
    automatic_budget_seconds: 300,
    automatic_started_at: 1785295800,
    automatic_deadline_at: 1785296100,
    automatic_remaining_seconds: 0,
    operation_deadline_at: 1785296400,
    intent_evidence: ['answer_regions_present'],
    intent_confidence: 0.99,
    confirmation_candidates: [],
    target: { type: 'homework_submission', id: 'submission-c02-process-issue' },
    target_projection: {
      kind: 'homework',
      stage: final ? 'completed' : 'awaiting_confirmation',
      confirmation_state: final ? 'confirmed' : 'pending',
      anchor_state: 'located',
      recognition: { questions: c02Questions(!final), subject: '数学' },
      progressive: {
        structure_version: 2,
        snapshot_revision: published,
        problem_progress: c02ProblemProgress(!final),
        coverage: {
          total: 16,
          published,
          skipped: 0,
          awaiting: final ? 0 : 1,
          failed: 0,
          status: final ? 'complete' : 'in_progress',
          projection_revision: published,
        },
      },
    },
    progress: {
      operation: 'homework',
      state: final ? 'completed' : 'awaiting_confirmation',
    },
    version: final ? 16 : 15,
    created_at: 1785295800,
    updated_at: final ? 1785295901 : 1785295880,
  }
}

function c02ProcessIssueResult() {
  const resultItems = c02Questions().map((question, index) => {
    const processIssue = index >= 14
    const problemNumber = (index + 1) as 15 | 16
    const wrongStep = index === 14 ? '300 ÷ 2 ÷ 2 = 50' : '42 = 18 × 2'
    const errorCause =
      index === 14
        ? '该步算术不成立：300 ÷ 2 = 150，150 ÷ 2 = 75，不是 50；当前书写过程不能支持最终答案。'
        : '等号两边不相等，且原过程中的算式相互矛盾，无法作为最终答案 29 的可复核证据。'
    return {
      question,
      status: processIssue ? 'correct_with_process_issue' : 'correct',
      result_kind: 'assessment',
      grade: {
        solution: question.student_answer,
        verdict: processIssue ? 'disagree' : 'agree',
        assessment_status: processIssue ? 'correct_with_process_issue' : 'correct',
        final_answer_correct: true,
        evidence_type: 'numeric_exec',
        badge: processIssue ? 'disagree' : 'verified-strong',
        out_of_scope: false,
        record_created: false,
        solve_only: false,
        ...(processIssue ? { wrong_step: wrongStep, error_cause: errorCause } : {}),
      },
      ...(processIssue ? { parent_guide: c02Guide(problemNumber) } : {}),
    }
  })
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
        items: resultItems,
        markdown: '# 整页批改完成\n\n共 16 题：14 道正确，2 道过程问题，0 道需订正。',
        image_warning: '',
        annotated_image: {
          mime: 'application/octet-stream',
          data_base64: 'AA==',
          digest: 'sha256:6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
        },
      },
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
      progressive: {
        structure_version: 1,
        snapshot_revision: 2,
        problem_progress: [
          {
            problem_id: 'blank-1',
            status: 'blank_solved',
            input_revision: 1,
            published_revision: 1,
            current_disposition: 'current',
          },
          {
            problem_id: 'blank-2',
            status: 'blank_solved',
            input_revision: 1,
            published_revision: 1,
            current_disposition: 'current',
          },
        ],
        coverage: {
          total: 2,
          published: 2,
          skipped: 0,
          awaiting: 0,
          failed: 0,
          status: 'complete',
          projection_revision: 2,
        },
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
  if (mode === 'homework-process-issue') return c02ProcessIssueDispatch(false)
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
              ['先按 45 × 2 = 90 计算，再按一个小数位点回小数点，得到 9.0。'],
              '用“先按整数乘法算，再数小数位”的五年级方法，不引入超纲术语。',
              '把 9.0 写成 90，或忘记积的小数位来自两个因数的小数位总数。',
              '先让孩子说 45 × 2，再问“原来的 4.5 缩小了几倍，结果要怎样还原？”最后让孩子自己点小数点。',
              '如果改成 0.45 × 2，积的小数点应放在哪里？为什么？',
              '用 9 ÷ 2 反算，结果应回到 4.5；也可估算 4.5 × 2 接近 5 × 2，答案应接近 10。',
            ),
          },
          {
            question: blankWorksheetDispatch().target_projection.recognition.questions[1],
            status: 'blank_solved',
            result_kind: 'parent_teaching_guide',
            parent_guide: guide(
              '9.3',
              ['把 15 写成 15.0，小数点对齐后计算 15.0 − 5.7 = 9.3。'],
              '小数加减先对齐小数点，再从最低位算起；整数末尾可补 0。',
              '把末位直接上下对齐，误算成 15 − 5.7 = 14.3。',
              '先问“15 元可以写成多少元多少角”，让孩子说出 15.0，再把两个小数点竖着对齐。',
              '为什么小数加减要对齐小数点，而不是只对齐最右边的数字？',
              '用 9.3 + 5.7 反算，结果应为 15；同时估算 15 − 6 约等于 9，数量级应一致。',
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
  if (mode === 'homework-process-issue') return c02ProcessIssueResult()
  if (mode === 'homework-completed' || mode === 'homework-tips') {
    return completedHomeworkResult()
  }
  if (mode === 'blank-worksheet') return blankWorksheetResult()
  if (mode === 'writing-result') return creativeResult('writing')
  if (mode === 'artwork-result') return creativeResult('artwork')
  return null
}

interface CurrentSourceFixtureControl {
  evidence: Record<string, unknown>
  releaseResult: () => void
}

async function installCurrentSourceFixture(page: Page, mode: ImplementationMode) {
  const composerUpload = mode === 'homework-process-issue'
  const hasTask = mode !== 'empty' && !composerUpload
  const dispatch = dispatchFor(mode)
  const completedDispatch = composerUpload ? c02ProcessIssueDispatch(true) : dispatch
  const result = resultFor(mode)
  const evidence: Record<string, unknown> = {
    composerUpload,
    sourceFixture: null,
    sourceAssetStored: false,
    sourceMessagePersisted: false,
    imageTaskCreated: false,
    imageTaskRequest: null,
    imageTaskConfirmed: false,
    progressiveProcessStatuses: [],
  }
  let c02Confirmed = false
  let c02Bytes: Buffer | null = null
  if (composerUpload) {
    c02Bytes = await readFile(C02_FIXTURE.path)
    const digest = createHash('sha256').update(c02Bytes).digest('hex')
    if (c02Bytes.length !== C02_FIXTURE.bytes || digest !== C02_FIXTURE.sha256) {
      throw new Error('C02 fixture bytes or SHA-256 drifted')
    }
    evidence.sourceFixture = {
      path: C02_FIXTURE.path,
      bytes: c02Bytes.length,
      sha256: digest,
      width: C02_FIXTURE.width,
      height: C02_FIXTURE.height,
    }
  }
  let releaseResult = () => {}
  const resultGate = composerUpload
    ? new Promise<void>((resolve) => {
        releaseResult = resolve
      })
    : Promise.resolve()
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
    if (apiPath === `/api/v1/sessions/${SESSION}/messages` && method === 'POST') {
      const body = request.postDataJSON() as {
        id?: string
        role?: string
        content?: string
        metadata?: Record<string, unknown>
      }
      evidence.sourceMessagePersisted = true
      evidence.sourceMessageID = body.id ?? null
      return json(route, {
        message: {
          ...body,
          id: body.id || MESSAGE,
          timestamp: NOW,
          created_at: NOW,
        },
      })
    }
    if (apiPath === `/api/v1/sessions/${SESSION}/messages` && method === 'GET') {
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
    if (apiPath === '/api/k12/assets' && method === 'POST' && composerUpload) {
      evidence.sourceAssetStored = true
      return json(route, { asset_id: C02_ASSET_ID, size: C02_FIXTURE.bytes })
    }
    if (
      apiPath === `/api/k12/assets/${C02_FIXTURE.sha256}.png` &&
      method === 'GET' &&
      composerUpload &&
      c02Bytes
    ) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: c02Bytes })
    }
    if (apiPath === '/api/k12/image-tasks' && method === 'POST' && composerUpload && dispatch) {
      const body = request.postDataJSON() as {
        agent?: string
        source_session?: string
        source_kind?: string
        source_ref?: string
        source_asset_refs?: string[]
      }
      evidence.imageTaskCreated = true
      evidence.imageTaskRequest = body
      return json(route, { created: true, dispatch })
    }
    if (
      apiPath === `/api/k12/image-tasks/${DISPATCH}/confirm` &&
      method === 'POST' &&
      composerUpload &&
      completedDispatch
    ) {
      c02Confirmed = true
      evidence.imageTaskConfirmed = true
      evidence.imageTaskConfirmRequest = request.postDataJSON()
      return json(route, { dispatch: completedDispatch })
    }
    if (apiPath === '/api/k12/image-tasks/recoverable' && method === 'GET') {
      // Let the source message and its Teleport anchor mount first. This matrix
      // measures the guide geometry, not the independent recovery/anchor race.
      await new Promise((resolve) => setTimeout(resolve, 500))
      return json(route, {
        items:
          hasTask && dispatch
            ? [
                {
                  source_session: SESSION,
                  source_message_id: MESSAGE,
                  dispatch,
                },
              ]
            : [],
      })
    }
    if (apiPath === `/api/k12/image-tasks/${DISPATCH}` && method === 'GET' && dispatch) {
      return json(route, {
        dispatch: c02Confirmed && completedDispatch ? completedDispatch : dispatch,
      })
    }
    if (apiPath === `/api/k12/image-tasks/${DISPATCH}/result` && method === 'GET' && result) {
      await resultGate
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
  return { evidence, releaseResult } satisfies CurrentSourceFixtureControl
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
  if (mode === 'photo-process-issue') {
    const source = await readFile(C02_FIXTURE.path)
    const digest = createHash('sha256').update(source).digest('hex')
    if (source.length !== C02_FIXTURE.bytes || digest !== C02_FIXTURE.sha256) {
      throw new Error('C02 reference fixture bytes or SHA-256 drifted')
    }
    await page.route('**/test/k12-test-*.png', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: source }),
    )
  }
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
    for (const child of thread.children) {
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
      if (fragment instanceof DocumentFragment) {
        const guide = fragment.querySelector<HTMLElement>('[data-parent-teaching-guide]')
        const unit = guide?.querySelector<HTMLElement>('.guide__unit')
        if (unit) unit.textContent = '已按原题顺序自动解答 2 题'
        guide?.querySelector('.guide__body > div')?.remove()
        guide?.querySelector('.guide__body > .note')?.remove()
        thread.appendChild(fragment)
      }
    }

    if (referenceMode === 'failure') {
      const api = window as typeof window & { simulateK12StageFailure?: () => void }
      api.simulateK12StageFailure?.()
    }
    if (referenceMode === 'photo-grade') {
      show(document.querySelector('#k12-batch'))
    }
    if (referenceMode === 'photo-process-issue') {
      const api = window as typeof window & {
        showK12CorrectWithProcessIssueResult?: () => boolean
      }
      api.showK12CorrectWithProcessIssueResult?.()
      show(document.querySelector('#k12-batch'))
    }
    if (referenceMode === 'artwork-processing' || referenceMode === 'artwork-result') {
      const api = window as typeof window & { startK12ArtworkReview?: () => void }
      api.startK12ArtworkReview?.()
    }
  }, mode)

  if (mode === 'photo-process-issue') {
    const sourceImage = page.locator(
      '#k12-batch .grade-result[data-assessment-fixture="correct_with_process_issue-c02"] .grade-photo--process > img',
    )
    await expect(sourceImage).toHaveJSProperty('complete', true)
    await expect(sourceImage).toHaveJSProperty('naturalWidth', C02_FIXTURE.width)
    await expect(sourceImage).toHaveJSProperty('naturalHeight', C02_FIXTURE.height)
    await sourceImage.evaluate((image) => (image as HTMLImageElement).decode())
  }

  if (mode === 'artwork-processing') {
    await page.waitForTimeout(700)
  } else if (mode === 'artwork-result') {
    await page.waitForTimeout(1800)
  }
}

async function openCurrentSource(page: Page, mode: ImplementationMode) {
  const control = await installCurrentSourceFixture(page, mode)
  await page.goto(
    `${CURRENT_SOURCE_URL}/chat?role=${AGENT}&roleTitle=${encodeURIComponent('小明的辅导助手')}`,
    { waitUntil: 'domcontentloaded' },
  )
  await expect(page.locator('.k12enh-tabs')).toBeVisible({ timeout: 20_000 })
  await page.waitForURL((url) => url.pathname === '/chat' && url.search === '', {
    waitUntil: 'domcontentloaded',
    timeout: 5_000,
  })
  if (mode === 'homework-process-issue') {
    try {
      await page.locator('.hc-composer input[type="file"]').setInputFiles(C02_FIXTURE.path)
      const guard = page.getByTestId('recognize-guard')
      await expect(guard).toBeVisible({ timeout: 20_000 })
      const processSlots = guard.locator(
        '[data-testid="homework-problem-progress-slot"][data-assessment-status="correct_with_process_issue"]',
      )
      await expect(processSlots).toHaveCount(2, { timeout: 20_000 })
      const progressiveProcessStatuses = await processSlots.evaluateAll((nodes) =>
        nodes.map((node) => {
          const marker = node.querySelector<HTMLElement>('.rec-problem-progress__status')
          return {
            problemId: (node as HTMLElement).dataset.problemId ?? '',
            assessmentStatus: (node as HTMLElement).dataset.assessmentStatus ?? '',
            marker: marker?.innerText.trim() ?? '',
            markerColor: marker ? getComputedStyle(marker).color : '',
          }
        }),
      )
      control.evidence.progressiveProcessStatuses = progressiveProcessStatuses
      expect(progressiveProcessStatuses).toEqual([
        {
          problemId: 'problem-15',
          assessmentStatus: 'correct_with_process_issue',
          marker: '⚠',
          markerColor: 'rgb(165, 107, 214)',
        },
        {
          problemId: 'problem-16',
          assessmentStatus: 'correct_with_process_issue',
          marker: '⚠',
          markerColor: 'rgb(165, 107, 214)',
        },
      ])

      const pendingConfirmation = guard.locator('[data-testid="rq-confirm-0"]')
      await expect(pendingConfirmation).toBeVisible()
      await pendingConfirmation.check()
      await guard.getByTestId('recognize-confirm-all').click()
      await expect.poll(() => control.evidence.imageTaskConfirmed, { timeout: 20_000 }).toBe(true)
    } finally {
      control.releaseResult()
    }
    const overlay = page.getByTestId('photo-grade-overlay')
    await expect(overlay).toBeVisible({ timeout: 20_000 })
    const overlayImage = overlay.getByTestId('overlay-image')
    await expect(overlayImage).toHaveJSProperty('complete', true)
    await expect(overlayImage).toHaveJSProperty('naturalWidth', C02_FIXTURE.width)
    await expect(overlayImage).toHaveJSProperty('naturalHeight', C02_FIXTURE.height)
    await overlayImage.evaluate((image) => (image as HTMLImageElement).decode())
    const overlayImageSrc = await overlayImage.getAttribute('src')
    control.evidence.overlayImageSource = overlayImageSrc?.startsWith('blob:') ? 'blob' : 'other'
    const request = control.evidence.imageTaskRequest as {
      agent?: string
      source_session?: string
      source_kind?: string
      source_ref?: string
      source_asset_refs?: string[]
    } | null
    expect(request).toMatchObject({
      agent: AGENT,
      source_session: SESSION,
      source_kind: 'desktop',
      source_ref: control.evidence.sourceMessageID,
      source_asset_refs: [C02_ASSET_ID],
    })
    expect(control.evidence.sourceAssetStored).toBe(true)
    expect(control.evidence.sourceMessagePersisted).toBe(true)
    expect(control.evidence.overlayImageSource).toBe('blob')
    return control.evidence
  }
  if (mode !== 'empty') {
    await expect(page.getByTestId('recognize-guard')).toBeVisible({ timeout: 20_000 })
  }
  control.releaseResult()
  return control.evidence
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
    '#k12-batch .grade-result__title:visible',
    '#k12-batch .grade-summary:visible',
    '#k12-batch .grade-workspace:visible',
    '#k12-batch .grade-media:visible',
    '#k12-batch .grade-photo--process:visible',
    '#k12-batch .grade-mark--process:visible',
    '#k12-batch .grade-analysis:visible',
    '#k12-batch .grade-card--process:visible',
    '#k12-batch .grade-card--process .grade-card__row > b.grade-math:visible',
    '#k12-batch .grade-card--process .grade-wrong-step > .grade-math:visible',
    '#k12-batch .grade-card--process .grade-card__row:has(> span:first-child:text-is("原因")) > span:last-child:visible',
    '#k12-batch .grade-card--process .grade-card__row:has(> span:first-child:text-is("家长怎么讲")) > span:last-child:visible',
    '#k12-batch .grade-card--correct:visible',
    '#k12-batch .grade-projection-status:visible',
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
    '[data-testid="photo-grade-overlay"] .grade-result__title:visible',
    '[data-testid="photo-grade-overlay"] .grade-summary:visible',
    '[data-testid="photo-grade-overlay"] .grade-workspace:visible',
    '[data-testid="photo-grade-overlay"] .grade-media:visible',
    '[data-testid="photo-grade-overlay"] .grade-photo:visible',
    '[data-testid="photo-grade-overlay"] .pg-overlay__mark--process .pg-overlay__sym:visible',
    '[data-testid="photo-grade-overlay"] .grade-analysis:visible',
    '[data-testid="photo-grade-overlay"] .grade-card--process:visible',
    '[data-testid="photo-grade-overlay"] .grade-card--process .grade-card__row > b.grade-math:visible',
    '[data-testid="photo-grade-overlay"] .grade-card--process .grade-wrong-step > .grade-math:visible',
    '[data-testid="photo-grade-overlay"] .grade-card--process .grade-card__row:has(> span:first-child:text-is("原因")) > span:last-child:visible',
    '[data-testid="photo-grade-overlay"] .grade-card--process .grade-card__row:has(> span:first-child:text-is("家长怎么讲")) > span:last-child:visible',
    '[data-testid="photo-grade-overlay"] .grade-card--correct:visible',
    '[data-testid="photo-grade-overlay"] .grade-projection-status:visible',
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
          assessmentStatus: element.dataset.assessmentStatus ?? '',
          problemId: element.dataset.problemId ?? '',
          open: element instanceof HTMLDetailsElement ? element.open : undefined,
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

type GeometryNode = {
  tag: string
  text: string
  rect: { x: number; y: number; width: number; height: number }
  style: Record<string, string>
}

function compareProcessIssueGeometry(
  reference: Record<string, unknown[]>,
  currentSource: Record<string, unknown[]>,
) {
  const mappings = [
    ['#k12-batch .grade-result:visible', '[data-testid="photo-grade-overlay"]:visible'],
    [
      '#k12-batch .grade-result__title:visible',
      '[data-testid="photo-grade-overlay"] .grade-result__title:visible',
    ],
    [
      '#k12-batch .grade-summary:visible',
      '[data-testid="photo-grade-overlay"] .grade-summary:visible',
    ],
    [
      '#k12-batch .grade-workspace:visible',
      '[data-testid="photo-grade-overlay"] .grade-workspace:visible',
    ],
    ['#k12-batch .grade-media:visible', '[data-testid="photo-grade-overlay"] .grade-media:visible'],
    [
      '#k12-batch .grade-photo--process:visible',
      '[data-testid="photo-grade-overlay"] .grade-photo:visible',
    ],
    [
      '#k12-batch .grade-mark--process:visible',
      '[data-testid="photo-grade-overlay"] .pg-overlay__mark--process .pg-overlay__sym:visible',
    ],
    [
      '#k12-batch .grade-analysis:visible',
      '[data-testid="photo-grade-overlay"] .grade-analysis:visible',
    ],
    [
      '#k12-batch .grade-card--process:visible',
      '[data-testid="photo-grade-overlay"] .grade-card--process:visible',
    ],
    [
      '#k12-batch .grade-card--process .grade-card__row > b.grade-math:visible',
      '[data-testid="photo-grade-overlay"] .grade-card--process .grade-card__row > b.grade-math:visible',
    ],
    [
      '#k12-batch .grade-card--process .grade-wrong-step > .grade-math:visible',
      '[data-testid="photo-grade-overlay"] .grade-card--process .grade-wrong-step > .grade-math:visible',
    ],
    [
      '#k12-batch .grade-card--process .grade-card__row:has(> span:first-child:text-is("原因")) > span:last-child:visible',
      '[data-testid="photo-grade-overlay"] .grade-card--process .grade-card__row:has(> span:first-child:text-is("原因")) > span:last-child:visible',
    ],
    [
      '#k12-batch .grade-card--process .grade-card__row:has(> span:first-child:text-is("家长怎么讲")) > span:last-child:visible',
      '[data-testid="photo-grade-overlay"] .grade-card--process .grade-card__row:has(> span:first-child:text-is("家长怎么讲")) > span:last-child:visible',
    ],
    [
      '#k12-batch .grade-card--correct:visible',
      '[data-testid="photo-grade-overlay"] .grade-card--correct:visible',
    ],
    [
      '#k12-batch .grade-projection-status:visible',
      '[data-testid="photo-grade-overlay"] .grade-projection-status:visible',
    ],
  ] as const
  const comparedStyles = [
    'display',
    'boxSizing',
    'backgroundColor',
    'color',
    'border',
    'borderRadius',
    'padding',
    'gap',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'overflowX',
    'overflowY',
  ] as const
  const issues: string[] = []
  const comparableStyle = (key: string, value: string) =>
    key === 'border' && /^0px\s/.test(value) ? '0px' : value
  const nestedComparedStyles: Record<string, readonly string[]> = {
    '#k12-batch .grade-card--process .grade-card__row > b.grade-math:visible': [
      'display',
      'fontFamily',
      'fontWeight',
    ],
    '#k12-batch .grade-card--process .grade-wrong-step > .grade-math:visible': [
      'fontFamily',
      'fontWeight',
    ],
    '#k12-batch .grade-card--process .grade-card__row:has(> span:first-child:text-is("原因")) > span:last-child:visible':
      ['display', 'fontFamily', 'fontWeight', 'lineHeight'],
    '#k12-batch .grade-card--process .grade-card__row:has(> span:first-child:text-is("家长怎么讲")) > span:last-child:visible':
      ['display', 'fontFamily', 'fontWeight', 'lineHeight'],
  }
  const referenceRoot = (reference['#k12-batch .grade-result:visible'] ?? [])[0] as
    | GeometryNode
    | undefined
  const currentRoot = (currentSource['[data-testid="photo-grade-overlay"]:visible'] ?? [])[0] as
    | GeometryNode
    | undefined
  const comparisons = mappings.map(([referenceSelector, currentSelector]) => {
    const styleKeys = nestedComparedStyles[referenceSelector] ?? comparedStyles
    const referenceNodes = (reference[referenceSelector] ?? []) as GeometryNode[]
    const currentNodes = (currentSource[currentSelector] ?? []) as GeometryNode[]
    if (referenceNodes.length !== currentNodes.length) {
      issues.push(
        `${referenceSelector} / ${currentSelector}: count ${referenceNodes.length} != ${currentNodes.length}`,
      )
    }
    const pairs = Array.from(
      { length: Math.min(referenceNodes.length, currentNodes.length) },
      (_, index) => {
        const referenceNode = referenceNodes[index]!
        const currentNode = currentNodes[index]!
        const absoluteRectDelta = {
          x: Number((currentNode.rect.x - referenceNode.rect.x).toFixed(2)),
          y: Number((currentNode.rect.y - referenceNode.rect.y).toFixed(2)),
          width: Number((currentNode.rect.width - referenceNode.rect.width).toFixed(2)),
          height: Number((currentNode.rect.height - referenceNode.rect.height).toFixed(2)),
        }
        const rectDelta = {
          x:
            referenceRoot && currentRoot
              ? Number(
                  (
                    currentNode.rect.x -
                    currentRoot.rect.x -
                    (referenceNode.rect.x - referenceRoot.rect.x)
                  ).toFixed(2),
                )
              : absoluteRectDelta.x,
          y:
            referenceRoot && currentRoot
              ? Number(
                  (
                    currentNode.rect.y -
                    currentRoot.rect.y -
                    (referenceNode.rect.y - referenceRoot.rect.y)
                  ).toFixed(2),
                )
              : absoluteRectDelta.y,
          width: absoluteRectDelta.width,
          height: absoluteRectDelta.height,
        }
        for (const [dimension, delta] of Object.entries(rectDelta)) {
          if (Math.abs(delta) > 1) {
            issues.push(
              `${referenceSelector}[${index}] ${dimension} drift ${delta}px against ${currentSelector}`,
            )
          }
        }
        const styleDelta = Object.fromEntries(
          styleKeys.flatMap((key) =>
            comparableStyle(key, referenceNode.style[key]) ===
            comparableStyle(key, currentNode.style[key])
              ? []
              : [
                  [
                    key,
                    {
                      reference: referenceNode.style[key],
                      currentSource: currentNode.style[key],
                    },
                  ],
                ],
          ),
        )
        for (const key of Object.keys(styleDelta)) {
          issues.push(`${referenceSelector}[${index}] ${key} differs from ${currentSelector}`)
        }
        return {
          index,
          reference: referenceNode,
          currentSource: currentNode,
          absoluteRectDelta,
          rectDelta,
          styleDelta,
        }
      },
    )
    return { referenceSelector, currentSelector, comparedStyles: styleKeys, pairs }
  })
  const finalAnswerSelector =
    '[data-testid="photo-grade-overlay"] .grade-card--process .grade-card__row > b.grade-math:visible'
  const finalAnswerNodes = (currentSource[finalAnswerSelector] ?? []) as GeometryNode[]
  if (
    finalAnswerNodes.length !== 2 ||
    finalAnswerNodes.some(
      (node) =>
        node.tag !== 'b' ||
        node.style.fontWeight !== '650' ||
        !/(?:SF Mono|Menlo|monospace)/i.test(node.style.fontFamily),
    )
  ) {
    issues.push(
      'current-source process cards must expose exactly two 650-weight mono final b values',
    )
  }
  const wrongStepSelector =
    '[data-testid="photo-grade-overlay"] .grade-card--process .grade-wrong-step > .grade-math:visible'
  const wrongStepNodes = (currentSource[wrongStepSelector] ?? []) as GeometryNode[]
  if (
    wrongStepNodes.length !== 2 ||
    wrongStepNodes.some((node) => !/(?:SF Mono|Menlo|monospace)/i.test(node.style.fontFamily))
  ) {
    issues.push('current-source process cards must expose exactly two mono wrong-step values')
  }
  for (const selector of [
    '[data-testid="photo-grade-overlay"] .grade-card--process .grade-card__row:has(> span:first-child:text-is("原因")) > span:last-child:visible',
    '[data-testid="photo-grade-overlay"] .grade-card--process .grade-card__row:has(> span:first-child:text-is("家长怎么讲")) > span:last-child:visible',
  ]) {
    const nodes = (currentSource[selector] ?? []) as GeometryNode[]
    if (
      nodes.length !== 2 ||
      nodes.some((node) => /(?:SF Mono|Menlo|monospace)/i.test(node.style.fontFamily))
    ) {
      issues.push(`${selector} must expose exactly two non-mono prose values`)
    }
  }
  return { tolerancePx: 1, comparedStyles, issues, comparisons }
}

async function collectProcessIssueSemanticEvidence(
  referencePage: Page,
  currentSourcePage: Page,
  taskShellEvidence: Record<string, unknown>,
) {
  const referenceRoot = referencePage.locator(
    '#k12-batch .grade-result[data-assessment-fixture="correct_with_process_issue-c02"]',
  )
  const currentRoot = currentSourcePage.locator(
    '[data-testid="photo-grade-overlay"][data-assessment-status="correct_with_process_issue"]',
  )
  const reference = {
    counts: await referenceRoot.evaluate((node) => ({
      total: Number((node as HTMLElement).dataset.totalCount),
      correct: Number((node as HTMLElement).dataset.correctCount),
      process: Number((node as HTMLElement).dataset.processIssueCount),
      incorrect: Number((node as HTMLElement).dataset.incorrectCount),
    })),
    summary: (await referenceRoot.locator('.grade-result__head').innerText()).replace(/\s+/g, ' '),
    processMarks: await referenceRoot.locator('.grade-mark--process').evaluateAll((nodes) =>
      nodes.map((node) => ({
        problemId: (node as HTMLElement).dataset.problemId ?? '',
        assessmentStatus: (node as HTMLElement).dataset.assessmentStatus ?? '',
        symbol: (node.textContent ?? '').trim(),
        color: getComputedStyle(node).backgroundColor,
      })),
    ),
    processCards: await referenceRoot.locator('.grade-card--process').evaluateAll((nodes) =>
      nodes.map((node) => ({
        problemId: (node as HTMLElement).dataset.problemId ?? '',
        assessmentStatus: (node as HTMLElement).dataset.assessmentStatus ?? '',
        open: (node as HTMLDetailsElement).open,
        text: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
      })),
    ),
    correctCardOpen: await referenceRoot
      .locator('.grade-card--correct')
      .evaluate((node) => (node as HTMLDetailsElement).open),
    wrongMarkCount: await referenceRoot.locator('.grade-mark--incorrect').count(),
    wrongCardCount: await referenceRoot.locator('.grade-card--wrong').count(),
    projectionText: (await referenceRoot.locator('.grade-projection-status').innerText())
      .replace(/\s+/g, ' ')
      .trim(),
  }
  const currentSource = {
    counts: Object.fromEntries(
      await currentRoot
        .locator('.grade-stat')
        .evaluateAll((nodes) =>
          nodes.map((node) => [
            node.querySelector('span')?.textContent?.trim() ?? '',
            Number(node.querySelector('b')?.textContent?.trim()),
          ]),
        ),
    ),
    summary: (await currentRoot.locator('.grade-result__head').innerText()).replace(/\s+/g, ' '),
    processMarks: await currentRoot.locator('.pg-overlay__mark--process').evaluateAll((nodes) =>
      nodes.map((node) => {
        const symbol = node.querySelector<HTMLElement>('.pg-overlay__sym')
        return {
          problemId: (node as HTMLElement).dataset.problemId ?? '',
          assessmentStatus: (node as HTMLElement).dataset.assessmentStatus ?? '',
          symbol: symbol?.innerText.trim() ?? '',
          color: symbol ? getComputedStyle(symbol).backgroundColor : '',
        }
      }),
    ),
    processCards: await currentRoot.locator('.grade-card--process').evaluateAll((nodes) =>
      nodes.map((node) => ({
        assessmentStatus: (node as HTMLElement).dataset.assessmentStatus ?? '',
        open: (node as HTMLDetailsElement).open,
        text: (node.textContent ?? '').replace(/\s+/g, ' ').trim(),
      })),
    ),
    correctCardOpen: await currentRoot
      .locator('.grade-card--correct')
      .evaluate((node) => (node as HTMLDetailsElement).open),
    wrongMarkCount: await currentRoot.locator('.pg-overlay__mark--wrong').count(),
    wrongCardCount: await currentRoot.locator('.grade-card--wrong').count(),
    projectionText: (await currentRoot.locator('.grade-projection-status').innerText())
      .replace(/\s+/g, ' ')
      .trim(),
    taskShell: taskShellEvidence,
  }
  const issues: string[] = []
  if (
    JSON.stringify(reference.counts) !==
    JSON.stringify({ total: 16, correct: 14, process: 2, incorrect: 0 })
  ) {
    issues.push('reference summary counters are not 16/14/2/0')
  }
  const currentCounts = currentSource.counts as Record<string, number>
  if (
    currentCounts['本页题目'] !== 16 ||
    currentCounts['正确'] !== 14 ||
    currentCounts['过程问题'] !== 2 ||
    currentCounts['待人工复核'] !== 0 ||
    '需要关注' in currentCounts
  ) {
    issues.push('current-source summary counters are not 16/14/2/0')
  }
  for (const [surface, marks] of [
    ['reference', reference.processMarks],
    ['current-source', currentSource.processMarks],
  ] as const) {
    if (
      marks.length !== 2 ||
      JSON.stringify(marks.map((mark) => mark.problemId).sort()) !==
        JSON.stringify(['problem-15', 'problem-16']) ||
      marks.some(
        (mark) =>
          mark.assessmentStatus !== 'correct_with_process_issue' ||
          mark.symbol !== '⚠' ||
          mark.color !== 'rgb(165, 107, 214)',
      )
    ) {
      issues.push(`${surface} must render exactly two purple process-warning marks`)
    }
  }
  if (
    reference.processCards.length !== 2 ||
    reference.processCards.some((card) => !card.open) ||
    currentSource.processCards.length !== 2 ||
    currentSource.processCards.some((card) => !card.open)
  ) {
    issues.push('both process cards must be open on both surfaces')
  }
  if (reference.correctCardOpen || currentSource.correctCardOpen) {
    issues.push('the 14-correct card must stay closed on both surfaces')
  }
  if (
    reference.wrongMarkCount ||
    reference.wrongCardCount ||
    currentSource.wrongMarkCount ||
    currentSource.wrongCardCount
  ) {
    issues.push('process-only fixture must not render wrong marks or wrong cards')
  }
  const referenceText = reference.processCards.map((card) => card.text).join(' ')
  const currentText = currentSource.processCards.map((card) => card.text).join(' ')
  for (const [label, text] of [
    ['reference', referenceText],
    ['current-source', currentText],
  ] as const) {
    for (const required of [
      '第 15 题',
      '第 16 题',
      '错误步骤',
      '300÷2÷2=50',
      '42=18×2',
      '原因',
      '家长怎么讲',
    ]) {
      if (!text.replace(/\s+/g, '').includes(required.replace(/\s+/g, ''))) {
        issues.push(`${label} is missing approved visible detail: ${required}`)
      }
    }
  }
  const approvedProjectionText = '答案正确但过程存在格式、单位或不可复核跳步；不记为错题。'
  if (
    reference.projectionText !== approvedProjectionText ||
    currentSource.projectionText !== approvedProjectionText ||
    reference.projectionText !== currentSource.projectionText
  ) {
    issues.push('both surfaces must render the exact approved process projection text')
  }
  if (currentRoot && (await currentRoot.innerText()).includes('已入错题本')) {
    issues.push('current-source must not project a mistake persistence side effect')
  }
  return { issues, reference, currentSource }
}

async function scrollEvidenceIntoView(page: Page, selector?: string) {
  if (!selector) return false
  const locator = page.locator(selector).first()
  const visible = await locator.isVisible().catch(() => false)
  if (visible) {
    const intersectsViewport = await locator
      .evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return rect.bottom > 0 && rect.top < window.innerHeight
      })
      .catch(() => false)
    if (!intersectsViewport) await locator.scrollIntoViewIfNeeded()
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    )
  }
  return visible
}

interface ProcessIssueExternalUiEvidence {
  referenceToastCount: number
  currentSourceToastCount: number
  referenceScrollToBottomCount: number
  currentSourceScrollToBottomCount: number
  referenceDistanceFromBottom: number
  currentSourceDistanceFromBottom: number
  referenceRootY: number
  currentSourceRootY: number
  rootYDelta: number
}

async function settleScrollHostAtBottom(page: Page, selector: string) {
  await page.locator(selector).evaluate(async (element) => {
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    let previousLayout = ''
    let stableFrameCount = 0

    for (let attempt = 0; attempt < 60 && stableFrameCount < 2; attempt += 1) {
      element.scrollTop = element.scrollHeight
      element.dispatchEvent(new Event('scroll', { bubbles: true }))
      await nextFrame()
      const currentLayout = `${element.scrollHeight}:${element.clientHeight}`
      if (currentLayout === previousLayout) stableFrameCount += 1
      else stableFrameCount = 0
      previousLayout = currentLayout
    }
    if (stableFrameCount < 2) {
      throw new Error(`scroll host layout did not settle: ${previousLayout}`)
    }

    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
    await nextFrame()
    await nextFrame()
  })
}

async function alignRootToY(
  page: Page,
  hostSelector: string,
  rootSelector: string,
  targetY: number,
) {
  const host = page.locator(hostSelector)
  const root = page.locator(rootSelector).first()
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const box = await root.boundingBox()
    if (!box) throw new Error(`target root has no box: ${rootSelector}`)
    const residual = box.y - targetY
    if (Math.abs(residual) <= 0.01) {
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
      const stableBox = await root.boundingBox()
      if (stableBox && Math.abs(stableBox.y - targetY) <= 0.01) return stableBox
      continue
    }
    await host.evaluate(async (element, scrollAdjustment) => {
      element.scrollTop += scrollAdjustment
      element.dispatchEvent(new Event('scroll', { bubbles: true }))
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
    }, residual)
  }
  const box = await root.boundingBox()
  throw new Error(
    `target root y did not align: selector=${rootSelector}, target=${targetY}, actual=${box?.y}`,
  )
}

async function settleProcessIssueExternalUi(
  referencePage: Page,
  currentSourcePage: Page,
  referenceSelector: string,
  currentSourceSelector: string,
): Promise<ProcessIssueExternalUiEvidence> {
  await Promise.all([
    expect(referencePage.locator('#toast.on')).toHaveCount(0, { timeout: 12_000 }),
    expect(currentSourcePage.locator('.hc-toast')).toHaveCount(0, { timeout: 12_000 }),
  ])

  await Promise.all([
    settleScrollHostAtBottom(referencePage, '#k12Thread'),
    settleScrollHostAtBottom(currentSourcePage, '.hc-chat__messages'),
  ])
  const [referenceBottomBox, currentSourceBottomBox] = await Promise.all([
    referencePage.locator(referenceSelector).first().boundingBox(),
    currentSourcePage.locator(currentSourceSelector).first().boundingBox(),
  ])
  if (!referenceBottomBox || !currentSourceBottomBox) {
    throw new Error('expected process-issue roots to expose bottom-position boxes')
  }
  const sharedRootY = Math.max(referenceBottomBox.y, currentSourceBottomBox.y)
  if (sharedRootY - referenceBottomBox.y >= 32 || sharedRootY - currentSourceBottomBox.y >= 32) {
    throw new Error(
      `no shared near-bottom root y: reference=${referenceBottomBox.y}, current=${currentSourceBottomBox.y}`,
    )
  }
  const [referenceAlignedBox, currentSourceAlignedBox] = await Promise.all([
    alignRootToY(referencePage, '#k12Thread', referenceSelector, sharedRootY),
    alignRootToY(currentSourcePage, '.hc-chat__messages', currentSourceSelector, sharedRootY),
  ])
  await Promise.all([
    expect(referencePage.locator('.hc-chat__scroll-btn--bottom')).toHaveCount(0),
    expect(currentSourcePage.locator('.hc-chat__scroll-btn--bottom')).toHaveCount(0),
  ])

  const [referenceScroll, currentSourceScroll] = await Promise.all([
    referencePage.locator('#k12Thread').evaluate((element) => ({
      distanceFromBottom: Math.max(
        0,
        element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    })),
    currentSourcePage.locator('.hc-chat__messages').evaluate((element) => ({
      distanceFromBottom: Math.max(
        0,
        element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    })),
  ])
  const evidence = {
    referenceToastCount: await referencePage.locator('#toast.on').count(),
    currentSourceToastCount: await currentSourcePage.locator('.hc-toast').count(),
    referenceScrollToBottomCount: await referencePage
      .locator('.hc-chat__scroll-btn--bottom')
      .count(),
    currentSourceScrollToBottomCount: await currentSourcePage
      .locator('.hc-chat__scroll-btn--bottom')
      .count(),
    referenceDistanceFromBottom: Number(referenceScroll.distanceFromBottom.toFixed(2)),
    currentSourceDistanceFromBottom: Number(currentSourceScroll.distanceFromBottom.toFixed(2)),
    referenceRootY: Number(referenceAlignedBox.y.toFixed(2)),
    currentSourceRootY: Number(currentSourceAlignedBox.y.toFixed(2)),
    rootYDelta: Number((currentSourceAlignedBox.y - referenceAlignedBox.y).toFixed(2)),
  }
  expect(evidence).toMatchObject({
    referenceToastCount: 0,
    currentSourceToastCount: 0,
    referenceScrollToBottomCount: 0,
    currentSourceScrollToBottomCount: 0,
    rootYDelta: 0,
  })
  expect(evidence.referenceDistanceFromBottom).toBeGreaterThanOrEqual(0)
  expect(evidence.referenceDistanceFromBottom).toBeLessThan(32)
  expect(evidence.currentSourceDistanceFromBottom).toBeGreaterThanOrEqual(0)
  expect(evidence.currentSourceDistanceFromBottom).toBeLessThan(32)
  return evidence
}

async function captureState(browser: Browser, state: MatrixState, testInfo: TestInfo) {
  const project = testInfo.project.name || 'chromium'
  const outputDir = path.join(EVIDENCE_ROOT, project, state.name)
  await mkdir(outputDir, { recursive: true })
  const referencePath = path.join(outputDir, 'reference.png')
  const currentSourcePath = path.join(outputDir, 'current-source.png')
  const referenceContextPath = path.join(outputDir, 'reference-context.png')
  const currentSourceContextPath = path.join(outputDir, 'current-source-context.png')
  const diffPath = path.join(outputDir, 'pixel-diff.png')
  const geometryPath = path.join(outputDir, 'geometry-style.json')
  const ratioPath = path.join(outputDir, 'ratio.json')
  const statusPath = path.join(outputDir, 'status.json')

  const referencePage = await browser.newPage()
  const currentSourcePage = await browser.newPage()
  let referenceTargetVisible = false
  let currentSourceTargetVisible = false
  let runtimeError = ''
  let referenceGeometry: Record<string, unknown[]> = {}
  let currentSourceGeometry: Record<string, unknown[]> = {}
  let currentSourceFixtureEvidence: Record<string, unknown> = {}
  let processIssueSemanticEvidence: Awaited<
    ReturnType<typeof collectProcessIssueSemanticEvidence>
  > | null = null
  let processIssueGeometryComparison: ReturnType<typeof compareProcessIssueGeometry> | null = null
  let processIssueExternalUiEvidence: ProcessIssueExternalUiEvidence | null = null
  let processIssueTargetCrop: {
    method: 'playwright-live-fractional-common-root-local-intersection'
    size: { width: number; height: number }
    localOffset: { left: number; top: number }
    rootY: { reference: number; currentSource: number; delta: number }
    reference: { left: number; top: number }
    currentSource: { left: number; top: number }
  } | null = null
  try {
    await openReference(referencePage, state.referenceMode)
    currentSourceFixtureEvidence = await openCurrentSource(
      currentSourcePage,
      state.implementationMode,
    )
    if (state.implementationSelector) {
      await currentSourcePage
        .locator(state.implementationSelector)
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
        .catch(() => {})
    }
    await Promise.all([freezeVisualState(referencePage), freezeVisualState(currentSourcePage)])

    if (state.name === '08b-photo-process-issue') {
      processIssueExternalUiEvidence = await settleProcessIssueExternalUi(
        referencePage,
        currentSourcePage,
        state.referenceSelector!,
        state.implementationSelector!,
      )
    }

    referenceTargetVisible = await scrollEvidenceIntoView(referencePage, state.referenceSelector)
    currentSourceTargetVisible = await scrollEvidenceIntoView(
      currentSourcePage,
      state.implementationSelector,
    )
    ;[referenceGeometry, currentSourceGeometry] = await Promise.all([
      collectGeometry(referencePage, geometrySelectors.reference),
      collectGeometry(currentSourcePage, geometrySelectors.implementation),
    ])

    if (state.name === '08b-photo-process-issue') {
      processIssueSemanticEvidence = await collectProcessIssueSemanticEvidence(
        referencePage,
        currentSourcePage,
        currentSourceFixtureEvidence,
      )
      processIssueGeometryComparison = compareProcessIssueGeometry(
        referenceGeometry,
        currentSourceGeometry,
      )
    }

    if (state.name === '08b-photo-process-issue') {
      await Promise.all([
        referencePage
          .locator(
            '#k12-batch .grade-result[data-assessment-fixture="correct_with_process_issue-c02"] .grade-photo--process > img',
          )
          .evaluate((image) => (image as HTMLImageElement).decode()),
        currentSourcePage
          .getByTestId('photo-grade-overlay')
          .getByTestId('overlay-image')
          .evaluate((image) => (image as HTMLImageElement).decode()),
        expect(referencePage.locator('#toast.on')).toHaveCount(0),
        expect(currentSourcePage.locator('.hc-toast')).toHaveCount(0),
        expect(referencePage.locator('.hc-chat__scroll-btn--bottom')).toHaveCount(0),
        expect(currentSourcePage.locator('.hc-chat__scroll-btn--bottom')).toHaveCount(0),
      ])
      await Promise.all([
        referencePage.screenshot({ path: referenceContextPath, animations: 'disabled' }),
        currentSourcePage.screenshot({ path: currentSourceContextPath, animations: 'disabled' }),
      ])
      const [referenceBox, currentSourceBox, referenceHostBox, currentSourceHostBox] =
        await Promise.all([
          referencePage.locator(state.referenceSelector!).first().boundingBox(),
          currentSourcePage.locator(state.implementationSelector!).first().boundingBox(),
          referencePage.locator('#k12Thread').boundingBox(),
          currentSourcePage.locator('.hc-chat__messages').boundingBox(),
        ])
      if (!referenceBox || !currentSourceBox || !referenceHostBox || !currentSourceHostBox) {
        throw new Error('expected process-issue surface has no screenshot bounding box')
      }
      const referenceViewport = referencePage.viewportSize()
      const currentSourceViewport = currentSourcePage.viewportSize()
      if (!referenceViewport || !currentSourceViewport) {
        throw new Error('expected process-issue pages to expose fixed viewport dimensions')
      }
      const referenceVisible = {
        left: Math.max(referenceBox.x, referenceHostBox.x, 0),
        top: Math.max(referenceBox.y, referenceHostBox.y, 0),
        right: Math.min(
          referenceBox.x + referenceBox.width,
          referenceHostBox.x + referenceHostBox.width,
          referenceViewport.width,
        ),
        bottom: Math.min(
          referenceBox.y + referenceBox.height,
          referenceHostBox.y + referenceHostBox.height,
          referenceViewport.height,
        ),
      }
      const currentSourceVisible = {
        left: Math.max(currentSourceBox.x, currentSourceHostBox.x, 0),
        top: Math.max(currentSourceBox.y, currentSourceHostBox.y, 0),
        right: Math.min(
          currentSourceBox.x + currentSourceBox.width,
          currentSourceHostBox.x + currentSourceHostBox.width,
          currentSourceViewport.width,
        ),
        bottom: Math.min(
          currentSourceBox.y + currentSourceBox.height,
          currentSourceHostBox.y + currentSourceHostBox.height,
          currentSourceViewport.height,
        ),
      }
      const commonLocalIntersection = {
        left: Math.max(
          referenceVisible.left - referenceBox.x,
          currentSourceVisible.left - currentSourceBox.x,
        ),
        top: Math.max(
          referenceVisible.top - referenceBox.y,
          currentSourceVisible.top - currentSourceBox.y,
        ),
        right: Math.min(
          referenceVisible.right - referenceBox.x,
          currentSourceVisible.right - currentSourceBox.x,
        ),
        bottom: Math.min(
          referenceVisible.bottom - referenceBox.y,
          currentSourceVisible.bottom - currentSourceBox.y,
        ),
      }
      const surfaceSize = {
        width: commonLocalIntersection.right - commonLocalIntersection.left,
        height: commonLocalIntersection.bottom - commonLocalIntersection.top,
      }
      if (
        Math.abs(referenceBox.width - currentSourceBox.width) > 0.01 ||
        Math.abs(referenceBox.y - currentSourceBox.y) > 0.01 ||
        surfaceSize.width <= 0 ||
        surfaceSize.height <= 0
      ) {
        throw new Error('expected process-issue roots do not share one aligned local crop')
      }
      processIssueTargetCrop = {
        method: 'playwright-live-fractional-common-root-local-intersection',
        size: surfaceSize,
        localOffset: {
          left: commonLocalIntersection.left,
          top: commonLocalIntersection.top,
        },
        rootY: {
          reference: referenceBox.y,
          currentSource: currentSourceBox.y,
          delta: currentSourceBox.y - referenceBox.y,
        },
        reference: {
          left: referenceBox.x + commonLocalIntersection.left,
          top: referenceBox.y + commonLocalIntersection.top,
        },
        currentSource: {
          left: currentSourceBox.x + commonLocalIntersection.left,
          top: currentSourceBox.y + commonLocalIntersection.top,
        },
      }
      await Promise.all([
        referencePage.screenshot({
          path: referencePath,
          animations: 'disabled',
          clip: {
            x: processIssueTargetCrop.reference.left,
            y: processIssueTargetCrop.reference.top,
            ...surfaceSize,
          },
        }),
        currentSourcePage.screenshot({
          path: currentSourcePath,
          animations: 'disabled',
          clip: {
            x: processIssueTargetCrop.currentSource.left,
            y: processIssueTargetCrop.currentSource.top,
            ...surfaceSize,
          },
        }),
      ])
      const fixtureAfterCapture = await readFile(C02_FIXTURE.path)
      const fixtureAfterCaptureSha256 = createHash('sha256')
        .update(fixtureAfterCapture)
        .digest('hex')
      currentSourceFixtureEvidence.sourceFixtureAfterCapture = {
        bytes: fixtureAfterCapture.length,
        sha256: fixtureAfterCaptureSha256,
      }
      currentSourceFixtureEvidence.sourceFixtureStable =
        fixtureAfterCapture.length === C02_FIXTURE.bytes &&
        fixtureAfterCaptureSha256 === C02_FIXTURE.sha256
      if (!currentSourceFixtureEvidence.sourceFixtureStable) {
        throw new Error('C02 fixture bytes or SHA-256 drifted during visual capture')
      }
    } else {
      await Promise.all([
        referencePage.screenshot({ path: referencePath, animations: 'disabled' }),
        currentSourcePage.screenshot({ path: currentSourcePath, animations: 'disabled' }),
      ])
    }
    await writeFile(
      geometryPath,
      JSON.stringify(
        {
          viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
          locale: 'zh-CN',
          timezone: 'Asia/Shanghai',
          colorScheme: 'light',
          processIssueExternalUiEvidence,
          processIssueTargetCrop,
          reference: referenceGeometry,
          currentSource: currentSourceGeometry,
          processIssueCriticalComparison: processIssueGeometryComparison,
        },
        null,
        2,
      ),
    )
  } catch (cause) {
    runtimeError = cause instanceof Error ? cause.stack || cause.message : String(cause)
    if (!(await referencePage.isClosed())) {
      await referencePage
        .screenshot({ path: referencePath, animations: 'disabled' })
        .catch(() => {})
      if (state.name === '08b-photo-process-issue') {
        await referencePage
          .screenshot({ path: referenceContextPath, animations: 'disabled' })
          .catch(() => {})
      }
    }
    if (!(await currentSourcePage.isClosed())) {
      await currentSourcePage
        .screenshot({ path: currentSourcePath, animations: 'disabled' })
        .catch(() => {})
      if (state.name === '08b-photo-process-issue') {
        await currentSourcePage
          .screenshot({ path: currentSourceContextPath, animations: 'disabled' })
          .catch(() => {})
      }
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
  const processIssueMaterialIssues = [
    ...(processIssueSemanticEvidence?.issues ?? []),
    ...(processIssueGeometryComparison?.issues ?? []),
  ]
  const status =
    runtimeError || missingExpectedSurface
      ? 'BLOCKED'
      : state.classification === 'NOT_COMPARABLE'
        ? 'NOT_COMPARABLE'
        : diffReport &&
            diffReport.changed_pixel_ratio <= 0.001 &&
            processIssueMaterialIssues.length === 0
          ? 'PASS'
          : 'RED'
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
        pixelDiffScope:
          state.name === '08b-photo-process-issue'
            ? 'expected-surface-visible-intersection'
            : 'full-viewport',
        processIssueTargetCrop,
        processIssueExternalUiEvidence,
        pixelDiff: diffReport,
        semanticEvidence: processIssueSemanticEvidence,
        criticalGeometryIssueCount: processIssueGeometryComparison?.issues.length ?? 0,
        materialIssues: processIssueMaterialIssues,
        runtimeError: runtimeError || null,
        acceptance: status === 'PASS' ? 'PASS' : 'NOT PASS',
        passClaimAllowed: status === 'PASS',
      },
      null,
      2,
    ),
  )
  if (state.name === '08b-photo-process-issue') {
    for (const [name, file, contentType] of [
      ['reference', referencePath, 'image/png'],
      ['current-source', currentSourcePath, 'image/png'],
      ['reference-context', referenceContextPath, 'image/png'],
      ['current-source-context', currentSourceContextPath, 'image/png'],
      ['pixel-diff', diffPath, 'image/png'],
      ['geometry-style', geometryPath, 'application/json'],
      ['status', statusPath, 'application/json'],
    ] as const) {
      const body = await readFile(file).catch(() => null)
      if (body) await testInfo.attach(`${state.name}-${name}`, { body, contentType })
    }
  }

  expect
    .soft(runtimeError, `${state.name} evidence capture must not crash; see ${statusPath}`)
    .toBe('')
  expect
    .soft(
      missingExpectedSurface,
      `${state.name} expected surface must be visible; see ${statusPath}`,
    )
    .toBe(false)
  expect.soft(diffReport, `${state.name} must emit a pixel ratio; see ${ratioPath}`).not.toBeNull()
  if (state.name === '08b-photo-process-issue') {
    expect
      .soft(
        processIssueSemanticEvidence?.issues ?? ['semantic evidence was not captured'],
        `${state.name} approved semantic locks must hold; see ${statusPath}`,
      )
      .toEqual([])
  }
  if (state.name === '10-blank-worksheet-parent-guide') {
    type GeometryNode = {
      rect: { x: number; y: number; width: number; height: number }
    }
    const referenceGuide = referenceGeometry['[data-parent-teaching-guide]:visible']?.[0] as
      | GeometryNode
      | undefined
    const currentGuide = currentSourceGeometry[
      '[data-testid="blank-worksheet-parent-guide"]:visible'
    ]?.[0] as GeometryNode | undefined
    const currentAssistantRow = currentSourceGeometry[
      '[data-testid="k12-photo-assistant-message"]:visible'
    ]?.[0] as GeometryNode | undefined
    const currentScrollHost = currentSourceGeometry['.hc-chat__messages']?.[0] as
      | GeometryNode
      | undefined
    expect.soft(referenceGuide?.rect.width, 'authoritative guide rail must be 780px').toBe(780)
    expect.soft(currentAssistantRow?.rect.width, 'shared assistant row must remain 826px').toBe(826)
    expect
      .soft(currentGuide?.rect.width, 'blank worksheet guide must consume the 780px body rail')
      .toBe(780)
    expect
      .soft(
        currentGuide && currentAssistantRow
          ? Number((currentGuide.rect.x - currentAssistantRow.rect.x).toFixed(2))
          : undefined,
        'guide left edge must start after the 36px avatar and 10px shared gap',
      )
      .toBe(46)
    expect
      .soft(
        currentGuide && currentScrollHost ? currentGuide.rect.y >= currentScrollHost.rect.y : false,
        'first reveal must keep the guide title below the conversation viewport top',
      )
      .toBe(true)
  }
  return {
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
    semanticEvidence: processIssueSemanticEvidence,
    criticalGeometryIssueCount: processIssueGeometryComparison?.issues.length ?? 0,
    materialIssues: processIssueMaterialIssues,
    runtimeError: runtimeError || null,
    acceptance: status === 'PASS' ? 'PASS' : 'NOT PASS',
    evidenceDir: outputDir,
  }
}

test.describe('feat/v0.5.0-k12-parent-tutor · K12 chat authoritative state matrix', () => {
  test('captures reference/current-source/diff/geometry for every reachable or explicitly blocked state', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(15 * 60_000)
    const results: Awaited<ReturnType<typeof captureState>>[] = []
    for (const state of selectedMatrices) {
      await test.step(state.name, async () => {
        results.push(await captureState(browser, state, testInfo))
      })
    }
    const project = testInfo.project.name || 'chromium'
    const summaryDir = path.join(EVIDENCE_ROOT, project)
    const statusCounts = results.reduce<Record<string, number>>((counts, result) => {
      counts[result.status] = (counts[result.status] ?? 0) + 1
      return counts
    }, {})
    await mkdir(summaryDir, { recursive: true })
    await writeFile(
      path.join(summaryDir, 'matrix-summary.json'),
      JSON.stringify(
        {
          branch: 'feat/v0.5.0-k12-parent-tutor',
          engine: project,
          stateCount: selectedMatrices.length,
          statusCounts,
          results,
        },
        null,
        2,
      ),
    )
  })
})
