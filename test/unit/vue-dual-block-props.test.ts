import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  extractProps,
  extractPropsDetailed,
  isVueUnresolvedPropsTypeWarning,
  isVueOptionsApiPropsWarning,
  isVueSetupRuntimePropsWarning,
  isVuePropsScopeExclusionWarning,
} from "../../src/prop-gen.js";
import { loadVueCompiler, parseSfcScript, detectOptionsApiProps } from "../../src/vue-sfc.js";
import type { VueSfcCompiler } from "../../src/vue-sfc.js";

const FIXTURES = path.resolve(__dirname, "../../fixtures/vue-dual-block");

let compiler: VueSfcCompiler | undefined;
beforeAll(async () => {
  compiler = await loadVueCompiler(FIXTURES);
});

function read(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf-8");
}

// nuxt-ui-F1: 122 of 124 components declare their props interface in a companion
// <script lang="ts"> block. Only the <script setup> block reached the program, so
// defineProps<BadgeProps>() named a type nothing declared.

describe("an SFC that declares its props type in a companion script block", () => {
  it("extracts the interface the setup block's defineProps names", async () => {
    const names = (await extractProps(path.join(FIXTURES, "DualBlock.vue"))).map((s) => s.name);

    expect(names).toEqual(expect.arrayContaining(["label", "color", "square", "count"]));
  });

  it("types a companion-block literal union as a union with its values", async () => {
    const color = (await extractProps(path.join(FIXTURES, "DualBlock.vue"))).find(
      (s) => s.name === "color",
    );

    expect(color?.kind).toBe("union");
    expect(color?.values).toEqual(expect.arrayContaining(["primary", "secondary", "error"]));
  });

  it("still applies withDefaults when the interface came from the companion block", async () => {
    const schemas = await extractProps(path.join(FIXTURES, "DualBlockDefaults.vue"));

    expect(schemas.find((s) => s.name === "label")?.values).toContain("badge");
    expect(schemas.find((s) => s.name === "count")?.values).toContain(7);
  });

  it("puts the companion block before the setup block in the virtual module", () => {
    const script = parseSfcScript(read("DualBlock.vue"), "DualBlock.vue", compiler!);

    expect(script?.content.indexOf("DualBlockProps")).toBeLessThan(
      script!.content.indexOf("defineProps"),
    );
    expect(script?.lang).toBe("ts");
  });

  it("returns nothing for an SFC with no setup block, so Options-API detection still runs", () => {
    expect(parseSfcScript(read("OptionsExtends.vue"), "OptionsExtends.vue", compiler!)).toBeUndefined();
  });
});

describe("a defineProps type argument that does not resolve", () => {
  it("names the unresolved type and the file it was expected in", async () => {
    const { schemas, warnings } = await extractPropsDetailed(
      path.join(FIXTURES, "UnresolvedImport.vue"),
      { onWarning: () => {} },
    );

    expect(schemas).toEqual([]);
    const named = warnings.filter(isVueUnresolvedPropsTypeWarning);
    expect(named).toHaveLength(1);
    expect(named[0]).toContain("MissingProps");
    expect(named[0]).toContain("UnresolvedImport.vue");
  });

  it("does not fire for a props type that resolved", async () => {
    const { warnings } = await extractPropsDetailed(path.join(FIXTURES, "DualBlock.vue"), {
      onWarning: () => {},
    });

    expect(warnings.filter(isVueUnresolvedPropsTypeWarning)).toEqual([]);
  });
});

// element-plus-F5: select.vue is defineComponent({ props, setup() }) — Composition
// API with a runtime props object, reported as "Vue's Options API".

describe("a component whose runtime props object is read by setup()", () => {
  it("is detected as a setup-props form rather than an Options-API one", () => {
    expect(
      detectOptionsApiProps(read("SetupRuntimeProps.vue"), "SetupRuntimeProps.vue", compiler!),
    ).toBe("setup-props");
  });

  it("keeps calling an inheritance form extends, whatever the body uses", () => {
    expect(detectOptionsApiProps(read("OptionsExtends.vue"), "OptionsExtends.vue", compiler!)).toBe(
      "extends",
    );
  });

  it("never describes the setup form as Vue's Options API", async () => {
    const { warnings } = await extractPropsDetailed(
      path.join(FIXTURES, "SetupRuntimeProps.vue"),
      { onWarning: () => {} },
    );

    const named = warnings.filter(isVueSetupRuntimePropsWarning);
    expect(named).toHaveLength(1);
    expect(named[0]).toContain("Composition API");
    expect(warnings.filter(isVueOptionsApiPropsWarning)).toEqual([]);
  });

  it("counts as a props-scope exclusion, like the other runtime forms", async () => {
    const { warnings } = await extractPropsDetailed(
      path.join(FIXTURES, "SetupRuntimeProps.vue"),
      { onWarning: () => {} },
    );

    expect(warnings.some(isVuePropsScopeExclusionWarning)).toBe(true);
  });
});

// element-plus-F3: `value?: string | number` printed as `unknown` with no
// disclosure, while every other multi-shape prop got one.

describe("a prop declared string | number", () => {
  it("is typed as a union with a member per branch", async () => {
    const value = (await extractProps(path.join(FIXTURES, "PrimitiveUnion.vue"))).find(
      (s) => s.name === "value",
    );

    expect(value?.kind).toBe("union");
    expect(value?.values.length).toBeGreaterThanOrEqual(2);
    expect(value?.values.some((v) => typeof v === "string")).toBe(true);
    expect(value?.values.some((v) => typeof v === "number")).toBe(true);
  });

  it("classifies number | string the same way", async () => {
    const width = (await extractProps(path.join(FIXTURES, "PrimitiveUnion.vue"))).find(
      (s) => s.name === "width",
    );

    expect(width?.kind).toBe("union");
  });

  it("gets the same collapsed-union disclosure every other union gets", async () => {
    const { warnings } = await extractPropsDetailed(path.join(FIXTURES, "PrimitiveUnion.vue"), {
      onWarning: () => {},
    });

    const disclosure = warnings.filter((w) => w.includes('prop "value"'));
    expect(disclosure).toHaveLength(1);
    expect(disclosure[0]).toContain("union of 2 different shapes");
  });
});
