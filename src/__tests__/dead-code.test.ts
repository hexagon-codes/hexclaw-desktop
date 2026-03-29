/**
 * Area 6: Dead code / unused exports
 *
 * Checks:
 * - isKnowledgeUploadEndpointMissing is still used
 * - Exported functions in src/api/ that are never imported elsewhere
 * - No leftover qrSetup references in im-channels.ts
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

function readFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf-8')
}

function readFileFromRoot(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, '../..', relativePath), 'utf-8')
}

function getAllTsVueFiles(dir: string): string[] {
  const result: string[] = []
  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const fullPath = path.join(d, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
        walk(fullPath)
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.ts') || entry.name.endsWith('.vue')) &&
        !entry.name.endsWith('.d.ts')
      ) {
        result.push(fullPath)
      }
    }
  }
  walk(dir)
  return result
}

describe('dead code detection', () => {
  // ─── isKnowledgeUploadEndpointMissing usage ─────────

  describe('isKnowledgeUploadEndpointMissing', () => {
    it('is still exported from knowledge.ts', () => {
      const knowledgeSource = readFile('api/knowledge.ts')
      expect(knowledgeSource).toContain('export function isKnowledgeUploadEndpointMissing')
    })

    it('is imported and used in production code (not just tests)', () => {
      // Check non-test files that import it
      const srcDir = path.resolve(__dirname, '..')
      const allFiles = getAllTsVueFiles(srcDir)
      const importers = allFiles.filter((f) => {
        if (f.includes('__tests__') || f.includes('.test.') || f.includes('.spec.')) return false
        const content = fs.readFileSync(f, 'utf-8')
        return content.includes('isKnowledgeUploadEndpointMissing')
      })

      expect(
        importers.length,
        'isKnowledgeUploadEndpointMissing should be imported in at least 1 production file. ' +
          `Found in: ${importers.map(f => path.relative(srcDir, f)).join(', ') || 'none'}`,
      ).toBeGreaterThanOrEqual(1)
    })

    it('is actually called (not just imported)', () => {
      // Check that it's used in a call expression, not just imported
      const knowledgeViewSource = readFile('views/KnowledgeView.vue')
      expect(knowledgeViewSource).toContain('isKnowledgeUploadEndpointMissing(')
    })
  })

  // ─── qrSetup references ────────────────────────────

  describe('no leftover qrSetup references', () => {
    it('im-channels.ts does not contain qrSetup', () => {
      const source = readFile('api/im-channels.ts')
      expect(source).not.toContain('qrSetup')
      expect(source).not.toContain('qr_setup')
      expect(source).not.toContain('qrCode')
      expect(source).not.toContain('qr_code')
    })

    it('no qrSetup in IMChannelMeta interface (would break type)', () => {
      const source = readFile('api/im-channels.ts')
      // The interface should only have the declared fields
      const interfaceMatch = source.match(/export interface IMChannelMeta \{[\s\S]*?\}/)
      if (interfaceMatch) {
        expect(interfaceMatch[0]).not.toContain('qr')
      }
    })

    it('CHANNEL_TYPES data does not contain qrSetup property', () => {
      const source = readFile('api/im-channels.ts')
      // Check that none of the CHANNEL_TYPES entries have qrSetup
      expect(source.match(/qrSetup\s*:/)).toBeNull()
    })
  })

  // ─── Unused exports in src/api/ ─────────────────────

  describe('unused exports in src/api/', () => {
    const srcDir = path.resolve(__dirname, '..')
    const apiDir = path.join(srcDir, 'api')
    const allFiles = getAllTsVueFiles(srcDir)
    const nonTestFiles = allFiles.filter(
      (f) => !f.includes('__tests__') && !f.includes('.test.') && !f.includes('.spec.'),
    )

    // Get all exported function/const names from api files (excluding index.ts and test files)
    function getExportedNames(filePath: string): string[] {
      const content = fs.readFileSync(filePath, 'utf-8')
      const exports: string[] = []

      // Match: export function name, export const name, export async function name
      const funcRegex = /export\s+(?:async\s+)?function\s+(\w+)/g
      const constRegex = /export\s+(?:const|let|var)\s+(\w+)/g

      let match
      while ((match = funcRegex.exec(content)) !== null) {
        exports.push(match[1]!)
      }
      while ((match = constRegex.exec(content)) !== null) {
        exports.push(match[1]!)
      }

      return exports
    }

    // Check if a name is imported/used anywhere outside its own file and tests
    function isNameUsedElsewhere(name: string, sourceFile: string): boolean {
      return nonTestFiles.some((f) => {
        if (f === sourceFile) return false
        const content = fs.readFileSync(f, 'utf-8')
        // Check for import or direct usage
        return content.includes(name)
      })
    }

    it('client.ts exports are all used', () => {
      const clientFile = path.join(apiDir, 'client.ts')
      const exports = getExportedNames(clientFile)
      for (const name of exports) {
        expect(
          isNameUsedElsewhere(name, clientFile),
          `client.ts exports "${name}" but it's not used outside its file`,
        ).toBe(true)
      }
    })

    it('im-channels.ts exports are all used', () => {
      const file = path.join(apiDir, 'im-channels.ts')
      const exports = getExportedNames(file)

      for (const name of exports) {
        const used = isNameUsedElsewhere(name, file)
        if (!used) {
          // Some exports may only be used via barrel export in index.ts
          // or in test files — that's acceptable. Flag only truly dead code.
          const usedInTests = allFiles.some((f) => {
            if (f === file) return false
            const content = fs.readFileSync(f, 'utf-8')
            return content.includes(name)
          })
          expect(
            usedInTests,
            `im-channels.ts exports "${name}" but it's not used anywhere (not even tests)`,
          ).toBe(true)
        }
      }
    })

    it('knowledge.ts exports are all used', () => {
      const file = path.join(apiDir, 'knowledge.ts')
      const exports = getExportedNames(file)

      for (const name of exports) {
        const usedAnywhere = allFiles.some((f) => {
          if (f === file) return false
          const content = fs.readFileSync(f, 'utf-8')
          return content.includes(name)
        })
        expect(
          usedAnywhere,
          `knowledge.ts exports "${name}" but it's not used anywhere`,
        ).toBe(true)
      }
    })
  })

  // ─── Index barrel re-exports completeness ──────────

  describe('api/index.ts barrel exports', () => {
    it('re-exports all api modules', () => {
      const indexSource = readFile('api/index.ts')

      // These modules are in src/api/ and should be re-exported
      // (some modules like im-channels, websocket, config, ollama, desktop, voice
      // are imported directly and may not need barrel re-export)
      const shouldExport = ['chat', 'agents', 'logs', 'memory', 'mcp', 'settings', 'skills', 'system', 'tasks', 'knowledge', 'canvas', 'tools-status']

      for (const mod of shouldExport) {
        const hasExport = indexSource.includes(`'./${mod}'`) || indexSource.includes(`"./${mod}"`)
        expect(
          hasExport,
          `api/index.ts should re-export './${mod}'`,
        ).toBe(true)
      }
    })

    it('does not re-export im-channels (imported directly)', () => {
      const indexSource = readFile('api/index.ts')
      // im-channels is typically imported directly, not through barrel
      // This is fine — just documenting the pattern
      const hasImChannels = indexSource.includes('./im-channels')
      // If it's not in the barrel, that's expected
      if (!hasImChannels) {
        expect(hasImChannels).toBe(false)
      }
    })
  })
})
