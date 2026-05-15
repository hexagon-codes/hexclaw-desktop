---
name: First Official Skill Validation
description: Candidate analysis for first production Official Skill
type: analysis
---

**Session**: ANL-first-official-skill-validation-2026-05-13
**Date**: 2026-05-13
**Type**: Candidate Analysis

## User Intent

Select and specify the first truly usable Official Skill

## Analysis Criteria

1. SKILL.md 依赖度 — 验证注入链
2. 结果可观测性
3. 是否需要新 capability
4. 是否需要 Result Surface 扩展
5. 是否需要 tool_call
6. Chat-first 符合度
7. Official Skill Boundary 验证度
8. Runtime Demo 适合度
9. 是否需要 structured output
10. 必须 deferred 的能力

## Constraints

- 不新增 Workflow / Planner / SkillTask / SkillExecutor
- 不扩 TaskResult
- 不新增 capability
- 不做 multi-step orchestration

---

## Candidate Comparison

| 维度 | summarize | rewrite | extract | translate | classify |
|------|-----------|---------|---------|-----------|----------|
| SKILL.md 依赖度 | ★★★★★ | ★★★☆☆ | ★★★★☆ | ★★☆☆☆ | ★★★☆☆ |
| 结果可观测性 | ★★★★★ | ★★★☆☆ | ★★★★★ | ★★★☆☆ | ★★★★☆ |
| 不需新 capability | ✅ | ✅ | ✅ | ✅ | ✅ |
| 不需 Result Surface 扩展 | ✅ | ✅ | ⚠️ 结构抽取最好是结构化 | ✅ | ✅ |
| 不需 tool_call | ✅ | ✅ | ✅ | ✅ | ✅ |
| Chat-first 符合度 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Official Boundary 验证 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Demo 适合度 | ★★★★★ | ★★★★☆ | ★★★☆☆ | ★★★☆☆ | ★★★☆☆ |
| 不需 structured output | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| **总分** | **5.0** | **3.8** | **3.5** | **3.3** | **3.5** |

---

## 逐项分析

### summarize — 推荐 ✅

**Arguments:**
- 已有完整 `skills/builtin/summarize/` — 零创建成本
- SKILL.md 包含 4 条 Working Principles + 4 条 Constraints + 4 条 Quality Bar — 注入链验证最强
- 可观测性最强：长度压缩率、[§N] 引用标记、实体保留率均可客观检查
- 纯 `llm` capability
- Text-in-text-out，无需扩展 TaskResult
- 单步 LLM 调用，零红线风险
- Demo 效果强：贴一段长文 → 返回结构化摘要

**SKILL.md 注入验证点:**
- 输出长度 ≤ 30% → 验证压缩约束
- 数字/日期/名称保留 → 验证"retain all numbers, dates, names"指令
- [§N] 引用格式 → 验证结构化输出指令
- 分类组织（Decisions / Action Items / Findings）→ 验证"Structure by information type"指令

### rewrite — 备选

**Arguments:**
- LLM 天然理解改写，SKILL.md 是风格约束（formality, tone, audience）
- 主观性强，结果好坏难客观判断
- SKILL.md 依赖度中等 — LLM 即使无指令也能改写

### extract — 备选但需 structured output

**Arguments:**
- 信息抽取天然适合结构化输出（JSON schema）
- 当前 TaskResult 只支持 `{ kind: 'text' }`，无结构化类型
- 勉强可用 text-in-text-out（JSON in markdown code block），但体验差
- 建议 deferred 至 TaskResult 支持 `kind: 'structured'` 后

### translate — 弱候选

**Arguments:**
- LLM 最天然能力，SKILL.md 几乎无附加价值
- SKILL.md 注入验证力最弱（无法区分是 LLM 自身能力还是 SKILL.md 生效）
- Demo 价值低（翻译工具太多）

### classify — 弱候选

**Arguments:**
- 分类依赖预定义类别列表，SKILL.md 可定义分类体系
- 但单一分类任务过于简单，无法展示 Skill System 能力
- Demo 价值最低

---

## 推荐: summarize

### 理由总结

| 优势 | 说明 |
|------|------|
| 零创建成本 | skill.json + SKILL.md 已存在，直接使用 |
| 最强验证力 | 4 条约束均可客观验证注入链是否生效 |
| 最强可观测性 | 压缩率、引用格式、实体保留可量化检查 |
| 红线安全 | 单步 LLM，不可能滑向 Workflow |
| Demo 价值 | @summarize <长文本> → 结构化摘要，用户直观感受 |
| 无依赖 | 不依赖新 capability / Result Surface / tool_call |

---

## Skill Specification

### skill.json（现有，已验证）

```json
{
  "name": "summarize",
  "display_name": "Summarize",
  "version": "0.1.0",
  "description": "Summarize long content into concise, structured summaries",
  "capabilities": ["llm"],
  "entry": "SKILL.md"
}
```

### SKILL.md（现有，已验证）

保留当前 `skills/builtin/summarize/SKILL.md` 不变：

```
# Summarize

## Purpose
Condense lengthy documents, conversations, or articles into clear,
structured summaries that preserve key information while reducing
reading time.

## Working Principles
1. Compress without loss — Retain all factual claims, data points,
   and named entities. Remove redundant expressions only.
2. Structure by information type — Organize by logical categories
   (e.g., "Findings", "Decisions", "Action Items").
3. Proportional coverage — Represent each section in proportion
   to its significance, not its length.
4. Neutral tone — Preserve original author's stance; no
   subjective judgement or editorialization.

## Constraints
- Target length: ≤ 30% of original (hard limit: 2000 tokens)
- Must retain all numbers, dates, names, and quantitative claims
- Must not introduce information absent from the source
- Must cite the source section for each major claim (using [§N])

## Common Patterns
- Meeting notes: Attendees → Decisions → Open Questions → Next Steps
- Research paper: Objective → Method → Key Results → Limitations
- Email thread: Context → Requests → Deadlines → Attachments
- Code review: Changes → Rationale → Concerns → Approvals

## Quality Bar
- Can the reader understand the original without reading it? → Pass
- Are all numbers/names/dates present? → Pass
- Is any section > 50% of original length? → Fail (over-long)
- Are there any claims not in the original? → Fail (hallucination)
```

---

## 输入/输出示例

### 正常流程

**User:**
```
@summarize Our team discussed the Q2 roadmap yesterday (2026-04-15). 
We decided to prioritize the notification system overhaul (estimated 3 
sprints, 5 engineers). The API rate limiting feature was deprioritized 
to Q3. Sarah will draft the technical spec by April 22nd. The 
stakeholder review is scheduled for April 29th. We also need to 
migrate the CI/CD pipeline from Jenkins to GitHub Actions—Mike 
estimates this will take 2 weeks.
```

**Expected output:**
```
## Decisions
- **Prioritize**: Notification system overhaul (3 sprints, 5 engineers)
- **Deprioritize**: API rate limiting → Q3 [§1]

## Action Items
- **Sarah**: Draft technical spec by April 22nd [§1]
- **Mike**: CI/CD migration (Jenkins → GitHub Actions, ~2 weeks) [§1]

## Timeline
- **Apr 15**: Q2 roadmap discussion [§1]
- **Apr 22**: Tech spec deadline [§1]
- **Apr 29**: Stakeholder review [§1]
```

### Edge Cases

**空输入:**
```
@summarize
```
→ 空内容 → LLM 返回空/提示无内容

**极短输入:**
```
@summarize Hello world
```
→ ≤30% of ~5 chars ≈ 1 char → 返回 "Hello world" 或简短确认

**超长输入:**
```
@summarize <10,000 word article>
```
→ 2000 token hard limit 触发截断 → 需确认 truncation 策略

---

## 验证清单

### 注入链验证

- [ ] output 长度 ≤ 30% original
- [ ] 数字/日期/名称保留
- [ ] 使用 [§N] 引用格式
- [ ] 分类结构（Decisions / Action Items / Findings 等）

### 架构验证

- [ ] skill.json 被 Registry discover
- [ ] @summarize 被 tryExecuteSkill 解析
- [ ] Capability check（llm）通过
- [ ] SKILL.md 被 SkillLoader(Resource) 加载
- [ ] SkillLayer 被注入 RuntimeContext
- [ ] buildPromptInput 合并 markdown 到 system prompt
- [ ] LLM 响应遵循 SKILL.md 约束

### 红线检查

- [ ] 无 DAG / Workflow / Node Graph / BPMN / Visual Builder / Auto Agent / Multi-Agent
- [ ] 无新 capability / tool_call
- [ ] 无 TaskResult 扩展
- [ ] 无 multi-step

---

## Deferred

| 能力 | 原因 | 触发条件 |
|------|------|---------|
| structured output (kind !== 'text') | 当前 TaskResult 只支持 text | 需要结构化展示的 Skill |
| references/ 加载 | SKILL.md 已足够 | Skill 需要 example 文件 |
| SkillTask Executor | type=chat 已满足 | 需要 skill-specific 执行逻辑 |
| multi-step orchestration | 红线禁止 | 永不 |
| extract skill | 需要 structured output | TaskResult 扩展后 |
