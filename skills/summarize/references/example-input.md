# Example Input: Q3 Product Review Meeting

**Participants**: Alice (PM), Bob (Eng), Carol (Design), Dave (Data)

**Duration**: 2026-04-15 14:00–15:30

---

Alice kicked off with the Q3 numbers: revenue grew 12 % QoQ to $4.2M, but
customer acquisition cost (CAC) rose from $38 to $47. The north star metric —
weekly active users — hit 142K, up 8 % from last quarter.

Bob reported that the search latency SLA breach (p99 > 800ms) has been resolved
by the new index sharding strategy; p99 is now 420ms. However, the deployment
pipeline still fails ~15 % of the time due to flaky integration tests in the
recommendation service. He needs QA help to stabilise those tests.

Carol walked through the new onboarding flow mockups. The first-run experience
drops from 7 steps to 3. Early user research (n=12) shows a 23 % improvement
in activation rate, but power users complain the skip button is too prominent.
She wants to A/B test two variants next sprint.

Dave flagged that the ML model for churn prediction is degrading: AUC dropped
from 0.87 to 0.81 over the last two weeks. He suspects a data drift issue in
the `user_session` feature and needs the data pipeline team to backfill three
weeks of training data.

**Action Items**:
1. Alice to escalate QA support for Bob's team (due: Fri)
2. Carol to prepare A/B test spec for onboarding (due: next Tue)
3. Dave to file a data backfill ticket and share the AUC trend chart (due: today)
