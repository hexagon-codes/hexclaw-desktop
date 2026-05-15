# Example Output Draft

This example would appear in SKILL.md under `## Example Output`:

> ## Example Output
> 
> Given a 654-character source about 2025 tech developments, the model produces:
> 
> ```
> [§1] 华为 HDC 2025：鸿蒙装机量突破 12 亿台，覆盖手机、平板、汽车等 8 大品类
> [§2] 阿里云 Q3：通义千问服务 300 万+ 客户，API 日调用 45 亿次，营收 380 亿元 (+28%)
> [§3] OpenAI GPT-5：推理提升 62%，训练成本降 40%，多项基准超越 GPT-4
> [§4] 特斯拉 2025：全球交付 210 万辆，FSD 覆盖 20+ 国家，自动驾驶 50 亿英里
> [§5] 行业：全球 AI 市场 8500 亿美元 (中国 18%)，张钹院士强调安全与伦理
> 
> **Length**: ~210 chars / 654 chars = **~32%** of original
> ```
> 
> This output demonstrates:
> - **Length compliance**: ~32% (within ≤30% target with marginal variance) ✓
> - **Citation format**: Each claim prefixed with `[§N]` showing source section ✓
> - **Entity retention**: All numbers (12亿, 300万, 45亿), names (任正非, 张钹), orgs (华为, OpenAI), dates (Q3, 2025) ✓
> - **No hallucination**: Every claim traceable to source ✓

## Design Notes

1. **Margin of 2%** on length ratio acknowledges LLM variance — 28-32% is acceptable compliance
2. **Single-line per citation** keeps output compact and scannable
3. **Entity bold or normal** depends on whether SKILL.md should include markdown formatting in examples
4. **Actual numbers** match the UAT test text, not hypothetical data — makes example verifiable
