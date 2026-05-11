# 08 Asset Upload Protocol & Naming v0.4

## 1. 目标

统一 Chat 上传、拖拽、目录导入、本地路径输入的资产协议，解决批量图片与不同 Skill 参数匹配问题。

## 2. 设计原则

```txt
不要让 Runtime 依赖“第几张图”
不要让用户必须按固定按钮分类上传
不要在前端靠文件名猜测后直接执行
必须生成 asset_id，并经过用户确认角色
```

## 3. 上传入口

P0 只保留一个统一上传按钮：

```txt
[＋ 上传]
```

弹层支持：

- 选择文件
- 拖拽文件
- 选择文件夹
- 输入本地目录路径，例如 D:\Study2\Seller Workspace\docs

## 4. Asset Draft

客户端读取本地素材后先形成草稿：

```json
{
  "local_temp_id": "tmp_001",
  "file_name": "shoe_01.png",
  "file_type": "image",
  "file_size": 123456,
  "hash": "sha256:...",
  "source_path": "D:\\SellerWorkspace\\shoe_01.png",
  "upload_order": 1,
  "role_guess": "product_image",
  "user_role": null
}
```

## 5. 后端 Asset

上传或登记后返回：

```json
{
  "asset_id": "ast_20260510_0001",
  "file_name": "shoe_01.png",
  "file_type": "image",
  "hash": "sha256:...",
  "role_guess": "product_image",
  "user_role": "product_image",
  "storage_url": "s3://bucket/..."
}
```

## 6. 角色枚举

P0 先支持：

| user_role | 说明 |
|---|---|
| product_image | 商品图 |
| reference_image | 风格/效果参考图 |
| logo | 品牌 Logo |
| background | 背景图 |
| platform_reference | 平台规范或案例图 |
| document | 文档资料 |
| other | 其他 |

## 7. 批量命名规则

导出结果建议命名：

```txt
{task_time}_{image_role}_{sequence}_{sku}_{platform}.{ext}
```

示例：

```txt
20260510_1430_detail_001_SKU123_xiaohongshu.png
20260510_1430_main_002_SKU123_amazon.png
```

字段规则：

| 字段 | 来源 |
|---|---|
| task_time | 任务创建时间 |
| image_role | 结果角色 |
| sequence | 同任务内序号 |
| sku | 用户参数或文件名识别，缺失时 unknown |
| platform | 用户参数，缺失时 general |

## 8. 批量失败策略

默认策略：

```txt
单个素材失败不应导致整批直接丢失。
```

任务结果应区分：

- succeeded_assets
- failed_assets
- skipped_assets
- retryable_assets

## 9. 用户确认规则

系统可自动识别角色，但必须允许用户修改。最终提交 Runtime 时以 `user_role` 为准。

## 10. 隐私规则

- 后端默认不保存本地明文路径，只保存 hash 或脱敏路径
- 用户主动输入目录时，前端可显示原路径
- 日志不打印完整本地路径
