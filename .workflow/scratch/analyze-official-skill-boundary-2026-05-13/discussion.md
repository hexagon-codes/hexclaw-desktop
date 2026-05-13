# Official Skill Boundary — 分析讨论

## Session Metadata

- **Session ID**: ANL-official-skill-boundary-2026-05-13
- **Date**: 2026-05-13
- **Topic**: Official Skill Boundary — 隔离、可见性、Registry、更新、授权
- **Scope**: Standalone

## User Intent

根据 `docs/1.md`，分析 10 个重点：
1. Official vs Custom 如何隔离
2. 客户端存放 Official Skill 但不泄露完整内容
3. Skill Registry 最小结构
4. Skill manifest 与 SKILL.md 的边界
5. Skill discovery 是否允许全文搜索
6. Skill 是否允许用户查看 prompt
7. Skill update 如何进行
8. Skill activation code / entitlement 如何关联
9. Skill category/tag 是否进入 Runtime
10. 哪些能力必须 deferred

严格禁止：
- Plugin Marketplace / Workflow Store / Cloud Workflow / Remote Execution / DAG / Visual Builder

## 讨论记录

### Round 1: 物理隔离方案

**问题**: Official vs Custom Skill 如何物理隔离？

**选择**: 两棵独立目录
- Official Skill: tauri app resource（只读，随应用打包）
- Custom Skill: AppData/skills/（读写，用户管理）

**理由**: 
- 天然只读保护 — Official Skill 无法被用户修改
- 应用更新自动更新 Official Skill
- Custom Skill 自由安装/删除/修改

### Round 2: 可见性策略

**问题**: Official Skill 的 prompt（SKILL.md）是否允许用户查看？

**选择**: 元数据可见，prompt 隐藏
- Official Skill: skill.json（name, description, version, capabilities）可见，SKILL.md 隐藏
- Custom Skill: 全部可见

**理由**:
- MentionPopup 需要展示 skill 名称和描述，元数据必须可见
- SKILL.md 包含 proprietary prompt 工程，不应暴露
- Custom Skill 是用户自己创建的，无保密需求

### Round 3: Registry 结构

**问题**: SkillRegistry 如何整合两棵独立目录？

**选择**: 双 BaseDirectory 合并
- 一个 SkillRegistry 实例，管理两个 BaseDirectory
- getAllSkills() 合并返回
- resolveSkill: Custom 覆盖 Official（同名 shadow）

**理由**:
- 对调用方透明 — skillBridge 无需感知两棵目录
- Custom 覆盖 Official 允许用户替换官方 skill 行为
- 单 Registry 保持现有接口不变

### Round 4: 更新模型

**问题**: Official Skill 如何更新？

**选择**: 随应用发布
- Official Skill 打包在 tauri resource bundle 中
- 不支持独立热更新
- 应用更新即 Official Skill 更新

**理由**:
- 最简单模型，零额外基础设施
- 与两棵独立目录方案自然兼容
- Official Skill 只读，无需版本管理

### Round 5: Entitlement 策略

**问题**: Official Skill 是否需要 entitlement / license key 控制？

**选择**: P0 不做授权
- 所有可用 Official Skill 对当前用户都可用
- 无 license key / activation code 检查

**理由**:
- P0 没有用户系统 / 账户体系
- entitlement 需要后端支持，P0 不引入

### Round 6: Category/Tag 策略

**问题**: Skill category/tag 是否进入 Runtime Context？

**选择**: 预留字段，P0 不消费
- skill.json schema 保留 tags/category 字段
- MentionPopup 不按 category 分组
- Runtime 不消费 category/tag

**理由**:
- P0 不需要 category-based routing
- 保留扩展性，不增加 P0 复杂度

### Round 7: P0 范围确认

**问题**: P0 最小实现范围？

**选择**: 目录隔离 + Schema
- 两棵独立目录 → SkillRegistry 双 BaseDirectory
- Official 只读（tauri resource，不可写）
- skill.json schema 扩展（添加 `official: true` 标记）

**不包含**（Deferred）:
- SkillLoader depth control（SKILL.md 读取保护）
- Category/Tag runtime 消费
- 独立更新机制
- Entitlement 授权

### Round 8: Deferred Roadmap

**问题**: Deferred 排序？

**选择**: 冻结，只做 P0
- 所有其他能力 deferred，不排 P1/P2
- 等真实需求出现再做

## Decision Trail

| Round | Decision | Chosen | Rationale |
|-------|----------|--------|-----------|
| 1 | 物理隔离 | 两棵独立目录 | 天然只读保护，更新简洁 |
| 2 | 可见性 | meta 可见，prompt 隐藏 | proprietary protection |
| 3 | Registry 结构 | 双 BaseDirectory 合并 | 调用方透明，Custom 可 shadow |
| 4 | 更新模型 | 随应用发布 | 最简单，零额外基础设施 |
| 5 | Entitlement | P0 不做 | 无用户系统 |
| 6 | Category/Tag | 预留字段，不消费 | 不增加 P0 复杂度 |
| 7 | P0 范围 | 目录隔离 + Schema | 最小可工作集合 |
| 8 | Deferred | 全部冻结 | 等真实需求 |

## Current Understanding

Official Skill Boundary P0 通过两棵独立目录（tauri resource + AppData）实现物理隔离和只读保护。SkillRegistry 双 BaseDirectory 合并对上层透明。skill.json 扩展 `official: true` 标记。所有其他能力（prompt 保护、category、entitlement、更新）全部冻结 deferred。
