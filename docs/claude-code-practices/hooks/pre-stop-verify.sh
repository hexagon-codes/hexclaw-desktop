#!/usr/bin/env bash
# Stop hook — 会话收尾前的验证闸门
#
# 绑定方式（settings.json）:
#   "Stop": [{"hooks":[{"type":"command","command":"~/.claude/hooks/pre-stop-verify.sh"}]}]
#
# Claude Code 通过 stdin 传入 JSON（Stop 事件 payload 简单，不需要解析）
#
# 目的：防止 Claude 声称"已修复/已完成"但没跑完整测试就关话题。
#
# exit 0 = 允许收尾；exit 2 = 阻止收尾，让 Claude 继续处理

set -euo pipefail

# 只有在仓库目录内启用（不是 git 仓库就跳过）
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

# 1. 如果有未提交变更，提示跑测试
DIRTY=$(git status --porcelain 2>/dev/null | head -1 || true)
if [[ -z "$DIRTY" ]]; then
  exit 0  # 工作区干净，直接放行
fi

# 2. 查找项目有没有测试命令
TEST_CMD=""
if [[ -f "package.json" ]] && jq -e '.scripts.test' package.json >/dev/null 2>&1; then
  TEST_CMD="npm test"
elif [[ -f "Makefile" ]] && grep -qE '^test:' Makefile 2>/dev/null; then
  TEST_CMD="make test"
elif [[ -f "go.mod" ]]; then
  TEST_CMD="go test ./..."
elif [[ -f "Cargo.toml" ]]; then
  TEST_CMD="cargo test"
elif [[ -f "pyproject.toml" ]] || [[ -f "pytest.ini" ]]; then
  TEST_CMD="pytest"
fi

if [[ -z "$TEST_CMD" ]]; then
  exit 0  # 识别不出测试命令就不干涉
fi

# 3. 允许通过环境变量跳过这个 hook（紧急绕过）
if [[ "${CLAUDE_SKIP_STOP_VERIFY:-}" == "1" ]]; then
  exit 0
fi

# 4. 跑测试
echo "🧪 Stop hook: 检测到未提交变更，跑 $TEST_CMD 做收尾验证..." >&2
if OUT=$($TEST_CMD 2>&1); then
  echo "✅ 测试通过，允许收尾。" >&2
  exit 0
else
  {
    echo "❌ 测试未通过，阻止收尾。"
    echo ""
    echo "命令：$TEST_CMD"
    echo ""
    echo "$OUT" | tail -40
    echo ""
    echo "要跳过这个闸门（不推荐）：CLAUDE_SKIP_STOP_VERIFY=1 继续会话"
  } >&2
  exit 2
fi
