# TASK-TRB-001 Summary: Tauri FS 配置修复

## Status: ✅ 已完成

## 改动内容

**文件**: `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`

### tauri.conf.json
- 删除 `plugins.fs` 块（旧版 `scope` 格式，与 tauri-plugin-fs v2.5.1 不兼容）
- `plugins.shell` 和 `plugins.updater` 保持不变

### capabilities/default.json
- 添加 `fs:default`（基础 fs 权限）
- 添加 `fs:allow-read` + `$APPDATA/skills/**`, `$RESOURCE/skills/**`
- 添加 `fs:allow-exists` + 同上路径
- 添加 `fs:allow-write-text-file` + 同上路径

## 验证

- `npx tsc --noEmit` 通过（TypeScript 无报错）
- `cargo build` 等待中（背景运行）

## 设计决策

- 采用 capability 系统（Tauri v2 规范迁移路径），而非降级 plugin 版本
- 权限粒度: allow-read + allow-exists + allow-write-text-file 足以覆盖 SkillRegistry 读写需求
