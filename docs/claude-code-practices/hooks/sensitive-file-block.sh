#!/usr/bin/env bash
# PreToolUse hook — 拦截 git commit 时包含敏感文件的情况
#
# 绑定方式（settings.json）:
#   "PreToolUse": [{"matcher":"Bash","hooks":[{"type":"command","command":"~/.claude/hooks/sensitive-file-block.sh"}]}]
#
# Claude Code 通过 stdin 传入 JSON:
#   {"tool_name":"Bash","tool_input":{"command":"git commit -m ..."}}
#
# exit 0 = 放行；exit 2 = 阻止（Claude 会看到 stderr 作为反馈）

set -euo pipefail

# 读取 stdin JSON
INPUT=$(cat)

# 提取 Bash 命令文本
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')

# 只拦截 git commit（其他 bash 调用放行）
if [[ ! "$CMD" =~ git[[:space:]]+commit ]]; then
  exit 0
fi

# 检查暂存区是否有敏感文件
STAGED=$(git diff --cached --name-only 2>/dev/null || true)
if [[ -z "$STAGED" ]]; then
  exit 0
fi

SENSITIVE=$(printf '%s\n' "$STAGED" | grep -E '\.(env|pem|key|secret|pfx|p12|keystore)(\..+)?$|(^|/)\.env($|\.)|credentials\.json$|id_rsa$' || true)

if [[ -n "$SENSITIVE" ]]; then
  {
    echo "❌ 阻止 git commit：检测到敏感文件进入暂存区"
    echo ""
    echo "$SENSITIVE" | sed 's/^/  - /'
    echo ""
    echo "修复方式："
    echo "  1) git restore --staged <file>   # 取消暂存"
    echo "  2) 把文件加入 .gitignore"
    echo "  3) 确认无误后重试 commit"
  } >&2
  exit 2
fi

exit 0
