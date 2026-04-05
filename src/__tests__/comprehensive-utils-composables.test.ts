/**
 * Comprehensive unit tests for utility modules and services.
 *
 * Covers: errors, content-blocks, diff, safe-html, file-parser,
 *         logger, chat-automation, messageService, env config.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ═══════════════════════════════════════════════════════════════
// 1. src/utils/errors.ts — Error handling
// ═══════════════════════════════════════════════════════════════

describe('utils/errors', () => {
  // Dynamic import so logger mock is applied before module loads
  let fromHttpStatus: typeof import('@/utils/errors').fromHttpStatus
  let fromNativeError: typeof import('@/utils/errors').fromNativeError
  let trySafe: typeof import('@/utils/errors').trySafe
  let isRetryable: typeof import('@/utils/errors').isRetryable
  let createApiError: typeof import('@/utils/errors').createApiError

  beforeEach(async () => {
    const mod = await import('@/utils/errors')
    fromHttpStatus = mod.fromHttpStatus
    fromNativeError = mod.fromNativeError
    trySafe = mod.trySafe
    isRetryable = mod.isRetryable
    createApiError = mod.createApiError
  })

  describe('fromHttpStatus()', () => {
    it('401 -> UNAUTHORIZED', () => {
      const err = fromHttpStatus(401)
      expect(err.code).toBe('UNAUTHORIZED')
      expect(err.status).toBe(401)
      expect(err.message).toContain('未授权')
    })

    it('403 -> FORBIDDEN', () => {
      const err = fromHttpStatus(403)
      expect(err.code).toBe('FORBIDDEN')
      expect(err.status).toBe(403)
    })

    it('404 -> NOT_FOUND', () => {
      const err = fromHttpStatus(404)
      expect(err.code).toBe('NOT_FOUND')
      expect(err.status).toBe(404)
    })

    it('422 -> VALIDATION_ERROR with serverMessage', () => {
      const err = fromHttpStatus(422, 'email is required')
      expect(err.code).toBe('VALIDATION_ERROR')
      expect(err.message).toBe('email is required')
      expect(err.status).toBe(422)
    })

    it('422 without serverMessage -> default message', () => {
      const err = fromHttpStatus(422)
      expect(err.code).toBe('VALIDATION_ERROR')
      expect(err.message).toContain('校验失败')
    })

    it('429 -> RATE_LIMITED', () => {
      const err = fromHttpStatus(429)
      expect(err.code).toBe('RATE_LIMITED')
      expect(err.status).toBe(429)
    })

    it('500 -> SERVER_ERROR with serverMessage', () => {
      const err = fromHttpStatus(500, 'internal panic')
      expect(err.code).toBe('SERVER_ERROR')
      expect(err.message).toBe('internal panic')
      expect(err.status).toBe(500)
    })

    it('502 -> SERVER_ERROR (any 5xx)', () => {
      const err = fromHttpStatus(502)
      expect(err.code).toBe('SERVER_ERROR')
      expect(err.status).toBe(502)
    })

    it('503 -> SERVER_ERROR (another 5xx)', () => {
      const err = fromHttpStatus(503)
      expect(err.code).toBe('SERVER_ERROR')
      expect(err.status).toBe(503)
    })

    it('418 -> UNKNOWN', () => {
      const err = fromHttpStatus(418)
      expect(err.code).toBe('UNKNOWN')
      expect(err.status).toBe(418)
    })

    it('200 -> UNKNOWN (not an error status but mapped as unknown)', () => {
      const err = fromHttpStatus(200)
      expect(err.code).toBe('UNKNOWN')
    })
  })

  describe('fromNativeError()', () => {
    it('already ApiError -> returns as-is', () => {
      const apiErr = createApiError('NOT_FOUND', 'gone', 404)
      const result = fromNativeError(apiErr)
      expect(result).toBe(apiErr)
      expect(result.code).toBe('NOT_FOUND')
    })

    it('TypeError with "fetch" -> NETWORK_ERROR', () => {
      const err = new TypeError('Failed to fetch')
      const result = fromNativeError(err)
      expect(result.code).toBe('NETWORK_ERROR')
      expect(result.cause).toBe(err)
    })

    it('DOMException AbortError -> TIMEOUT', () => {
      const err = new DOMException('The operation was aborted.', 'AbortError')
      const result = fromNativeError(err)
      expect(result.code).toBe('TIMEOUT')
      expect(result.cause).toBe(err)
    })

    it('FetchError with status -> delegates to fromHttpStatus', () => {
      const err = Object.assign(new Error('Not Found'), { status: 404 })
      const result = fromNativeError(err)
      expect(result.code).toBe('NOT_FOUND')
      expect(result.status).toBe(404)
    })

    it('FetchError with statusCode -> delegates to fromHttpStatus', () => {
      const err = Object.assign(new Error('Internal'), { statusCode: 500 })
      const result = fromNativeError(err)
      expect(result.code).toBe('SERVER_ERROR')
    })

    it('FetchError with data.error -> uses data.error as serverMessage', () => {
      const err = Object.assign(new Error('oops'), {
        status: 422,
        data: { error: 'field X invalid' },
      })
      const result = fromNativeError(err)
      expect(result.code).toBe('VALIDATION_ERROR')
      expect(result.message).toBe('field X invalid')
    })

    it('plain string -> UNKNOWN with string as message', () => {
      const result = fromNativeError('something went wrong')
      expect(result.code).toBe('UNKNOWN')
      expect(result.message).toBe('something went wrong')
    })

    it('null -> UNKNOWN with "未知错误"', () => {
      const result = fromNativeError(null)
      expect(result.code).toBe('UNKNOWN')
      expect(result.message).toBe('未知错误')
    })

    it('undefined -> UNKNOWN with "未知错误"', () => {
      const result = fromNativeError(undefined)
      expect(result.code).toBe('UNKNOWN')
      expect(result.message).toBe('未知错误')
    })

    it('generic Error without status -> UNKNOWN with error message', () => {
      const err = new Error('random failure')
      const result = fromNativeError(err)
      expect(result.code).toBe('UNKNOWN')
      expect(result.message).toBe('random failure')
    })

    it('object with numeric code (DOMException-like) is not treated as ApiError', () => {
      // DOMException has numeric `code` — should NOT match ApiError check
      const fake = { code: 20, message: 'AbortError' }
      const result = fromNativeError(fake)
      // numeric code => falls through to string check => UNKNOWN
      expect(result.code).toBe('UNKNOWN')
    })
  })

  describe('trySafe()', () => {
    it('success -> [data, null]', async () => {
      const [data, err] = await trySafe(async () => 42)
      expect(data).toBe(42)
      expect(err).toBeNull()
    })

    it('failure -> [null, ApiError]', async () => {
      const [data, err] = await trySafe(async () => {
        throw new TypeError('Failed to fetch')
      })
      expect(data).toBeNull()
      expect(err).not.toBeNull()
      expect(err!.code).toBe('NETWORK_ERROR')
    })

    it('failure with context -> logs context', async () => {
      const [data, err] = await trySafe(
        async () => { throw new Error('fail') },
        'loadUser',
      )
      expect(data).toBeNull()
      expect(err).not.toBeNull()
      expect(err!.code).toBe('UNKNOWN')
    })
  })

  describe('isRetryable()', () => {
    it('NETWORK_ERROR -> true', () => {
      expect(isRetryable(createApiError('NETWORK_ERROR', 'x'))).toBe(true)
    })

    it('TIMEOUT -> true', () => {
      expect(isRetryable(createApiError('TIMEOUT', 'x'))).toBe(true)
    })

    it('SERVER_ERROR -> true', () => {
      expect(isRetryable(createApiError('SERVER_ERROR', 'x'))).toBe(true)
    })

    it('RATE_LIMITED -> true', () => {
      expect(isRetryable(createApiError('RATE_LIMITED', 'x'))).toBe(true)
    })

    it('NOT_FOUND -> false', () => {
      expect(isRetryable(createApiError('NOT_FOUND', 'x'))).toBe(false)
    })

    it('UNAUTHORIZED -> false', () => {
      expect(isRetryable(createApiError('UNAUTHORIZED', 'x'))).toBe(false)
    })

    it('FORBIDDEN -> false', () => {
      expect(isRetryable(createApiError('FORBIDDEN', 'x'))).toBe(false)
    })

    it('VALIDATION_ERROR -> false', () => {
      expect(isRetryable(createApiError('VALIDATION_ERROR', 'x'))).toBe(false)
    })

    it('UNKNOWN -> false', () => {
      expect(isRetryable(createApiError('UNKNOWN', 'x'))).toBe(false)
    })
  })
})

// ═══════════════════════════════════════════════════════════════
// 2. src/utils/content-blocks.ts — Content block parsing
// ═══════════════════════════════════════════════════════════════

describe('utils/content-blocks', () => {
  let toContentBlocks: typeof import('@/utils/content-blocks').toContentBlocks
  let isTextBlock: typeof import('@/utils/content-blocks').isTextBlock
  let isThinkingBlock: typeof import('@/utils/content-blocks').isThinkingBlock
  let isToolUseBlock: typeof import('@/utils/content-blocks').isToolUseBlock
  let isToolResultBlock: typeof import('@/utils/content-blocks').isToolResultBlock
  let isCodeBlock: typeof import('@/utils/content-blocks').isCodeBlock

  beforeEach(async () => {
    const mod = await import('@/utils/content-blocks')
    toContentBlocks = mod.toContentBlocks
    isTextBlock = mod.isTextBlock
    isThinkingBlock = mod.isThinkingBlock
    isToolUseBlock = mod.isToolUseBlock
    isToolResultBlock = mod.isToolResultBlock
    isCodeBlock = mod.isCodeBlock
  })

  function makeMsg(overrides: Partial<import('@/types/chat').ChatMessage> = {}): import('@/types/chat').ChatMessage {
    return {
      id: 'msg-1',
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      ...overrides,
    }
  }

  describe('toContentBlocks()', () => {
    it('message with pre-built blocks -> returns blocks as-is', () => {
      const existingBlocks = [
        { type: 'text' as const, text: 'hello' },
        { type: 'thinking' as const, thinking: 'hmm', duration: 1.5 },
      ]
      const msg = makeMsg({ blocks: existingBlocks })
      const result = toContentBlocks(msg)
      expect(result).toBe(existingBlocks)
      expect(result).toHaveLength(2)
    })

    it('message with reasoning only -> thinking block', () => {
      const msg = makeMsg({ reasoning: 'Let me think...' })
      const result = toContentBlocks(msg)
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ type: 'thinking', thinking: 'Let me think...', duration: undefined })
    })

    it('message with content only -> text block', () => {
      const msg = makeMsg({ content: 'Hello world' })
      const result = toContentBlocks(msg)
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ type: 'text', text: 'Hello world' })
    })

    it('message with both reasoning and content -> thinking + text blocks', () => {
      const msg = makeMsg({ reasoning: 'thinking...', content: 'answer' })
      const result = toContentBlocks(msg)
      expect(result).toHaveLength(2)
      expect(result[0]).toMatchObject({ type: 'thinking', thinking: 'thinking...' })
      expect(result[1]).toMatchObject({ type: 'text', text: 'answer' })
    })

    it('message with tool_calls -> tool_use + tool_result blocks', () => {
      const msg = makeMsg({
        tool_calls: [
          { id: 'tc1', name: 'search', arguments: '{"q":"test"}', result: '{"items":[]}' },
        ],
      })
      const result = toContentBlocks(msg)
      expect(result).toHaveLength(2)
      expect(result[0]).toMatchObject({
        type: 'tool_use',
        id: 'tc1',
        name: 'search',
        input: '{"q":"test"}',
      })
      expect(result[1]).toMatchObject({
        type: 'tool_result',
        toolUseId: 'tc1',
        toolName: 'search',
        output: '{"items":[]}',
        isError: false,
      })
    })

    it('tool_call without result -> only tool_use block', () => {
      const msg = makeMsg({
        tool_calls: [
          { id: 'tc2', name: 'calc', arguments: '{}' },
        ],
      })
      const result = toContentBlocks(msg)
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({ type: 'tool_use', id: 'tc2', name: 'calc' })
    })

    it('thinking_duration as string number -> converted correctly', () => {
      const msg = makeMsg({
        reasoning: 'deep thought',
        metadata: { thinking_duration: '3.14' },
      })
      const result = toContentBlocks(msg)
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({ type: 'thinking', thinking: 'deep thought', duration: 3.14 })
    })

    it('thinking_duration as NaN -> NaN passed through (known behavior)', () => {
      const msg = makeMsg({
        reasoning: 'hmm',
        metadata: { thinking_duration: 'not-a-number' },
      })
      const result = toContentBlocks(msg)
      expect(result[0]).toMatchObject({ type: 'thinking', thinking: 'hmm' })
      expect((result[0] as { duration?: number }).duration).toBeNaN()
    })

    it('empty message (no content, no reasoning, no tool_calls) -> empty array', () => {
      const msg = makeMsg({ content: '', reasoning: undefined, tool_calls: undefined })
      const result = toContentBlocks(msg)
      expect(result).toEqual([])
    })

    it('message with all fields produces thinking + text + tool blocks in order', () => {
      const msg = makeMsg({
        reasoning: 'think',
        content: 'answer',
        tool_calls: [
          { id: 't1', name: 'tool1', arguments: '{}', result: 'ok' },
        ],
      })
      const result = toContentBlocks(msg)
      expect(result).toHaveLength(4)
      expect(result[0]).toMatchObject({ type: 'thinking' })
      expect(result[1]).toMatchObject({ type: 'text' })
      expect(result[2]).toMatchObject({ type: 'tool_use' })
      expect(result[3]).toMatchObject({ type: 'tool_result' })
    })
  })

  describe('type guards', () => {
    it('isTextBlock identifies text blocks', () => {
      expect(isTextBlock({ type: 'text', text: 'hi' })).toBe(true)
      expect(isTextBlock({ type: 'thinking', thinking: 'x' })).toBe(false)
    })

    it('isThinkingBlock identifies thinking blocks', () => {
      expect(isThinkingBlock({ type: 'thinking', thinking: 'x' })).toBe(true)
      expect(isThinkingBlock({ type: 'text', text: 'x' })).toBe(false)
    })

    it('isToolUseBlock identifies tool_use blocks', () => {
      expect(isToolUseBlock({ type: 'tool_use', id: '1', name: 'a', input: '{}' })).toBe(true)
      expect(isToolUseBlock({ type: 'text', text: '' })).toBe(false)
    })

    it('isToolResultBlock identifies tool_result blocks', () => {
      expect(isToolResultBlock({
        type: 'tool_result', toolUseId: '1', toolName: 'a', output: '', isError: false,
      })).toBe(true)
      expect(isToolResultBlock({ type: 'tool_use', id: '1', name: 'a', input: '{}' })).toBe(false)
    })

    it('isCodeBlock identifies code blocks', () => {
      expect(isCodeBlock({ type: 'code', language: 'ts', content: 'x' })).toBe(true)
      expect(isCodeBlock({ type: 'text', text: 'x' })).toBe(false)
    })
  })
})

// ═══════════════════════════════════════════════════════════════
// 3. src/utils/diff.ts — Diff algorithm
// ═══════════════════════════════════════════════════════════════

describe('utils/diff', () => {
  let computeDiff: typeof import('@/utils/diff').computeDiff
  let computeStructuredDiff: typeof import('@/utils/diff').computeStructuredDiff

  beforeEach(async () => {
    const mod = await import('@/utils/diff')
    computeDiff = mod.computeDiff
    computeStructuredDiff = mod.computeStructuredDiff
  })

  describe('computeDiff()', () => {
    it('identical texts -> all equal lines', () => {
      const text = 'line1\nline2\nline3'
      const result = computeDiff(text, text)
      expect(result.every(l => l.type === 'equal')).toBe(true)
      expect(result).toHaveLength(3)
    })

    it('completely different texts -> all remove + add', () => {
      const old = 'aaa\nbbb'
      const nw = 'xxx\nyyy'
      const result = computeDiff(old, nw)
      const removes = result.filter(l => l.type === 'remove')
      const adds = result.filter(l => l.type === 'add')
      expect(removes).toHaveLength(2)
      expect(adds).toHaveLength(2)
      expect(result.filter(l => l.type === 'equal')).toHaveLength(0)
    })

    it('single line addition', () => {
      const old = 'line1\nline3'
      const nw = 'line1\nline2\nline3'
      const result = computeDiff(old, nw)
      const adds = result.filter(l => l.type === 'add')
      expect(adds).toHaveLength(1)
      expect(adds[0].content).toBe('line2')
    })

    it('single line removal', () => {
      const old = 'line1\nline2\nline3'
      const nw = 'line1\nline3'
      const result = computeDiff(old, nw)
      const removes = result.filter(l => l.type === 'remove')
      expect(removes).toHaveLength(1)
      expect(removes[0].content).toBe('line2')
    })

    it('mixed add/remove/equal with correct line numbers', () => {
      const old = 'A\nB\nC'
      const nw = 'A\nX\nC'
      const result = computeDiff(old, nw)

      const equal1 = result.find(l => l.content === 'A')
      expect(equal1).toMatchObject({ type: 'equal', oldLineNo: 1, newLineNo: 1 })

      const removed = result.find(l => l.content === 'B')
      expect(removed).toMatchObject({ type: 'remove' })
      expect(removed!.oldLineNo).toBeDefined()

      const added = result.find(l => l.content === 'X')
      expect(added).toMatchObject({ type: 'add' })
      expect(added!.newLineNo).toBeDefined()

      const equal2 = result.find(l => l.content === 'C')
      expect(equal2).toMatchObject({ type: 'equal' })
    })

    it('empty old text -> all additions', () => {
      const result = computeDiff('', 'new1\nnew2')
      // '' splits into [''] so there's one remove for '' and two adds
      const adds = result.filter(l => l.type === 'add')
      expect(adds.length).toBeGreaterThanOrEqual(2)
    })

    it('empty new text -> all removals', () => {
      const result = computeDiff('old1\nold2', '')
      const removes = result.filter(l => l.type === 'remove')
      expect(removes.length).toBeGreaterThanOrEqual(2)
    })

    it('both empty -> single equal empty line', () => {
      const result = computeDiff('', '')
      // '' splits into [''] so there is one equal empty line
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({ type: 'equal', content: '' })
    })

    it('large file exceeding MAX_LCS_CELLS -> uses simple fallback', () => {
      // MAX_LCS_CELLS = 4_000_000. Need m*n > 4M => e.g. 2100 x 2100 = 4_410_000
      const bigOld = Array.from({ length: 2100 }, (_, i) => `old-line-${i}`).join('\n')
      const bigNew = Array.from({ length: 2100 }, (_, i) => `new-line-${i}`).join('\n')
      const result = computeDiff(bigOld, bigNew)
      // Should still produce a valid diff
      expect(result.length).toBeGreaterThan(0)
      // Simple fallback pairs remove+add for each mismatching line
      const removes = result.filter(l => l.type === 'remove')
      const adds = result.filter(l => l.type === 'add')
      expect(removes.length).toBe(adds.length)
    })

    it('common prefix and suffix optimization', () => {
      const old = 'common1\ncommon2\nOLD\ncommon3\ncommon4'
      const nw = 'common1\ncommon2\nNEW\ncommon3\ncommon4'
      const result = computeDiff(old, nw)

      const equals = result.filter(l => l.type === 'equal')
      expect(equals).toHaveLength(4) // common1, common2, common3, common4

      const removed = result.find(l => l.type === 'remove')
      expect(removed!.content).toBe('OLD')

      const added = result.find(l => l.type === 'add')
      expect(added!.content).toBe('NEW')
    })
  })

  describe('computeStructuredDiff()', () => {
    it('groups changes into hunks with context', () => {
      const old = 'A\nB\nC\nD\nE'
      const nw = 'A\nB\nX\nD\nE'
      const sd = computeStructuredDiff(old, nw, 1)
      expect(sd.hunks.length).toBeGreaterThanOrEqual(1)
      // Hunk should contain the changed line plus context
      const hunk = sd.hunks[0]
      expect(hunk.lines.some(l => l.type === 'remove' && l.content === 'C')).toBe(true)
      expect(hunk.lines.some(l => l.type === 'add' && l.content === 'X')).toBe(true)
    })

    it('no changes -> empty hunks', () => {
      const text = 'A\nB\nC'
      const sd = computeStructuredDiff(text, text)
      expect(sd.hunks).toEqual([])
      expect(sd.stats.additions).toBe(0)
      expect(sd.stats.deletions).toBe(0)
      expect(sd.stats.unchanged).toBe(3)
    })

    it('adjacent changes merged into single hunk', () => {
      const old = 'A\nB\nC\nD\nE'
      const nw = 'A\nX\nY\nD\nE'
      // B->X, C->Y are adjacent changes, should be in one hunk
      const sd = computeStructuredDiff(old, nw, 1)
      expect(sd.hunks).toHaveLength(1)
    })

    it('distant changes -> separate hunks', () => {
      // Build texts where changes are far apart (> 2 * contextLines)
      const lines = Array.from({ length: 30 }, (_, i) => `line${i}`)
      const oldText = lines.join('\n')
      const newLines = [...lines]
      newLines[2] = 'CHANGED-2'
      newLines[27] = 'CHANGED-27'
      const newText = newLines.join('\n')

      const sd = computeStructuredDiff(oldText, newText, 2) // context=2, gap needs > 4
      expect(sd.hunks.length).toBe(2)
    })

    it('correct hunk header format "@@ -X,Y +A,B @@"', () => {
      const old = 'A\nB\nC'
      const nw = 'A\nX\nC'
      const sd = computeStructuredDiff(old, nw, 1)
      expect(sd.hunks).toHaveLength(1)
      const header = sd.hunks[0].header
      expect(header).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/)
    })

    it('stats counts additions/deletions/unchanged', () => {
      const old = 'A\nB\nC\nD'
      const nw = 'A\nX\nD\nE'
      const sd = computeStructuredDiff(old, nw)
      // A stays, B->X (remove+add), C removed, D stays, E added
      expect(sd.stats.additions).toBeGreaterThanOrEqual(1)
      expect(sd.stats.deletions).toBeGreaterThanOrEqual(1)
      expect(sd.stats.unchanged).toBeGreaterThanOrEqual(1)
      expect(sd.stats.additions + sd.stats.deletions + sd.stats.unchanged)
        .toBe(sd.hunks.reduce((acc, h) => acc + h.lines.length, 0)
          + (sd.stats.unchanged - sd.hunks.reduce((acc, h) =>
              acc + h.lines.filter(l => l.type === 'equal').length, 0)))
    })

    it('stats add up to total diff lines', () => {
      const old = 'foo\nbar\nbaz'
      const nw = 'foo\nqux\nbaz'
      const sd = computeStructuredDiff(old, nw)
      const flat = computeDiff(old, nw)
      expect(sd.stats.additions + sd.stats.deletions + sd.stats.unchanged).toBe(flat.length)
    })
  })
})

// ═══════════════════════════════════════════════════════════════
// 4. src/utils/safe-html.ts — XSS prevention
// ═══════════════════════════════════════════════════════════════

describe('utils/safe-html', () => {
  let sanitizeArtifactHtml: typeof import('@/utils/safe-html').sanitizeArtifactHtml

  beforeEach(async () => {
    const mod = await import('@/utils/safe-html')
    sanitizeArtifactHtml = mod.sanitizeArtifactHtml
  })

  it('strips script tags', () => {
    const result = sanitizeArtifactHtml('<p>Hello</p><script>alert("xss")</script>')
    expect(result).not.toContain('<script')
    expect(result).not.toContain('alert("xss")')
    expect(result).toContain('Hello')
  })

  it('allows safe HTML elements (p, div, span, h1-h6)', () => {
    const input = '<div><p>text</p><span>inline</span><h1>Title</h1><h3>Sub</h3></div>'
    const result = sanitizeArtifactHtml(input)
    expect(result).toContain('<div>')
    expect(result).toContain('<p>')
    expect(result).toContain('<span>')
    expect(result).toContain('<h1>')
    expect(result).toContain('<h3>')
  })

  it('removes onclick/onerror event handlers', () => {
    const input = '<div onclick="alert(1)" onerror="alert(2)"><img onerror="steal()">text</div>'
    const result = sanitizeArtifactHtml(input)
    expect(result).not.toContain('onclick')
    expect(result).not.toContain('onerror')
    expect(result).not.toContain('alert')
    expect(result).not.toContain('steal')
  })

  it('keeps CSS styles in body wrapper', () => {
    const input = '<p>styled text</p>'
    const result = sanitizeArtifactHtml(input)
    // The function wraps non-document HTML with a default style
    expect(result).toContain('<style>')
    expect(result).toContain('font-family')
  })

  it('handles empty input', () => {
    const result = sanitizeArtifactHtml('')
    // Should return a valid HTML document wrapper (the function wraps empty body)
    expect(result).toContain('<!doctype html>')
    expect(result).toContain('<body>')
  })

  it('strips iframe and object tags', () => {
    const input = '<iframe src="evil.com"></iframe><object data="evil.swf"></object>'
    const result = sanitizeArtifactHtml(input)
    expect(result).not.toContain('<iframe')
    expect(result).not.toContain('<object')
  })

  it('strips form and input tags', () => {
    const input = '<form action="/steal"><input type="text" /><button>Submit</button></form>'
    const result = sanitizeArtifactHtml(input)
    expect(result).not.toContain('<form')
    expect(result).not.toContain('<input')
    expect(result).not.toContain('<button')
  })

  it('processes full HTML document input differently', () => {
    const input = '<!doctype html><html><head><title>Test</title></head><body><p>content</p></body></html>'
    const result = sanitizeArtifactHtml(input)
    expect(result).toContain('content')
    // Full document mode (WHOLE_DOCUMENT: true) is used
  })

  it('sanitizes title parameter to prevent injection', () => {
    const result = sanitizeArtifactHtml('<p>text</p>', '<script>alert(1)</script>')
    expect(result).not.toContain('<script>')
  })
})

// ═══════════════════════════════════════════════════════════════
// 5. src/utils/file-parser.ts — File parsing
// ═══════════════════════════════════════════════════════════════

describe('utils/file-parser', () => {
  let isDocumentFile: typeof import('@/utils/file-parser').isDocumentFile

  beforeEach(async () => {
    const mod = await import('@/utils/file-parser')
    isDocumentFile = mod.isDocumentFile
  })

  function fakeFile(name: string): File {
    return new File([''], name, { type: 'application/octet-stream' })
  }

  it('.pdf -> true', () => {
    expect(isDocumentFile(fakeFile('report.pdf'))).toBe(true)
  })

  it('.docx -> true', () => {
    expect(isDocumentFile(fakeFile('document.docx'))).toBe(true)
  })

  it('.doc -> true', () => {
    expect(isDocumentFile(fakeFile('legacy.doc'))).toBe(true)
  })

  it('.txt -> true', () => {
    expect(isDocumentFile(fakeFile('notes.txt'))).toBe(true)
  })

  it('.md -> true', () => {
    expect(isDocumentFile(fakeFile('README.md'))).toBe(true)
  })

  it('.xlsx -> true', () => {
    expect(isDocumentFile(fakeFile('data.xlsx'))).toBe(true)
  })

  it('.xls -> true', () => {
    expect(isDocumentFile(fakeFile('old-data.xls'))).toBe(true)
  })

  it('.csv -> true', () => {
    expect(isDocumentFile(fakeFile('export.csv'))).toBe(true)
  })

  it('.json -> true', () => {
    expect(isDocumentFile(fakeFile('config.json'))).toBe(true)
  })

  it('.jpg -> false', () => {
    expect(isDocumentFile(fakeFile('photo.jpg'))).toBe(false)
  })

  it('.exe -> false', () => {
    expect(isDocumentFile(fakeFile('installer.exe'))).toBe(false)
  })

  it('.png -> false', () => {
    expect(isDocumentFile(fakeFile('image.png'))).toBe(false)
  })

  it('no extension -> false', () => {
    expect(isDocumentFile(fakeFile('Makefile'))).toBe(false)
  })

  it('uppercase extension .PDF -> true (lowercased internally)', () => {
    expect(isDocumentFile(fakeFile('REPORT.PDF'))).toBe(true)
  })

  it('mixed case .Docx -> true', () => {
    expect(isDocumentFile(fakeFile('Paper.Docx'))).toBe(true)
  })

  it('double extension .tar.gz -> false', () => {
    expect(isDocumentFile(fakeFile('archive.tar.gz'))).toBe(false)
  })

  it('dot-only file "." -> false', () => {
    // lastIndexOf('.') == 0, function checks dotIdx <= 0
    expect(isDocumentFile(fakeFile('.hidden'))).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════
// 6. src/utils/logger.ts — Logger
// ═══════════════════════════════════════════════════════════════

describe('utils/logger', () => {
  // The logger module reads import.meta.env at call time.
  // In test mode getMinLevel() returns 'warn', so debug/info are suppressed.

  let logger: typeof import('@/utils/logger').logger

  beforeEach(async () => {
    const mod = await import('@/utils/logger')
    logger = mod.logger
  })

  it('logger.warn() logs in test mode (min level is warn)', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logger.warn('test warning')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toContain('WARN')
    expect(spy.mock.calls[0][0]).toContain('test warning')
    spy.mockRestore()
  })

  it('logger.error() logs in test mode', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logger.error('test error')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toContain('ERROR')
    spy.mockRestore()
  })

  it('logger.debug() does NOT log in test mode (level below warn)', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    logger.debug('hidden debug')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('logger.info() does NOT log in test mode (level below warn)', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    logger.info('hidden info')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('log output contains timestamp pattern HH:mm:ss.SSS', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logger.warn('timestamp test')
    expect(spy.mock.calls[0][0]).toMatch(/\[\d{2}:\d{2}:\d{2}\.\d{3}\]/)
    spy.mockRestore()
  })

  it('logger methods accept extra arguments', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const extra = { detail: 'x' }
    logger.error('with extra', extra)
    expect(spy).toHaveBeenCalledWith(expect.any(String), extra)
    spy.mockRestore()
  })
})

// ═══════════════════════════════════════════════════════════════
// 7. src/utils/chat-automation.ts — Conversation automation
// ═══════════════════════════════════════════════════════════════

describe('utils/chat-automation', () => {
  let buildConversationAutomationActions: typeof import('@/utils/chat-automation').buildConversationAutomationActions

  beforeEach(async () => {
    const mod = await import('@/utils/chat-automation')
    buildConversationAutomationActions = mod.buildConversationAutomationActions
  })

  function makeInput(userText: string, extra: Partial<import('@/utils/chat-automation').ConversationAutomationParseInput> = {}) {
    return {
      userText,
      sourceMessageId: 'msg-test',
      ...extra,
    }
  }

  describe('create task detection', () => {
    it('detects "创建定时任务" with schedule -> cron action', () => {
      const actions = buildConversationAutomationActions(
        makeInput('帮我创建一个定时任务，每天下午3点执行'),
      )
      expect(actions.length).toBeGreaterThanOrEqual(1)
      const taskAction = actions.find(a => a.kind === 'create_task')
      expect(taskAction).toBeDefined()
      expect(taskAction!.kind).toBe('create_task')
      expect((taskAction as import('@/utils/chat-automation').CreateTaskAction).payload.schedule).toBeTruthy()
    })

    it('detects @daily schedule', () => {
      const actions = buildConversationAutomationActions(
        makeInput('新建定时任务 @daily 每日汇总'),
      )
      const taskAction = actions.find(a => a.kind === 'create_task') as import('@/utils/chat-automation').CreateTaskAction | undefined
      expect(taskAction).toBeDefined()
      expect(taskAction!.payload.schedule).toBe('@daily')
    })

    it('detects @every interval schedule', () => {
      const actions = buildConversationAutomationActions(
        makeInput('创建定时任务 @every 30m 检查服务状态'),
      )
      const taskAction = actions.find(a => a.kind === 'create_task') as import('@/utils/chat-automation').CreateTaskAction | undefined
      expect(taskAction).toBeDefined()
      expect(taskAction!.payload.schedule).toContain('@every')
      expect(taskAction!.payload.schedule).toContain('30m')
    })

    it('detects 每小时 natural language schedule', () => {
      const actions = buildConversationAutomationActions(
        makeInput('创建一个定时任务，每小时自动执行一次'),
      )
      const taskAction = actions.find(a => a.kind === 'create_task') as import('@/utils/chat-automation').CreateTaskAction | undefined
      expect(taskAction).toBeDefined()
      expect(taskAction!.payload.schedule).toBe('@every 1h')
    })
  })

  describe('knowledge actions', () => {
    it('detects "写入知识库" pattern -> knowledge action', () => {
      const actions = buildConversationAutomationActions(
        makeInput('把上面的结果写入知识库', { assistantContent: 'Some knowledge content to store' }),
      )
      const knowledgeAction = actions.find(a => a.kind === 'add_text_to_knowledge')
      expect(knowledgeAction).toBeDefined()
    })

    it('detects "搜索知识库" pattern -> search action', () => {
      const actions = buildConversationAutomationActions(
        makeInput('搜索知识库关于机器学习的内容'),
      )
      const searchAction = actions.find(a => a.kind === 'search_knowledge') as import('@/utils/chat-automation').SearchKnowledgeAction | undefined
      expect(searchAction).toBeDefined()
      expect(searchAction!.payload.query).toBeTruthy()
    })

    it('detects "查询知识库" variant', () => {
      const actions = buildConversationAutomationActions(
        makeInput('查询知识库有没有部署文档'),
      )
      expect(actions.find(a => a.kind === 'search_knowledge')).toBeDefined()
    })
  })

  describe('multiple actions', () => {
    it('multiple actions in single message', () => {
      // A message that triggers both search and something else
      const actions = buildConversationAutomationActions(
        makeInput('搜索知识库关于天气的内容，另外暂停任务"数据备份"'),
      )
      expect(actions.length).toBeGreaterThanOrEqual(2)
      expect(actions.some(a => a.kind === 'search_knowledge')).toBe(true)
      expect(actions.some(a => a.kind === 'pause_task')).toBe(true)
    })
  })

  describe('edge cases', () => {
    it('no matching patterns -> empty array', () => {
      const actions = buildConversationAutomationActions(
        makeInput('今天天气怎么样？'),
      )
      expect(actions).toEqual([])
    })

    it('empty input -> empty array', () => {
      const actions = buildConversationAutomationActions(makeInput(''))
      expect(actions).toEqual([])
    })

    it('whitespace-only input -> empty array', () => {
      const actions = buildConversationAutomationActions(makeInput('   \n\t  '))
      expect(actions).toEqual([])
    })

    it('task target actions: pause', () => {
      const actions = buildConversationAutomationActions(
        makeInput('暂停任务"每日报告"'),
      )
      const pauseAction = actions.find(a => a.kind === 'pause_task')
      expect(pauseAction).toBeDefined()
    })

    it('task target actions: delete', () => {
      const actions = buildConversationAutomationActions(
        makeInput('删除任务"旧备份"'),
      )
      const deleteAction = actions.find(a => a.kind === 'delete_task')
      expect(deleteAction).toBeDefined()
    })

    it('task target actions: trigger', () => {
      const actions = buildConversationAutomationActions(
        makeInput('立即执行任务"数据同步"'),
      )
      const triggerAction = actions.find(a => a.kind === 'trigger_task')
      expect(triggerAction).toBeDefined()
    })

    it('all actions have id and pending status', () => {
      const actions = buildConversationAutomationActions(
        makeInput('搜索知识库关于API的内容'),
      )
      for (const a of actions) {
        expect(a.id).toBeTruthy()
        expect(typeof a.id).toBe('string')
        expect(a.status).toBe('pending')
      }
    })
  })
})

// ═══════════════════════════════════════════════════════════════
// 8. src/services/messageService.ts — Direct function tests
// ═══════════════════════════════════════════════════════════════

describe('services/messageService', () => {
  let parseMessageMetadata: typeof import('@/services/messageService').parseMessageMetadata
  let normalizeLoadedMessage: typeof import('@/services/messageService').normalizeLoadedMessage
  let serializeMessageMetadata: typeof import('@/services/messageService').serializeMessageMetadata

  beforeEach(async () => {
    const mod = await import('@/services/messageService')
    parseMessageMetadata = mod.parseMessageMetadata
    normalizeLoadedMessage = mod.normalizeLoadedMessage
    serializeMessageMetadata = mod.serializeMessageMetadata
  })

  describe('parseMessageMetadata()', () => {
    it('valid JSON string -> parsed object', () => {
      const result = parseMessageMetadata('{"key":"value","count":42}')
      expect(result).toEqual({ key: 'value', count: 42 })
    })

    it('invalid JSON -> undefined', () => {
      const result = parseMessageMetadata('{not valid json}')
      expect(result).toBeUndefined()
    })

    it('null input -> undefined', () => {
      const result = parseMessageMetadata(null)
      expect(result).toBeUndefined()
    })

    it('empty string -> undefined', () => {
      const result = parseMessageMetadata('')
      expect(result).toBeUndefined()
    })

    it('JSON array string -> returns parsed array (not object)', () => {
      const result = parseMessageMetadata('[1,2,3]')
      // Returns as-is (JSON.parse), typed as Record but actually array
      expect(result).toEqual([1, 2, 3])
    })

    it('nested JSON -> deep parsed', () => {
      const json = '{"a":{"b":{"c":true}}}'
      const result = parseMessageMetadata(json)
      expect(result).toEqual({ a: { b: { c: true } } })
    })
  })

  describe('normalizeLoadedMessage()', () => {
    it('full message with all fields', () => {
      const row = {
        id: 'msg-1',
        role: 'assistant',
        content: 'Hello',
        timestamp: '2024-01-01T00:00:00Z',
        metadata: JSON.stringify({
          tool_calls: [{ id: 'tc1', name: 'search', arguments: '{}', result: 'ok' }],
          agent_name: 'Agent007',
          reasoning: 'I thought about it',
          extra_field: 'preserved',
        }),
      }
      const msg = normalizeLoadedMessage(row)
      expect(msg.id).toBe('msg-1')
      expect(msg.role).toBe('assistant')
      expect(msg.content).toBe('Hello')
      expect(msg.timestamp).toBe('2024-01-01T00:00:00Z')
      expect(msg.tool_calls).toHaveLength(1)
      expect(msg.tool_calls![0].name).toBe('search')
      expect(msg.agent_name).toBe('Agent007')
      expect(msg.reasoning).toBe('I thought about it')
      expect(msg.metadata?.extra_field).toBe('preserved')
    })

    it('minimal message with nulls', () => {
      const row = {
        id: 'msg-2',
        role: 'user',
        content: 'Hi',
        timestamp: '2024-01-02T00:00:00Z',
        metadata: null,
      }
      const msg = normalizeLoadedMessage(row)
      expect(msg.id).toBe('msg-2')
      expect(msg.role).toBe('user')
      expect(msg.content).toBe('Hi')
      expect(msg.metadata).toBeUndefined()
      expect(msg.tool_calls).toBeUndefined()
      expect(msg.agent_name).toBeUndefined()
      expect(msg.reasoning).toBeUndefined()
    })

    it('metadata with tool_calls array -> extracted', () => {
      const row = {
        id: 'msg-3',
        role: 'assistant',
        content: '',
        timestamp: '2024-01-03T00:00:00Z',
        metadata: JSON.stringify({
          tool_calls: [
            { id: 'a', name: 'fn1', arguments: '{}' },
            { id: 'b', name: 'fn2', arguments: '{"x":1}', result: 'done' },
          ],
        }),
      }
      const msg = normalizeLoadedMessage(row)
      expect(msg.tool_calls).toHaveLength(2)
      expect(msg.tool_calls![0].id).toBe('a')
      expect(msg.tool_calls![1].result).toBe('done')
    })

    it('metadata with non-array tool_calls -> undefined', () => {
      const row = {
        id: 'msg-4',
        role: 'assistant',
        content: '',
        timestamp: '2024-01-04T00:00:00Z',
        metadata: JSON.stringify({ tool_calls: 'not-an-array' }),
      }
      const msg = normalizeLoadedMessage(row)
      expect(msg.tool_calls).toBeUndefined()
    })

    it('metadata with non-string agent_name -> undefined', () => {
      const row = {
        id: 'msg-5',
        role: 'assistant',
        content: '',
        timestamp: '2024-01-05T00:00:00Z',
        metadata: JSON.stringify({ agent_name: 123 }),
      }
      const msg = normalizeLoadedMessage(row)
      expect(msg.agent_name).toBeUndefined()
    })

    it('metadata with non-string reasoning -> undefined', () => {
      const row = {
        id: 'msg-6',
        role: 'assistant',
        content: '',
        timestamp: '2024-01-06T00:00:00Z',
        metadata: JSON.stringify({ reasoning: false }),
      }
      const msg = normalizeLoadedMessage(row)
      expect(msg.reasoning).toBeUndefined()
    })
  })

  describe('serializeMessageMetadata()', () => {
    it('message with tool_calls + agent_name + reasoning', () => {
      const msg = {
        id: '1',
        role: 'assistant' as const,
        content: 'answer',
        timestamp: '2024-01-01T00:00:00Z',
        tool_calls: [{ id: 'tc1', name: 'fn', arguments: '{}' }],
        agent_name: 'Agent',
        reasoning: 'because...',
      }
      const result = serializeMessageMetadata(msg)
      expect(result).toBeDefined()
      expect(result!.tool_calls).toEqual(msg.tool_calls)
      expect(result!.agent_name).toBe('Agent')
      expect(result!.reasoning).toBe('because...')
    })

    it('message with empty metadata -> undefined', () => {
      const msg = {
        id: '2',
        role: 'user' as const,
        content: 'hello',
        timestamp: '2024-01-01T00:00:00Z',
      }
      const result = serializeMessageMetadata(msg)
      expect(result).toBeUndefined()
    })

    it('message with only metadata but no tool_calls/agent_name/reasoning', () => {
      const msg = {
        id: '3',
        role: 'assistant' as const,
        content: '',
        timestamp: '2024-01-01T00:00:00Z',
        metadata: { custom_key: 'value' },
      }
      const result = serializeMessageMetadata(msg)
      expect(result).toBeDefined()
      expect(result!.custom_key).toBe('value')
    })

    it('message with empty tool_calls array -> not included', () => {
      const msg = {
        id: '4',
        role: 'assistant' as const,
        content: '',
        timestamp: '2024-01-01T00:00:00Z',
        tool_calls: [] as import('@/types/chat').ToolCall[],
      }
      const result = serializeMessageMetadata(msg)
      // Empty tool_calls.length is 0, so if-check fails => not added
      expect(result).toBeUndefined()
    })

    it('preserves existing metadata fields alongside tool_calls', () => {
      const msg = {
        id: '5',
        role: 'assistant' as const,
        content: '',
        timestamp: '2024-01-01T00:00:00Z',
        metadata: { provider: 'openai', model: 'gpt-4' },
        tool_calls: [{ id: 'x', name: 'y', arguments: '{}' }],
        reasoning: 'think',
      }
      const result = serializeMessageMetadata(msg)
      expect(result).toBeDefined()
      expect(result!.provider).toBe('openai')
      expect(result!.model).toBe('gpt-4')
      expect(result!.tool_calls).toEqual(msg.tool_calls)
      expect(result!.reasoning).toBe('think')
    })
  })
})

// ═══════════════════════════════════════════════════════════════
// 9. src/config/env.ts — Environment config
// ═══════════════════════════════════════════════════════════════

describe('config/env', () => {
  let env: typeof import('@/config/env').env

  beforeEach(async () => {
    const mod = await import('@/config/env')
    env = mod.env
  })

  it('has apiBase property', () => {
    expect(env.apiBase).toBeDefined()
    expect(typeof env.apiBase).toBe('string')
    expect(env.apiBase.length).toBeGreaterThan(0)
  })

  it('has wsBase property', () => {
    expect(env.wsBase).toBeDefined()
    expect(typeof env.wsBase).toBe('string')
    expect(env.wsBase).toMatch(/^ws/)
  })

  it('has isDev boolean', () => {
    expect(typeof env.isDev).toBe('boolean')
  })

  it('has timeout number', () => {
    expect(typeof env.timeout).toBe('number')
    expect(env.timeout).toBeGreaterThan(0)
  })

  it('has logLevel', () => {
    expect(['debug', 'info', 'warn', 'error']).toContain(env.logLevel)
  })

  it('is frozen (Object.isFrozen)', () => {
    expect(Object.isFrozen(env)).toBe(true)
  })

  it('apiBase has no trailing slash', () => {
    expect(env.apiBase.endsWith('/')).toBe(false)
  })

  it('wsBase has no trailing slash', () => {
    expect(env.wsBase.endsWith('/')).toBe(false)
  })

  it('wsBase is derived from apiBase (http -> ws)', () => {
    // Default apiBase is http://localhost:16060
    // wsBase should be ws://localhost:16060
    const expectedWs = env.apiBase.replace(/^http/, 'ws')
    expect(env.wsBase).toBe(expectedWs)
  })

  it('cannot mutate frozen env', () => {
    expect(() => {
      (env as Record<string, unknown>).apiBase = 'http://evil.com'
    }).toThrow()
  })
})

// ═══════════════════════════════════════════════════════════════
// 10. Benchmarks (vitest bench style, guarded by describe.skip)
// ═══════════════════════════════════════════════════════════════

// Skip benchmarks in normal test runs — they are run via `pnpm test:bench`
describe.todo('benchmarks (run with pnpm test:bench)', () => {
  it('computeDiff() with 100-line files', async () => {
    const { computeDiff } = await import('@/utils/diff')
    const oldLines = Array.from({ length: 100 }, (_, i) => `line ${i}: original content here`)
    const newLines = oldLines.map((line, i) =>
      i % 10 === 0 ? `line ${i}: modified content here` : line,
    )
    const oldText = oldLines.join('\n')
    const newText = newLines.join('\n')

    const start = performance.now()
    for (let i = 0; i < 100; i++) {
      computeDiff(oldText, newText)
    }
    const elapsed = performance.now() - start
    // Just record timing; should be well under 1s for 100 iterations
    expect(elapsed).toBeLessThan(5000)
  })

  it('toContentBlocks() with 50 tool calls', async () => {
    const { toContentBlocks } = await import('@/utils/content-blocks')
    const toolCalls = Array.from({ length: 50 }, (_, i) => ({
      id: `tc-${i}`,
      name: `tool_${i}`,
      arguments: JSON.stringify({ index: i }),
      result: JSON.stringify({ ok: true }),
    }))
    const msg = {
      id: 'bench-msg',
      role: 'assistant' as const,
      content: 'result text',
      reasoning: 'deep reasoning',
      timestamp: new Date().toISOString(),
      tool_calls: toolCalls,
    }

    const start = performance.now()
    for (let i = 0; i < 1000; i++) {
      toContentBlocks(msg)
    }
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(5000)
  })

  it('fromNativeError() with various input types', async () => {
    const { fromNativeError } = await import('@/utils/errors')
    const inputs: unknown[] = [
      null,
      undefined,
      'string error',
      new TypeError('Failed to fetch'),
      new DOMException('abort', 'AbortError'),
      new Error('generic'),
      Object.assign(new Error('http'), { status: 404 }),
      { code: 'NETWORK_ERROR', message: 'test' },
      42,
    ]

    const start = performance.now()
    for (let i = 0; i < 10000; i++) {
      for (const input of inputs) {
        fromNativeError(input)
      }
    }
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(5000)
  })
})
