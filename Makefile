# HexClaw Desktop — 开发命令

.PHONY: dev build clean sidecar sidecar-all sidecar-darwin-arm64 sidecar-darwin-amd64 sidecar-linux-amd64 sidecar-windows-amd64 lint format

# 开发模式 (前端 + Tauri 窗口)
dev:
	pnpm tauri dev

# 构建生产版本
build:
	pnpm tauri build

# 仅构建前端
build-web:
	pnpm build

# 编译 hexclaw sidecar 并放入 binaries 目录 (自动检测当前平台)
sidecar:
	@echo "编译 hexclaw sidecar..."
	@mkdir -p src-tauri/binaries
	cd ../hexclaw && go build -o ../hexclaw-desktop/src-tauri/binaries/hexclaw-$$(rustc -vV | grep 'host:' | awk '{print $$2}') ./cmd/hexclaw
	@echo "sidecar 编译完成"

# Cross-compile sidecar for all platforms
sidecar-all: sidecar-darwin-arm64 sidecar-darwin-amd64 sidecar-linux-amd64 sidecar-windows-amd64

sidecar-darwin-arm64:
	@mkdir -p src-tauri/binaries
	cd ../hexclaw && GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-s -w" -o ../hexclaw-desktop/src-tauri/binaries/hexclaw-aarch64-apple-darwin ./cmd/hexclaw

sidecar-darwin-amd64:
	@mkdir -p src-tauri/binaries
	cd ../hexclaw && GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o ../hexclaw-desktop/src-tauri/binaries/hexclaw-x86_64-apple-darwin ./cmd/hexclaw

sidecar-linux-amd64:
	@mkdir -p src-tauri/binaries
	cd ../hexclaw && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o ../hexclaw-desktop/src-tauri/binaries/hexclaw-x86_64-unknown-linux-gnu ./cmd/hexclaw

sidecar-windows-amd64:
	@mkdir -p src-tauri/binaries
	cd ../hexclaw && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o ../hexclaw-desktop/src-tauri/binaries/hexclaw-x86_64-pc-windows-msvc.exe ./cmd/hexclaw

# 代码检查
lint:
	pnpm lint

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
