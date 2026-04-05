export function buildDuplicateInstanceNameError(name: string): string {
  return `实例名称重复：${name.trim()}。请使用唯一名称`
}
