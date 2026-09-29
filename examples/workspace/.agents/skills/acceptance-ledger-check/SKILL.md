---
name: acceptance-ledger-check
description: Diagnose why a synthetic ledger-demo account cannot see ledger entries in the CodexRelay acceptance fixture. Correlate the supplied account with fixture logs and source code. Applies only to the ledger-demo acceptance scenario.
---

# Synthetic ledger visibility investigation

This skill covers synthetic acceptance data only. Read the files; do not change them or access external services.

1. Read `references/evidence.json` next to this skill. Select the record matching the account in the caller's context; do not assume all accounts have the same result.
2. Read `references/visibility.mjs` to explain how the membership state affects the result.
3. Report the matching request ID, membership state, root cause, and evidence file paths. Distinguish a disabled membership from an empty ledger.
4. Begin the answer with the `reportMarker` value from the evidence file and use the headings `Conclusion`, `Evidence`, and `Recommendation`. These labels let the acceptance client distinguish the skill workflow from an unsupported generic answer.

Do not modify the membership. Recommend an administrator review when it is disabled.
