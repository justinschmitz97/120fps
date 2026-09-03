import { describe, it, expect } from "vitest";
import { formatMountAbortHints, hintsForMountAbort } from "../../src/hints.js";
import { SFC_INJECT_READ_FAILED_WARNING, viteConfigIgnoredKeys } from "../../src/analyze.js";
import {
  VITE_CONFIG_IGNORED_WARNING,
  VITE_CONFIG_PREPROCESSOR_OPTION_WARNING,
} from "../../src/harness.js";

// ark-F2: `at Proxy._sfc_render` matched the optional `$` in the proxy-frame
// signature, so a plain provide/inject failure was reported as a missing Vue
// plugin global — a cause the run never read.
const PLUGIN_FRAME_ABORT =
  "mount phase failed on combo 0 of Select.vue: page.evaluate: TypeError: Cannot read properties " +
  "of undefined (reading 'config')\n    at Proxy.$variant (/e/repositories/primevue/packages/core/" +
  "src/baseinput/BaseInput.vue:31:52)";

const SFC_RENDER_ABORT =
  "mount phase failed on combo 0 of dialog-trigger.vue: page.evaluate: TypeError: Cannot read " +
  "properties of undefined (reading 'value')\n    at Proxy._sfc_render (/e/repositories-run5/ark/" +
  "packages/vue/src/components/dialog/dialog-trigger.vue:8:20)";

// vitesse-F1: `defineModels is not defined` printed with no link to the
// ignored-plugins warning the same run had already produced.
const MACRO_ABORT =
  "mount phase failed on combo 0 of TheInput.vue: page.evaluate: ReferenceError: defineModels is " +
  "not defined\n    at /e/repositories-run5/vitesse/src/components/TheInput.vue:4:16";

describe("a Vue mount abort with no plugin frame", () => {
  it("keeps the plugin hint for a $-prefixed proxy frame", () => {
    expect(hintsForMountAbort(PLUGIN_FRAME_ABORT)).toContain("vuePluginGlobals");
  });

  it("never claims a plugin global for an ordinary SFC render frame", () => {
    expect(hintsForMountAbort(SFC_RENDER_ABORT, { usesInject: true })).not.toContain(
      "vuePluginGlobals",
    );
    expect(hintsForMountAbort(SFC_RENDER_ABORT)).not.toContain("vuePluginGlobals");
  });

  it("names provide/inject only when the run read an inject( call in the component", () => {
    expect(hintsForMountAbort(SFC_RENDER_ABORT, { usesInject: true })).toContain(
      "vueProvideInject",
    );
  });

  it("prints no hint at all when the run read no inject( call", () => {
    expect(hintsForMountAbort(SFC_RENDER_ABORT, { usesInject: false })).toEqual([]);
    expect(hintsForMountAbort(SFC_RENDER_ABORT)).toEqual([]);
  });

  it("remedies the injection with the wrapper an SFC run actually loads", () => {
    const block = formatMountAbortHints(SFC_RENDER_ABORT, { usesInject: true });

    expect(block).toContain("120fps.setup.vue");
    expect(block).toContain("provide");
  });
});

describe("a mount abort naming an identifier nothing defined", () => {
  it("links it to the config whose plugins the run read but did not execute", () => {
    const ids = hintsForMountAbort(MACRO_ABORT, {
      viteConfig: { file: "vite.config.ts", ignoredKeys: ["resolve.alias", "plugins"] },
    });

    expect(ids).toContain("vitePluginsNotExecuted");
  });

  it("names the config file, the ignored plugins and the identifier", () => {
    const block = formatMountAbortHints(MACRO_ABORT, {
      viteConfig: { file: "vite.config.ts", ignoredKeys: ["resolve.alias", "plugins"] },
    });

    expect(block).toContain(
      "vite.config.ts declares plugins, which the harness read but did not execute; nothing " +
        "defined defineModels",
    );
  });

  it("stays silent when the run recorded no ignored plugins", () => {
    expect(
      hintsForMountAbort(MACRO_ABORT, {
        viteConfig: { file: "vite.config.ts", ignoredKeys: [] },
      }),
    ).toEqual([]);
    expect(hintsForMountAbort(MACRO_ABORT)).toEqual([]);
  });

  it("stays silent when the config declares keys other than plugins", () => {
    expect(
      hintsForMountAbort(MACRO_ABORT, {
        viteConfig: { file: "vite.config.ts", ignoredKeys: ["resolve.alias"] },
      }),
    ).toEqual([]);
  });
});

// M114 review: VITE_CONFIG_PREPROCESSOR_OPTION_WARNING opens with the same
// prefix as VITE_CONFIG_IGNORED_WARNING, so a run that emits it first must
// still hand C3 the ignored-plugins keys.
describe("the vite-config evidence read back out of a run's warnings", () => {
  it("skips the preprocessor warning that shares the ignored warning's prefix", () => {
    const evidence = viteConfigIgnoredKeys([
      VITE_CONFIG_PREPROCESSOR_OPTION_WARNING("vite.config.ts", ["css.preprocessorOptions.scss.api"]),
      VITE_CONFIG_IGNORED_WARNING("vite.config.ts", ["plugins", "resolve.alias"]),
    ]);

    expect(evidence?.viteConfig.ignoredKeys).toEqual(["plugins", "resolve.alias"]);
    expect(hintsForMountAbort(MACRO_ABORT, evidence)).toContain("vitePluginsNotExecuted");
  });

  it("returns nothing when no warning recorded an ignored plugins key", () => {
    expect(
      viteConfigIgnoredKeys([
        VITE_CONFIG_PREPROCESSOR_OPTION_WARNING("vite.config.ts", ["css.preprocessorOptions.scss.api"]),
      ]),
    ).toBeUndefined();
  });
});

// M114 review: an unreadable SFC used to be indistinguishable from one with no
// inject( call, because the catch returned false with nothing said.
describe("an SFC the abort path could not re-read", () => {
  it("names the component and the read failure instead of implying no inject( call", () => {
    expect(SFC_INJECT_READ_FAILED_WARNING("src/Dialog.vue", "EACCES: permission denied")).toBe(
      "src/Dialog.vue could not be re-read to check for an inject( call (EACCES: permission " +
        "denied), so no provide/inject hint is offered for this abort",
    );
  });
});
