#!/usr/bin/env bash
# release/scripts/render-bundle.sh — 按平台下载 pandoc + typst，校验 SHA256，安装到 sidecar binaries。
#
# 用法：
#   ./release/scripts/render-bundle.sh [<dest-dir>]
#
# 默认 dest-dir = src-tauri/binaries/render-bundle。
# 平台从 uname 自动探测；交叉打包时通过 RENDER_BUNDLE_TARGET 覆盖：
#   RENDER_BUNDLE_TARGET=windows-x86_64 ./release/scripts/render-bundle.sh
#
# SHA256 校验和在 versions.json 里；FILL_ON_NEXT_RELEASE_AUDIT 占位时跳过校验
# （初次接入还没补上）。CI 必须把所有平台的 sha256 填上才算合格。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VERSIONS_JSON="$SCRIPT_DIR/versions.json"
DEST_DIR="${1:-$REPO_ROOT/src-tauri/binaries/render-bundle}"

if [ ! -f "$VERSIONS_JSON" ]; then
  echo "FATAL: versions.json not found at $VERSIONS_JSON" >&2
  exit 1
fi

# 探测平台
target="${RENDER_BUNDLE_TARGET:-}"
if [ -z "$target" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)   target="darwin-arm64" ;;
    Darwin-x86_64)  target="darwin-x86_64" ;;
    Linux-x86_64)   target="linux-x86_64" ;;
    *)
      echo "ERROR: unsupported platform $(uname -s)-$(uname -m); set RENDER_BUNDLE_TARGET to override" >&2
      exit 1
      ;;
  esac
fi

mkdir -p "$DEST_DIR"

read_json() {
  # read_json <key-path>  — 用 python3 读 JSON，避免依赖 jq
  python3 -c "import json,sys; j=json.load(open('$VERSIONS_JSON')); print(j$1)"
}

verify_sha256() {
  local file="$1" expected="$2"
  if [ "$expected" = "FILL_ON_NEXT_RELEASE_AUDIT" ]; then
    echo "  ⚠️  SHA256 校验跳过（versions.json 未填，仅开发期临时允许）"
    return 0
  fi
  local actual
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  else
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  fi
  if [ "$actual" != "$expected" ]; then
    echo "ERROR: SHA256 mismatch for $file" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
  echo "  ✓ SHA256 verified"
}

download_engine() {
  local name="$1"
  local version url sha256 archive
  version="$(read_json "['$name']['version']")"
  url="$(read_json "['$name']['platforms']['$target']['url']")"
  sha256="$(read_json "['$name']['platforms']['$target']['sha256']")"

  echo "下载 $name v$version (target: $target)..."
  case "$url" in
    *.zip)    archive="/tmp/render-bundle-$name-$$.zip" ;;
    *.tar.gz) archive="/tmp/render-bundle-$name-$$.tar.gz" ;;
    *.tar.xz) archive="/tmp/render-bundle-$name-$$.tar.xz" ;;
    *)        echo "ERROR: unknown archive format: $url" >&2; exit 1 ;;
  esac

  curl -fSL "$url" -o "$archive"
  verify_sha256 "$archive" "$sha256"

  # 解包到 staging，再 find 出二进制移到 DEST_DIR — 避开 BSD/GNU tar 的 --wildcards 差异
  local staging
  staging="$(mktemp -d "/tmp/render-bundle-stage-$name-XXXXXX")"
  case "$archive" in
    *.zip)    unzip -q -o "$archive" -d "$staging" ;;
    *.tar.gz) tar xzf "$archive" -C "$staging" ;;
    *.tar.xz) tar xJf "$archive" -C "$staging" ;;
  esac
  rm -f "$archive"

  # 优先匹配可执行文件名，再 fallback .exe（Windows）
  local found
  found="$(find "$staging" -type f \( -name "$name" -o -name "$name.exe" \) -print 2>/dev/null | head -1)"
  if [ -z "$found" ]; then
    echo "ERROR: $name binary not found inside archive (staging=$staging)" >&2
    find "$staging" -maxdepth 3 -type f >&2 || true
    exit 1
  fi

  case "$found" in
    *.exe) cp "$found" "$DEST_DIR/$name.exe" ;;
    *)     cp "$found" "$DEST_DIR/$name" && chmod +x "$DEST_DIR/$name" ;;
  esac
  rm -rf "$staging"
}

download_engine pandoc
download_engine typst

echo "render-bundle 完成: $DEST_DIR (target=$target)"
ls -la "$DEST_DIR"
