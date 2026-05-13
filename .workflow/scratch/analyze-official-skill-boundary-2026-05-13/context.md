# Context: Official Skill Boundary

**Date**: 2026-05-13
**Areas discussed**: 物理隔离、可见性、Registry 结构、更新模型、Entitlement、Category/Tag、P0 范围、Deferred Roadmap

## Decisions

### Decision 1: 两棵独立目录
- **Context**: Official Skill 需要物理只读保护，Custom Skill 需要用户读写
- **Options**: 同树分目录 / 两棵独立目录 / 二进制 vs 文件
- **Chosen**: 两棵独立目录
- **Reason**: Official Skill 打包在 tauri app resource（天然只读），Custom Skill 存在 AppData/skills/（读写）

### Decision 2: 元数据可见，prompt 隐藏
- **Context**: MentionPopup 需要展示 skill 信息，但 SKILL.md 包含 proprietary prompt
- **Options**: meta 可见 prompt 隐藏 / 仅 meta 可见 / 完全透明
- **Chosen**: meta 可见，prompt 隐藏
- **Reason**: skill.json（name, description, version, capabilities）展示用，SKILL.md 不暴露

### Decision 3: 双 BaseDirectory 合并
- **Context**: 两棵目录需要统一的查询接口
- **Options**: 双 BaseDirectory 合并 / 双 Registry / 分离管理
- **Chosen**: 双 BaseDirectory 合并
- **Reason**: 调用方透明，Custom 可 shadow Official，保持现有接口不变

### Decision 4: 随应用发布
- **Context**: Official Skill 的更新策略
- **Options**: 随应用发布 / 启动时同步 / 按需更新
- **Chosen**: 随应用发布
- **Reason**: 最简单模型，无需独立基础设施

### Decision 5: P0 不做授权
- **Context**: entitlement/license key 是否需要
- **Options**: 需要 entitlement / 不做授权 / 服务端控制
- **Chosen**: P0 不做授权
- **Reason**: P0 无用户系统/账户体系

### Decision 6: 预留字段，P0 不消费
- **Context**: category/tag 是否进入 Runtime
- **Options**: 仅 UI 分类 / 影响 Runtime 匹配 / 预留字段
- **Chosen**: 预留字段，P0 不消费
- **Reason**: 不增加 P0 复杂度

### Decision 7: P0 = 目录隔离 + Schema
- **Context**: 最小可工作集合
- **Options**: 仅目录隔离 / 目录隔离+Schema / 完整 P0
- **Chosen**: 目录隔离 + Schema
- **Reason**: 最小边界，冻结 deferred

## Constraints

### Locked
- Official Skill 在 tauri resource（只读），Custom Skill 在 AppData（读写）
- SkillRegistry 双 BaseDirectory 合并，Custom 可 shadow Official
- skill.json 扩展 `official: true` 标记
- Official Skill 随应用更新
- P0 不做 entitlement
- category/tag 预留字段不消费
- 严格遵守 7 条红线（无 Marketplace / Store / Cloud Execution / DAG / Visual Builder）

### Free
- SkillLoader depth control（loadMarkdown 参数）的实现细节
- MentionPopup 是否显示 official badge
- skill.json schema 的 exact 字段名（`official` vs `origin` vs `source`）

### Deferred
- Prompt 保护（SkillLoader 阻止读取 Official SKILL.md）
- Category/Tag Runtime 消费
- 独立更新机制
- Entitlement/license 集成
- Official Skill UI 标识（badge / 分组）

## Code Context
- `src/services/skillRegistry.ts` — 当前单 BaseDirectory，需要扩展为双目录
- `src/services/skillLoader.ts` — 当前支持 loadMarkdown 参数（预留），但无 Official/Custom 判定
- `src/services/skillBridge.ts` — 调用方可复用，无需修改
- `src/types/skill.ts` — SkillMeta 需要扩展 `official?: boolean` 字段
- `skills/` — 当前仅有 builtin/summarize（放到 official/ 目录）
- `src/components/chat/MentionPopup.vue` — 当前不区分 skill 类型
