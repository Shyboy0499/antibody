import { describe, expect, it } from "vitest";
import * as antibody from "../src/index";
import * as redactPatterns from "../src/redact-patterns";
import * as redact from "../src/redact";
import * as signature from "../src/signature";

// The package entry re-exports each ported module unchanged. Every port adds
// its module here, so a forgotten export fails the suite.
describe("public entry point", () => {
  it.each([
    ["signature", signature],
    ["redact-patterns", redactPatterns],
    ["redact", redact],
  ])("re-exports %s", (_module, exports) => {
    for (const [name, value] of Object.entries(exports)) {
      expect(antibody, name).toHaveProperty(name, value);
    }
  });
});
