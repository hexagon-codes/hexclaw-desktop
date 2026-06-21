/**
 * BUG PROOF (RED): 数据连接器的数据库密码以【明文】落 localStorage。
 *
 * useConnectorInstances 的模块级 deep watch 把整个实例列表 JSON.stringify 写入
 * localStorage['hexclaw:connectorInstances']，其中 config.password 等敏感字段原样落盘。
 * 这与产品「本地加密」约定冲突，也与 IM 通道密钥的正确做法（走 Tauri 安全 store）不一致。
 *
 * 本测试断言「明文密码不应出现在 localStorage」，当前会 FAIL —— 失败即证明明文持久化 bug。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { useConnectorInstances } from '@/composables/useConnectorInstances'

const STORAGE_KEY = 'hexclaw:connectorInstances'

describe('BUG: connector DB credentials are persisted as plaintext in localStorage', () => {
  beforeEach(() => {
    // 模块级单例跨用例共享，清空内存态 + localStorage，保证从干净起点出发。
    const { list } = useConnectorInstances()
    list.value.splice(0, list.value.length)
    localStorage.clear()
  })

  it('does not write the raw DB password into localStorage', async () => {
    const { addInstance } = useConnectorInstances()
    const SECRET = 'sup3r-s3cret-db-pw'

    addInstance({
      type: 'postgres',
      name: '生产库',
      config: { host: 'db.internal', port: '5432', user: 'admin', password: SECRET },
      enabled: true,
    })

    // 触发 deep watch 落盘。
    await nextTick()

    const raw = localStorage.getItem(STORAGE_KEY) ?? ''
    expect(raw.length, 'expected the instance to be persisted to localStorage').toBeGreaterThan(0)
    expect(
      raw.includes(SECRET),
      'plaintext DB password found in localStorage — secrets must be encrypted or stored via the Tauri secure store, not raw localStorage',
    ).toBe(false)
  })
})
