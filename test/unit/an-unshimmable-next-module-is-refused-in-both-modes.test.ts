import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { explainProps } from "../../src/pipeline/index.js";
import { runPreflight, preflightFailureMessage } from "../../src/project/index.js";

// scaffold-next-pages' shape: the dry run predicted "imported but not shimmed" and exited 0, and
// the real run failed on the same import five seconds later.
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function nextProject(componentSource: string): { root: string; entry: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-next-shim-"));
  tmpDirs.push(root);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "next-app",
      dependencies: { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" },
    }),
  );
  fs.mkdirSync(path.join(root, "pages"), { recursive: true });
  fs.writeFileSync(path.join(root, "pages", "index.tsx"), componentSource);
  // The react-dom version gate runs before the later probes, so the project needs one it accepts.
  const reactDom = path.join(root, "node_modules", "react-dom");
  fs.mkdirSync(reactDom, { recursive: true });
  fs.writeFileSync(
    path.join(reactDom, "package.json"),
    JSON.stringify({ name: "react-dom", version: "19.0.0", main: "index.js" }),
  );
  fs.writeFileSync(path.join(reactDom, "index.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(reactDom, "client.js"), "module.exports = {};\n");
  return { root, entry: path.join(root, "pages", "index.tsx") };
}

const FONT_IMPORT = [
  'import { Inter } from "next/font/google";',
  "const inter = Inter({ subsets: [\"latin\"] });",
  "export default function Home() {",
  "  return <main className={inter.className}>hi</main>;",
  "}",
].join("\n");

const SERVER_IMPORT = [
  'import { NextResponse } from "next/server";',
  "export default function Home() {",
  "  return <main>{String(NextResponse)}</main>;",
  "}",
].join("\n");

describe("an import of a Next.js module 120fps has decided never to shim", () => {
  it("is a hard preflight hit before the browser starts", () => {
    const { root, entry } = nextProject(FONT_IMPORT);

    const preflight = runPreflight({ projectRoot: root, entries: [entry], componentName: "Home" });

    expect(preflight.hard.map((hit) => hit.kind)).toContain("unshimmable-next-module");
  });

  it("names the importing file and the module, and says why no shim can cover it", () => {
    const { root, entry } = nextProject(FONT_IMPORT);

    const message = preflightFailureMessage(
      runPreflight({ projectRoot: root, entries: [entry], componentName: "Home" }).hard,
    );

    expect(message).toContain("pages/index.tsx");
    expect(message).toContain("next/font/google");
    expect(message).toContain("→");
  });

  it("refuses the dry run with the text the real run's gate produces", async () => {
    const { root, entry } = nextProject(FONT_IMPORT);
    const expected = preflightFailureMessage(
      runPreflight({ projectRoot: root, entries: [entry], componentName: "Home" }).hard,
    );

    await expect(explainProps(entry, {})).rejects.toThrow(expected);
  });

  it("is bypassable with --no-preflight, like every other hard refusal", async () => {
    const { entry } = nextProject(FONT_IMPORT);

    await expect(explainProps(entry, { noPreflight: true })).resolves.toBeDefined();
  });
});

describe("an import of a Next.js module that is merely not shimmed yet", () => {
  it("stays a warning, not a refusal", () => {
    const { root, entry } = nextProject(SERVER_IMPORT);

    const preflight = runPreflight({ projectRoot: root, entries: [entry], componentName: "Home" });

    expect(preflight.hard.map((hit) => hit.kind)).not.toContain("unshimmable-next-module");
  });

  it("lets the dry run reach a result", async () => {
    const { entry } = nextProject(SERVER_IMPORT);

    await expect(explainProps(entry, {})).resolves.toBeDefined();
  });
});
