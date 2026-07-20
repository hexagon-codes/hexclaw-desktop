# HexClaw Desktop — 开发命令

.PHONY: dev build build-local package-local clean verify-local-deps sidecar sidecar-local sidecar-all sidecar-all-local sidecar-darwin-arm64 sidecar-darwin-amd64 sidecar-linux-amd64 sidecar-windows-amd64 sidecar-assets ollama ollama-all ollama-darwin ollama-linux-amd64 ollama-linux-arm64 render-bundle lint lint-fix format prepare-sidecar-src install test refresh-icon

HEXCLAW_REPO_URL ?= https://github.com/hexagon-codes/hexclaw.git
HEXCLAW_REF ?= refs/tags/v0.5.0-beta
HEXCLAW_SRC_DIR ?= /tmp/hexclaw-gith-src
HEXCLAW_LOCAL_SRC ?=
DESKTOP_ROOT := $(CURDIR)
SIDECAR_BIN_DIR := $(DESKTOP_ROOT)/src-tauri/binaries
TARGET ?= aarch64-apple-darwin
HEXCLAW_DEFAULT_LOCAL_SRC := $(abspath $(DESKTOP_ROOT)/../hexclaw)
HEXCLAW_DEFAULT_GOWORK := $(abspath $(DESKTOP_ROOT)/../go.work)
HEXCLAW_WORK_ROOT := $(abspath $(DESKTOP_ROOT)/..)
# 本机 go.work 构建时 hexagon 引擎源码位于 workspace 同级目录；用于注入 git 版本（方案 A）。
HEXAGON_SRC_DIR := $(HEXCLAW_WORK_ROOT)/hexagon
HEXCLAW_BUILD_SRC := $(if $(strip $(HEXCLAW_LOCAL_SRC)),$(abspath $(HEXCLAW_LOCAL_SRC)),$(HEXCLAW_SRC_DIR))
HEXCLAW_GOWORK ?= $(if $(strip $(HEXCLAW_LOCAL_SRC)),$(HEXCLAW_DEFAULT_GOWORK),)
HEXCLAW_GO_ENV := $(if $(strip $(HEXCLAW_GOWORK)),GOWORK=$(HEXCLAW_GOWORK),)
HEXCLAW_LOCAL_MODULES := github.com/hexagon-codes/hexclaw github.com/hexagon-codes/ai-core github.com/hexagon-codes/hexagon github.com/hexagon-codes/toolkit
DESKTOP_VERSION := $(shell node -p "require('./package.json').version")
HOST_TRIPLE := $(shell rustc -vV | awk '/host:/ {print $$2}')
LOCAL_DMG_ARCH := $(if $(findstring aarch64,$(HOST_TRIPLE)),aarch64,x64)
LOCAL_APP_BUNDLE := $(DESKTOP_ROOT)/src-tauri/target/release/bundle/macos/HexClaw.app
LOCAL_DMG_DIR := $(DESKTOP_ROOT)/src-tauri/target/release/bundle/dmg
LOCAL_DMG_ROOT := $(LOCAL_DMG_DIR)/HexClaw.dmgroot
LOCAL_DMG_PATH := $(LOCAL_DMG_DIR)/HexClaw_$(DESKTOP_VERSION)_$(LOCAL_DMG_ARCH).dmg
LOCAL_PACKAGE_TAURI_CONFIG := $(DESKTOP_ROOT)/src-tauri/tauri.package-local.conf.json

# Ollama 版本控制（更新版本只需改这一处）
OLLAMA_VERSION ?= 0.30.10
OLLAMA_RELEASE_BASE ?= https://github.com/ollama/ollama/releases/download/v$(OLLAMA_VERSION)

# 开发模式 (前端 + Tauri 窗口)
dev:
	pnpm tauri dev

# 构建生产版本
build:
	pnpm tauri build

# 本机装机包：先用本地全生态 Go workspace 重建 sidecar，再构建 Tauri 包。
build-local package-local: sidecar-local
	pnpm tauri build --config "$(LOCAL_PACKAGE_TAURI_CONFIG)" --bundles app
	@if [ "$$(uname -s)" = "Darwin" ]; then \
		rm -rf "$(LOCAL_DMG_ROOT)" "$(LOCAL_DMG_PATH)"; \
		mkdir -p "$(LOCAL_DMG_ROOT)" "$(LOCAL_DMG_DIR)"; \
		ditto "$(LOCAL_APP_BUNDLE)" "$(LOCAL_DMG_ROOT)/HexClaw.app"; \
		ln -s /Applications "$(LOCAL_DMG_ROOT)/Applications"; \
		hdiutil create -volname "HexClaw" -srcfolder "$(LOCAL_DMG_ROOT)" -ov -format UDZO "$(LOCAL_DMG_PATH)"; \
		rm -rf "$(LOCAL_DMG_ROOT)"; \
		echo "本地装机 DMG: $(LOCAL_DMG_PATH)"; \
	fi

# 仅构建前端
build-web:
	pnpm build

# 从 GitHub 远程仓库同步后端源码；设置 HEXCLAW_LOCAL_SRC 时改用本地源码。
prepare-sidecar-src:
	@if [ -n "$(strip $(HEXCLAW_LOCAL_SRC))" ]; then \
		test -d "$(HEXCLAW_BUILD_SRC)/cmd/hexclaw" || { echo "本地 hexclaw 源码无效: $(HEXCLAW_BUILD_SRC)"; exit 1; }; \
		if [ -n "$(strip $(HEXCLAW_GOWORK))" ]; then \
			test -f "$(HEXCLAW_GOWORK)" || { echo "Go workspace 不存在: $(HEXCLAW_GOWORK)"; exit 1; }; \
			echo "使用本地 hexclaw 源码: $(HEXCLAW_BUILD_SRC)"; \
			echo "使用 Go workspace: $(HEXCLAW_GOWORK)"; \
		else \
			echo "使用本地 hexclaw 源码: $(HEXCLAW_BUILD_SRC)"; \
		fi; \
	else \
		mkdir -p $$(dirname "$(HEXCLAW_SRC_DIR)"); \
		if [ ! -d "$(HEXCLAW_SRC_DIR)/.git" ]; then \
			echo "克隆 hexclaw 后端源码: $(HEXCLAW_REPO_URL)"; \
			git clone "$(HEXCLAW_REPO_URL)" "$(HEXCLAW_SRC_DIR)"; \
		fi; \
		git -C "$(HEXCLAW_SRC_DIR)" remote set-url origin "$(HEXCLAW_REPO_URL)"; \
		git -C "$(HEXCLAW_SRC_DIR)" fetch origin; \
		git -C "$(HEXCLAW_SRC_DIR)" checkout --detach "$(HEXCLAW_REF)"; \
	fi

# 同步 reference.docx 到已跟踪资产 src-tauri/render-assets/（tauri.conf resources 从此处打包）。
# 资产已纳入 git，是打包真源；仅在后端更新了 reference.docx 时手动跑此目标刷新。
sidecar-assets: prepare-sidecar-src
	@if [ -f "$(HEXCLAW_BUILD_SRC)/render/assets/reference.docx" ]; then \
		cp "$(HEXCLAW_BUILD_SRC)/render/assets/reference.docx" $(DESKTOP_ROOT)/src-tauri/render-assets/reference.docx; \
		echo "  ✓ synced render-assets/reference.docx"; \
	else \
		echo "  ⚠️  reference.docx 不在 $(HEXCLAW_BUILD_SRC) 中（保留已跟踪副本）"; \
	fi

# 编译 hexclaw sidecar 并放入 binaries 目录 (自动检测当前平台)
sidecar: prepare-sidecar-src
	@echo "编译 hexclaw sidecar..."
	@mkdir -p src-tauri/binaries
	cd "$(HEXCLAW_BUILD_SRC)" && \
		VERSION="$$(git describe --tags --always --dirty 2>/dev/null)" && \
		COMMIT="$$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" && \
		DATE="$$(date -u +%Y-%m-%dT%H:%M:%SZ)" && \
		HEXAGON_VER="$$(git -C "$(HEXAGON_SRC_DIR)" describe --tags --dirty 2>/dev/null || true)" && \
		$(HEXCLAW_GO_ENV) go build -ldflags="-X main.version=$$VERSION -X main.commit=$$COMMIT -X main.date=$$DATE -X github.com/hexagon-codes/hexagon.injectedVersion=$$HEXAGON_VER" \
			-o "$(SIDECAR_BIN_DIR)/hexclaw-$$(rustc -vV | grep 'host:' | awk '{print $$2}')" ./cmd/hexclaw
	@echo "sidecar 编译完成"

verify-local-deps:
	@test -f "$(HEXCLAW_DEFAULT_GOWORK)" || { echo "Go workspace 不存在: $(HEXCLAW_DEFAULT_GOWORK)"; exit 1; }
	@test -d "$(HEXCLAW_DEFAULT_LOCAL_SRC)/cmd/hexclaw" || { echo "本地 hexclaw 源码无效: $(HEXCLAW_DEFAULT_LOCAL_SRC)"; exit 1; }
	@echo "校验本地 Go workspace 依赖..."
	@cd "$(HEXCLAW_DEFAULT_LOCAL_SRC)" && \
		GOWORK="$(HEXCLAW_DEFAULT_GOWORK)" go list -m -f '{{.Path}}	{{.Dir}}	{{.Main}}' $(HEXCLAW_LOCAL_MODULES) | \
		while IFS=$$(printf '\t') read -r path dir main; do \
			case "$$dir" in \
				"$(HEXCLAW_WORK_ROOT)"/*) echo "  ✓ $$path -> $$dir";; \
				*) echo "  ✗ $$path 未解析到本地 workspace: $$dir"; exit 1;; \
			esac; \
			if [ "$$main" != "true" ]; then echo "  ✗ $$path 不是 workspace main module"; exit 1; fi; \
		done

sidecar-local: verify-local-deps
	$(MAKE) sidecar HEXCLAW_LOCAL_SRC="$(HEXCLAW_DEFAULT_LOCAL_SRC)" HEXCLAW_GOWORK="$(HEXCLAW_DEFAULT_GOWORK)"

# Cross-compile sidecar for all platforms
sidecar-all: sidecar-darwin-arm64 sidecar-darwin-amd64 sidecar-linux-amd64 sidecar-windows-amd64

sidecar-all-local: verify-local-deps
	$(MAKE) sidecar-all HEXCLAW_LOCAL_SRC="$(HEXCLAW_DEFAULT_LOCAL_SRC)" HEXCLAW_GOWORK="$(HEXCLAW_DEFAULT_GOWORK)"

sidecar-darwin-arm64: prepare-sidecar-src
	@mkdir -p src-tauri/binaries
	cd "$(HEXCLAW_BUILD_SRC)" && \
		VERSION="$$(git describe --tags --always --dirty 2>/dev/null)" && \
		COMMIT="$$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" && \
		DATE="$$(date -u +%Y-%m-%dT%H:%M:%SZ)" && \
		GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 $(HEXCLAW_GO_ENV) go build \
			-ldflags="-s -w -X main.version=$$VERSION -X main.commit=$$COMMIT -X main.date=$$DATE" \
			-o "$(SIDECAR_BIN_DIR)/hexclaw-aarch64-apple-darwin" ./cmd/hexclaw

sidecar-darwin-amd64: prepare-sidecar-src
	@mkdir -p src-tauri/binaries
	cd "$(HEXCLAW_BUILD_SRC)" && \
		VERSION="$$(git describe --tags --always --dirty 2>/dev/null)" && \
		COMMIT="$$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" && \
		DATE="$$(date -u +%Y-%m-%dT%H:%M:%SZ)" && \
		GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 $(HEXCLAW_GO_ENV) go build \
			-ldflags="-s -w -X main.version=$$VERSION -X main.commit=$$COMMIT -X main.date=$$DATE" \
			-o "$(SIDECAR_BIN_DIR)/hexclaw-x86_64-apple-darwin" ./cmd/hexclaw

sidecar-linux-amd64: prepare-sidecar-src
	@mkdir -p src-tauri/binaries
	cd "$(HEXCLAW_BUILD_SRC)" && \
		VERSION="$$(git describe --tags --always --dirty 2>/dev/null)" && \
		COMMIT="$$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" && \
		DATE="$$(date -u +%Y-%m-%dT%H:%M:%SZ)" && \
		GOOS=linux GOARCH=amd64 CGO_ENABLED=0 $(HEXCLAW_GO_ENV) go build \
			-ldflags="-s -w -X main.version=$$VERSION -X main.commit=$$COMMIT -X main.date=$$DATE" \
			-o "$(SIDECAR_BIN_DIR)/hexclaw-x86_64-unknown-linux-gnu" ./cmd/hexclaw

sidecar-windows-amd64: prepare-sidecar-src
	@mkdir -p src-tauri/binaries
	cd "$(HEXCLAW_BUILD_SRC)" && \
		VERSION="$$(git describe --tags --always --dirty 2>/dev/null)" && \
		COMMIT="$$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" && \
		DATE="$$(date -u +%Y-%m-%dT%H:%M:%SZ)" && \
		GOOS=windows GOARCH=amd64 CGO_ENABLED=0 $(HEXCLAW_GO_ENV) go build \
			-ldflags="-s -w -X main.version=$$VERSION -X main.commit=$$COMMIT -X main.date=$$DATE" \
			-o "$(SIDECAR_BIN_DIR)/hexclaw-x86_64-pc-windows-msvc.exe" ./cmd/hexclaw

# ─── 文档渲染二进制下载（pandoc + typst）─────────────────
# 详见 hexclaw/.claude/doc-generation-architecture.md §3.2 升级回归策略
#
# 版本号 + SHA256 集中维护在 release/scripts/versions.json（待补）；
# 本期最小可用版本：固定当前测试通过的最新版，校验 SHA256，下载到 sidecar binaries 目录。
# CI 每周拉 latest 跑黄金回归，patch 版本自动滚 PR。

# 下载当前平台的 pandoc + typst，按 externalBin 命名落到 binaries/ 根目录
# （pandoc-<triple> / typst-<triple>，与 hexclaw sidecar 同目录，tauri 自动签名）。
# 版本号 + SHA256 维护在 release/scripts/versions.json；脚本支持通过
# RENDER_BUNDLE_TARGET={darwin-arm64|darwin-x86_64|linux-x86_64|windows-x86_64} 交叉打包。
render-bundle:
	./release/scripts/render-bundle.sh $(SIDECAR_BIN_DIR)

# ─── Ollama 二进制下载 ──────────────────────────────────
# 从 GitHub Releases 下载预编译 Ollama 二进制，重命名为 Rust target triple

OLLAMA_BUNDLE_DIR := $(SIDECAR_BIN_DIR)/ollama-bundle

# 自动检测当前平台下载 Ollama（含二进制 + 动态库）
ollama:
	@mkdir -p $(OLLAMA_BUNDLE_DIR)
	@case "$$(uname -s)-$$(uname -m)" in \
		Darwin-*) \
			echo "下载 Ollama v$(OLLAMA_VERSION) for macOS..."; \
			curl -fSL "$(OLLAMA_RELEASE_BASE)/ollama-darwin.tgz" -o /tmp/ollama-darwin.tgz; \
			tar xzf /tmp/ollama-darwin.tgz -C $(OLLAMA_BUNDLE_DIR); \
			rm -f /tmp/ollama-darwin.tgz; \
			;; \
		Linux-x86_64) \
			echo "下载 Ollama v$(OLLAMA_VERSION) for Linux amd64..."; \
			curl -fSL "$(OLLAMA_RELEASE_BASE)/ollama-linux-amd64.tar.zst" -o /tmp/ollama-linux.tar.zst; \
			zstd -d /tmp/ollama-linux.tar.zst -o /tmp/ollama-linux.tar; \
			tar xf /tmp/ollama-linux.tar -C $(OLLAMA_BUNDLE_DIR); \
			rm -f /tmp/ollama-linux.tar.zst /tmp/ollama-linux.tar; \
			;; \
		Linux-aarch64) \
			echo "下载 Ollama v$(OLLAMA_VERSION) for Linux arm64..."; \
			curl -fSL "$(OLLAMA_RELEASE_BASE)/ollama-linux-arm64.tar.zst" -o /tmp/ollama-linux.tar.zst; \
			zstd -d /tmp/ollama-linux.tar.zst -o /tmp/ollama-linux.tar; \
			tar xf /tmp/ollama-linux.tar -C $(OLLAMA_BUNDLE_DIR); \
			rm -f /tmp/ollama-linux.tar.zst /tmp/ollama-linux.tar; \
			;; \
		*) echo "不支持的平台: $$(uname -s)-$$(uname -m)"; exit 1 ;; \
	esac
	@chmod +x "$(OLLAMA_BUNDLE_DIR)/ollama"
	@echo "Ollama v$(OLLAMA_VERSION) 下载完成 → $(OLLAMA_BUNDLE_DIR)/"
	@ls -lh "$(OLLAMA_BUNDLE_DIR)/ollama"

# 代码检查
lint:
	pnpm lint

# 代码检查并自动修复
lint-fix:
	pnpm lint:fix

# 代码格式化
format:
	pnpm format

# 类型检查
type-check:
	pnpm type-check

# 单元测试
test:
	pnpm test:unit

# 清理构建产物
clean:
	rm -rf dist
	rm -rf src-tauri/target
	rm -rf src-tauri/binaries
	rm -rf node_modules/.vite

# 安装依赖
install:
	pnpm install
	cd src-tauri && cargo fetch

# macOS：刷新已安装 App 的图标缓存。
# 现象：反复装机后 Finder/应用程序里 HexClaw.app 显示通用占位图标，但 Dock 里正常显示蟹图标。
# 根因：bundle 的 Contents/Resources/icon.icns 完好（Dock 取的就是它，能正常渲染），是 macOS
#   icon-services 缓存在「同路径 + 同 bundle id 反复覆盖安装」时未失效，残留旧占位图 —— 非构建缺陷。
# 修复：用 Launch Services 强制重注册并重启 Dock/Finder 让其重读 bundle 图标。
APP_INSTALL_PATH ?= /Applications/HexClaw.app
LSREGISTER := /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
refresh-icon:
	@test -d "$(APP_INSTALL_PATH)" || { echo "未找到 $(APP_INSTALL_PATH)（先装机：pnpm tauri build 后拷到 /Applications）"; exit 1; }
	"$(LSREGISTER)" -f "$(APP_INSTALL_PATH)"
	touch "$(APP_INSTALL_PATH)"
	killall Dock Finder 2>/dev/null || true
	@echo "✓ 已重注册并重启 Dock/Finder。若仍是占位图标（icon-services 缓存被深度污染），执行带 sudo 的彻底清缓存："
	@echo "    sudo rm -rf /Library/Caches/com.apple.iconservices.store && sudo find /private/var/folders -name com.apple.dock.iconcache -delete; killall Dock Finder"
