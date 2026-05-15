# Expected Adherence Improvement

## Before
| Constraint | Actual | Compliance |
|-----------|--------|-----------|
| Length ≤ 30% | 41.9% | ❌ (−11.9pp) |
| [§N] citations | None | ❌ |
| Entity retention | 95.8% | ✅ |
| Structured output | Bullet format | ✅ |

## After (Predicted)

| Constraint | Expected Compliance | Rationale |
|-----------|-------------------|-----------|
| **Length ≤ 30%** | **~70-80%** | Constraints-first + ALL CAPS should significantly reduce over-generation. LLMs still don't natively count tokens, so perfection unrealistic. |
| **[§N] citations** | **~85-95%** | Dedicated section + explicit example dramatically improves format adherence. Example output is the strongest signal. |
| **Entity retention** | **unchanged (~95%)** | Already strong; no regression expected. |
| **Structured output** | **slightly improved** | Example shows a format; model may follow it more closely. |

## Confidence Factors

| Factor | Score | Reasoning |
|--------|-------|-----------|
| Primacy effect | HIGH | Constraints-first is well-established prompt engineering practice |
| ALL CAPS salience | MEDIUM | Works for most models; some tokenizers normalize case |
| Example demonstration | HIGH | Examples consistently outperform declarative rules for LLMs |
| Model variance | LOW-MEDIUM | `mimo-v2.5` showed reasonable instruction-following; no reason to expect regression |
| Pipeline injection | HIGH | Pipeline confirmed working in UAT (same mechanism, different content) |

## Limitation

**No prompt rewrite can guarantee 100% compliance** because:
- LLMs don't count output length during generation
- [§N] is a custom format not in training data
- Model behavior varies per inference

The goal is **significant improvement** (est. 70-95% compliance), not perfection.
