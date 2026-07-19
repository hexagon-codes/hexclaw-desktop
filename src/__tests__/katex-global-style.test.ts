import { describe, expect, it } from 'vitest'
import mainSource from '@/main.ts?raw'

describe('KaTeX desktop style loading', () => {
  it('loads KaTeX CSS synchronously from the application entry for WKWebView', () => {
    expect(mainSource).toContain("import 'katex/dist/katex.min.css'")
  })
})
