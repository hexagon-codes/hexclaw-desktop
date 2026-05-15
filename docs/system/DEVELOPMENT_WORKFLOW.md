# DEVELOPMENT_WORKFLOW

> Runtime-native 老项目二次开发流程  
> Version: v0.1  
> Date: 2026-05-14

---

## 1. 当前协作原则

当前项目只使用 Claude 终端为主。

maestro-flow 是开发工具链，不是项目架构参考。

可以使用 maestro-flow 的能力：

- analyze
- plan
- execute
- verify
- review
- checkpoint
- freeze
- issue
- skill / UI skill / 约束管理

但禁止把 maestro-flow 的架构引入 HexClaw Runtime 项目内部。

---

## 2. 为什么要文档先行

本项目是老项目二次开发 + Runtime 融合。

如果边改边想，会出现：

- AI 反复重新扫描项目
- Runtime 边界漂移
- Skill 语义被误解
- UI 改动影响 Runtime
- WS/RT 双路径混淆
- Tauri/browser 环境差异被忽略

所以必须：

```
System Map
  ↓
Gap Doc
  ↓
Module Doc
  ↓
Single Module Execute
  ↓
UAT
  ↓
Freeze / Tag
```

---

## 3. 每个模块必须包含

每个 `docs/refactor/modules/module-xxx.md` 必须包含：

- 当前现状
- 目标状态
- 涉及文件
- 不允许改动的边界
- 验收标准
- 回滚方式
- 是否需要 Tauri Desktop UAT

没有模块文档，不允许执行代码修改。

---

## 4. 单模块执行流程

```
选择一个 module
  ↓
读取 module 文档
  ↓
生成 plan
  ↓
执行
  ↓
验证
  ↓
UAT
  ↓
review
  ↓
commit + tag
  ↓
更新 MODULE_STATUS
```

---

## 5. 禁止事项

- 禁止一次执行多个 P1 module
- 禁止顺手改 RuntimeStore
- 禁止无文档改 SkillRegistry
- 禁止 UI 改动顺手改 Runtime
- 禁止 prompt 问题升级为 workflow/repair/validator
- 禁止把浏览器 dev 测试当作 Tauri Desktop 验收
- 禁止用一次静态验证替代真实 Desktop UAT

---

## 6. 推荐命令模式

### 分析

```
/maestro-analyze --dir <module-doc-dir>
```

### 规划

```
/maestro-plan --dir <analysis-dir>
```

### 执行

```
/maestro-execute --dir <plan-dir>
```

### 验证

```
/maestro-verify --dir <plan-dir>
```

### 审查

```
/quality-review
```

---

## 7. 新终端恢复

新终端先读：

```
docs/system/PROJECT_CONSTITUTION.md
docs/system/SYSTEM_MAP.md
docs/system/MODULE_STATUS.md
docs/system/RUNTIME_BOUNDARY.md
docs/system/DEVELOPMENT_WORKFLOW.md
```

然后只问：

```
当前 active module 是什么？
是否有未提交代码？
是否有未完成 UAT？
```

不要重新分析整个项目。
