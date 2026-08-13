---
kind: milestone
status: done
tests: [test/unit/stress-patterns.test.ts, test/unit/stress-patterns-harden.test.ts, test/unit/report.test.ts]
---

# M10 — stress patterns

Single-shot exercise misses real perf cliffs. Dispatch by type+role, first match: keyboard-sweep (role tab/listbox/combobox/menu/tree + siblings), hover-sweep (+siblings), open-close-10 (portal trigger; aria-haspopup=dialog → role dialog), multi-keystroke ("abcde12345"), rapid-toggle-11, single-shot fallback. Always-on, no flag.

Non-obvious:
- rapid-toggle count MUST be ODD (11): even count returns binary toggles to initial DOM state → explorer hash equals initial → state transitions never discovered (was 10, broke M4; fixed M24 D13).
- Full pattern runs INSIDE the CDP trace, every one of N samples.
- No ARIA container siblings found → single-shot fallback; components without ARIA roles behave identically to pre-M10.
- Double-rAF settle after each step.
