---
kind: decision
status: approved
---

## Context
Need real perf metrics: paint, layout, compositing, frame timing, INP.

## Decision
Playwright + headless Chromium. All measurement via CDP.

## Why
- jsdom/happy-dom: no paint, no layout, no frames. JS execution time only.
- Custom engine: person-years to match Blink; different engine = different numbers.
- Playwright: direct CDP access, µs-resolution traces, real Blink pipeline.

## Consequences
- Chromium ~400MB download (Playwright auto-manages).
- ~15-30s per component vs ~2-5s for jsdom. Acceptable for depth.
- Headless works in CI without display server.
