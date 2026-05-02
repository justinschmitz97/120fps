import { describe, it, expect } from "vitest";
import type { InteractionDescriptor, InteractionType } from "../../src/discovery.js";

describe("InteractionDescriptor types", () => {
  it("interaction types are exhaustive", () => {
    const validTypes: InteractionType[] = [
      "click",
      "type",
      "select",
      "focus",
      "keyboard",
      "hover",
    ];
    expect(validTypes).toHaveLength(6);
  });

  it("descriptor has required fields", () => {
    const desc: InteractionDescriptor = {
      type: "click",
      selector: "button",
      tagName: "BUTTON",
      label: "Submit",
    };
    expect(desc.type).toBe("click");
    expect(desc.selector).toBe("button");
    expect(desc.tagName).toBe("BUTTON");
    expect(desc.label).toBe("Submit");
    expect(desc.role).toBeUndefined();
    expect(desc.inputType).toBeUndefined();
  });

  it("descriptor supports optional role and inputType", () => {
    const desc: InteractionDescriptor = {
      type: "type",
      selector: "input[type=text]",
      tagName: "INPUT",
      label: "Name",
      role: "combobox",
      inputType: "text",
    };
    expect(desc.role).toBe("combobox");
    expect(desc.inputType).toBe("text");
  });
});
