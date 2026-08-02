import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WORKFLOW_DIRECTORY = path.join(REPOSITORY_ROOT, '.github', 'workflows')
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i
const ALLOWED_WRITE_GRANTS = new Set(['release.yml:build:contents'])

function issue(file, line, rule, detail) {
  return `${file}:${line} [${rule}] ${detail}`
}

function workflowPolicy(file, source) {
  const lines = source.split(/\r?\n/)
  const violations = []
  const writeGrants = []
  let topLevelPermissions = null

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1
    const uses = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/)
    if (uses) {
      const action = uses[1]
      if (action.startsWith('docker://')) {
        if (!/@sha256:[0-9a-f]{64}$/i.test(action)) {
          violations.push(issue(file, lineNumber, 'immutable-action', `${action} must use a sha256 digest`))
        }
      } else if (!action.startsWith('./')) {
        const separator = action.lastIndexOf('@')
        const ref = separator === -1 ? '' : action.slice(separator + 1)
        if (!FULL_COMMIT_SHA.test(ref)) {
          violations.push(issue(file, lineNumber, 'immutable-action', `${action} must use a full 40-character commit SHA`))
        }
      }
    }

    const policyText = line.replace(/\s+#.*$/, '')
    if (/@latest\b/i.test(policyText)) {
      violations.push(issue(file, lineNumber, 'moving-latest', 'package/tool @latest references are forbidden'))
    }
    if (/\b(?:ubuntu|windows|macos)-latest\b/i.test(policyText)) {
      violations.push(issue(file, lineNumber, 'moving-runner', 'runner labels must name an explicit OS version'))
    }

    const permissions = line.match(/^(\s*)permissions:\s*$/)
    if (!permissions) continue

    const blockIndent = permissions[1].length
    const entries = []
    for (let entryIndex = index + 1; entryIndex < lines.length; entryIndex += 1) {
      const entryLine = lines[entryIndex]
      if (!entryLine.trim() || entryLine.trimStart().startsWith('#')) continue
      const entryIndent = entryLine.match(/^\s*/)[0].length
      if (entryIndent <= blockIndent) break
      const entry = entryLine.match(/^\s+([a-z-]+):\s*(read|write|none)\s*(?:#.*)?$/)
      if (entry) entries.push({ scope: entry[1], access: entry[2], line: entryIndex + 1 })
    }

    if (blockIndent === 0) topLevelPermissions = { line: lineNumber, entries }
    for (const entry of entries.filter(({ access }) => access === 'write')) {
      let job = '<workflow>'
      if (blockIndent === 4) {
        for (let jobIndex = index - 1; jobIndex >= 0; jobIndex -= 1) {
          const jobLine = lines[jobIndex].match(/^  ([a-zA-Z0-9_-]+):\s*$/)
          if (jobLine) {
            job = jobLine[1]
            break
          }
        }
      }
      const grant = `${file}:${job}:${entry.scope}`
      writeGrants.push(grant)
      if (!ALLOWED_WRITE_GRANTS.has(grant)) {
        violations.push(issue(file, entry.line, 'least-privilege', `unexpected write grant ${grant}`))
      }
    }
  }

  if (!topLevelPermissions) {
    violations.push(issue(file, 1, 'explicit-permissions', 'workflow must declare top-level permissions'))
  } else {
    const permissionSummary = topLevelPermissions.entries.map(({ scope, access }) => `${scope}:${access}`)
    if (permissionSummary.length !== 1 || permissionSummary[0] !== 'contents:read') {
      violations.push(issue(file, topLevelPermissions.line, 'least-privilege', 'top-level permissions must be exactly contents: read'))
    }
  }

  return { violations, writeGrants }
}

test('policy detects mutable actions, moving latest aliases, and broad token permissions', () => {
  const unsafe = `name: unsafe
permissions:
  contents: write
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install example@latest
`
  const result = workflowPolicy('unsafe.yml', unsafe)
  const rules = new Set(result.violations.map((violation) => violation.match(/\[([^\]]+)]/)[1]))
  assert.deepEqual(rules, new Set(['immutable-action', 'moving-latest', 'moving-runner', 'least-privilege']))
})

test('repository workflows use immutable dependencies and least-privilege tokens', async () => {
  const workflowFiles = (await readdir(WORKFLOW_DIRECTORY))
    .filter((file) => /\.ya?ml$/i.test(file))
    .sort()
  assert.ok(workflowFiles.length > 0, 'no GitHub Actions workflows found')

  const violations = []
  const writeGrants = []
  for (const file of workflowFiles) {
    const source = await readFile(path.join(WORKFLOW_DIRECTORY, file), 'utf8')
    const result = workflowPolicy(file, source)
    violations.push(...result.violations)
    writeGrants.push(...result.writeGrants)
  }

  assert.deepEqual(violations, [], violations.join('\n'))
  assert.deepEqual(new Set(writeGrants), ALLOWED_WRITE_GRANTS, 'release publishing must be the only write-capable job')
})
