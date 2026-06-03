# HexClaw Desktop — 开发命令

.PHONY: dev build clean sidecar sidecar-all sidecar-darwin-arm64 sidecar-darwin-amd64 sidecar-linux-amd64 sidecar-windows-amd64 sidecar-assets ollama ollama-all ollama-darwin ollama-linux-amd64 ollama-linux-arm64 render-bundle lint lint-fix format prepare-sidecar-src

HEXCLAW_REPO_URL ?= https://github.com/hexagon-codes/hexclaw.git
HEXCLAW_REF ?= refs/tags/v0.4.1
HEXCLAW_SRC_DIR ?= /tmp/hexclaw-gith-src
DESKTOP_ROOT := $(CURDIR)
SIDECAR_BIN_DIR := $(DESKTOP_ROOT)/src-tauri/binaries
TARGET ?= aarch64-apple-darwin

# Ollama 版本控制（更新版本只需改这一处）
OLLAMA_VERSION ?= 0.20.3
OLLAMA_RELEASE_BASE ?= https://github.com/ollama/ollama/releases/download/v$(OLLAMA_VERSION)

# 开发模式 (前端 + Tauri 窗口)
dev:
	pnpm tauri dev

# 构建生产版本
build:
	pnpm tauri build

# 仅构建前端
build-web:
	pnpm build

# 从 GitHub 远程仓库同步后端源码
prepare-sidecar-src:
	@mkdir -p $$(dirname "$(HEXCLAW_SRC_DIR)")
	@if [ ! -d "$(HEXCLAW_SRC_DIR)/.git" ]; then \
		echo "克隆 hexclaw 后端源码: $(HEXCLAW_REPO_URL)"; \
		git clone "$(HEXCLAW_REPO_URL)" "$(HEXCLAW_SRC_DIR)"; \
	fi
	git -C "$(HEXCLAW_SRC_DIR)" remote set-url origin "$(HEXCLAW_REPO_URL)"
	git -C "$(HEXCLAW_SRC_DIR)" fetch origin
	git -C "$(HEXCLAW_SRC_DIR)" checkout --detach "$(HEXCLAW_REF)"

# 把 sidecar 运行期资产（reference.docx 等）拷到 binaries/assets/，
# 与可执行文件同目录——main.go.resolveRenderAssetPaths 第一优先级在此查找。
# HEXCLAW_REF 尚未含资产时静默跳过，sidecar 启动会回退到 cwd / ~/.hexclaw 候选。
sidecar-assets: prepare-sidecar-src
	@mkdir -p $(SIDECAR_BIN_DIR)/assets/render
	@if [ -f "$(HEXCLAW_SRC_DIR)/render/assets/reference.docx" ]; then \
		cp "$(HEXCLAW_SRC_DIR)/render/assets/reference.docx" $(SIDECAR_BIN_DIR)/assets/render/; \
		echo "  ✓ render assets: reference.docx"; \
	else \
		echo "  ⚠️  reference.docx 不在 HEXCLAW_REF=$(HEXCLAW_REF) 中（跳过；sidecar 仍可启动，回退到 ~/.hexclaw）"; \
	fi

# 编译 hexclaw sidecar 并放入 binaries 目录 (自动检测当前平台)
sidecar: prepare-sidecar-src sidecar-assets
	@echo "编译 hexclaw sidecar..."
	@mkdir -p src-tauri/binaries
	cd "$(HEXCLAW_SRC_DIR)" && \
		VERSION="$$(git describe --tags --always --dirty 2>/dev/null)" && \
		COMMIT="$$(git rev-parse --short HEAD)" && \
		DATE="$$(date -u +%Y-%m-%dT%H:%M:%SZ)" && \
		go build -ldflags="-X main.version=$$VERSION -X main.commit=$$COMMIT -X main.date=$$DATE" \
			-o "$(SIDECAR_BIN_DIR)/hexclaw-$$(rustc -vV | grep 'host:' | awk '{print $$2}')" ./cmd/hexclaw
	@echo "sidecar 编译完成"

# Cross-compile sidecar for all platforms
sidecar-all: sidecar-darwin-arm64 sidecar-darwin-amd64 sidecar-linux-amd64 sidecar-windows-amd64

sidecar-darwin-arm64: prepare-sidecar-src sidecar-assets
	@mkdir -p src-tauri/binaries
	cd "$(HEXCLAW_SRC_DIR)" && \
		VERSION="$$(git describe --tags --always --dirty 2>/dev/null)" && \
		COMMIT="$$(git rev-parse --short HEAD)" && \
		DATE="$$(date -u +%Y-%m-%dT%H:%M:%SZ)" && \
		GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build \
			-ldflags="-s -w -X main.version=$$VERSION -X main.commit=$$COMMIT -X main.date=$$DATE" \
			-o "$(SIDECAR_BIN_DIR)/hexclaw-aarch64-apple-darwin" ./cmd/hexclaw

sidecar-darwin-amd64: prepare-sidecar-src sidecar-assets
	@mkdir -p src-tauri/binaries
	cd "$(HEXCLAW_SRC_DIR)" && \
		VERSION="$$(git describe --tags --always --dirty 2>/dev/null)" && \
		COMMIT="$$(git rev-parse --short HEAD)" && \
		DATE="$$(date -u +%Y-%m-%dT%H:%M:%SZ)" && \
		GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 go build \
			-ldflags="-s -w -X main.version=$$VERSION -X main.commit=$$COMMIT -X main.date=$$DATE" \
			-o "$(SIDECAR_BIN_DIR)/hexclaw-x86_64-apple-darwin" ./cmd/hexclaw

sidecar-linux-amd64: prepare-sidecar-src sidecar-assets
	@mkdir -p src-tauri/binaries
	cd "$(HEXCLAW_SRC_DIR)" && \
		VERSION="$$(git describe --tags --always --dirty 2>/dev/null)" && \
		COMMIT="$$(git rev-parse --short HEAD)" && \
		DATE="$$(date -u +%Y-%m-%dT%H:%M:%SZ)" && \
		GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build \
			-ldflags="-s -w -X main.version=$$VERSION -X main.commit=$$COMMIT -X main.date=$$DATE" \
			-o "$(SIDECAR_BIN_DIR)/hexclaw-x86_64-unknown-linux-gnu" ./cmd/hexclaw

sidecar-windows-amd64: prepare-sidecar-src sidecar-assets
	@mkdir -p src-tauri/binaries
	cd "$(HEXCLAW_SRC_DIR)" && \
		VERSION="$$(git describe --tags --always --dirty 2>/dev/null)" && \
		COMMIT="$$(git rev-parse --short HEAD)" && \
		DATE="$$(date -u +%Y-%m-%dT%H:%M:%SZ)" && \
		GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build \
			-ldflags="-s -w -X main.version=$$VERSION -X main.commit=$$COMMIT -X main.date=$$DATE" \
			-o "$(SIDECAR_BIN_DIR)/hexclaw-x86_64-pc-windows-msvc.exe" ./cmd/hexclaw

# ─── 文档渲染二进制下载（pandoc + typst）─────────────────
# 详见 hexclaw/.claude/doc-generation-architecture.md §3.2 升级回归策略
#
# 版本号 + SHA256 集中维护在 release/scripts/versions.json（待补）；
# 本期最小可用版本：固定当前测试通过的最新版，校验 SHA256，下载到 sidecar binaries 目录。
# CI 每周拉 latest 跑黄金回归，patch 版本自动滚 PR。

RENDER_BUNDLE_DIR := $(SIDECAR_BIN_DIR)/render-bundle

# 下载当前平台的 pandoc + typst 到 render-bundle 目录。
# 版本号 + SHA256 维护在 release/scripts/versions.json；脚本支持
# 通过 RENDER_BUNDLE_TARGET={darwin-arm64|darwin-x86_64|linux-x86_64|windows-x86_64}
# 交叉打包。
render-bundle:
	./release/scripts/render-bundle.sh $(RENDER_BUNDLE_DIR)

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

