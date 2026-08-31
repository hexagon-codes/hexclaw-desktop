import { expect, test, type Browser, type Page, type Route, type TestInfo } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const REFERENCE_URL = process.env.HEX_UI_REFERENCE_URL?.trim() || 'http://127.0.0.1:16070/app.html'
const CURRENT_SOURCE_URL = process.env.HEX_UI_IMPLEMENTATION_URL?.trim() || 'http://127.0.0.1:16061'
const AGENT = 'k12-chat-matrix-ming'
const ORDINARY_AGENT = 'chat-matrix-assistant'
const ORDINARY_AGENT_DISPLAY_NAME = '小蟹'
const SESSION = 'k12-chat-matrix-session'
const MESSAGE = 'k12-chat-matrix-message'
const DISPATCH = 'k12-chat-matrix-dispatch'
const NOW = '2026-07-29T11:32:00+08:00'
const EVIDENCE_ROOT =
  process.env.HEX_UI_EVIDENCE_ROOT?.trim() || `/tmp/hexclaw-k12-chat-evidence-${process.pid}`
const REQUESTED_STATE = process.env.HEX_UI_STATE?.trim() || ''
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
  | 'ordinary-assistant'
  | 'entry'
  | 'image-routing'
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
  | 'ordinary-assistant'
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
  | 'artwork-failure'
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

const CREATIVE_FEEDBACK_FAILURE_STATE = '06b-artwork-feedback-failed-retryable'
const TASK_SHELL_FOOTER_TARGET_STATES = new Set([
  '04-homework-recognition-confirmation',
  '05-homework-progress-and-source-resolver',
  '06-homework-failed-retryable',
  CREATIVE_FEEDBACK_FAILURE_STATE,
])
const ORDINARY_ASSISTANT_ACTIONS_STATE = '02b-ordinary-assistant-actions'
const IMAGE_ROUTING_TARGET_STATE = '03-image-routing'
const ACTION_TOOLBAR_TARGET_STATES = new Set([
  ORDINARY_ASSISTANT_ACTIONS_STATE,
  '04-homework-recognition-confirmation',
  '05-homework-progress-and-source-resolver',
  '06-homework-failed-retryable',
])

interface ActionToolbarContract {
  sequence: readonly string[]
  width: number
}

const ACTION_TOOLBAR_CONTRACTS: Record<string, ActionToolbarContract> = {
  [ORDINARY_ASSISTANT_ACTIONS_STATE]: {
    sequence: [
      'button:赞',
      'button:踩',
      'divider',
      'button:复制',
      'button:重新生成',
      'button:朗读',
      'button:创建分支',
    ],
    width: 161,
  },
  '04-homework-recognition-confirmation': {
    sequence: ['button:赞', 'button:踩', 'divider', 'button:复制', 'button:朗读'],
    width: 109,
  },
  '05-homework-progress-and-source-resolver': {
    sequence: ['button:赞', 'button:踩', 'divider', 'button:复制', 'button:朗读'],
    width: 109,
  },
  '06-homework-failed-retryable': {
    sequence: [
      'button:赞',
      'button:踩',
      'divider',
      'button:复制',
      'button:朗读',
      'button:重试当前阶段',
    ],
    width: 135,
  },
  [CREATIVE_FEEDBACK_FAILURE_STATE]: {
    sequence: [
      'button:赞',
      'button:踩',
      'divider',
      'button:复制',
      'button:朗读',
      'button:重试当前阶段',
    ],
    width: 135,
  },
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
    name: ORDINARY_ASSISTANT_ACTIONS_STATE,
    title: '普通助手消息动作顺序',
    referenceMode: 'ordinary-assistant',
    implementationMode: 'ordinary-assistant',
    classification: 'NOT_COMPARABLE',
    reason:
      '两侧都使用 light 主题的普通 Chat 与确定性助手动作 fixture；全页正文仍不同，仅 toolbar 裁剪和结构化证据参与本目标验收。',
    referenceSelector:
      '#chatNormalView .msg.bot[data-reasoning-fixture-message] .msg-actions--assistant',
    implementationSelector: '[data-testid="chat-message-assistant"] .hc-msg-actions--assistant',
  },
  {
    name: '03-image-routing',
    title: '图片意图识别处理中',
    referenceMode: 'image-routing',
    implementationMode: 'routing',
    classification: 'COMPARABLE',
    reason: '两侧冻结同一图片意图尚未判定状态，只比较状态行，不比较会话正文。',
    referenceSelector:
      '[data-artwork-review-output] [data-component="ImageTaskRunStatus"] [data-testid="activity-timeline-item"]',
    implementationSelector:
      '[data-testid="recognize-guard"] [data-component="ImageTaskRunStatus"] [data-testid="activity-timeline-item"]',
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
    name: CREATIVE_FEEDBACK_FAILURE_STATE,
    title: '作品点评可重试失败的单一轻量活动行',
    referenceMode: 'failure',
    implementationMode: 'artwork-failure',
    classification: 'COMPARABLE',
    reason:
      '作品点评复用共享 ActivityTimeline 轻量失败行；目标裁剪注入同一确定性文案，只比较无框活动行、阶段重试与宿主 exact-set，不比较业务正文。',
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
      progressive: {
        structure_version: 2,
        snapshot_revision: 8,
        problem_progress: problemProgress.map((problem, index) => ({
          problem_id: problem.problem_id,
          status: final || index === 0 ? 'correct' : 'awaiting_source',
          input_revision: problem.input_revision,
          published_revision: final || index === 0 ? 1 : 0,
          current_disposition: 'current',
        })),
        coverage: final
          ? {
              total: 2,
              published: 2,
              skipped: 0,
              awaiting: 0,
              failed: 0,
              status: 'complete',
              projection_revision: 8,
            }
          : {
              total: 2,
              published: 1,
              skipped: 0,
              awaiting: 1,
              failed: 0,
              status: 'in_progress',
              projection_revision: 8,
            },
      },
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
  const dispatch = homeworkDispatch('completed', { final: true })
  return {
    ...dispatch,
    target_projection: {
      ...dispatch.target_projection,
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
  state: 'awaiting_confirmation' | 'feedback_pending' | 'feedback_failed' | 'feedback_ready',
) {
  const writing = intent === 'writing'
  return {
    dispatch_id: DISPATCH,
    task_intent: intent,
    status: 'routed',
    retryable: state === 'feedback_failed',
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
            promoted_work_id: writing ? 'work-writing-matrix' : 'work-art-matrix',
            promoted_generation_id: writing ? 'generation-writing-matrix' : 'generation-art-matrix',
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
      target_projection: { stage: 'routing' },
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
  if (mode === 'artwork-failure') return creativeDispatch('artwork', 'feedback_failed')
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
  const composerUpload = mode === 'routing' || mode === 'homework-process-issue'
  const ordinaryAssistant = mode === 'ordinary-assistant'
  const fixtureAgent = ordinaryAssistant ? ORDINARY_AGENT : AGENT
  const fixtureAgentDisplayName = ordinaryAssistant ? ORDINARY_AGENT_DISPLAY_NAME : '小明的辅导助手'
  const hasTask = mode !== 'empty' && !ordinaryAssistant && !composerUpload
  const dispatch = dispatchFor(mode)
  const wireDispatch =
    mode === 'routing' && dispatch ? { ...dispatch, target_projection: undefined } : dispatch
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
  const hasPersistedSourceMessage = () =>
    hasTask || ordinaryAssistant || (composerUpload && evidence.sourceMessagePersisted === true)
  const hasPersistedImageTask = () =>
    hasTask || (composerUpload && evidence.imageTaskCreated === true)
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
    {
      agent: fixtureAgent,
      session: SESSION,
      message: MESSAGE,
      dispatchId: DISPATCH,
      bindTask: hasTask,
    },
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
        agents: ordinaryAssistant
          ? [
              {
                name: ORDINARY_AGENT,
                display_name: ORDINARY_AGENT_DISPLAY_NAME,
                description: '普通助手确定性视觉夹具',
                provider: 'openai',
                model: 'gpt-5.6-sol',
                metadata: { avatar: '🦀' },
              },
            ]
          : [
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
        default: fixtureAgent,
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
            title: fixtureAgentDisplayName,
            agent_id: fixtureAgent,
            created_at: NOW,
            updated_at: NOW,
            message_count: ordinaryAssistant ? 2 : hasPersistedSourceMessage() ? 1 : 0,
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
        messages: ordinaryAssistant
          ? [
              {
                id: `${MESSAGE}-user`,
                role: 'user',
                content: '请解释一道小数乘法题。',
                timestamp: NOW,
                created_at: NOW,
              },
              {
                id: `${MESSAGE}-assistant`,
                role: 'assistant',
                content: '先按整数乘法计算，再补回小数位。',
                agent_name: fixtureAgent,
                timestamp: NOW,
                created_at: NOW,
                metadata: {
                  provider: 'openai',
                  provider_display_name: 'HexClaw-GPT',
                  model: 'gpt-5.6-sol',
                },
              },
            ]
          : hasPersistedSourceMessage()
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
        total: ordinaryAssistant ? 2 : hasPersistedSourceMessage() ? 1 : 0,
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
      return json(route, { created: true, dispatch: wireDispatch })
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
          hasPersistedImageTask() && dispatch
            ? [
                {
                  dispatch_id: dispatch.dispatch_id,
                  source_session_id: SESSION,
                  source_message_id: MESSAGE,
                  attempt_generation: 1,
                  version: dispatch.version,
                  stage: dispatch.target_projection.stage,
                  status: dispatch.status,
                  projection_ready: true,
                  terminal: dispatch.progress.state === 'completed',
                },
              ]
            : [],
      })
    }
    if (apiPath === `/api/k12/image-tasks/${DISPATCH}` && method === 'GET' && dispatch) {
      return json(route, {
        dispatch: c02Confirmed && completedDispatch ? completedDispatch : wireDispatch,
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
  if (mode === 'ordinary-assistant') {
    await page.evaluate(() => {
      const api = window as typeof window & { openNormalChat?: () => void }
      api.openNormalChat?.()
    })
    await expect(
      page.locator(
        '#chatNormalView .msg.bot[data-reasoning-fixture-message] .msg-actions--assistant',
      ),
    ).toBeVisible()
    return
  }
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
    if (referenceMode === 'image-routing') {
      const api = window as typeof window & { startK12ArtworkReview?: () => void }
      const nativeSetTimeout = window.setTimeout
      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (timeout === 550 || timeout === 1550) return 0
        return nativeSetTimeout(handler, timeout, ...args)
      }) as typeof window.setTimeout
      try {
        api.startK12ArtworkReview?.()
      } finally {
        window.setTimeout = nativeSetTimeout
      }
    } else if (referenceMode === 'artwork-processing' || referenceMode === 'artwork-result') {
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
  const ordinaryAssistant = mode === 'ordinary-assistant'
  const fixtureAgent = ordinaryAssistant ? ORDINARY_AGENT : AGENT
  const fixtureAgentDisplayName = ordinaryAssistant ? ORDINARY_AGENT_DISPLAY_NAME : '小明的辅导助手'
  await page.goto(
    `${CURRENT_SOURCE_URL}/chat?role=${fixtureAgent}&roleTitle=${encodeURIComponent(fixtureAgentDisplayName)}`,
    { waitUntil: 'domcontentloaded' },
  )
  if (ordinaryAssistant) {
    await expect(
      page.locator('[data-testid="chat-message-assistant"] .hc-msg-actions--assistant'),
    ).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.k12enh-tabs')).toHaveCount(0)
  } else {
    await expect(page.locator('.k12enh-tabs')).toBeVisible({ timeout: 20_000 })
  }
  await page.waitForURL((url) => url.pathname === '/chat' && url.search === '', {
    waitUntil: 'domcontentloaded',
    timeout: 5_000,
  })
  if (mode === 'routing') {
    try {
      await page.locator('.hc-composer input[type="file"]').setInputFiles(C02_FIXTURE.path)
      await expect(
        page.getByTestId('recognize-guard').locator('[data-component="ImageTaskRunStatus"]'),
      ).toBeVisible({ timeout: 20_000 })
    } finally {
      control.releaseResult()
    }
    return control.evidence
  }
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
  if (mode !== 'empty' && mode !== 'ordinary-assistant') {
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
    '[data-k12-task-shell-footer]:visible',
    '[data-k12-task-shell-footer] > .msg-meta:visible',
    '[data-k12-task-shell-footer] > .msg-actions--assistant:visible',
    '#chatNormalView .msg.bot[data-reasoning-fixture-message] .msg-actions--assistant:visible',
    '.k12-pipeline:visible',
    '#k12StageError:visible',
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
    '[data-testid="task-shell-footer"]:visible',
    '[data-testid="task-shell-footer"] > [data-testid="task-shell-metadata"]:visible',
    '[data-testid="task-shell-footer"] > .hc-msg-actions--assistant:visible',
    '[data-testid="chat-message-assistant"] .hc-msg-actions--assistant:visible',
    '[data-testid="recognize-pipeline"]:visible',
    '[data-testid="recognize-stage-error"]:visible',
    '.rec-panel__err:visible',
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
            paddingTop: style.paddingTop,
            margin: style.margin,
            marginTop: style.marginTop,
            marginLeft: style.marginLeft,
            marginRight: style.marginRight,
            marginInlineStart: style.marginInlineStart,
            marginInlineEnd: style.marginInlineEnd,
            gap: style.gap,
            justifyContent: style.justifyContent,
            alignItems: style.alignItems,
            flexGrow: style.flexGrow,
            flexShrink: style.flexShrink,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            minHeight: style.minHeight,
            opacity: style.opacity,
            whiteSpace: style.whiteSpace,
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

function actionToolbarSelectors(stateName: string) {
  if (stateName === ORDINARY_ASSISTANT_ACTIONS_STATE) {
    return {
      reference: '#chatNormalView .msg.bot[data-reasoning-fixture-message] .msg-actions--assistant',
      currentSource: '[data-testid="chat-message-assistant"] .hc-msg-actions--assistant',
    }
  }
  return {
    reference: '[data-k12-task-shell-footer] > .msg-actions--assistant',
    currentSource: '[data-testid="task-shell-footer"] > .hc-msg-actions--assistant',
  }
}

async function collectActionToolbarEvidence(page: Page, selector: string) {
  return page
    .locator(selector)
    .first()
    .evaluate((node) => {
      const toolbar = node as HTMLElement
      const toolbarRect = toolbar.getBoundingClientRect()
      const toolbarStyle = getComputedStyle(toolbar)
      const rect = (element: Element) => {
        const box = element.getBoundingClientRect()
        return {
          x: Number(box.x.toFixed(2)),
          y: Number(box.y.toFixed(2)),
          width: Number(box.width.toFixed(2)),
          height: Number(box.height.toFixed(2)),
        }
      }
      const resolveThemeColor = (token: string) => {
        const probe = document.createElement('span')
        probe.style.color = `var(${token})`
        probe.style.display = 'none'
        toolbar.appendChild(probe)
        const value = getComputedStyle(probe).color
        probe.remove()
        return value
      }
      const footer = toolbar.closest<HTMLElement>(
        '.msg-footer, .hc-msg__footer, [data-testid="task-shell-footer"]',
      )
      const metadata = footer?.querySelector<HTMLElement>(
        ':scope > .msg-meta, :scope > .hc-msg__meta, :scope > [data-testid="task-shell-metadata"]',
      )
      const footerRect = footer?.getBoundingClientRect()
      const metadataRect = metadata?.getBoundingClientRect()
      const children = [...toolbar.children]
        .filter((child) => {
          const element = child as HTMLElement
          return !element.hidden && getComputedStyle(element).display !== 'none'
        })
        .map((child) => {
          const element = child as HTMLElement
          const style = getComputedStyle(element)
          const button = element instanceof HTMLButtonElement
          const divider = element.matches('.msg-action-sep, .hc-msg-actions__divider')
          const label = button ? (element.getAttribute('aria-label') ?? '') : ''
          const icon = element.querySelector('svg')
          return {
            kind: button ? 'button' : divider ? 'divider' : 'unexpected',
            key: button ? `button:${label}` : divider ? 'divider' : `unexpected:${element.tagName}`,
            ariaLabel: label,
            ariaHidden: element.getAttribute('aria-hidden'),
            disabled: button ? element.disabled : undefined,
            rect: rect(element),
            style: {
              display: style.display,
              width: style.width,
              height: style.height,
              padding: style.padding,
              margin: style.margin,
              borderRadius: style.borderRadius,
              backgroundColor: style.backgroundColor,
              color: style.color,
            },
            icon: icon
              ? {
                  rect: rect(icon),
                  style: {
                    strokeWidth: getComputedStyle(icon).strokeWidth,
                  },
                }
              : null,
          }
        })
      return {
        role: toolbar.getAttribute('role'),
        ariaLabel: toolbar.getAttribute('aria-label'),
        sequence: children.map((child) => child.key),
        rect: {
          x: Number(toolbarRect.x.toFixed(2)),
          y: Number(toolbarRect.y.toFixed(2)),
          width: Number(toolbarRect.width.toFixed(2)),
          height: Number(toolbarRect.height.toFixed(2)),
        },
        style: {
          display: toolbarStyle.display,
          height: toolbarStyle.height,
          padding: toolbarStyle.padding,
          marginLeft: toolbarStyle.marginLeft,
          marginInlineStart: toolbarStyle.marginInlineStart,
          gap: toolbarStyle.gap,
          border: toolbarStyle.border,
          borderRadius: toolbarStyle.borderRadius,
          backgroundColor: toolbarStyle.backgroundColor,
          boxShadow: toolbarStyle.boxShadow,
          color: toolbarStyle.color,
          opacity: toolbarStyle.opacity,
        },
        theme: {
          colorScheme: document.documentElement.dataset.theme ?? '',
          k12Skin: document.body.dataset.k12SkinActive ?? '',
          textSecondary: resolveThemeColor('--hc-text-secondary'),
          textMuted: resolveThemeColor('--hc-text-muted'),
        },
        footerContext:
          footer && footerRect && metadata && metadataRect
            ? {
                footer: rect(footer),
                metadata: rect(metadata),
                metadataToActionsGap: Number(
                  (toolbarRect.x - (metadataRect.x + metadataRect.width)).toFixed(2),
                ),
                actionsTrailingSpace: Number(
                  (footerRect.x + footerRect.width - (toolbarRect.x + toolbarRect.width)).toFixed(
                    2,
                  ),
                ),
                style: {
                  display: getComputedStyle(footer).display,
                  gap: getComputedStyle(footer).gap,
                  justifyContent: getComputedStyle(footer).justifyContent,
                },
              }
            : null,
        children,
      }
    })
}

type ActionToolbarEvidence = Awaited<ReturnType<typeof collectActionToolbarEvidence>>

function validateActionToolbarSide(
  surface: 'reference' | 'currentSource',
  evidence: ActionToolbarEvidence,
  contract: ActionToolbarContract,
) {
  const issues: string[] = []
  const expectValue = (actual: unknown, expected: unknown, invariant: string) => {
    if (actual !== expected)
      issues.push(`${surface}: ${invariant} is ${String(actual)}, expected ${String(expected)}`)
  }
  const expectPixels = (actual: number, expected: number, invariant: string) => {
    if (Math.abs(actual - expected) > 0.01) {
      issues.push(`${surface}: ${invariant} is ${actual}px, expected ${expected}px`)
    }
  }

  if (JSON.stringify(evidence.sequence) !== JSON.stringify(contract.sequence)) {
    issues.push(
      `${surface}: action sequence is ${evidence.sequence.join('→')}, expected ${contract.sequence.join('→')}`,
    )
  }
  expectValue(evidence.role, 'toolbar', 'toolbar role')
  expectValue(evidence.ariaLabel, '消息操作', 'toolbar aria-label')
  expectPixels(evidence.rect.width, contract.width, 'toolbar width')
  expectPixels(evidence.rect.height, 24, 'toolbar height')
  expectValue(evidence.style.display, 'flex', 'toolbar display')
  expectValue(evidence.style.height, '24px', 'toolbar computed height')
  expectValue(evidence.style.padding, '0px', 'toolbar padding')
  expectValue(evidence.style.marginLeft, '0px', 'toolbar margin-left')
  expectValue(evidence.style.marginInlineStart, '0px', 'toolbar margin-inline-start')
  expectValue(evidence.style.gap, '2px', 'toolbar gap')
  expectValue(evidence.style.borderRadius, '8px', 'toolbar border-radius')
  expectValue(evidence.style.backgroundColor, 'rgba(0, 0, 0, 0)', 'toolbar background')
  expectValue(evidence.style.boxShadow, 'none', 'toolbar box-shadow')
  expectValue(evidence.style.color, evidence.theme.textSecondary, 'toolbar theme color')
  expectValue(evidence.style.opacity, '0.68', 'toolbar opacity')
  if (!evidence.footerContext) {
    issues.push(`${surface}: toolbar footer/metadata context is missing`)
  } else {
    expectValue(evidence.footerContext.style.display, 'flex', 'footer display')
    expectValue(evidence.footerContext.style.gap, '8px', 'footer gap')
    if (evidence.footerContext.style.justifyContent === 'space-between') {
      issues.push(`${surface}: footer must not use space-between`)
    }
    expectPixels(evidence.footerContext.metadataToActionsGap, 8, 'metadata-to-actions gap')
    if (evidence.footerContext.actionsTrailingSpace <= 0) {
      issues.push(`${surface}: actions are pinned to the footer row end`)
    }
  }

  for (const child of evidence.children) {
    if (child.kind === 'button') {
      expectPixels(child.rect.width, 24, `${child.key} width`)
      expectPixels(child.rect.height, 24, `${child.key} height`)
      expectValue(child.style.width, '24px', `${child.key} computed width`)
      expectValue(child.style.height, '24px', `${child.key} computed height`)
      expectValue(child.style.padding, '0px', `${child.key} padding`)
      expectValue(child.style.borderRadius, '7px', `${child.key} border-radius`)
      expectValue(child.style.backgroundColor, 'rgba(0, 0, 0, 0)', `${child.key} background`)
      expectValue(child.style.color, evidence.theme.textMuted, `${child.key} theme color`)
      if (!child.icon) {
        issues.push(`${surface}: ${child.key} has no SVG icon`)
      } else {
        expectPixels(child.icon.rect.width, 14, `${child.key} icon width`)
        expectPixels(child.icon.rect.height, 14, `${child.key} icon height`)
        expectValue(child.icon.style.strokeWidth, '1.9px', `${child.key} icon stroke-width`)
      }
    } else if (child.kind === 'divider') {
      expectValue(child.ariaHidden, 'true', 'divider aria-hidden')
      expectPixels(child.rect.width, 1, 'divider width')
      expectPixels(child.rect.height, 16, 'divider height')
      expectValue(child.style.margin, '0px 2px', 'divider margin')
    } else {
      issues.push(`${surface}: unexpected toolbar child ${child.key}`)
    }
  }
  return issues
}

async function compareActionToolbarTarget(
  stateName: string,
  referencePage: Page,
  currentSourcePage: Page,
) {
  const contract = ACTION_TOOLBAR_CONTRACTS[stateName]
  if (!contract) throw new Error(`missing action toolbar contract for ${stateName}`)
  const selectors = actionToolbarSelectors(stateName)
  const [reference, currentSource] = await Promise.all([
    collectActionToolbarEvidence(referencePage, selectors.reference),
    collectActionToolbarEvidence(currentSourcePage, selectors.currentSource),
  ])
  const issues = [
    ...validateActionToolbarSide('reference', reference, contract),
    ...validateActionToolbarSide('currentSource', currentSource, contract),
  ]
  if (stateName === ORDINARY_ASSISTANT_ACTIONS_STATE) {
    if (reference.theme.k12Skin === 'k12') issues.push('reference: ordinary Chat uses the K12 skin')
    if (currentSource.theme.k12Skin === 'k12') {
      issues.push('currentSource: ordinary Chat uses the K12 skin')
    }
    if (reference.theme.textSecondary !== currentSource.theme.textSecondary) {
      issues.push(
        `ordinary Chat --hc-text-secondary differs: ${reference.theme.textSecondary} != ${currentSource.theme.textSecondary}`,
      )
    }
    if (reference.theme.textMuted !== currentSource.theme.textMuted) {
      issues.push(
        `ordinary Chat --hc-text-muted differs: ${reference.theme.textMuted} != ${currentSource.theme.textMuted}`,
      )
    }
  }
  return {
    classification: 'COMPARABLE_TARGET' as const,
    status: issues.length === 0 ? ('PASS' as const) : ('RED' as const),
    contract,
    selectors,
    normalization: 'toolbar-only crop on a deterministic white evidence stage; no business copy',
    reference,
    currentSource,
    issues,
  }
}

async function captureNormalizedActionToolbar(
  page: Page,
  selector: string,
  outputPath: string,
  expectedWidth: number,
) {
  const stageID = `visual-action-toolbar-${Math.random().toString(36).slice(2)}`
  const toolbar = page.locator(selector).first()
  await toolbar.evaluate(
    (node, stageOptions) => {
      const source = node as HTMLElement
      const stage = document.createElement('div')
      stage.id = stageOptions.id
      stage.dataset.visualNormalization = 'toolbar-only-white-stage'
      Object.assign(stage.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        width: `${stageOptions.expectedWidth}px`,
        height: '24px',
        margin: '0',
        padding: '0',
        overflow: 'hidden',
        background: '#fff',
        zIndex: '2147483647',
      })
      const clone = source.cloneNode(true) as HTMLElement
      clone.removeAttribute('id')
      clone.style.margin = '0'
      stage.appendChild(clone)
      document.body.appendChild(stage)
    },
    { id: stageID, expectedWidth },
  )
  try {
    await page.locator(`#${stageID}`).screenshot({ path: outputPath, animations: 'disabled' })
  } finally {
    await page
      .locator(`#${stageID}`)
      .evaluate((node) => node.remove())
      .catch(() => {})
  }
}

async function collectCreativeFailureTargetEvidence(
  page: Page,
  selector: string,
  surface: 'reference' | 'currentSource',
) {
  const target = page.locator(selector)
  const targetCount = await target.count()
  const card = await target.first().evaluate((node) => {
    const host = node as HTMLElement
    const element = host.matches('.hc-activity-timeline')
      ? host
      : host.querySelector<HTMLElement>('[data-testid="activity-timeline"]')
    if (!element) throw new Error('creative failure ActivityTimeline is missing')
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      text: host.innerText.replace(/\s+/g, ' ').trim(),
      role: host.getAttribute('role') ?? '',
      rect: {
        width: Number(rect.width.toFixed(2)),
        height: Number(rect.height.toFixed(2)),
      },
      style: {
        display: style.display,
        alignItems: style.alignItems,
        gap: style.gap,
        marginTop: style.marginTop,
        padding: style.padding,
        borderWidth: style.borderWidth,
        borderRadius: style.borderRadius,
        backgroundColor: style.backgroundColor,
        boxShadow: style.boxShadow,
        color: style.color,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        boxSizing: style.boxSizing,
      },
    }
  })
  const [legacyErrorCount, stageErrorCount, taskRetryCount, regenerateCount, notRetryableCount] =
    await Promise.all([
      page.locator('.rec-panel__err:visible').count(),
      page.locator('[data-testid="recognize-stage-error"]:visible').count(),
      page.locator('[data-testid="message-task-stage-retry"]:visible').count(),
      page.locator('[data-testid="message-regenerate"]:visible').count(),
      page.locator('[data-testid="recognize-stage-not-retryable"]:visible').count(),
    ])
  return {
    surface,
    targetCount,
    card,
    legacyErrorCount,
    stageErrorCount,
    taskRetryCount,
    regenerateCount,
    notRetryableCount,
  }
}

type CreativeFailureTargetEvidence = Awaited<
  ReturnType<typeof collectCreativeFailureTargetEvidence>
>

function validateCreativeFailureTargetSide(evidence: CreativeFailureTargetEvidence) {
  const issues: string[] = []
  const expectValue = (actual: unknown, expected: unknown, invariant: string) => {
    if (actual !== expected) {
      issues.push(
        `${evidence.surface}: ${invariant} is ${String(actual)}, expected ${String(expected)}`,
      )
    }
  }
  expectValue(evidence.targetCount, 1, 'failure activity exact-set')
  expectValue(evidence.card.role, 'alert', 'failure activity role')
  expectValue(evidence.card.style.display, 'grid', 'failure activity display')
  expectValue(evidence.card.style.alignItems, 'normal', 'failure activity align-items')
  expectValue(evidence.card.style.gap, '9px', 'failure activity gap')
  expectValue(evidence.card.style.marginTop, '0px', 'failure activity margin-top')
  expectValue(evidence.card.style.padding, '0px', 'failure activity padding')
  expectValue(evidence.card.style.borderWidth, '0px', 'failure activity border')
  expectValue(evidence.card.style.borderRadius, '0px', 'failure activity border-radius')
  expectValue(
    evidence.card.style.backgroundColor,
    'rgba(0, 0, 0, 0)',
    'failure activity background',
  )
  expectValue(evidence.card.style.boxShadow, 'none', 'failure activity shadow')
  expectValue(evidence.card.style.fontSize, '13px', 'failure activity font-size')
  if (evidence.surface === 'currentSource') {
    expectValue(evidence.legacyErrorCount, 0, 'legacy top error exact-set')
    expectValue(evidence.stageErrorCount, 1, 'TaskShell error exact-set')
    expectValue(evidence.taskRetryCount, 1, 'task-stage retry exact-set')
    expectValue(evidence.regenerateCount, 0, 'generic regenerate exact-set')
    expectValue(evidence.notRetryableCount, 0, 'not-retryable copy exact-set')
    if (!evidence.card.text.includes('点评生成失败')) {
      issues.push('currentSource: creative feedback failure copy is missing')
    }
    for (const forbidden of ['识题失败', '拍照批改', '本地模型慢', '超时']) {
      if (evidence.card.text.includes(forbidden)) {
        issues.push(`currentSource: creative feedback failure leaked forbidden copy ${forbidden}`)
      }
    }
  }
  return issues
}

async function compareCreativeFailureTarget(
  referencePage: Page,
  currentSourcePage: Page,
  referenceSelector: string,
  currentSourceSelector: string,
) {
  const [reference, currentSource] = await Promise.all([
    collectCreativeFailureTargetEvidence(referencePage, referenceSelector, 'reference'),
    collectCreativeFailureTargetEvidence(currentSourcePage, currentSourceSelector, 'currentSource'),
  ])
  const issues = [
    ...validateCreativeFailureTargetSide(reference),
    ...validateCreativeFailureTargetSide(currentSource),
  ]
  const contextualDifferences: string[] = []
  for (const key of [
    'display',
    'alignItems',
    'gap',
    'marginTop',
    'padding',
    'borderWidth',
    'borderRadius',
    'backgroundColor',
    'boxShadow',
    'color',
    'fontSize',
    'boxSizing',
  ] as const) {
    if (reference.card.style[key] !== currentSource.card.style[key]) {
      issues.push(
        `failure activity ${key} differs: ${reference.card.style[key]} != ${currentSource.card.style[key]}`,
      )
    }
  }
  if (reference.card.style.lineHeight !== currentSource.card.style.lineHeight) {
    contextualDifferences.push(
      `inherited lineHeight differs: ${reference.card.style.lineHeight} != ${currentSource.card.style.lineHeight}`,
    )
  }
  for (const dimension of ['width', 'height'] as const) {
    if (Math.abs(reference.card.rect[dimension] - currentSource.card.rect[dimension]) > 0.01) {
      contextualDifferences.push(
        `parent-context ${dimension} differs: ${reference.card.rect[dimension]} != ${currentSource.card.rect[dimension]}`,
      )
    }
  }
  return {
    classification: 'COMPARABLE_TARGET' as const,
    normalization: 'shared TaskShell lightweight activity crop with deterministic business copy',
    reference,
    currentSource,
    contextualDifferences,
    issues,
  }
}

async function captureNormalizedCreativeFailureTarget(
  page: Page,
  selector: string,
  outputPath: string,
) {
  const stageID = `visual-creative-failure-${Math.random().toString(36).slice(2)}`
  await page
    .locator(selector)
    .first()
    .evaluate((node, id) => {
      const stage = document.createElement('div')
      stage.id = id
      stage.dataset.visualNormalization = 'creative-failure-activity-white-stage'
      Object.assign(stage.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        width: '780px',
        margin: '0',
        padding: '0',
        background: '#fff',
        zIndex: '2147483647',
      })
      const clone = node.cloneNode(true) as HTMLElement
      const label = clone.querySelector('b')
      if (label) label.textContent = '点评生成失败，你可以重试。'
      clone.querySelectorAll('small').forEach((detail) => detail.remove())
      clone.removeAttribute('id')
      Object.assign(clone.style, { width: '100%', margin: '0', boxSizing: 'border-box' })
      stage.appendChild(clone)
      document.body.appendChild(stage)
    }, stageID)
  try {
    await page.locator(`#${stageID} > :first-child`).screenshot({
      path: outputPath,
      animations: 'disabled',
    })
  } finally {
    await page
      .locator(`#${stageID}`)
      .evaluate((node) => node.remove())
      .catch(() => {})
  }
}

async function captureNormalizedImageRoutingTarget(
  page: Page,
  selector: string,
  surface: 'reference' | 'currentSource',
  outputPath: string,
) {
  const stageID = `visual-image-routing-${Math.random().toString(36).slice(2)}`
  await page
    .locator(selector)
    .first()
    .evaluate(
      (node, options) => {
        const summary = node as HTMLElement
        const host = summary.closest<HTMLElement>('[data-component="ImageTaskRunStatus"]')
        if (!host) throw new Error(`${options.surface}: image-routing host is missing`)

        const stage = document.createElement('div')
        stage.id = options.id
        stage.dataset.visualNormalization = 'image-routing-status-line-white-stage'
        Object.assign(stage.style, {
          position: 'fixed',
          left: '0',
          top: '0',
          width: '137px',
          height: '30px',
          margin: '0',
          padding: '0',
          overflow: 'hidden',
          background: '#fff',
          zIndex: '2147483647',
        })
        const clone = host.cloneNode(true) as HTMLElement
        clone.removeAttribute('id')
        clone.style.margin = '0'
        clone.style.position = 'static'
        clone.style.transform = 'none'
        clone.style.animation = 'none'
        clone.style.transition = 'none'
        stage.appendChild(clone)
        document.body.appendChild(stage)
      },
      { id: stageID, surface },
    )
  try {
    await page.locator(`#${stageID}`).screenshot({ path: outputPath, animations: 'disabled' })
  } finally {
    await page
      .locator(`#${stageID}`)
      .evaluate((node) => node.remove())
      .catch(() => {})
  }
}

async function createBrowserPixelDiff(
  browser: Browser,
  referencePath: string,
  implementationPath: string,
  diffPath: string,
  threshold: number,
): Promise<PixelDiffReport> {
  const [reference, implementation] = await Promise.all([
    readFile(referencePath, 'base64'),
    readFile(implementationPath, 'base64'),
  ])
  const page = await browser.newPage()
  try {
    const result = await page.evaluate(
      async ({ referencePng, implementationPng, pixelThreshold }) => {
        const loadImage = (source: string) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image()
            image.onload = () => resolve(image)
            image.onerror = reject
            image.src = `data:image/png;base64,${source}`
          })
        const [referenceImage, implementationImage] = await Promise.all([
          loadImage(referencePng),
          loadImage(implementationPng),
        ])
        if (
          referenceImage.width !== implementationImage.width ||
          referenceImage.height !== implementationImage.height
        ) {
          throw new Error(
            `screenshot size mismatch: reference=${referenceImage.width}x${referenceImage.height}, implementation=${implementationImage.width}x${implementationImage.height}`,
          )
        }

        const width = referenceImage.width
        const height = referenceImage.height
        const sourceCanvas = document.createElement('canvas')
        sourceCanvas.width = width
        sourceCanvas.height = height
        const sourceContext = sourceCanvas.getContext('2d')
        if (!sourceContext) throw new Error('2D source canvas is unavailable')
        sourceContext.drawImage(referenceImage, 0, 0)
        const referencePixels = sourceContext.getImageData(0, 0, width, height).data
        sourceContext.clearRect(0, 0, width, height)
        sourceContext.drawImage(implementationImage, 0, 0)
        const implementationPixels = sourceContext.getImageData(0, 0, width, height).data

        const diffCanvas = document.createElement('canvas')
        diffCanvas.width = width
        diffCanvas.height = height
        const diffContext = diffCanvas.getContext('2d')
        if (!diffContext) throw new Error('2D diff canvas is unavailable')
        const output = diffContext.createImageData(width, height)
        let changedPixels = 0
        let minX = width
        let minY = height
        let maxX = -1
        let maxY = -1
        for (let index = 0; index < referencePixels.length; index += 4) {
          const changed =
            Math.max(
              Math.abs(referencePixels[index]! - implementationPixels[index]!),
              Math.abs(referencePixels[index + 1]! - implementationPixels[index + 1]!),
              Math.abs(referencePixels[index + 2]! - implementationPixels[index + 2]!),
              Math.abs(referencePixels[index + 3]! - implementationPixels[index + 3]!),
            ) > pixelThreshold
          const pixel = index / 4
          const x = pixel % width
          const y = Math.floor(pixel / width)
          if (changed) {
            changedPixels += 1
            minX = Math.min(minX, x)
            minY = Math.min(minY, y)
            maxX = Math.max(maxX, x)
            maxY = Math.max(maxY, y)
            output.data[index] = 255
            output.data[index + 1] = 35
            output.data[index + 2] = 35
          } else {
            const luminance = Math.round(
              (referencePixels[index]! * 0.299 +
                referencePixels[index + 1]! * 0.587 +
                referencePixels[index + 2]! * 0.114) *
                0.45,
            )
            output.data[index] = luminance
            output.data[index + 1] = luminance
            output.data[index + 2] = luminance
          }
          output.data[index + 3] = 255
        }
        diffContext.putImageData(output, 0, 0)
        return {
          png: diffCanvas.toDataURL('image/png').split(',')[1]!,
          width,
          height,
          threshold: pixelThreshold,
          changed_pixels: changedPixels,
          total_pixels: width * height,
          changed_pixel_ratio: width * height > 0 ? changedPixels / (width * height) : 0,
          changed_bbox: changedPixels > 0 ? ([minX, minY, maxX + 1, maxY + 1] as const) : null,
        }
      },
      {
        referencePng: reference,
        implementationPng: implementation,
        pixelThreshold: threshold,
      },
    )
    await writeFile(diffPath, Buffer.from(result.png, 'base64'))
    return {
      width: result.width,
      height: result.height,
      threshold: result.threshold,
      changed_pixels: result.changed_pixels,
      total_pixels: result.total_pixels,
      changed_pixel_ratio: result.changed_pixel_ratio,
      changed_bbox: result.changed_bbox ? [...result.changed_bbox] : null,
    }
  } finally {
    await page.close()
  }
}

async function collectImageRoutingTargetEvidence(
  page: Page,
  selector: string,
  surface: 'reference' | 'currentSource',
) {
  return page
    .locator(selector)
    .first()
    .evaluate((node, surfaceName) => {
      const summary = node as HTMLElement
      const host = summary.closest<HTMLElement>('[data-component="ImageTaskRunStatus"]')
      const spinner = summary.querySelector<HTMLElement>('.hc-typing-dots')
      if (!host || !spinner) throw new Error(`${surfaceName}: image-routing status is incomplete`)
      const dots = [...spinner.querySelectorAll<HTMLElement>('.hc-typing-dots__dot')]
      const rect = (element: Element) => {
        const box = element.getBoundingClientRect()
        return {
          x: Number(box.x.toFixed(2)),
          y: Number(box.y.toFixed(2)),
          width: Number(box.width.toFixed(2)),
          height: Number(box.height.toFixed(2)),
        }
      }
      const resolveThemeColor = (token: string) => {
        const probe = document.createElement('span')
        probe.style.color = `var(${token})`
        probe.style.display = 'none'
        document.body.appendChild(probe)
        const value = getComputedStyle(probe).color
        probe.remove()
        return value
      }
      const summaryStyle = getComputedStyle(summary)
      const hostStyle = getComputedStyle(host)
      const spinnerStyle = getComputedStyle(spinner)
      const summaryRect = summary.getBoundingClientRect()
      const visualChildren = [...summary.children]
        .map((child) => child.getBoundingClientRect())
        .filter((box) => box.width > 0 && box.height > 0)
      const visualRight = visualChildren.reduce(
        (right, box) => Math.max(right, box.right),
        summaryRect.left,
      )
      return {
        surface: surfaceName,
        text: summary.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        host: {
          role: host.getAttribute('role'),
          ariaLive: host.getAttribute('aria-live'),
          ariaAtomic: host.getAttribute('aria-atomic'),
          component: host.getAttribute('data-component'),
          rect: rect(host),
          style: {
            margin: hostStyle.margin,
            maxWidth: hostStyle.maxWidth,
          },
        },
        summary: {
          rect: rect(summary),
          visualLineRect: {
            x: Number(summaryRect.x.toFixed(2)),
            y: Number(summaryRect.y.toFixed(2)),
            width: Number((visualRight - summaryRect.left).toFixed(2)),
            height: Number(summaryRect.height.toFixed(2)),
          },
          style: {
            display: summaryStyle.display,
            alignItems: summaryStyle.alignItems,
            gap: summaryStyle.gap,
            padding: summaryStyle.padding,
            color: summaryStyle.color,
            fontSize: summaryStyle.fontSize,
            fontWeight: summaryStyle.fontWeight,
            lineHeight: summaryStyle.lineHeight,
            backgroundColor: summaryStyle.backgroundColor,
            borderWidth: summaryStyle.borderWidth,
            borderRadius: summaryStyle.borderRadius,
          },
        },
        spinner: {
          rect: rect(spinner),
          ariaHidden: spinner.closest('[aria-hidden="true"]')?.getAttribute('aria-hidden') ?? null,
          dotCount: dots.length,
          style: {
            display: spinnerStyle.display,
            alignItems: spinnerStyle.alignItems,
            gap: spinnerStyle.gap,
            padding: spinnerStyle.padding,
            backgroundColor: spinnerStyle.backgroundColor,
            borderWidth: spinnerStyle.borderWidth,
            borderRadius: spinnerStyle.borderRadius,
          },
          dots: dots.map((dot) => {
            const style = getComputedStyle(dot)
            return {
              rect: rect(dot),
              style: {
                backgroundColor: style.backgroundColor,
                borderRadius: style.borderRadius,
              },
            }
          }),
        },
        typingDotGroups: document.querySelectorAll('.hc-typing-dots').length,
        theme: {
          textSecondary: resolveThemeColor('--hc-text-secondary'),
          textMuted: resolveThemeColor('--hc-text-muted'),
        },
      }
    }, surface)
}

type ImageRoutingTargetEvidence = Awaited<ReturnType<typeof collectImageRoutingTargetEvidence>>

function validateImageRoutingTargetSide(evidence: ImageRoutingTargetEvidence) {
  const issues: string[] = []
  const expectValue = (actual: unknown, expected: unknown, invariant: string) => {
    if (actual !== expected) {
      issues.push(
        `${evidence.surface}: ${invariant} is ${String(actual)}, expected ${String(expected)}`,
      )
    }
  }
  const expectPixels = (actual: number, expected: number, invariant: string) => {
    if (Math.abs(actual - expected) > 0.01) {
      issues.push(`${evidence.surface}: ${invariant} is ${actual}px, expected ${expected}px`)
    }
  }
  expectValue(evidence.text, '正在识别图片内容', 'status text')
  expectValue(evidence.host.component, 'ImageTaskRunStatus', 'component identity')
  expectValue(evidence.host.role, 'status', 'status role')
  expectValue(evidence.host.ariaLive, 'polite', 'aria-live')
  expectValue(evidence.host.ariaAtomic, 'true', 'aria-atomic')
  expectValue(evidence.summary.style.display, 'grid', 'summary display')
  expectValue(evidence.summary.style.alignItems, 'start', 'summary align-items')
  expectValue(evidence.summary.style.gap, '8px', 'summary gap')
  expectValue(evidence.summary.style.padding, '0px', 'summary padding')
  expectValue(evidence.summary.style.color, evidence.theme.textSecondary, 'summary theme color')
  expectValue(evidence.summary.style.fontSize, '13px', 'summary font-size')
  expectValue(evidence.summary.style.fontWeight, '400', 'summary font-weight')
  expectValue(evidence.summary.style.lineHeight, '19.5px', 'summary line-height')
  expectValue(evidence.summary.style.backgroundColor, 'rgba(0, 0, 0, 0)', 'summary background')
  expectValue(evidence.summary.style.borderWidth, '0px', 'summary border width')
  expectValue(evidence.summary.style.borderRadius, '0px', 'summary border radius')
  expectPixels(evidence.summary.rect.height, 19.5, 'summary height')
  expectPixels(evidence.spinner.rect.width, 26, 'typing dots width')
  expectPixels(evidence.spinner.rect.height, 6, 'typing dots height')
  expectValue(evidence.spinner.ariaHidden, 'true', 'spinner aria-hidden')
  expectValue(evidence.spinner.dotCount, 3, 'typing dot count')
  expectValue(evidence.spinner.style.display, 'flex', 'typing dots display')
  expectValue(evidence.spinner.style.alignItems, 'center', 'typing dots alignment')
  expectValue(evidence.spinner.style.gap, '4px', 'typing dots gap')
  expectValue(evidence.spinner.style.padding, '0px', 'typing dots padding')
  expectValue(evidence.spinner.style.backgroundColor, 'rgba(0, 0, 0, 0)', 'typing dots background')
  expectValue(evidence.spinner.style.borderWidth, '0px', 'typing dots border')
  for (const [index, dot] of evidence.spinner.dots.entries()) {
    expectPixels(dot.rect.width, 6, `typing dot ${index + 1} width`)
    expectPixels(dot.rect.height, 6, `typing dot ${index + 1} height`)
    expectValue(dot.style.borderRadius, '50%', `typing dot ${index + 1} radius`)
    expectValue(
      dot.style.backgroundColor,
      evidence.theme.textMuted,
      `typing dot ${index + 1} color`,
    )
  }
  expectValue(evidence.typingDotGroups, 1, 'typing dot group exact-set')
  return issues
}

async function compareImageRoutingTarget(
  referencePage: Page,
  currentSourcePage: Page,
  referenceSelector: string,
  currentSourceSelector: string,
) {
  const [reference, currentSource] = await Promise.all([
    collectImageRoutingTargetEvidence(referencePage, referenceSelector, 'reference'),
    collectImageRoutingTargetEvidence(currentSourcePage, currentSourceSelector, 'currentSource'),
  ])
  const issues = [
    ...validateImageRoutingTargetSide(reference),
    ...validateImageRoutingTargetSide(currentSource),
  ]
  const contextualDifferences: string[] = []
  for (const dimension of ['width', 'height'] as const) {
    if (
      Math.abs(
        reference.summary.visualLineRect[dimension] -
          currentSource.summary.visualLineRect[dimension],
      ) > 0.01
    ) {
      const target = dimension === 'width' ? contextualDifferences : issues
      target.push(
        `status-line ${dimension} differs: ${reference.summary.visualLineRect[dimension]} != ${currentSource.summary.visualLineRect[dimension]}`,
      )
    }
    if (Math.abs(reference.host.rect[dimension] - currentSource.host.rect[dimension]) > 0.01) {
      const target = dimension === 'width' ? contextualDifferences : issues
      target.push(
        `status host ${dimension} differs: ${reference.host.rect[dimension]} != ${currentSource.host.rect[dimension]}`,
      )
    }
  }
  for (const key of [
    'alignItems',
    'gap',
    'padding',
    'color',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'backgroundColor',
    'borderWidth',
    'borderRadius',
  ] as const) {
    if (reference.summary.style[key] !== currentSource.summary.style[key]) {
      issues.push(
        `status-line ${key} differs: ${reference.summary.style[key]} != ${currentSource.summary.style[key]}`,
      )
    }
  }
  for (const key of [
    'display',
    'alignItems',
    'gap',
    'padding',
    'backgroundColor',
    'borderWidth',
    'borderRadius',
  ] as const) {
    if (reference.spinner.style[key] !== currentSource.spinner.style[key]) {
      const difference = `typing dots ${key} differs: ${reference.spinner.style[key]} != ${currentSource.spinner.style[key]}`
      if (
        key === 'borderRadius' &&
        reference.spinner.style.borderWidth === '0px' &&
        currentSource.spinner.style.borderWidth === '0px' &&
        reference.spinner.style.backgroundColor === 'rgba(0, 0, 0, 0)' &&
        currentSource.spinner.style.backgroundColor === 'rgba(0, 0, 0, 0)'
      ) {
        contextualDifferences.push(difference)
      } else {
        issues.push(difference)
      }
    }
  }
  return {
    classification: 'COMPARABLE_TARGET' as const,
    normalization: 'status-line-only crop; conversation and business data excluded',
    reference,
    currentSource,
    contextualDifferences,
    issues,
  }
}

function taskShellFooterSideEvidence(
  geometry: Record<string, unknown[]>,
  surface: 'reference' | 'currentSource',
  expectedToolbarWidth: number,
) {
  const selectors =
    surface === 'reference'
      ? {
          footer: '[data-k12-task-shell-footer]:visible',
          metadata: '[data-k12-task-shell-footer] > .msg-meta:visible',
          actions: '[data-k12-task-shell-footer] > .msg-actions--assistant:visible',
        }
      : {
          footer: '[data-testid="task-shell-footer"]:visible',
          metadata:
            '[data-testid="task-shell-footer"] > [data-testid="task-shell-metadata"]:visible',
          actions: '[data-testid="task-shell-footer"] > .hc-msg-actions--assistant:visible',
        }
  const footer = geometry[selectors.footer]?.[0] as GeometryNode | undefined
  const metadata = geometry[selectors.metadata]?.[0] as GeometryNode | undefined
  const actions = geometry[selectors.actions]?.[0] as GeometryNode | undefined
  const issues: string[] = []

  if (!footer) issues.push(`${surface}: TaskShell footer bbox/computed style missing`)
  if (!metadata) issues.push(`${surface}: TaskShell metadata bbox/computed style missing`)
  if (!actions) issues.push(`${surface}: TaskShell actions bbox/computed style missing`)

  const metadataToActionsGap =
    metadata && actions
      ? Number((actions.rect.x - (metadata.rect.x + metadata.rect.width)).toFixed(2))
      : null
  const actionsTrailingSpace =
    footer && actions
      ? Number(
          (footer.rect.x + footer.rect.width - (actions.rect.x + actions.rect.width)).toFixed(2),
        )
      : null

  if (footer && footer.style.display !== 'flex') {
    issues.push(`${surface}: TaskShell footer display is ${footer.style.display}, expected flex`)
  }
  if (footer && footer.style.position !== 'relative') {
    issues.push(
      `${surface}: TaskShell footer position is ${footer.style.position}, expected relative`,
    )
  }
  if (footer && Math.abs(footer.rect.height - 24) > 0.01) {
    issues.push(`${surface}: TaskShell footer height is ${footer.rect.height}px, expected 24px`)
  }
  if (footer && footer.style.minHeight !== '24px') {
    issues.push(
      `${surface}: TaskShell footer min-height is ${footer.style.minHeight}, expected 24px`,
    )
  }
  if (footer && footer.style.padding !== '0px') {
    issues.push(`${surface}: TaskShell footer padding is ${footer.style.padding}, expected 0px`)
  }
  if (footer && footer.style.marginTop !== '7px') {
    issues.push(
      `${surface}: TaskShell footer margin-top is ${footer.style.marginTop}, expected 7px`,
    )
  }
  if (footer && footer.style.gap !== '8px') {
    issues.push(`${surface}: TaskShell footer computed gap is ${footer.style.gap}, expected 8px`)
  }
  if (footer?.style.justifyContent === 'space-between') {
    issues.push(`${surface}: TaskShell footer must not use space-between`)
  }
  if (metadataToActionsGap !== null && Math.abs(metadataToActionsGap - 8) > 0.01) {
    issues.push(
      `${surface}: TaskShell actions bbox starts ${metadataToActionsGap}px after metadata, expected 8px`,
    )
  }
  if (actionsTrailingSpace !== null && actionsTrailingSpace <= 0) {
    issues.push(`${surface}: TaskShell actions are pinned to the footer row end`)
  }
  if (
    actions &&
    (actions.style.marginLeft === 'auto' || actions.style.marginInlineStart === 'auto')
  ) {
    issues.push(`${surface}: TaskShell actions must not use an automatic start margin`)
  }
  if (metadata && metadata.style.gap !== '0px') {
    issues.push(`${surface}: TaskShell metadata gap is ${metadata.style.gap}, expected 0px`)
  }
  if (metadata && metadata.style.fontSize !== '11px') {
    issues.push(
      `${surface}: TaskShell metadata font-size is ${metadata.style.fontSize}, expected 11px`,
    )
  }
  if (metadata && metadata.style.opacity !== '0.64') {
    issues.push(
      `${surface}: TaskShell metadata opacity is ${metadata.style.opacity}, expected 0.64`,
    )
  }
  if (metadata && metadata.style.whiteSpace !== 'nowrap') {
    issues.push(
      `${surface}: TaskShell metadata white-space is ${metadata.style.whiteSpace}, expected nowrap`,
    )
  }
  if (actions && Math.abs(actions.rect.width - expectedToolbarWidth) > 0.01) {
    issues.push(
      `${surface}: TaskShell toolbar width is ${actions.rect.width}px, expected ${expectedToolbarWidth}px`,
    )
  }
  if (actions && Math.abs(actions.rect.height - 24) > 0.01) {
    issues.push(`${surface}: TaskShell toolbar height is ${actions.rect.height}px, expected 24px`)
  }
  if (actions && actions.style.borderRadius !== '8px') {
    issues.push(
      `${surface}: TaskShell toolbar border-radius is ${actions.style.borderRadius}, expected 8px`,
    )
  }

  return {
    footer: footer ? { rect: footer.rect, style: footer.style } : null,
    metadata: metadata ? { rect: metadata.rect, style: metadata.style } : null,
    actions: actions ? { rect: actions.rect, style: actions.style } : null,
    metadataToActionsGap,
    actionsTrailingSpace,
    issues,
  }
}

function compareTaskShellFooterTarget(
  stateName: string,
  referenceGeometry: Record<string, unknown[]>,
  currentSourceGeometry: Record<string, unknown[]>,
) {
  const expectedToolbarWidth = ACTION_TOOLBAR_CONTRACTS[stateName]?.width
  if (!expectedToolbarWidth) throw new Error(`missing TaskShell toolbar width for ${stateName}`)
  const reference = taskShellFooterSideEvidence(
    referenceGeometry,
    'reference',
    expectedToolbarWidth,
  )
  const currentSource = taskShellFooterSideEvidence(
    currentSourceGeometry,
    'currentSource',
    expectedToolbarWidth,
  )
  const issues = [...reference.issues, ...currentSource.issues]
  return {
    classification: 'COMPARABLE_TARGET' as const,
    status: issues.length === 0 ? ('PASS' as const) : ('RED' as const),
    invariant: 'actions bbox follows metadata by 8px and retains trailing row space',
    reference,
    currentSource,
    issues,
  }
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
  const accept = (box: { y: number }) => {
    // Chromium 的 scrollTop 只接受整数像素，亚像素残差不可滚动收敛；
    // 截图为整数像素采样，≤0.75px 残差视为已对齐。
    if (Math.abs(box.y - targetY) <= 0.75) return true
    return false
  }
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
    if (accept(box)) return box
    await host.evaluate(
      async (element, scrollAdjustment) => {
        element.scrollTop += scrollAdjustment
        element.dispatchEvent(new Event('scroll', { bubbles: true }))
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
      },
      Math.sign(residual) * Math.max(1, Math.round(Math.abs(residual))),
    )
  }
  const box = await root.boundingBox()
  if (box && accept(box)) return box
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
  })
  expect(Math.abs(evidence.rootYDelta)).toBeLessThanOrEqual(0.75)
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
  const targetReferencePath = path.join(outputDir, 'target-reference.png')
  const targetCurrentSourcePath = path.join(outputDir, 'target-current-source.png')
  const targetDiffPath = path.join(outputDir, 'target-pixel-diff.png')
  const targetRatioPath = path.join(outputDir, 'target-ratio.json')

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
  let taskShellFooterTarget: ReturnType<typeof compareTaskShellFooterTarget> | null = null
  let actionToolbarTarget: Awaited<ReturnType<typeof compareActionToolbarTarget>> | null = null
  let imageRoutingTarget: Awaited<ReturnType<typeof compareImageRoutingTarget>> | null = null
  let creativeFailureTarget: Awaited<ReturnType<typeof compareCreativeFailureTarget>> | null = null
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
      const [alignReferenceBox, alignCurrentSourceBox] = await Promise.all([
        referencePage.locator(state.referenceSelector!).first().boundingBox(),
        currentSourcePage.locator(state.implementationSelector!).first().boundingBox(),
      ])
      if (!alignReferenceBox || !alignCurrentSourceBox) {
        throw new Error('expected process-issue roots to expose aligned boxes')
      }
      const alignDelta = alignCurrentSourceBox.y - alignReferenceBox.y
      if (Math.abs(alignDelta) > 0.01) {
        await referencePage
          .locator(state.referenceSelector!)
          .first()
          .evaluate((node, offset) => {
            const el = node as HTMLElement
            el.style.position = 'relative'
            el.style.top = `${offset}px`
          }, alignDelta)
        await Promise.all([
          referencePage.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              ),
          ),
          currentSourcePage.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              ),
          ),
        ])
      }
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

    if (TASK_SHELL_FOOTER_TARGET_STATES.has(state.name)) {
      taskShellFooterTarget = compareTaskShellFooterTarget(
        state.name,
        referenceGeometry,
        currentSourceGeometry,
      )
    }
    if (ACTION_TOOLBAR_TARGET_STATES.has(state.name)) {
      actionToolbarTarget = await compareActionToolbarTarget(
        state.name,
        referencePage,
        currentSourcePage,
      )
      const selectors = actionToolbarSelectors(state.name)
      const expectedWidth = ACTION_TOOLBAR_CONTRACTS[state.name]!.width
      await Promise.all([
        captureNormalizedActionToolbar(
          referencePage,
          selectors.reference,
          targetReferencePath,
          expectedWidth,
        ),
        captureNormalizedActionToolbar(
          currentSourcePage,
          selectors.currentSource,
          targetCurrentSourcePath,
          expectedWidth,
        ),
      ])
    }
    if (state.name === IMAGE_ROUTING_TARGET_STATE) {
      imageRoutingTarget = await compareImageRoutingTarget(
        referencePage,
        currentSourcePage,
        state.referenceSelector!,
        state.implementationSelector!,
      )
      await Promise.all([
        captureNormalizedImageRoutingTarget(
          referencePage,
          state.referenceSelector!,
          'reference',
          targetReferencePath,
        ),
        captureNormalizedImageRoutingTarget(
          currentSourcePage,
          state.implementationSelector!,
          'currentSource',
          targetCurrentSourcePath,
        ),
      ])
    }
    if (state.name === CREATIVE_FEEDBACK_FAILURE_STATE) {
      creativeFailureTarget = await compareCreativeFailureTarget(
        referencePage,
        currentSourcePage,
        state.referenceSelector!,
        state.implementationSelector!,
      )
      await Promise.all([
        captureNormalizedCreativeFailureTarget(
          referencePage,
          state.referenceSelector!,
          targetReferencePath,
        ),
        captureNormalizedCreativeFailureTarget(
          currentSourcePage,
          state.implementationSelector!,
          targetCurrentSourcePath,
        ),
      ])
    }

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
        Math.abs(referenceBox.y - currentSourceBox.y) > 0.75 ||
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
          taskShellFooterTarget,
          actionToolbarTarget,
          imageRoutingTarget,
          creativeFailureTarget,
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
    diffReport = await createBrowserPixelDiff(
      browser,
      referencePath,
      currentSourcePath,
      diffPath,
      PIXEL_THRESHOLD,
    )
    await writeFile(ratioPath, JSON.stringify(diffReport, null, 2))
  } catch (cause) {
    runtimeError ||= cause instanceof Error ? cause.stack || cause.message : String(cause)
    await writeFile(ratioPath, JSON.stringify({ error: runtimeError }, null, 2))
  }

  let targetDiffReport: PixelDiffReport | null = null
  if (
    ACTION_TOOLBAR_TARGET_STATES.has(state.name) ||
    state.name === IMAGE_ROUTING_TARGET_STATE ||
    state.name === CREATIVE_FEEDBACK_FAILURE_STATE
  ) {
    try {
      targetDiffReport = await createBrowserPixelDiff(
        browser,
        targetReferencePath,
        targetCurrentSourcePath,
        targetDiffPath,
        PIXEL_THRESHOLD,
      )
      await writeFile(targetRatioPath, JSON.stringify(targetDiffReport, null, 2))
    } catch (cause) {
      const targetError = cause instanceof Error ? cause.stack || cause.message : String(cause)
      runtimeError ||= targetError
      await writeFile(targetRatioPath, JSON.stringify({ error: targetError }, null, 2))
    }
  }

  const missingExpectedSurface =
    (!!state.referenceSelector && !referenceTargetVisible) ||
    (!!state.implementationSelector && !currentSourceTargetVisible)
  const processIssueMaterialIssues = [
    ...(processIssueSemanticEvidence?.issues ?? []),
    ...(processIssueGeometryComparison?.issues ?? []),
  ]
  const targetMaterialIssues = [
    ...(taskShellFooterTarget?.issues ?? []),
    ...(actionToolbarTarget?.issues ?? []),
    ...(imageRoutingTarget?.issues ?? []),
    ...(creativeFailureTarget?.issues ?? []),
  ]
  const materialIssues = [...processIssueMaterialIssues, ...targetMaterialIssues]
  const gatedPixelDiff =
    state.name === IMAGE_ROUTING_TARGET_STATE || state.name === CREATIVE_FEEDBACK_FAILURE_STATE
      ? targetDiffReport
      : diffReport
  const status =
    runtimeError || missingExpectedSurface
      ? 'BLOCKED'
      : state.classification === 'NOT_COMPARABLE'
        ? 'NOT_COMPARABLE'
        : gatedPixelDiff &&
            gatedPixelDiff.changed_pixel_ratio <= 0.001 &&
            materialIssues.length === 0
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
            : state.name === IMAGE_ROUTING_TARGET_STATE
              ? 'approved-status-line-target; full viewport is evidence-only'
              : state.name === CREATIVE_FEEDBACK_FAILURE_STATE
                ? 'approved-TaskShell-lightweight-activity-target; business content normalized'
                : 'full-viewport',
        processIssueTargetCrop,
        processIssueExternalUiEvidence,
        pixelDiff: diffReport,
        semanticEvidence: processIssueSemanticEvidence,
        criticalGeometryIssueCount: processIssueGeometryComparison?.issues.length ?? 0,
        comparableTargets: {
          taskShellFooter: taskShellFooterTarget,
          actionToolbar: actionToolbarTarget
            ? {
                ...actionToolbarTarget,
                pixelDiff: targetDiffReport,
                pixelDiffGate:
                  'evidence-only; scoped acceptance is the approved DOM, bbox and computed-style contract',
              }
            : null,
          imageRouting: imageRoutingTarget
            ? {
                ...imageRoutingTarget,
                pixelDiff: targetDiffReport,
                pixelDiffGate: 'approved status-line target only; business content excluded',
              }
            : null,
          creativeFailure: creativeFailureTarget
            ? {
                ...creativeFailureTarget,
                pixelDiff: targetDiffReport,
                pixelDiffGate:
                  'shared TaskShell lightweight activity target with normalized business copy',
              }
            : null,
        },
        materialIssues,
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
  if (
    ACTION_TOOLBAR_TARGET_STATES.has(state.name) ||
    state.name === IMAGE_ROUTING_TARGET_STATE ||
    state.name === CREATIVE_FEEDBACK_FAILURE_STATE
  ) {
    for (const [name, file, contentType] of [
      ['target-reference', targetReferencePath, 'image/png'],
      ['target-current-source', targetCurrentSourcePath, 'image/png'],
      ['target-pixel-diff', targetDiffPath, 'image/png'],
      ['target-ratio', targetRatioPath, 'application/json'],
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
  if (TASK_SHELL_FOOTER_TARGET_STATES.has(state.name)) {
    expect
      .soft(
        taskShellFooterTarget?.issues ?? ['TaskShell footer target was not captured'],
        `${state.name} TaskShell footer must keep actions 8px after metadata and off the row end; see ${statusPath}`,
      )
      .toEqual([])
  }
  if (ACTION_TOOLBAR_TARGET_STATES.has(state.name)) {
    expect
      .soft(
        targetDiffReport,
        `${state.name} action toolbar must emit a target pixel diff; see ${targetRatioPath}`,
      )
      .not.toBeNull()
    expect
      .soft(
        actionToolbarTarget?.issues ?? ['action toolbar target was not captured'],
        `${state.name} action toolbar must match the approved DOM/bbox/computed-style contract; see ${statusPath}`,
      )
      .toEqual([])
  }
  if (state.name === IMAGE_ROUTING_TARGET_STATE) {
    expect
      .soft(
        targetDiffReport,
        `${state.name} status line must emit a target pixel diff; see ${targetRatioPath}`,
      )
      .not.toBeNull()
    expect
      .soft(
        imageRoutingTarget?.issues ?? ['image-routing target was not captured'],
        `${state.name} status line must match the approved DOM/bbox/computed-style contract; see ${statusPath}`,
      )
      .toEqual([])
    if (targetDiffReport) {
      expect
        .soft(
          targetDiffReport.changed_pixel_ratio,
          `${state.name} status-line pixels must match the prototype; see ${targetRatioPath}`,
        )
        .toBeLessThanOrEqual(0.001)
    }
  }
  if (state.name === CREATIVE_FEEDBACK_FAILURE_STATE) {
    expect
      .soft(
        targetDiffReport,
        `${state.name} failure activity must emit a target pixel diff; see ${targetRatioPath}`,
      )
      .not.toBeNull()
    expect
      .soft(
        creativeFailureTarget?.issues ?? ['creative failure target was not captured'],
        `${state.name} failure activity and exact-set must match the approved contract; see ${statusPath}`,
      )
      .toEqual([])
    if (targetDiffReport) {
      expect
        .soft(
          targetDiffReport.changed_pixel_ratio,
          `${state.name} normalized activity pixels must match the prototype; see ${targetRatioPath}`,
        )
        .toBeLessThanOrEqual(0.001)
    }
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
    comparableTargets: {
      taskShellFooter: taskShellFooterTarget,
      actionToolbar: actionToolbarTarget
        ? {
            ...actionToolbarTarget,
            pixelDiff: targetDiffReport,
            pixelDiffGate:
              'evidence-only; scoped acceptance is the approved DOM, bbox and computed-style contract',
          }
        : null,
      imageRouting: imageRoutingTarget
        ? {
            ...imageRoutingTarget,
            pixelDiff: targetDiffReport,
            pixelDiffGate: 'approved status-line target only; business content excluded',
          }
        : null,
      creativeFailure: creativeFailureTarget
        ? {
            ...creativeFailureTarget,
            pixelDiff: targetDiffReport,
            pixelDiffGate:
              'shared TaskShell lightweight activity target with normalized business copy',
          }
        : null,
    },
    materialIssues,
    runtimeError: runtimeError || null,
    acceptance: status === 'PASS' ? 'PASS' : 'NOT PASS',
    evidenceDir: outputDir,
  }
}

test.describe('feat/v0.5.0-k12-parent-tutor · K12 chat authoritative state matrix', () => {
  test('C02 process issue keeps its source task through fixture recovery refresh', async ({
    browser,
  }) => {
    test.skip(
      REQUESTED_STATE !== '08b-photo-process-issue',
      'runs only for the C02 process fixture',
    )
    const page = await browser.newPage()
    const processOverlay = page.locator(
      '[data-testid="photo-grade-overlay"][data-assessment-status="correct_with_process_issue"]',
    )
    try {
      const fixture = await openCurrentSource(page, 'homework-process-issue')
      expect(fixture.sourceMessagePersisted).toBe(true)
      expect(fixture.imageTaskCreated).toBe(true)
      await expect(processOverlay).toBeVisible()

      await page.waitForTimeout(12_000)
      await expect(processOverlay).toBeVisible({ timeout: 5_000 })
    } finally {
      await page.close()
    }
  })

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
