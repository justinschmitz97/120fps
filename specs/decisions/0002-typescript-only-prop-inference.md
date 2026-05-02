---
kind: decision
status: approved
---

## Context
Need valid props to render components. Options: manual scenarios, Storybook stories, TS type inference.

## Decision
TypeScript Compiler API only. No manual scenarios, no Storybook.

## Why
- Zero-config is the product goal.
- TS types already present in every typed codebase.
- Deterministic, reproducible generation.

## Consequences
- Weak coverage for opaque props (`children: ReactNode`). Mitigated: sensible defaults.
- Complex runtime-dependent props get shallow coverage. Flagged as "synthetic props" in report.
- Untyped JS components: default props only.
- Must use **Bundler moduleResolution** (not user's tsconfig). Extensionless imports fail under Node16.
- Must **recursively unwrap HOC chains** — `memo(forwardRef(...))` nests CallExpressions.
- Must handle **class components** separately — props type lives in heritage clause type arg, not function parameter.
- `React.FC<P>` adds implicit `children`, but we extract from the user's interface (correct — extract what's declared).
- Harness export detection regex must allow **type annotations** between name and `=` (`export const X: React.FC<P> = ...`).
