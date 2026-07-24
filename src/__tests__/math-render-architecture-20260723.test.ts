import { readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(process.cwd())
const SRC = resolve(ROOT, 'src')
const PACKAGE_JSON = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
}
const PRODUCTION_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.vue'])
const EXCLUDED_DIRECTORIES = new Set(['__tests__', '__mocks__'])

interface ProductionSource {
  absolutePath: string
  path: string
  source: string
  script: string
  ast: ts.SourceFile
}

interface ModuleReference {
  file: string
  kind: 'static' | 'dynamic'
  specifier: string
}

function productionFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue
    const absolutePath = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...productionFiles(absolutePath))
      continue
    }
    if (!entry.isFile() || !PRODUCTION_EXTENSIONS.has(extname(entry.name))) continue
    if (/\.(?:test|spec|bench)\.[^.]+$/.test(entry.name)) continue
    files.push(absolutePath)
  }
  return files
}

function vueScripts(source: string): string {
  return Array.from(source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))
    .map((match) => match[1] ?? '')
    .join('\n')
}

function sourceRecord(absolutePath: string): ProductionSource {
  const source = readFileSync(absolutePath, 'utf8')
  const path = relative(SRC, absolutePath).split(sep).join('/')
  const script = absolutePath.endsWith('.vue') ? vueScripts(source) : source
  const scriptKind = absolutePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return {
    absolutePath,
    path,
    source,
    script,
    ast: ts.createSourceFile(path, script, ts.ScriptTarget.Latest, true, scriptKind),
  }
}

const production = productionFiles(SRC).sort().map(sourceRecord)
const byPath = new Map(production.map((file) => [file.path, file]))

function moduleReferences(file: ProductionSource): ModuleReference[] {
  const references: ModuleReference[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (
        (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) ||
        (ts.isExportDeclaration(node) && node.isTypeOnly)
      ) {
        return
      }
      references.push({ file: file.path, kind: 'static', specifier: node.moduleSpecifier.text })
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]!) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      references.push({ file: file.path, kind: 'dynamic', specifier: node.arguments[0]!.text })
    }
    ts.forEachChild(node, visit)
  }
  visit(file.ast)
  return references
}

const references = production.flatMap(moduleReferences)

function ownersOfModule(specifier: string): string[] {
  return references
    .filter((reference) => reference.specifier === specifier)
    .map((reference) => reference.file)
    .sort()
}

function callOwners(predicate: (call: ts.CallExpression) => boolean): string[] {
  const owners: string[] = []
  for (const file of production) {
    let matched = false
    const visit = (node: ts.Node) => {
      if (matched) return
      if (ts.isCallExpression(node) && predicate(node)) {
        matched = true
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(file.ast)
    if (matched) owners.push(file.path)
  }
  return owners.sort()
}

function defaultImport(file: ProductionSource, localName: string): string | undefined {
  for (const statement of file.ast.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      statement.importClause?.name?.text === localName &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return statement.moduleSpecifier.text
    }
  }
  return undefined
}

function resolveLocalImport(file: ProductionSource, specifier: string): string | undefined {
  if (specifier.startsWith('@/')) return resolve(SRC, specifier.slice(2))
  if (specifier.startsWith('.')) return resolve(dirname(file.absolutePath), specifier)
  return undefined
}

function componentConsumers(componentName: 'MarkdownRenderer' | 'MessageText'): ProductionSource[] {
  const tag = new RegExp(`<${componentName}(?:\\s|/|>)`)
  return production.filter(
    (file) =>
      file.absolutePath.endsWith('.vue') && tag.test(file.source.replace(/<!--[\s\S]*?-->/g, '')),
  )
}

function expectCanonicalComponent(
  consumer: ProductionSource,
  componentName: 'MarkdownRenderer' | 'MessageText',
  canonicalPath: string,
) {
  const specifier = defaultImport(consumer, componentName)
  expect(specifier, `${consumer.path} 渲染 <${componentName}> 时必须显式导入共享边界`).toBeDefined()
  expect(
    resolveLocalImport(consumer, specifier!),
    `${consumer.path} 的 ${componentName} 不得指向局部/复制版渲染器`,
  ).toBe(resolve(SRC, canonicalPath))
}

describe('数学公式架构防漂移', () => {
  it('MarkdownIt 运行时只允许存在于共享 MarkdownRenderer', () => {
    expect(ownersOfModule('markdown-it')).toEqual(['components/chat/MarkdownRenderer.vue'])
  })

  it('KaTeX runtime 与 mhchem 只存在于共享 math-render adapter', () => {
    const directRuntimeReferences = references
      .filter(
        ({ specifier }) =>
          specifier === 'katex' ||
          (specifier.startsWith('katex/') &&
            specifier !== 'katex/contrib/mhchem' &&
            specifier !== 'katex/dist/katex.min.css'),
      )
      .map(({ file }) => file)
      .sort()

    expect(directRuntimeReferences).toEqual(['utils/math-render.ts'])
    expect(
      callOwners(
        (call) =>
          ts.isPropertyAccessExpression(call.expression) &&
          ts.isIdentifier(call.expression.expression) &&
          call.expression.expression.text === 'katex' &&
          ['render', 'renderToString'].includes(call.expression.name.text),
      ),
    ).toEqual(['utils/math-render.ts'])
    expect(ownersOfModule('katex/contrib/mhchem')).toEqual(['utils/math-render.ts'])
  })

  it('MarkdownRenderer 只拥有 TeX delimiter parser，不再引入二次 KaTeX renderer', () => {
    expect(PACKAGE_JSON.dependencies?.['@mdit/plugin-tex']).toBeDefined()
    expect(PACKAGE_JSON.dependencies?.['@mdit/plugin-katex']).toBeUndefined()
    expect(ownersOfModule('@mdit/plugin-katex')).toEqual([])
    expect(ownersOfModule('@mdit/plugin-tex')).toEqual(['components/chat/MarkdownRenderer.vue'])
    expect(
      callOwners(
        (call) =>
          ts.isPropertyAccessExpression(call.expression) &&
          call.expression.name.text === 'use' &&
          call.arguments.some((argument) => ts.isIdentifier(argument) && argument.text === 'tex'),
      ),
    ).toEqual(['components/chat/MarkdownRenderer.vue'])
  })

  it('MarkdownRenderer 与 MessageText 均复用唯一 math-render adapter', () => {
    for (const path of ['components/chat/MarkdownRenderer.vue', 'components/chat/MessageText.vue']) {
      const file = byPath.get(path)
      expect(file, `${path} 必须存在`).toBeDefined()
      expect(
        moduleReferences(file!).some(({ specifier }) => specifier === '@/utils/math-render'),
        `${path} 不得绕过共享 KaTeX adapter`,
      ).toBe(true)
    }
  })

  it('整个 src 的 Markdown/纯文本消费者都解析到共享边界，包含非消息 Markdown 页面', () => {
    const markdownConsumers = componentConsumers('MarkdownRenderer')
    const messageTextConsumers = componentConsumers('MessageText')

    for (const consumer of markdownConsumers) {
      expectCanonicalComponent(consumer, 'MarkdownRenderer', 'components/chat/MarkdownRenderer.vue')
    }
    for (const consumer of messageTextConsumers) {
      expectCanonicalComponent(consumer, 'MessageText', 'components/chat/MessageText.vue')
    }

    const markdownPaths = markdownConsumers.map((file) => file.path).sort()
    expect(markdownPaths).toEqual(
      expect.arrayContaining([
        'components/agents/SoulStructuredEditor.vue',
        'components/skills/SkillMarkdownPreview.vue',
        'views/PromptsView.vue',
        'views/KnowledgeView.vue',
      ]),
    )
  })

  it('主 ChatInput 复用 MessageText editable，不得另建第三套公式 renderer', () => {
    const chatInput = byPath.get('components/chat/ChatInput.vue')
    expect(chatInput).toBeDefined()
    expectCanonicalComponent(
      chatInput!,
      'MessageText',
      'components/chat/MessageText.vue',
    )
    expect(chatInput!.source).toMatch(/<MessageText[\s\S]*?\beditable\b/)
    expect(chatInput!.source).not.toMatch(/\b(?:katex\.render|renderKatexToHtml)\s*\(/)
  })

  it('Chat、QuickChat 与现有 K12 数学展示面均复用共享渲染边界', () => {
    for (const path of ['views/ChatView.vue', 'views/QuickChatView.vue']) {
      const file = byPath.get(path)
      expect(file, `${path} 必须存在`).toBeDefined()
      expect(componentConsumers('MarkdownRenderer').map((entry) => entry.path)).toContain(path)
      expect(componentConsumers('MessageText').map((entry) => entry.path)).toContain(path)
      expectCanonicalComponent(file!, 'MarkdownRenderer', 'components/chat/MarkdownRenderer.vue')
      expectCanonicalComponent(file!, 'MessageText', 'components/chat/MessageText.vue')
    }

    const k12MathSurfaces = [
      'features/k12/views/K12CreativeWorksPanel.vue',
      'features/k12/views/K12PracticeSetsPanel.vue',
      'features/k12/views/K12RecordsView.vue',
      'features/k12/views/PhotoGradeOverlay.vue',
      'features/k12/views/RecognizeGuardPanel.vue',
      'features/k12/views/TutorProgressivePanel.vue',
      'features/k12/views/TutoringTipsPanel.vue',
    ]
    const markdownPaths = componentConsumers('MarkdownRenderer').map((file) => file.path)
    for (const path of k12MathSurfaces) {
      const file = byPath.get(path)
      expect(file, `${path} 必须存在`).toBeDefined()
      expect(markdownPaths, `${path} 不得退化为纯插值/局部公式渲染`).toContain(path)
      expectCanonicalComponent(file!, 'MarkdownRenderer', 'components/chat/MarkdownRenderer.vue')
    }
  })

  it('KaTeX CSS 只由 main 入口同步导入', () => {
    const cssReferences = references.filter(
      ({ specifier }) => specifier === 'katex/dist/katex.min.css',
    )
    expect(cssReferences).toEqual([
      {
        file: 'main.ts',
        kind: 'static',
        specifier: 'katex/dist/katex.min.css',
      },
    ])
  })

  it('ChatInput 与 useChatSend 都在发送边界调用 normalizeMathMarkdown', () => {
    for (const path of ['components/chat/ChatInput.vue', 'composables/useChatSend.ts']) {
      const file = byPath.get(path)
      expect(file, `${path} 必须存在`).toBeDefined()
      expect(
        moduleReferences(file!).some(({ specifier }) => specifier === '@/utils/math-content'),
        `${path} 必须从共享 math-content 导入归一化函数`,
      ).toBe(true)
      expect(
        callOwners(
          (call) =>
            ts.isIdentifier(call.expression) && call.expression.text === 'normalizeMathMarkdown',
        ),
        '发送边界不得绕过公式规范化',
      ).toContain(path)
    }
  })
})
