import { describe, expect, it } from "vitest";
import * as antibody from "../src/index";
import * as capture from "../src/capture";
import * as agent from "../src/agent";
import * as claims from "../src/claims";
import * as claudeCode from "../src/claude-code";
import * as gemini from "../src/gemini";
import * as codex from "../src/codex";
import * as hookInput from "../src/hook-input";
import * as cli from "../src/cli";
import * as events from "../src/events";
import * as fleet from "../src/fleet";
import * as injector from "../src/injector";
import * as match from "../src/match";
import * as notice from "../src/notice";
import * as paths from "../src/paths";
import * as redactPatterns from "../src/redact-patterns";
import * as redact from "../src/redact";
import * as resolveDetect from "../src/resolve-detect";
import * as session from "../src/session";
import * as signature from "../src/signature";
import * as state from "../src/state";
import * as store from "../src/store";
import * as trust from "../src/trust";
import * as transcript from "../src/transcript";
import * as review from "../src/review";
import * as exchange from "../src/exchange";
import * as exchangeCli from "../src/exchange-cli";
import * as autoImport from "../src/auto-import";
import * as relay from "../src/relay";
import * as relayServer from "../src/relay-server";
import * as relayCli from "../src/relay-cli";
import * as memoryCli from "../src/memory-cli";
import * as reviewCli from "../src/review-cli";
import * as tools from "../src/tools";
import * as mcp from "../src/mcp";
import * as setup from "../src/setup";
import * as watchModel from "../src/watch-model";
import * as watchRender from "../src/watch-render";

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
    ["transcript", transcript],
    ["review", review],
    ["exchange", exchange],
    ["exchange-cli", exchangeCli],
    ["auto-import", autoImport],
    ["relay", relay],
    ["relay-server", relayServer],
    ["relay-cli", relayCli],
    ["memory-cli", memoryCli],
    ["review-cli", reviewCli],
    ["resolve-detect", resolveDetect],
    ["injector", injector],
    ["state", state],
    ["events", events],
    ["claims", claims],
    ["agent", agent],
    ["hook-input", hookInput],
    ["claude-code", claudeCode],
    ["gemini", gemini],
    ["codex", codex],
    ["session", session],
    ["fleet", fleet],
    ["tools", tools],
    ["mcp", mcp],
    ["setup", setup],
    ["watch-model", watchModel],
    ["watch-render", watchRender],
    ["cli", cli],
  ])("re-exports %s", (_module, exports) => {
    for (const [name, value] of Object.entries(exports)) {
      expect(antibody, name).toHaveProperty(name, value);
    }
  });
});
