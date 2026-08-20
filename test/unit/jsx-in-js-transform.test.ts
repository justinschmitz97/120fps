import { describe, it, expect } from "vitest";
import path from "node:path";
import { jsxInJsPlugin, buildAndServe } from "../../src/harness.js";

// M77: Vite's default esbuild.include (`/\.(m?ts|[jt]sx)$/`) excludes plain
// `.js`, and forcing config.esbuild.loader to "jsx" globally would break
// every typed .ts/.tsx file sharing the same esbuild plugin instance (esbuild
// itself rejects TypeScript-only syntax under the "jsx" loader — verified:
// `esbuild.transformSync('interface X{}', { loader: 'jsx' })` throws). A
// narrow, own plugin ahead of Vite's own esbuild plugin gives `.js` outside
// node_modules JSX support without touching what already works.
describe("jsxInJsPlugin", () => {
  const plugin = jsxInJsPlugin();

  it("transforms a project .js file's JSX into plain JS", async () => {
    const code = "export default function Button() { return <div className='x'>hi</div>; }\n";
    const result = await plugin.transform(code, path.join("project", "Button.js"));
    expect(result).not.toBeNull();
    expect(result!.code).not.toContain("<div");
  });

  it("leaves a vendored .js file under node_modules untouched", async () => {
    const code = "export default function Button() { return <div>hi</div>; }\n";
    const result = await plugin.transform(
      code,
      path.join("project", "node_modules", "some-lib", "Button.js"),
    );
    expect(result).toBeNull();
  });

  it("leaves .ts and .tsx files untouched (Vite's own esbuild plugin owns those)", async () => {
    const tsResult = await plugin.transform(
      "interface Props { name: string }\nexport const x: Props = { name: 'a' };\n",
      path.join("project", "types.ts"),
    );
    expect(tsResult).toBeNull();

    const tsxResult = await plugin.transform(
      "interface Props { name: string }\nexport const X = (p: Props) => <div>{p.name}</div>;\n",
      path.join("project", "Card.tsx"),
    );
    expect(tsxResult).toBeNull();
  });

  it("strips a query string before deciding, matching a Vite-appended cache-busting suffix", async () => {
    const code = "export default function Button() { return <div>hi</div>; }\n";
    const result = await plugin.transform(code, path.join("project", "Button.js") + "?t=1699999999");
    expect(result).not.toBeNull();
    expect(result!.code).not.toContain("<div");
  });

  it("does not choke on plain .js with no JSX at all", async () => {
    const code = "export function helper() { return 1; }\n";
    const result = await plugin.transform(code, path.join("project", "helper.js"));
    expect(result).not.toBeNull();
    expect(result!.code).toContain("helper");
  });

  it("is registered ahead of Vite's own transform pipeline", () => {
    expect(plugin.enforce).toBe("pre");
    expect(plugin.name).toBe("120fps-jsx-in-js");
  });
});

// M79 (adopted open item): root cause of the server.close() hang, found by
// instrumenting process._getActiveHandles() during the hang — it reported
// only the process's own stdio/IPC pipes, nothing server-related, meaning
// nothing was pinning the event loop. The hang is Vite's dev server itself
// never settling an internal await, not a leaked handle: transformRequest()
// bypasses the HTTP middleware that normally ties a module's in-flight-
// request bookkeeping to a response, so that bookkeeping (used by
// server.close()'s own teardown sequence) is still pending the instant
// close() is called back-to-back with no real page interaction in between.
// A real measurement run never hits this: it is seconds between the first
// transform and cleanup(), giving Vite's own internal tracking time to
// settle on its own. Fix for any caller reaching the dev server outside
// normal browser navigation (transformRequest, ssrLoadModule, etc.): await
// the dev server's own public server.waitForRequestsIdle() before close().
// Confirmed deterministic and fast (~any real request's settle time, no
// arbitrary sleep needed) — this test previously hung indefinitely without
// the wait and now completes well under a second.
describe("real-server regression (M77 fix, end to end)", () => {
  it("serves and transforms a real .js JSX file through the real dev server", async () => {
    const harness = await buildAndServe(path.resolve("fixtures/jsx-in-js.js"), {});
    try {
      const entryUrl = new URL(harness.url).pathname + "entry.tsx";
      const result = await harness.server.transformRequest(entryUrl);
      expect(result).not.toBeNull();
      expect(result!.code).toContain("jsx-in-js");
      // Required before close()/cleanup() whenever the dev server is reached
      // outside a real page load — see the comment above.
      await harness.server.waitForRequestsIdle();
    } finally {
      await harness.cleanup();
    }
  });
});
