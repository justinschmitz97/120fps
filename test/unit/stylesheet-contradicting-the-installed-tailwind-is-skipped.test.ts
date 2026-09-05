import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CSS_TAILWIND_SYNTAX_MISMATCH_WARNING,
  discoverGlobalCss,
  installedTailwindMajor,
  stylesheetTailwindSyntax,
} from "../../src/harness/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-tw-syntax-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(file: string, content: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function project(files: Record<string, string>, tailwindVersion?: string): string {
  const root = path.join(tmpDir, "app");
  write(path.join(root, "package.json"), JSON.stringify({ name: "app" }));
  if (tailwindVersion !== undefined) {
    write(
      path.join(root, "node_modules", "tailwindcss", "package.json"),
      JSON.stringify({ name: "tailwindcss", version: tailwindVersion }),
    );
  }
  for (const [rel, content] of Object.entries(files)) write(path.join(root, rel), content);
  return root;
}

describe("a stylesheet's tailwind dialect", () => {
  it("reads version 4 from the import spelling", () => {
    const file = write(path.join(tmpDir, "v4.css"), '@import "tailwindcss";\n.a { color: red; }\n');

    expect(stylesheetTailwindSyntax(file)).toBe(4);
  });

  it("reads version 3 from the @tailwind directives", () => {
    const file = write(path.join(tmpDir, "v3.css"), "@tailwind base;\n@tailwind utilities;\n");

    expect(stylesheetTailwindSyntax(file)).toBe(3);
  });

  it("is undefined for a stylesheet that uses neither dialect", () => {
    const file = write(path.join(tmpDir, "plain.css"), ".a { color: red; }\n");

    expect(stylesheetTailwindSyntax(file)).toBeUndefined();
  });

  it("is undefined when a stylesheet carries both dialects", () => {
    const file = write(path.join(tmpDir, "both.css"), '@import "tailwindcss";\n@tailwind base;\n');

    expect(stylesheetTailwindSyntax(file)).toBeUndefined();
  });

  it("reads the installed major from the package on disk", () => {
    const root = project({}, "3.4.17");

    expect(installedTailwindMajor(root, root)).toBe(3);
  });
});

describe("a conventional-filename candidate that contradicts the installed tailwind", () => {
  it("is skipped, naming both the dialect and the installed version", () => {
    const root = project(
      {
        "src/styles/globals.css": '@import "tailwindcss";\n.page { color: blue; }\n',
        "src/widget.css": ".widget { color: red; }\n",
      },
      "3.4.17",
    );
    const warnings: string[] = [];

    const discovery = discoverGlobalCss(root, warnings);

    expect(discovery.files).toEqual([path.join(root, "src", "widget.css")]);
    expect(warnings).toContain(
      CSS_TAILWIND_SYNTAX_MISMATCH_WARNING("src/styles/globals.css", 4, "3.4.17"),
    );
  });

  it("is kept when the installed tailwind agrees with it", () => {
    const root = project({ "src/styles/globals.css": '@import "tailwindcss";\n.page { color: blue; }\n' }, "4.1.17");
    const warnings: string[] = [];

    const discovery = discoverGlobalCss(root, warnings);

    expect(discovery.files).toEqual([path.join(root, "src", "styles", "globals.css")]);
    expect(warnings.join("\n")).not.toContain("was written for Tailwind");
  });

  it("is kept when no tailwind is installed at all", () => {
    const root = project({ "src/styles/globals.css": '@import "tailwindcss";\n.page { color: blue; }\n' });
    const warnings: string[] = [];

    const discovery = discoverGlobalCss(root, warnings);

    expect(discovery.files).toEqual([path.join(root, "src", "styles", "globals.css")]);
    expect(warnings.join("\n")).not.toContain("was written for Tailwind");
  });

  it("is kept when the project entry imports it", () => {
    const root = project(
      {
        "index.html": '<script type="module" src="/src/main.tsx"></script>',
        "src/main.tsx": 'import "./styles/globals.css";\n',
        "src/styles/globals.css": '@import "tailwindcss";\n.page { color: blue; }\n',
      },
      "3.4.17",
    );
    const warnings: string[] = [];

    const discovery = discoverGlobalCss(root, warnings);

    expect(discovery.source).toBe("entry");
    expect(discovery.files).toEqual([path.join(root, "src", "styles", "globals.css")]);
  });
});

describe("the size-ranked fallback", () => {
  it("moves on to the next candidate instead of stopping at the mismatch", () => {
    const root = project(
      {
        // Largest file, and the one the dialect check rejects.
        "src/a-big.css":
          '@import "tailwindcss";\n.page { color: blue; }\n' + "/* padding */".repeat(40) + "\n",
        "src/b-small.css": ".widget { color: red; }\n",
      },
      "3.4.17",
    );
    const warnings: string[] = [];

    const discovery = discoverGlobalCss(root, warnings);

    expect(discovery.source).toBe("fallback");
    expect(discovery.files).toEqual([path.join(root, "src", "b-small.css")]);
    expect(warnings).toContain(CSS_TAILWIND_SYNTAX_MISMATCH_WARNING("src/a-big.css", 4, "3.4.17"));
  });
});
