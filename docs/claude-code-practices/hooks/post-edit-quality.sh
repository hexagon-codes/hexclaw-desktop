#!/usr/bin/env bash
# PostToolUse hook — 改完文件后自动跑对应语言的 lint/typecheck
#
# 绑定方式（settings.json）:
#   "PostToolUse": [{"matcher":"Edit|Write|MultiEdit","hooks":[{"type":"command","command":"~/.claude/hooks/post-edit-quality.sh"}]}]
#
# Claude Code 通过 stdin 传入 JSON:
#   {"tool_name":"Edit","tool_input":{"file_path":"/abs/path/to/file.go",...}}
#
# exit 0 = 放行；exit 2 = 阻止（Claude 会在 stderr 看到错误并尝试修复）

set -euo pipefail

INPUT=$(cat)
FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')

if [[ -z "$FILE" ]] || [[ ! -f "$FILE" ]]; then
  exit 0
fi

# 跳过非源码文件
case "$FILE" in
  *.md|*.txt|*.json|*.yaml|*.yml|*.toml|*.lock|*.env*|*.gitignore)
    exit 0
    ;;
esac

fail() {
  {
    echo "❌ 质量检查未通过：$FILE"
    echo ""
    echo "$1"
    echo ""
    echo "修复后再继续。"
  } >&2
  exit 2
}

case "$FILE" in
  *.go)
    # go vet + gofmt
    if ! OUT=$(gofmt -l "$FILE" 2>&1); then
      fail "gofmt 失败：\n$OUT"
    fi
    if [[ -n "$OUT" ]]; then
      fail "gofmt 发现未格式化的代码：\n$OUT\n跑：gofmt -w $FILE"
    fi
    if ! OUT=$(cd "$(dirname "$FILE")" && go vet ./... 2>&1); then
      fail "go vet 报错：\n$OUT"
    fi
    ;;

  *.ts|*.tsx)
    if command -v npx >/dev/null 2>&1; then
      if ! OUT=$(npx --no-install tsc --noEmit 2>&1); then
        fail "tsc 类型检查失败：\n$OUT"
      fi
    fi
    ;;

  *.js|*.jsx|*.mjs|*.cjs)
    if command -v eslint >/dev/null 2>&1; then
      if ! OUT=$(eslint "$FILE" 2>&1); then
        fail "eslint 报错：\n$OUT"
      fi
    fi
    ;;

  *.py)
    if command -v ruff >/dev/null 2>&1; then
      if ! OUT=$(ruff check "$FILE" 2>&1); then
        fail "ruff 报错：\n$OUT"
      fi
    fi
    ;;

  *.rs)
    if ! OUT=$(cargo check --quiet 2>&1); then
      fail "cargo check 报错：\n$OUT"
    fi
    ;;

  *.vue)
    if command -v npx >/dev/null 2>&1; then
      if ! OUT=$(npx --no-install vue-tsc --noEmit 2>&1); then
        fail "vue-tsc 类型检查失败：\n$OUT"
      fi
    fi
    ;;
esac

exit 0
