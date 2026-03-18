/**
 * useValidation 测试
 *
 * 验证表单验证逻辑的正确性和边界情况
 */
import { describe, it, expect } from 'vitest'
import { useValidation, rules } from '../useValidation'

describe('rules', () => {
  describe('required', () => {
    const rule = rules.required()

    it('空字符串应不通过', () => {
      expect(rule.validate('')).toBe(false)
    })

    it('纯空格应不通过', () => {
      expect(rule.validate('   ')).toBe(false)
    })

    it('null 应不通过', () => {
      expect(rule.validate(null)).toBe(false)
    })

    it('undefined 应不通过', () => {
      expect(rule.validate(undefined)).toBe(false)
    })

    it('有值应通过', () => {
      expect(rule.validate('hello')).toBe(true)
    })

    it('数字 0 应通过（不是空值）', () => {
      expect(rule.validate(0)).toBe(true)
    })

    it('布尔 false 应通过', () => {
      // String(false).trim() = 'false' !== ''
      expect(rule.validate(false)).toBe(true)
    })
  })

  describe('url', () => {
    const rule = rules.url()

    it('有效 http URL 应通过', () => {
      expect(rule.validate('http://example.com')).toBe(true)
    })

    it('有效 https URL 应通过', () => {
      expect(rule.validate('https://api.openai.com/v1')).toBe(true)
    })

    it('空值应通过（非必填时）', () => {
      expect(rule.validate('')).toBe(true)
      expect(rule.validate(null)).toBe(true)
    })

    it('缺少协议应不通过', () => {
      expect(rule.validate('example.com')).toBe(false)
    })

    it('BUG: ftp URL 不应通过但正则不检查', () => {
      // url rule 的正则是 /^https?:\/\/.+/
      // 所以 ftp:// 不通过，这是正确的
      expect(rule.validate('ftp://example.com')).toBe(false)
    })
  })

  describe('range', () => {
    const rule = rules.range(0, 1)

    it('范围内应通过', () => {
      expect(rule.validate(0.5)).toBe(true)
    })

    it('边界值应通过', () => {
      expect(rule.validate(0)).toBe(true)
      expect(rule.validate(1)).toBe(true)
    })

    it('超出范围应不通过', () => {
      expect(rule.validate(-0.1)).toBe(false)
      expect(rule.validate(1.1)).toBe(false)
    })

    it('非数字应不通过', () => {
      expect(rule.validate('abc')).toBe(false)
      expect(rule.validate(NaN)).toBe(false)
    })
  })

  describe('positiveInt', () => {
    const rule = rules.positiveInt()

    it('正整数应通过', () => {
      expect(rule.validate(1)).toBe(true)
      expect(rule.validate(100)).toBe(true)
    })

    it('0 应不通过', () => {
      expect(rule.validate(0)).toBe(false)
    })

    it('负数应不通过', () => {
      expect(rule.validate(-1)).toBe(false)
    })

    it('浮点数应不通过', () => {
      expect(rule.validate(1.5)).toBe(false)
    })
  })
})

describe('useValidation', () => {
  it('validateAll 应返回所有字段的错误', () => {
    const { validateAll, errors } = useValidation({
      name: [rules.required()],
      url: [rules.url()],
    })

    const result = validateAll({ name: '', url: 'invalid' })
    expect(result).toBe(false)
    expect(errors.value.name).toBeTruthy()
    expect(errors.value.url).toBeTruthy()
  })

  it('validateField 单字段验证', () => {
    const { validateField, getError } = useValidation({
      name: [rules.required('名称必填')],
    })

    expect(validateField('name', '')).toBe(false)
    expect(getError('name')).toBe('名称必填')
  })

  it('clearErrors 应清除所有错误', () => {
    const { validateAll, clearErrors, hasErrors } = useValidation({
      name: [rules.required()],
    })

    validateAll({ name: '' })
    expect(hasErrors.value).toBe(true)

    clearErrors()
    expect(hasErrors.value).toBe(false)
  })

  it('未定义的字段验证应返回 true', () => {
    const { validateField } = useValidation({
      name: [rules.required()],
    })

    expect(validateField('nonexistent', '')).toBe(true)
  })

  it('多规则串联验证应在第一个失败时停止', () => {
    const { validateField, getError } = useValidation({
      url: [rules.required('URL 必填'), rules.url('URL 格式无效')],
    })

    // 空值时应该先报 required 错误
    expect(validateField('url', '')).toBe(false)
    expect(getError('url')).toBe('URL 必填')
  })
})
