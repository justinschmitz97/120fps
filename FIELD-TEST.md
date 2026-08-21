# Field test: 120fps 0.5.0 against twenty real repositories

Twenty well-known UI repositories were cloned, installed, profiled, and measured with the shipped 0.5.0 CLI. Five produced a usable measurement.

This document records why the test was run, how it was run, and what it found.

Evidence lives outside the repo at `C:\Projekte\120fps-fieldtest\`: `EVIDENCE.md` (all findings with repro commands), `findings/` (per repository), `profiles/` (per repository shape), `STATE.md` (verified root causes), `report.html`.

The twenty cloned repositories live at `E:\repositories\`.

## Why this was done

0.5.0 was the portability release. It closed a long list of portability defects found in the 2026-08-19 audit and remediated as M67 through M75: the workspace project model, config resolution, import scanning, CSS discovery, failure diagnosability, unsupported-setup gates, boot guardrails, environment advisories, and import diagnosis.

Every one of those fixes was validated the same way: against fixtures written for the milestone, and against repositories the tool was already known to handle. That is the right way to develop a milestone and the wrong way to establish confidence in a portability claim, because both halves of the test were authored by the same people who authored the assumption being tested.

The product promise makes this gap unusually expensive. 120fps is zero-config: it claims to take a component file and measure it without setup. A promise like that can only be falsified by code nobody wrote for it. And it fails at the worst possible moment — a user runs `npx 120fps ./Button.tsx` exactly once, and if it crashes, there is no second attempt and no bug report.

So the test was adversarial by construction: real repositories, unmodified, in the state a first-time contributor actually finds them after a plain install. Nothing was pre-built, no environment files were fabricated, and no target repository's source was edited.

The question was not "is 120fps fast enough". It was **"does 120fps survive first contact with the ecosystem it is aimed at"**.

---

## Method

### Fleet selection: by stress axis, not by fame

Choosing twenty popular repositories would have produced twenty variations on one shape. shadcn-style projects alone would have exercised a single code path — pnpm plus Tailwind plus Radix — twenty times over.

Instead each repository was chosen to stress a named 0.5.0 subsystem, and the fleet deliberately included repositories that were **supposed** to fail. A fleet of only supported setups never tests the failure surface, and the failure surface was a headline feature of the release.

| Axis under test | Repositories |
|---|---|
| Monorepo model, prop extraction from library source | shadcn/ui, radix-primitives, chakra-ui, mantine, heroui, base-ui |
| Giant monorepos, worst-case scale | material-ui, cal.com, twenty (nx, outside documented support) |
| App-shaped, CSS discovery, Next shims, providers | taxonomy, dub, excalidraw, vercel/commerce, ant-design |
| Vue path | primevue, element-plus, nuxt/ui |
| Expected rejection | solid-ui (Solid), react-dnd (Yarn PnP), craig (Preact behind a react alias) |

Two picks earned their place by being extremes. **taxonomy** is the simplest conventional shape in existence — single package, Next App Router, no workspace — and served as the control: a failure there means something different from a failure in a giant monorepo. **twenty** uses nx, which 120fps does not claim to support, testing how gracefully it degrades outside its documented range.

### Orchestration: three waves

Work was delegated to parallel subagents throughout, with a coordinator holding only distilled state. The coordinator never read a findings file or a transcript in bulk; workers returned structured, token-dense reports.

**Wave 1 — profile (4 workers, parallel).** Clone shallow, install with the repository's own package manager, and write a profile per repository recording: commit sha, install command and outcome, package manager and workspace flavor, framework versions, styling stack, **the real CSS entry chain**, tsconfig shape, four to five candidate components labeled leaf / composed / heavy, and red flags.

The profiles are the load-bearing part of the method. They establish **ground truth before measurement**, which is the only thing that makes it possible to judge whether the tool's answer was correct rather than merely plausible. Knowing that ant-design's only stylesheet is an unused opt-in reset is what turned "120fps disclosed a stylesheet" into "120fps injected a stylesheet the application never loads".

**Wave 2 — run (one worker per repository, up to 5 concurrent).** Each runner received a shared protocol plus repo-specific probes derived from that repository's profile, each probe aimed at one specific 0.5.0 claim.

Shared protocol, executed from the target repository root:

1. `--explain-props` on every candidate — cheap, exercises config resolution and prop extraction without booting a browser.
2. Staged full runs, ordered leaf → composed → heavy.
3. One extra mode on a survivor: `--matrix`, or `--isolate memory` if matrix auto-activated.
4. The repo-specific probes.

**Wave 3 — synthesize.** One worker read all twenty findings files and produced the evidence appendix: a master table of every finding with its exact repro command, a deduplication map grouping findings by root cause, and a coverage matrix. The coordinator wrote the ranking and the verdict.

### Judging rules

These rules are what make the findings trustworthy, and they are worth preserving for any repeat run.

**Timing numbers are not evidence.** Up to ten workers shared one machine, each capable of launching Chromium and Vite. Every finding in this report is functional: a crash, a wrong result, a misleading message, or a missing disclosure. The tool's own noise sentinel correctly classified the machine as hostile — that was recorded as **correct behavior**, not a defect.

**A clean rejection is a pass.** A fast, accurate, actionable error on an unsupported setup is the tool working. Twenty-four findings were logged as passing gates, and they are listed in this report precisely so they can be protected by regression tests before anything else is touched.

**Every finding carries its own proof.** Exact repro command, verbatim output, expected versus actual, category, severity. Where a runner could not produce a repro command, the evidence table says `NOT RECORDED` rather than inventing one.

**Ground truth is read before a verdict is issued.** A schema is only "wrong" after someone reads the component's actual props. A stylesheet is only "wrong" after someone traces the real entry chain.

**Target repositories are not edited.** The single exception is following 120fps's own documented remediation — writing a `<stem>.props.tsx` fixture or a `120fps.setup.tsx` wrapper when the tool's output instructs it — because whether the documented escape hatch actually works is itself a finding. Both were tested; both worked.

**Slow is not the same as hung.** Under heavy contention, a hang finding required no progress output at all, not merely a long run.
