# ADR-001 Why Not Dify or Coze

## 状态
Accepted

## 背景

项目需要：

- 商业化
- Skill 权限治理
- Runtime 可控
- 桌面资源接入

## 决策

不采用 Dify/Coze 节点工作流作为核心 Runtime。

## 原因

- 节点编排过重
- 难治理
- 用户复杂度高
- 不适合 Chat-first

## 替代方案

采用：

- 自研 SkillRuntime
- Schema Driven UI
- ExecutorRegistry
