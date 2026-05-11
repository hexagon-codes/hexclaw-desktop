# Runtime Workspace v0.4 文档索引

> v0.4 目的：把上一版 v0.3 调整为“贴合当前项目真实进度”的执行/蓝图混合文档。  
> 关键修正：用户端技术栈改回 Tauri + Vue；当前 Runtime 以 Go 后端 SkillRuntime 为主；分销商面板、Marketplace、Browser/RPA、外部 Skill 下载等标注为 P1/P2/V2，不写进 P0 执行范围。

## 文件清单

1. `01_Current_Progress_Aligned_PRD_v0.4.md`  
   当前真实进度对齐版总需求。

2. `02_Technical_Stack_Recheck_and_Refactor_Map_v0.4.md`  
   技术栈复审与需要修改/重构清单。

3. `03_Three_Panels_UI_Cards_Stage_Marked_v0.4.md`  
   三端页面与功能卡片，全部标注 P0/P1/P2/V2。

4. `04_Skill_Security_Permission_Runtime_Rules_v0.4.md`  
   Skill 安全、权限、加密、无权限防误用与可见性规则。

## 当前执行口径

```txt
P0 当前执行主线：
Go 后端 SkillRuntime MVP
+ image_pipeline 跑通
+ 后台参数治理
+ 用户端 Chat-first 动态参数卡
+ Tauri 桌面资源接入
```

## 不应误导开发的内容

```txt
不是 Electron
不是 P0 分销商面板
不是 P0 Marketplace
不是 P0 外部 Skill 下载
不是 P0 Browser Runtime
不是 P0 全本地 Local Runtime 替代 Go 后端
```
