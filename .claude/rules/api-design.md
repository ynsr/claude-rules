---
paths:
  - 'src/**'
  - '!**/*.test.ts'
description: API design guardrails
---

Prefer explicit error returns over thrown exceptions for expected failure modes.
Keep public API surface minimal; add exports only when a consumer needs them.
