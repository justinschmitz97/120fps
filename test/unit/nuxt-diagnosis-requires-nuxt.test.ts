import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { presentBundlerFailure } from "../../src/harness.js";

// epic-stack-F1 and primer-react-F1: `Missing "X" specifier in "Y" package` is
// Node's package-imports/exports resolver, not a Nuxt signal. Two repositories
// that declare no `nuxt` were told to run `nuxi prepare`.
const IMPORTS_FIXTURE = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "imports-field-project",
);

const EPIC_STACK_MESSAGE = 'Missing "#app" specifier in "epic-stack-template" package';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-nuxt-gate-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function declare(deps: Record<string, string>): void {
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ dependencies: deps }));
}

describe("a package-imports miss in a repository without Nuxt", () => {
  it("carries no Nuxt wording and no nuxi prepare remedy", () => {
    const presented = presentBundlerFailure(EPIC_STACK_MESSAGE, IMPORTS_FIXTURE, []);

    expect(presented).not.toContain("nuxi prepare");
    expect(presented).not.toMatch(/nuxt/i);
  });

  it("names the specifier and the package whose map lacks it", () => {
    const presented = presentBundlerFailure(EPIC_STACK_MESSAGE, IMPORTS_FIXTURE, []);

    expect(presented).toContain("#app");
    expect(presented).toContain("epic-stack-template");
  });

  it("names the importer when the bundler message carries one", () => {
    const presented = presentBundlerFailure(
      `${EPIC_STACK_MESSAGE}\nFailed to resolve import "#app/utils/misc" from "app/components/ui/button.tsx".`,
      IMPORTS_FIXTURE,
      [],
    );

    expect(presented).toContain("app/components/ui/button.tsx");
  });

  it("still fires the Nuxt diagnosis for a #build specifier when nuxt is declared", () => {
    declare({ nuxt: "3.13.0" });
    const presented = presentBundlerFailure(
      'Missing "#build" specifier in "@nuxt/ui" package',
      tmpDir,
      [],
    );

    expect(presented).toContain("nuxi prepare");
  });

  it("stays generic for a #build specifier when nuxt is not declared", () => {
    declare({ react: "18.3.1" });
    const presented = presentBundlerFailure(
      'Missing "#build" specifier in "@nuxt/ui" package',
      tmpDir,
      [],
    );

    expect(presented).not.toContain("nuxi prepare");
    expect(presented).toContain("#build");
  });

  it("stays generic for an ordinary exports miss in a Nuxt repository", () => {
    declare({ nuxt: "3.13.0" });
    const presented = presentBundlerFailure(
      'Missing "./version" specifier in "antd" package',
      tmpDir,
      [],
    );

    expect(presented).not.toContain("nuxi prepare");
    expect(presented).toContain("antd");
  });

  // M108 review: the prefix test needs a segment boundary. "#appsettings/x" is
  // an ordinary imports-map miss that shares three letters with "#app".
  it("stays generic for a #-specifier that only shares a prefix with #app", () => {
    declare({ nuxt: "3.13.0" });
    const presented = presentBundlerFailure(
      'Missing "#appsettings/x" specifier in "my-pkg" package',
      tmpDir,
      [],
    );

    expect(presented).not.toContain("nuxi prepare");
    expect(presented).toContain("#appsettings/x");
    expect(presented).toContain("my-pkg");
  });

  it("still fires the Nuxt diagnosis for a nested #app/ specifier", () => {
    declare({ nuxt: "3.13.0" });
    const presented = presentBundlerFailure(
      'Missing "#app/nuxt" specifier in "@nuxt/ui" package',
      tmpDir,
      [],
    );

    expect(presented).toContain("nuxi prepare");
  });
});
