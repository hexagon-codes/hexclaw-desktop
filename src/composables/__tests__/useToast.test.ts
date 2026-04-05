import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { useToast } from '../useToast'

describe('useToast', () => {
  let originalHcToast: unknown

  beforeEach(() => {
    originalHcToast = (window as any).__hcToast
  })

  afterEach(() => {
    if (originalHcToast === undefined) {
      delete (window as any).__hcToast
    } else {
      ;(window as any).__hcToast = originalHcToast
    }
  })

  describe('getToast (via useToast internals)', () => {
    it('returns undefined when __hcToast is not set', () => {
      delete (window as any).__hcToast

      const toast = useToast()
      // Calling methods should not throw — they silently no-op
      expect(() => toast.success('test')).not.toThrow()
    })

    it('delegates to the .value of __hcToast when set', () => {
      const mockInstance = {
        success: vi.fn(),
        error: vi.fn(),
        warning: vi.fn(),
        info: vi.fn(),
      }
      ;(window as any).__hcToast = { value: mockInstance }

      const toast = useToast()
      toast.success('hello')

      expect(mockInstance.success).toHaveBeenCalledWith('hello')
    })
  })

  describe('method delegation', () => {
    let mockInstance: {
      success: ReturnType<typeof vi.fn>
      error: ReturnType<typeof vi.fn>
      warning: ReturnType<typeof vi.fn>
      info: ReturnType<typeof vi.fn>
    }

    beforeEach(() => {
      mockInstance = {
        success: vi.fn(),
        error: vi.fn(),
        warning: vi.fn(),
        info: vi.fn(),
      }
      ;(window as any).__hcToast = { value: mockInstance }
    })

    it('success() delegates to toast instance', () => {
      const toast = useToast()
      toast.success('Operation completed')
      expect(mockInstance.success).toHaveBeenCalledTimes(1)
      expect(mockInstance.success).toHaveBeenCalledWith('Operation completed')
    })

    it('error() delegates to toast instance', () => {
      const toast = useToast()
      toast.error('Something failed')
      expect(mockInstance.error).toHaveBeenCalledTimes(1)
      expect(mockInstance.error).toHaveBeenCalledWith('Something failed')
    })

    it('warning() delegates to toast instance', () => {
      const toast = useToast()
      toast.warning('Be careful')
      expect(mockInstance.warning).toHaveBeenCalledTimes(1)
      expect(mockInstance.warning).toHaveBeenCalledWith('Be careful')
    })

    it('info() delegates to toast instance', () => {
      const toast = useToast()
      toast.info('FYI')
      expect(mockInstance.info).toHaveBeenCalledTimes(1)
      expect(mockInstance.info).toHaveBeenCalledWith('FYI')
    })
  })

  describe('graceful no-op when toast is undefined', () => {
    beforeEach(() => {
      delete (window as any).__hcToast
    })

    it('success() does not throw when toast is undefined', () => {
      const toast = useToast()
      expect(() => toast.success('test')).not.toThrow()
    })

    it('error() does not throw when toast is undefined', () => {
      const toast = useToast()
      expect(() => toast.error('test')).not.toThrow()
    })

    it('warning() does not throw when toast is undefined', () => {
      const toast = useToast()
      expect(() => toast.warning('test')).not.toThrow()
    })

    it('info() does not throw when toast is undefined', () => {
      const toast = useToast()
      expect(() => toast.info('test')).not.toThrow()
    })
  })

  describe('message passthrough', () => {
    it('passes the exact message string through to the toast instance', () => {
      const mockInstance = {
        success: vi.fn(),
        error: vi.fn(),
        warning: vi.fn(),
        info: vi.fn(),
      }
      ;(window as any).__hcToast = { value: mockInstance }

      const toast = useToast()
      const messages = [
        'Simple message',
        'Message with special chars: <>&"\'',
        '',
        'Unicode: \u4f60\u597d\u4e16\u754c',
      ]

      for (const msg of messages) {
        toast.success(msg)
        toast.error(msg)
        toast.warning(msg)
        toast.info(msg)
      }

      for (const msg of messages) {
        expect(mockInstance.success).toHaveBeenCalledWith(msg)
        expect(mockInstance.error).toHaveBeenCalledWith(msg)
        expect(mockInstance.warning).toHaveBeenCalledWith(msg)
        expect(mockInstance.info).toHaveBeenCalledWith(msg)
      }
    })
  })
})
