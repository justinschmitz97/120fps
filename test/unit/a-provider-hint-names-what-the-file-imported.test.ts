import { describe, it, expect } from "vitest";
import { detectProviderImport } from "../../src/project/index.js";

const IMPORTS_LINK = 'import { Link } from "react-router";\nexport const Nav = () => <Link to="/" />;';
const IMPORTS_HOOK = 'import { useNavigate } from "react-router";\nexport const Nav = () => useNavigate();';

describe("the provider suspect a file's imports produce", () => {
  it("names the package alone when the representative hook is not in the file", () => {
    expect(detectProviderImport("react-router", IMPORTS_LINK)).toEqual({ source: "react-router" });
  });

  it("names the hook when the file uses it", () => {
    expect(detectProviderImport("react-router", IMPORTS_HOOK)).toEqual({
      source: "react-router",
      hook: "useNavigate",
    });
  });

  it("names the hook from the table when no source text was read", () => {
    expect(detectProviderImport("react-router")).toEqual({
      source: "react-router",
      hook: "useNavigate",
    });
  });

  it("names a scoped package with no hook, whatever the file says", () => {
    expect(detectProviderImport("@radix-ui/react-dialog", IMPORTS_LINK)).toEqual({
      source: "@radix-ui/react-dialog",
    });
  });
});
