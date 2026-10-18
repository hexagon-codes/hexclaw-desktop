import { i18n } from '@/i18n'

type ErrorRecord = Record<string, unknown>
type MessageParams = Record<string, string | number>

const genericCodes = new Set(['UNKNOWN', 'SERVER_ERROR', 'VALIDATION_ERROR', 'BAD_REQUEST', 'NOT_FOUND', 'INTERNAL_ERROR'])

const nativeCodes: Record<string, string> = {
  workflow_directory_save_failed: 'DELIVERY_DIRECTORY_FAILED',
  workflow_directory_unavailable: 'DELIVERY_DIRECTORY_UNAVAILABLE',
  workflow_backend_changed: 'WORKFLOW_BACKEND_CHANGED',
  workflow_network_unavailable: 'NETWORK_ERROR',
  workflow_file_unavailable: 'OUTPUT_FILE_UNAVAILABLE',
  workflow_digest_mismatch: 'OUTPUT_DIGEST_MISMATCH',
  workflow_file_conflict: 'DELIVERY_DIRECTORY_CONFLICT',
}

const messageCodes: Record<string, string> = {
  'A workflow definition is required': 'WORKFLOW_DEFINITION_REQUIRED',
  'Workflow not found': 'WORKFLOW_NOT_FOUND',
  'Workflow run was not found': 'WORKFLOW_RUN_NOT_FOUND',
  'Workflow could not be saved': 'WORKFLOW_PERSIST_FAILED',
  'Workflow name is required': 'WORKFLOW_NAME_REQUIRED',
  'Select an existing Webhook endpoint': 'WEBHOOK_REQUIRED',
  'Workflow timeout must be a finite positive number of minutes': 'WORKFLOW_TIMEOUT_INVALID',
  'Select a model': 'MODEL_REQUIRED',
  'Step task is required': 'STEP_TASK_REQUIRED',
  'Select a tool': 'TOOL_REQUIRED',
  'Configure at least two complete parallel tasks': 'PARALLEL_TASKS_REQUIRED',
  'Each parallel branch must select an Agent': 'PARALLEL_AGENT_REQUIRED',
  'Parallel group has no Agent branches': 'PARALLEL_TASKS_REQUIRED',
  'Input source must refer to an earlier step': 'INPUT_SOURCE_INVALID',
  'Tool arguments must be a JSON object': 'TOOL_ARGS_INVALID',
  'Invalid workflow import response': 'WORKFLOW_IMPORT_INVALID_RESPONSE',
  'Invalid workflow export response': 'WORKFLOW_EXPORT_INVALID_RESPONSE',
  'This run has no source conversation; select the workflow conversation': 'DELIVERY_SOURCE_MISSING',
  'Unsupported workflow conversation mode': 'DELIVERY_SESSION_MODE_INVALID',
  'A DingTalk instance and bound conversation are required': 'DELIVERY_DINGTALK_TARGET_REQUIRED',
  'DingTalk workflow delivery supports direct conversations only': 'DELIVERY_DINGTALK_DIRECT_ONLY',
  'DingTalk workflow delivery supports text, images and PDF files': 'DELIVERY_DINGTALK_FORMAT_UNSUPPORTED',
  'DingTalk file delivery requires an existing image or PDF, or a selected PDF output': 'DINGTALK_FILES_REQUIRED',
  'DingTalk message delivery requires workflow text content': 'DINGTALK_MESSAGE_REQUIRED',
  'DingTalk workflow delivery mode is unsupported': 'DINGTALK_MODE_INVALID',
  'Generated file storage is unavailable': 'OUTPUT_PERSIST_FAILED',
  'Workflow artifact bytes are missing': 'OUTPUT_FILE_UNAVAILABLE',
  'Workflow output contains no deliverable content': 'OUTPUT_CONTENT_REQUIRED',
  'Workflow conversation is unavailable': 'DELIVERY_SESSION_UNAVAILABLE',
  'Workflow conversation does not belong to this user or no longer exists': 'DELIVERY_SESSION_UNAVAILABLE',
  'Workflow conversation message identity conflicts with an existing result': 'DELIVERY_SESSION_CONFLICT',
  'Workflow conversation message could not be checked': 'DELIVERY_SESSION_CHECK_FAILED',
  'Workflow conversation message could not be persisted': 'DELIVERY_SESSION_PERSIST_FAILED',
  'Workflow artifact file is unavailable': 'OUTPUT_FILE_UNAVAILABLE',
  'Workflow artifact file could not be read': 'OUTPUT_FILE_UNAVAILABLE',
  'Workflow artifact file no longer matches the frozen output': 'OUTPUT_DIGEST_MISMATCH',
  'Workflow delivery artifact could not be matched to the frozen part': 'OUTPUT_DIGEST_MISMATCH',
  'DingTalk workflow attachment preparation failed': 'DELIVERY_DINGTALK_PREPARE_FAILED',
  'DingTalk workflow delivery failed; inspect its status before retrying': 'DELIVERY_DINGTALK_FAILED',
  'Delivery has no provider receipt; it cannot be resent automatically': 'DELIVERY_OUTCOME_UNKNOWN',
  'Delivery was interrupted after entering the provider boundary': 'DELIVERY_OUTCOME_UNKNOWN',
  'Workflow output file was not found': 'OUTPUT_FILE_UNAVAILABLE',
  'Workflow output file is already active': 'OUTPUT_NOT_RETRYABLE',
  'Required workflow output files are not ready': 'OUTPUT_FILES_NOT_READY',
  'Workflow directory delivery requires at least one output file': 'OUTPUT_FILES_REQUIRED',
  'Workflow output file is unavailable': 'OUTPUT_FILE_UNAVAILABLE',
  'Workflow output file could not be opened': 'OUTPUT_FILE_UNAVAILABLE',
  'Workflow output file no longer matches its frozen digest': 'OUTPUT_DIGEST_MISMATCH',
  'Workflow desktop delivery is not pending': 'DELIVERY_NOT_RETRYABLE',
  'Workflow delivery was not found': 'DELIVERY_NOT_FOUND',
  'Workflow delivery part was not found': 'DELIVERY_NOT_FOUND',
  'Workflow delivery is already active': 'DELIVERY_NOT_RETRYABLE',
  'Workflow delivery part is already active': 'DELIVERY_NOT_RETRYABLE',
  'Workflow email is already active': 'DELIVERY_NOT_RETRYABLE',
  'Workflow Skill loading is unavailable': 'SKILLS_UNAVAILABLE',
  'Knowledge retrieval is unavailable': 'KNOWLEDGE_UNAVAILABLE',
  'MCP tools are unavailable': 'TOOLS_UNAVAILABLE',
  'Workflow output must be a JSON object': 'OUTPUT_JSON_REQUIRED',
  'Workflow output contains no actual artifact references': 'OUTPUT_FILES_REQUIRED',
  'Workflow output has no artifacts of the requested kind': 'OUTPUT_ARTIFACT_KIND_INVALID',
  'Selected workflow input contains no artifact references': 'INPUT_ARTIFACT_REQUIRED',
  'Workflow artifact reference is incomplete': 'INPUT_ARTIFACT_INVALID',
  'Unsupported workflow input selection kind': 'INPUT_SELECTION_INVALID',
  'Workflow output object requires a string value': 'OUTPUT_STRING_REQUIRED',
  'Workflow output object must contain one named string field': 'OUTPUT_FIELD_INVALID',
  'Workflow output object must map a named field to the selected value': 'OUTPUT_FIELD_INVALID',
  'Agent returned no response': 'AGENT_EMPTY_RESPONSE',
  'engine 未初始化': 'ENGINE_UNAVAILABLE',
  'mcp manager 未初始化': 'TOOLS_UNAVAILABLE',
  'tool 节点缺少 tool 名称': 'TOOL_REQUIRED',
}

function asRecord(value: unknown): ErrorRecord | undefined {
  return value && typeof value === 'object' ? value as ErrorRecord : undefined
}

function translateCode(code: string, params: MessageParams = {}): string | undefined {
  const key = `workflow.errors.${nativeCodes[code] ?? code}`
  return i18n.global.te(key) ? i18n.global.t(key, params) : undefined
}

function messageText(message: string): string | undefined {
  const code = messageCodes[message]
  if (code) return translateCode(code)
  const limit = message.match(/^(.+) must be (\d+) (characters|bytes) or fewer\.$/)
  if (limit) {
    const labels: Record<string, string> = {
      'Workflow name': 'workflowName', 'Step name': 'stepName', Prompt: 'task', 'Input content': 'input',
      Model: 'model', Agent: 'agent', 'Tool name': 'tool', Role: 'agent', Description: 'description',
      'Workflow description': 'description', 'Step label': 'stepName', 'Step task': 'task',
    }
    const label = labels[limit[1]!]
    return translateCode(limit[3] === 'bytes' ? 'INPUT_LIMIT_BYTES' : 'INPUT_LIMIT_CHARACTERS', {
      field: i18n.global.t(`workflow.errors.fields.${label ?? 'value'}`), limit: limit[2]!,
    })
  }
  const parameterMessages: Array<[RegExp, string]> = [
    [/^Selected Agent is unavailable: (.+)$/, 'AGENT_UNAVAILABLE'],
    [/^Workflow output is missing field: (.+)$/, 'OUTPUT_FIELD_MISSING'],
    [/^Workflow output field has an unexpected type: (.+)$/, 'OUTPUT_FIELD_TYPE_INVALID'],
    [/^Workflow input field is missing: (.+)$/, 'INPUT_FIELD_MISSING'],
    [/^Workflow input (?:index is invalid|field cannot be selected): (.+)$/, 'INPUT_FIELD_INVALID'],
    [/^Resource is not available on this service: (.+)$/, 'RESOURCE_UNAVAILABLE_NAMED'],
    [/^Unsupported workflow node type: (.+)$/, 'UNSUPPORTED_NODE_NAMED'],
    [/^Unsupported Coze node type: (.+)$/, 'UNSUPPORTED_COZE_NODE_NAMED'],
    [/^Coze prompt uses an unmapped variable: (.+)$/, 'UNSUPPORTED_COZE_TEMPLATE_NAMED'],
    [/^(?:Invalid workflow configuration: )?Prompt is unavailable: (.+)$/, 'PROMPT_UNAVAILABLE'],
    [/^(?:Invalid workflow configuration: )?Knowledge document is unavailable: (.+)$/, 'KNOWLEDGE_DOCUMENT_UNAVAILABLE'],
    [/^(?:Invalid workflow configuration: )?Tool is unavailable: (.+)$/, 'TOOL_UNAVAILABLE'],
    [/^workflow node id 重复: (.+)$/, 'NODE_ID_DUPLICATE'],
    [/^workflow node\[(\d+)\] 缺少 id$/, 'NODE_ID_MISSING'],
    [/^workflow edge 引用了不存在的节点: (.+)$/, 'EDGE_NODE_MISSING'],
  ]
  for (const [pattern, key] of parameterMessages) {
    const match = message.match(pattern)
    if (match) return translateCode(key, { value: match[1]! })
  }
  if (/^Selected workflow input is not valid JSON:/.test(message)) return translateCode('INPUT_JSON_INVALID')
  if (message === 'workflow DAG 存在环或不可达依赖') return translateCode('INVALID_GRAPH')
  if (/^(?:Invalid workflow configuration: )?Workflow timeout must be a finite positive number of minutes$/.test(message)) return translateCode('WORKFLOW_TIMEOUT_INVALID')
  if (/^Invalid workflow configuration:/.test(message)) return translateCode('INVALID_WORKFLOW_CONFIG')
  if (/^Workflow artifact is unavailable:/.test(message)) return translateCode('OUTPUT_FILE_UNAVAILABLE')
  if (/^Invalid (?:frozen workflow resources|workflow artifact content):/.test(message)) return translateCode('INVALID_WORKFLOW_CONFIG')
  return undefined
}

/** 仅翻译展示层；原始错误、错误码与服务端诊断保持在调用者的数据中。 */
export function workflowErrorText(value: unknown, explicitCode?: string): string {
  const records: ErrorRecord[] = []
  const messages: string[] = []
  const codes: string[] = explicitCode ? [explicitCode] : []
  const queue: unknown[] = [value]
  const visited = new Set<unknown>()
  while (queue.length && visited.size < 32) {
    const current = queue.shift()
    if (typeof current === 'string') {
      messages.push(current)
      // 原生命令可能把结构化错误作为 JSON 字符串返回。
      if (current.trim().startsWith('{')) {
        try { const parsed: unknown = JSON.parse(current); if (asRecord(parsed)) queue.push(parsed) } catch { /* 非 JSON 诊断按普通文本保留。 */ }
      }
      continue
    }
    const record = asRecord(current)
    if (!record || visited.has(record)) continue
    visited.add(record)
    records.push(record)
    if (typeof record.code === 'string') codes.push(record.code)
    if (typeof record.message === 'string') messages.push(record.message)
    if (typeof record.error === 'string') messages.push(record.error)
    // HTTP 包装层和本机调用都可能保留各自的 cause/data。
    queue.push(record.data, record.cause, record.error, asRecord(record.response)?._data)
    if (Array.isArray(record.issues)) queue.unshift(...record.issues)
  }
  for (const code of codes) {
    if (genericCodes.has(code)) continue
    if (['INVALID_WORKFLOW_CONFIG', 'INVALID_GRAPH', 'RESOURCE_UNAVAILABLE', 'UNSUPPORTED_NODE', 'UNSUPPORTED_COZE_NODE', 'UNSUPPORTED_COZE_TEMPLATE'].includes(code)) {
      for (const message of messages) {
        const detail = messageText(message.trim())
        if (detail) return detail
      }
    }
    const result = translateCode(code)
    if (result) return result
  }
  for (const message of messages) {
    const result = messageText(message.trim())
    if (result) return result
  }
  if (records.some(record => record.name === 'AbortError' || record.name === 'TimeoutError')
    || messages.some(message => /timed?\s*out|timeout|请求超时/i.test(message))) return translateCode('TIMEOUT')!
  if (messages.some(message => /failed to fetch|fetch failed|network(?:error| request failed)|load failed|网络不可达|服务未启动/i.test(message))) return translateCode('NETWORK_ERROR')!
  for (const record of records) {
    const status = record.status ?? record.statusCode ?? asRecord(record.response)?.status
    if (typeof status !== 'number' || status < 400) continue
    const key = status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN'
      : status === 404 ? 'NOT_FOUND' : status === 408 || status === 504 ? 'TIMEOUT'
        : status === 409 ? 'CONFLICT' : status === 422 || status === 400 ? 'VALIDATION_ERROR'
          : status === 429 ? 'RATE_LIMITED' : status >= 500 ? 'SERVER_ERROR' : 'HTTP_ERROR'
    return translateCode(key, { status })!
  }
  for (const code of codes) {
    const result = translateCode(code)
    if (result) return result
  }
  return translateCode('UNKNOWN')!
}

/** 兼容性问题使用同一错误码字典，不修改导入预检的原始诊断。 */
export function workflowIssueText(issue: { code: string; message: string }): string {
  return workflowErrorText(issue, issue.code)
}
