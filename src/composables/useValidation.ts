import { ref, computed } from 'vue'

export interface ValidationRule {
  validate: (value: unknown) => boolean
  message: string
}

export interface FieldErrors {
  [field: string]: string | null
}

/** 预定义验证规则 */
export const rules = {
  required: (msg = '此项为必填'): ValidationRule => ({
    validate: (v) => v !== null && v !== undefined && String(v).trim() !== '',
    message: msg,
  }),

  url: (msg = 'URL 格式无效'): ValidationRule => ({
    validate: (v) => !v || /^https?:\/\/.+/.test(String(v)),
    message: msg,
  }),

  range: (min: number, max: number, msg?: string): ValidationRule => ({
    validate: (v) => {
      const n = Number(v)
      return !isNaN(n) && n >= min && n <= max
    },
    message: msg ?? `值应在 ${min} 到 ${max} 之间`,
  }),

  positiveInt: (msg = '请输入正整数'): ValidationRule => ({
    validate: (v) => {
      const n = Number(v)
      return Number.isInteger(n) && n > 0
    },
    message: msg,
  }),

  apiKey: (msg = 'API Key 不能为空'): ValidationRule => ({
    validate: (v) => v !== null && v !== undefined && String(v).trim().length > 0,
    message: msg,
  }),
}

/** 表单验证 composable */
export function useValidation(schema: Record<string, ValidationRule[]>) {
  const errors = ref<FieldErrors>({})

  /** 验证单个字段 */
  function validateField(field: string, value: unknown): boolean {
    const fieldRules = schema[field]
    if (!fieldRules) return true

    for (const rule of fieldRules) {
      if (!rule.validate(value)) {
        errors.value[field] = rule.message
        return false
      }
    }
    errors.value[field] = null
    return true
  }

  /** 验证所有字段 */
  function validateAll(values: Record<string, unknown>): boolean {
    let valid = true
    for (const field of Object.keys(schema)) {
      if (!validateField(field, values[field])) {
        valid = false
      }
    }
    return valid
  }

  /** 清除所有错误 */
  function clearErrors() {
    errors.value = {}
  }

  /** 是否有错误 */
  const hasErrors = computed(() => Object.values(errors.value).some((e) => e !== null && e !== undefined))

  /** 获取某个字段的错误 */
  function getError(field: string): string | null {
    return errors.value[field] ?? null
  }

  return { errors, hasErrors, validateField, validateAll, clearErrors, getError }
}
