import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCssFiles, resolveWrapPath } from "../../src/analyze.js";

// mantine-F1: the three stylesheets a MantineProvider setup module imports are
// exactly the ones the measured render needs, and discovery walked the project
// entry only. A `120fps.setup.tsx` sitting at the project root importing
// `@mantine/core/styles.css` was invisible, so the run measured unstyled and
// said nothing about it.

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// No project entry and no conventional global stylesheet: the only thing that
// can find `theme.css` is the wrapper's own import. A second, larger sheet
// buried elsewhere is what the largest-file fallback picks when nothing else
// does, so the two outcomes are distinguishable.
function project(): { root: string; wrap: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-wrap-css-"));
  tmpDirs.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "wrap-css-app" }));
  fs.writeFileSync(path.join(root, "theme.css"), ".mantine-Button-root { color: red; }\n");
  fs.mkdirSync(path.join(root, "vendor"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "vendor", "huge.css"),
    ".x { color: blue; }\n".repeat(500),
  );
  fs.writeFileSync(path.join(root, "Card.tsx"), "export function Card() { return null; }\n");
  const wrap = path.join(root, "120fps.setup.tsx");
  fs.writeFileSync(
    wrap,
    'import "./theme.css";\nexport default function Wrap({ children }: any) { return children; }\n',
  );
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  return { root, wrap };
}

describe("a provider wrapper's stylesheets are discovered like the entry's own", () => {
  it("finds the sheet the wrapper imports and labels it an entry import", () => {
    const { root, wrap } = project();
    const resolved = resolveCssFiles({}, root, [], { wrapPath: wrap });
    expect(resolved.files.map((f) => path.basename(f))).toContain("theme.css");
    expect(resolved.layer).toBe("entry-chain");
  });

  it("does not find it without the wrapper, which is what the run used to do", () => {
    const { root } = project();
    const resolved = resolveCssFiles({}, root, []);
    expect(resolved.files.map((f) => path.basename(f))).not.toContain("theme.css");
    expect(resolved.layer).not.toBe("entry-chain");
  });

  it("uses the wrapper the run auto-detects, not one the caller has to name", () => {
    const { root, wrap } = project();
    const { wrapPath, wrapAutoDetected } = resolveWrapPath({}, root, "react", []);
    expect(wrapPath).toBe(wrap);
    expect(wrapAutoDetected).toBe(true);
    const resolved = resolveCssFiles({}, root, [], wrapPath ? { wrapPath } : undefined);
    expect(resolved.files.map((f) => path.basename(f))).toContain("theme.css");
  });

  it("leaves an explicit --css pick alone", () => {
    const { root, wrap } = project();
    const explicit = path.join(root, "vendor", "huge.css");
    const resolved = resolveCssFiles({ cssFiles: [explicit] }, root, [], { wrapPath: wrap });
    expect(resolved.files).toEqual([explicit]);
    expect(resolved.layer).toBe("explicit");
  });

  it("changes nothing for a project whose wrapper imports no stylesheet", () => {
    const { root } = project();
    const bare = path.join(root, "bare.setup.tsx");
    fs.writeFileSync(bare, "export default function Wrap({ children }: any) { return children; }\n");
    const withWrap = resolveCssFiles({}, root, [], { wrapPath: bare });
    const without = resolveCssFiles({}, root, []);
    expect(withWrap.files).toEqual(without.files);
    expect(withWrap.layer).toBe(without.layer);
  });
});
