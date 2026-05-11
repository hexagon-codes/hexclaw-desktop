/**
 * RuntimeServices — Runtime 服务定位器
 *
 * 持有 CapabilityRegistry / CapabilityValidator 等实例，
 * RuntimeStore 不直接 new 服务，通过此模块获取。
 *
 * @see docs/agents-OS/Capability-Spec.md
 */

import { CapabilityRegistry } from '@/services/capabilityRegistry'
import { CapabilityValidator } from '@/services/capabilityValidator'

export interface RuntimeServiceContainer {
  capabilityRegistry: CapabilityRegistry
  capabilityValidator: CapabilityValidator
}

let container: RuntimeServiceContainer | null = null

export function getRuntimeServices(): RuntimeServiceContainer {
  if (!container) {
    container = {
      capabilityRegistry: new CapabilityRegistry(),
      capabilityValidator: new CapabilityValidator(),
    }
  }
  return container
}
