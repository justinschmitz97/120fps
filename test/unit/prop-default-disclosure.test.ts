import { describe, it, expect } from "vitest";
import path from "node:path";
import { extractProps } from "../../src/prop-gen.js";

const REACT = path.resolve(__dirname, "../../fixtures/own-props-rank");
const VUE = path.resolve(__dirname, "../../fixtures/vue-dual-block");

// calcom-F2: the union ordering already put the real default first, so the tool
// knew the defaults and never said so.

describe("a prop whose default comes from the parameter's destructuring", () => {
  it("carries the declared default value", async () => {
    const schemas = await extractProps(path.join(REACT, "DefaultsButton.tsx"));

    expect(schemas.find((s) => s.name === "color")).toMatchObject({
      defaultValue: "primary",
      defaultSource: "destructuring",
    });
    expect(schemas.find((s) => s.name === "variant")?.defaultValue).toBe("button");
  });

  it("records a falsy default as the default it is", async () => {
    const loading = (await extractProps(path.join(REACT, "DefaultsButton.tsx"))).find(
      (s) => s.name === "loading",
    );

    expect(loading?.defaultValue).toBe(false);
    expect(loading?.defaultSource).toBe("destructuring");
  });

  it("leaves a destructured prop with no default alone", async () => {
    const rounded = (await extractProps(path.join(REACT, "DefaultsButton.tsx"))).find(
      (s) => s.name === "rounded",
    );

    expect(rounded?.defaultValue).toBeUndefined();
    expect(rounded?.defaultSource).toBeUndefined();
  });
});

describe("a prop destructured in the body rather than the parameter list", () => {
  it("still carries the declared default", async () => {
    const schemas = await extractProps(path.join(REACT, "BodyDefaultsButton.tsx"));

    expect(schemas.find((s) => s.name === "color")).toMatchObject({
      defaultValue: "primary",
      defaultSource: "destructuring",
    });
    expect(schemas.find((s) => s.name === "loading")?.defaultValue).toBe(false);
    expect(schemas.find((s) => s.name === "tooltipOffset")?.defaultValue).toBe(4);
  });
});

describe("a prop whose default comes from defaultProps", () => {
  it("carries the value and names the source", async () => {
    const schemas = await extractProps(path.join(REACT, "LegacyDefaults.tsx"));

    expect(schemas.find((s) => s.name === "label")).toMatchObject({
      defaultValue: "legacy",
      defaultSource: "defaultProps",
    });
    expect(schemas.find((s) => s.name === "count")?.defaultValue).toBe(4);
  });
});

describe("a Vue prop whose default comes from withDefaults", () => {
  it("carries the value and names the source", async () => {
    const schemas = await extractProps(path.join(VUE, "DualBlockDefaults.vue"));

    expect(schemas.find((s) => s.name === "label")).toMatchObject({
      defaultValue: "badge",
      defaultSource: "withDefaults",
    });
    expect(schemas.find((s) => s.name === "count")?.defaultValue).toBe(7);
  });

  it("still measures the default first among the prop's values", async () => {
    const label = (await extractProps(path.join(VUE, "DualBlockDefaults.vue"))).find(
      (s) => s.name === "label",
    );

    expect(label?.values[0]).toBe("badge");
  });
});
