# 24 Provider Adapter Interface v0.4

统一 Provider Adapter 接口。

## 原则
Provider 只负责：
- inference
- generation
- structured output

禁止负责：
- 文件保存
- entitlement
- asset lifecycle

## Runtime 调用流程
Runtime → Provider Generate → AssetService Save → ResultManifest Build
