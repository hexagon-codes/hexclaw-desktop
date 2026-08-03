/**
 * 版本化 L3→L4 视图描述符（架构 §8.4 · ViewExtensionRegistry 的传输格式）。
 *
 * 核心契约：**后端返回实例视图描述符，desktop chat shell 只渲染描述符、不认识任何
 * 领域概念**。原型里的场景 glue（ID/函数）是演示用，实现不得照搬。
 *
 * 本文件是「前端契约先行」的手写 L4 视图；后端 `api/view_contracts/`（JSON Schema）
 * 就绪后，`src/contracts/generated/` 承接生成类型，本文件收敛为兼容层。
 *
 * 领域无关红线：本层出现任何场景领域字面量都是架构 bug（回归锁 §4.4）。
 */

/** 消息装饰类型（实例声明它的消息能携带哪些装饰槽） */
export type MessageBadgeKind = 'verify' | 'record-chip'

/** 头部子视图 tab（就地切换，不分叉会话 · §7.4 头部槽） */
export interface HeaderTab {
  /** 稳定 id（渲染 key、路由锚） */
  id: string
  /** i18n key（皮肤文案，shell 不内联领域词） */
  labelKey: string
  /** lucide 图标名或 emoji */
  icon?: string
  /** tab 指向的视图类型 */
  kind: 'chat' | 'records' | 'report'
  /** kind=records 时指向的 collection id */
  collection?: string
}

/** 记录集引用（任意业务记录集按 schema 渲染，shell 不知其语义） */
export interface RecordCollectionRef {
  /** collection id，如 'mistakes' */
  collection: string
  labelKey: string
  schemaVersion: string
}

/** 侧栏产物面板（场景专属侧栏，独立于通用 artifact 面板 · §7.4 产物槽） */
export interface SidePanelRef {
  /** 面板 id，如 'tutoring-tips' */
  id: string
  titleKey: string
  icon?: string
  /** 面板宽度（px），缺省由 shell 决定 */
  width?: number
}

/** 头部/工具条动作（场景侧栏、备份、打印、导出…由场景包声明） */
export interface ViewAction {
  /** 动作 id，shell 通过 registry 派发到 feature handler */
  id: string
  labelKey: string
  icon?: string
  placement?: 'header' | 'toolbar'
  /** 关联的侧栏面板 id（点击即开该侧栏） */
  opensPanel?: string
}

/** composer 预设（同一 composer 不分叉，仅提示语随场景变 · §7.4 composer 槽） */
export interface ComposerPreset {
  /** 提示语 i18n key */
  placeholderKey?: string
  /** 输入框下方的低干扰说明；强调语与补充说明分别本地化。 */
  hint?: {
    emphasisKey: string
    detailKey: string
  }
  /**
   * 预设 chips（已本地化的字面串，来自后端 descriptor.composer_chips）。
   * 由后端下发、通用 composer 直接渲染——不在前端 shell 硬编码场景 chip（AP-1）。
   */
  chips?: string[]
}

/** 场景实例空态（首屏无消息时，替换通用「选择一个智能体」为场景化引导 · §7.4 空态） */
export interface EmptyStatePreset {
  /** 标题 i18n key（皮肤文案，shell 不内联领域词） */
  titleKey: string
  /** 副标题 i18n key */
  subtitleKey: string
}

/**
 * 实例视图描述符：一个 Agent 实例声明它的增强视图。
 * 普通会话 = 空描述符（零增强）；场景实例 = 声明其头部/装饰/记录/侧栏/动作。
 */
export interface InstanceViewDescriptor {
  schemaVersion: string
  /** i18n 命名空间前缀（皮肤从此取 key） */
  i18nNamespace?: string
  /**
   * 头部视觉 chrome 的归属。缺省为 shell，保留普通会话的通用工具栏；
   * 仅声明 scenario 的场景包可用自身已批准的头部替代它。
   */
  headerOwner?: 'shell' | 'scenario'
  headerTabs: HeaderTab[]
  messageBadges: MessageBadgeKind[]
  composer?: ComposerPreset
  /** 场景化空态（首屏无消息时的引导；缺省走 shell 通用空态） */
  emptyState?: EmptyStatePreset
  recordCollections: RecordCollectionRef[]
  sidePanels: SidePanelRef[]
  actions: ViewAction[]
}

/** 空描述符：普通会话的零增强视图（shell 默认态） */
export const EMPTY_VIEW_DESCRIPTOR: InstanceViewDescriptor = {
  schemaVersion: '0',
  headerOwner: 'shell',
  headerTabs: [],
  messageBadges: [],
  recordCollections: [],
  sidePanels: [],
  actions: [],
}
