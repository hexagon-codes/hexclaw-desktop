# Hooks 合集

Claude Code 的 Hooks 机制能在特定事件点自动触发 shell 脚本——这是让 AI unattended 运行也不翻车的关键。本目录提供 3 份开箱即用的 hook 样本 + 一份 `settings.json` 配置示例。

## Claude Code Hook 事件类型

| 事件 | 触发时机 | 典型用途 |
|------|---------|---------|
| `PreToolUse` | 工具调用**前** | 拦截敏感操作（命令白名单、文件黑名单） |
| `PostToolUse` | 工具调用**后** | 跑 lint / 编译 / 格式化 |
| `UserPromptSubmit` | 用户提交 prompt 时 | 注入项目上下文、提醒检查项 |
| `Stop` | 会话结束前 | 跑完整测试套件、阻止未验证收尾 |
| `SessionStart` | 会话开启时 | 加载项目状态摘要 |

Hook 脚本从 **stdin 读取 JSON** 获取事件信息，通过 **exit code** 控制：
- `exit 0`：放行
- `exit 2`：阻止操作（Claude 会看到 stderr 输出作为反馈，可以修正后重试）
- 其他非零：错误

> ⚠️ 本文提供的脚本都按 Claude Code 官方 hook 协议实现。不要直接拷贝公众号文章里的简化版（那些是伪代码示意）。

## 安装到个人全局（所有项目共用）

```bash
# 复制脚本
mkdir -p ~/.claude/hooks
cp hooks/*.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/*.sh

# 合并 settings.json（参考下方示例段落，按需合并到 ~/.claude/settings.json）
```

## 安装到项目级（只对本仓库生效）

```bash
mkdir -p .claude/hooks
cp hooks/*.sh .claude/hooks/
chmod +x .claude/hooks/*.sh
# 然后在 .claude/settings.json 里配置 hooks（见下）
```

## `settings.json` 配置示例

把这段合并到 `~/.claude/settings.json`（全局）或 `.claude/settings.json`（项目）：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/sensitive-file-block.sh"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/post-edit-quality.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/pre-stop-verify.sh"
          }
        ]
      }
    ]
  }
}
```

项目级路径用 `${CLAUDE_PROJECT_DIR}/.claude/hooks/*.sh` 替换 `~/.claude/hooks/*.sh`。

## 三个样本脚本

| 文件 | 事件 | 作用 |
|------|------|------|
| `sensitive-file-block.sh` | PreToolUse / Bash | 拦截 `git commit`，如果暂存区有 `.env` / `.pem` / `*.key` / `*.secret` 就阻止 |
| `post-edit-quality.sh` | PostToolUse / Edit·Write·MultiEdit | 改完 `.go` `.ts` `.py` 文件后自动跑对应的 lint/typecheck，失败阻止后续操作 |
| `pre-stop-verify.sh` | Stop | 会话结束前检查：有未提交变更时提示跑测试，测试未通过阻止收尾 |

## 调试建议

- 本地跑单个脚本：`echo '{"tool_name":"Bash","tool_input":{"command":"git commit"}}' | ~/.claude/hooks/sensitive-file-block.sh`
- 查看实际收到的 JSON：脚本里加 `cat - | tee /tmp/hook-input.json`
- Hook 阻止时 Claude 会收到 stderr 内容——写清楚**阻止原因 + 怎么修**比单纯报错有用

## 我线上挂了什么

主要跑的 6 个 hook，覆盖敏感文件、lint、编译、关键测试、生成前注入上下文、收尾前跑完整测试套件。没跑通就不让改动进仓库。
