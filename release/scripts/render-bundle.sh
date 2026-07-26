#!/usr/bin/env bash
# release/scripts/render-bundle.sh — 按平台下载 pandoc + typst，校验 SHA256，安装到 sidecar binaries。
#
# 用法：
#   ./release/scripts/render-bundle.sh [<dest-dir>]
#
# 默认 dest-dir = src-tauri/binaries（externalBin 根目录）。
# 产出 externalBin 命名：<dest>/pandoc-<rust-triple>、<dest>/typst-<rust-triple>。
# 平台从 uname 自动探测；交叉打包时通过 RENDER_BUNDLE_TARGET 覆盖：
#   RENDER_BUNDLE_TARGET=windows-x86_64 ./release/scripts/render-bundle.sh
#
# SHA256 校验和在 versions.json 里；FILL_ON_NEXT_RELEASE_AUDIT 占位时跳过校验
# （初次接入还没补上）。CI 必须把所有平台的 sha256 填上才算合格。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VERSIONS_JSON="$SCRIPT_DIR/versions.json"
DEST_DIR="${1:-$REPO_ROOT/src-tauri/binaries}"

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

# Rust target triple（externalBin 命名用）
case "$target" in
  darwin-arm64)    triple="aarch64-apple-darwin" ;;
  darwin-x86_64)   triple="x86_64-apple-darwin" ;;
  linux-x86_64)    triple="x86_64-unknown-linux-gnu" ;;
  windows-x86_64)  triple="x86_64-pc-windows-msvc" ;;
  *) echo "ERROR: no rust triple mapping for target=$target" >&2; exit 1 ;;
esac

mkdir -p "$DEST_DIR"

read_json() {
  # read_json <key-path>  — python3 读 JSON，经 stdin 喂文件：bash 负责打开（认得 Windows
  # git-bash 的 MSYS 路径），python 只读 stdin，避开 Windows python 解析不了 /d/a/... 的问题。
  # 不依赖 jq（CI runner 不保证有）。
  python3 -c "import json,sys; j=json.load(sys.stdin); print(j$1)" < "$VERSIONS_JSON"
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
  # 解包：tar.gz/tar.xz 用 tar；zip 在 Windows(git-bash 的 GNU tar 不支持 zip)用 python
  # zipfile（路径经 cygpath 转 native 喂 Windows python），其余平台用 bsdtar(tar -xf)。
  local zsrc zdst
  case "$archive" in
    *.zip)
      if [ "$target" = "windows-x86_64" ]; then
        zsrc="$(command -v cygpath >/dev/null 2>&1 && cygpath -w "$archive" || printf '%s' "$archive")"
        zdst="$(command -v cygpath >/dev/null 2>&1 && cygpath -w "$staging" || printf '%s' "$staging")"
        python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$zsrc" "$zdst"
      else
        tar -xf "$archive" -C "$staging"
      fi
      ;;
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

  # externalBin 命名：<name>-<triple>（Windows 加 .exe）。
  # 先写同目录临时文件再原子替换，避免已打包过的只读二进制令 cp 失败后仍被误判成功。
  local output_name output staged
  if [ "$target" = "windows-x86_64" ]; then
    output_name="$name-$triple.exe"
  else
    output_name="$name-$triple"
  fi
  output="$DEST_DIR/$output_name"
  staged="$DEST_DIR/.$output_name.tmp.$$"
  rm -f "$staged"
  if ! cp "$found" "$staged" || ! chmod +x "$staged" || ! mv -f "$staged" "$output"; then
    rm -f "$staged"
    echo "ERROR: failed to install $name external binary at $output" >&2
    rm -rf "$staging"
    return 1
  fi
  rm -rf "$staging"
}

download_engine pandoc
download_engine typst

echo "render engines staged: $DEST_DIR (target=$target, triple=$triple)"
ls -la "$DEST_DIR"/pandoc-* "$DEST_DIR"/typst-* 2>/dev/null || true
