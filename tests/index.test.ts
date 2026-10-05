import { describe, expect, it } from "vitest";
import * as antibody from "../src/index";
import * as capture from "../src/capture";
import * as match from "../src/match";
import * as notice from "../src/notice";
import * as paths from "../src/paths";
import * as redactPatterns from "../src/redact-patterns";
import * as redact from "../src/redact";
import * as signature from "../src/signature";
import * as store from "../src/store";
import * as trust from "../src/trust";

// The package entry re-exports each ported module unchanged. Every port adds
// its module here, so a forgotten export fails the suite.
describe("public entry point", () => {
  it.each([
    ["signature", signature],
    ["redact-patterns", redactPatterns],
    ["redact", redact],
    ["paths", paths],
    ["store", store],
    ["match", match],
    ["capture", capture],
    ["notice", notice],
    ["trust", trust],
  ])("re-exports %s", (_module, exports) => {
    for (const [name, value] of Object.entries(exports)) {
      expect(antibody, name).toHaveProperty(name, value);
    }
  });
});
