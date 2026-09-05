import { describe, it, expect } from "vitest";
import {
  CSS_COMPILE_FAILED_WARNING,
  CSS_COMPILE_TIMEOUT_MS,
  CSS_COMPILE_TIMEOUT_WARNING,
  probeInjectedStylesheets,
} from "../../src/harness/index.js";

interface Sheet {
  specifier: string;
  label: string;
}

// Stands in for the dev server: one behaviour per url.
function server(behaviour: Record<string, "ok" | "throw" | "hang">): {
  transformRequest: (url: string) => Promise<unknown>;
  requested: string[];
} {
  const requested: string[] = [];
  return {
    requested,
    transformRequest(url: string) {
      requested.push(url);
      const how = behaviour[url] ?? "ok";
      if (how === "throw") {
        return Promise.reject(
          new Error('[postcss] postcss-import: index.js:1:1: Unknown word "use strict"\n    at x'),
        );
      }
      if (how === "hang") return new Promise(() => {});
      return Promise.resolve({ code: ".a{}" });
    },
  };
}

const sheets: Sheet[] = [
  { specifier: "/src/styles/globals.css", label: "src/styles/globals.css" },
  { specifier: "/src/widget.css", label: "src/widget.css" },
];

describe("the injected stylesheet probe", () => {
  it("keeps every stylesheet that compiles and says nothing", async () => {
    const dev = server({});

    const result = await probeInjectedStylesheets(dev, sheets);

    expect(result.kept).toEqual(["/src/styles/globals.css", "/src/widget.css"]);
    expect(result.warnings).toEqual([]);
    expect(dev.requested).toEqual(["/src/styles/globals.css", "/src/widget.css"]);
  });

  it("drops a stylesheet that fails and names the compiler's first line", async () => {
    const dev = server({ "/src/styles/globals.css": "throw" });

    const result = await probeInjectedStylesheets(dev, sheets);

    expect(result.kept).toEqual(["/src/widget.css"]);
    expect(result.warnings).toEqual([
      CSS_COMPILE_FAILED_WARNING(
        "src/styles/globals.css",
        '[postcss] postcss-import: index.js:1:1: Unknown word "use strict"',
      ),
    ]);
  });

  it("drops a stylesheet that never finishes and names the bound", async () => {
    const dev = server({ "/src/styles/globals.css": "hang" });

    const result = await probeInjectedStylesheets(dev, sheets, 50);

    expect(result.kept).toEqual(["/src/widget.css"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(
      /^src\/styles\/globals\.css did not compile within \d+ s; the stylesheet was not injected and the component may render unstyled\./,
    );
  });

  it("names the configured bound in seconds", () => {
    expect(CSS_COMPILE_TIMEOUT_WARNING("a.css", 20_000)).toContain("did not compile within 20 s");
  });

  it("compiles nothing when no stylesheet is injected", async () => {
    const dev = server({});

    const result = await probeInjectedStylesheets(dev, []);

    expect(result.kept).toEqual([]);
    expect(dev.requested).toEqual([]);
  });

  it("bounds a stylesheet at 20 seconds by default", () => {
    expect(CSS_COMPILE_TIMEOUT_MS).toBe(20_000);
  });
});
