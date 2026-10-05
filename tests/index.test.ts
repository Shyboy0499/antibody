import { describe, expect, it } from "vitest";
import * as antibody from "../src/index";
import * as signature from "../src/signature";

// The package entry re-exports each ported module unchanged. Every port adds
// its module here, so a forgotten export fails the suite.
describe("public entry point", () => {
  it("re-exports the signature module", () => {
    for (const [name, value] of Object.entries(signature)) {
      expect(antibody, name).toHaveProperty(name, value);
    }
  });
});
