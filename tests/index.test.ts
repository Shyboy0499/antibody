import { describe, expect, it } from "vitest";
import * as antibody from "../src/index";
import * as capture from "../src/capture";
import * as agent from "../src/agent";
import * as claims from "../src/claims";
import * as events from "../src/events";
import * as injector from "../src/injector";
import * as match from "../src/match";
import * as notice from "../src/notice";
import * as paths from "../src/paths";
import * as redactPatterns from "../src/redact-patterns";
import * as redact from "../src/redact";
import * as resolveDetect from "../src/resolve-detect";
import * as signature from "../src/signature";
import * as state from "../src/state";
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
    ["resolve-detect", resolveDetect],
    ["injector", injector],
    ["state", state],
    ["events", events],
    ["claims", claims],
    ["agent", agent],
  ])("re-exports %s", (_module, exports) => {
    for (const [name, value] of Object.entries(exports)) {
      expect(antibody, name).toHaveProperty(name, value);
    }
  });
});
