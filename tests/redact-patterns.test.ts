// Ported from dsh-errkb, tests/redact-patterns.test.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE). Section marks such as §5.1 refer to dsh-errkb's design document.
//
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { redact } from "../src/redact";
import { PATH_GUARDS, REDACT_PATTERNS } from "../src/redact-patterns";

// The privacy guard is a shell step and cannot import TypeScript, so its regular
// expression is a copy. These tests are what keeps the copy honest.

const workflow = readFileSync(
  resolve(
    fileURLToPath(new URL("..", import.meta.url)),
    ".github",
    "workflows",
    "privacy-guard.yml",
  ),
  "utf8",
);

/** The PATTERN='…' assignment in the workflow, unquoted. */
function guardPattern(text: string): string {
  const match = /^\s*PATTERN='([^']+)'\s*$/m.exec(text);
  if (match === null) throw new Error("no PATTERN='…' line in the workflow");
  return match[1] as string;
}

/** Split an ERE on its top-level `|`, leaving groups and classes intact. */
function alternatives(ere: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inClass = false;
  let current = "";
  for (let i = 0; i < ere.length; i++) {
    const ch = ere[i] as string;
    if (ch === "\\") {
      current += ch + (ere[i + 1] ?? "");
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
    } else if (ch === "[") inClass = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "|" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

// Assembled at run time for the same reason as in redact.test.ts: written out,
// each of these would trip the guard this file is testing.
const j = (...parts: string[]) => parts.join("");
const SAMPLES: Record<string, string> = {
  "[A-Za-z]:\\\\[^\\\\`]+\\\\": j("open D:", "\\", "work", "\\", "a.ts"),
  "/Users/[A-Za-z0-9._-]+/": j("open /", "Users/kim/p/a.ts"),
  "/home/[A-Za-z0-9._-]+/": j("open /", "home/kim/p/a.ts"),
  "[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\\.)*(edu|edu\\.[a-z]{2}|ac\\.[a-z]{2}|gmail\\.com|outlook\\.com|hotmail\\.com|qq\\.com|163\\.com|126\\.com)":
    j("from kim", "@", "qq.com"),
  "sk-[A-Za-z0-9]{16,}": j("key sk-", "Ab12Cd34Ef56Gh78Ij90"),
  "ghp_[A-Za-z0-9]{20,}": j("token ghp_", "Ab12Cd34Ef56Gh78Ij90Kl"),
  "github_pat_[A-Za-z0-9_]{20,}": j(
    "token github_pat_",
    "Ab12Cd34Ef56Gh78Ij90",
  ),
  "AKIA[0-9A-Z]{16}": j("id AKIA", "ABCDEFGH12345678"),
  "Bearer [A-Za-z0-9._~+/-]{20,}": j("Bearer ", "Ab12Cd34Ef56Gh78Ij90Kl"),
};

describe("privacy-guard.yml and redact-patterns.ts", () => {
  const ours = [
    ...REDACT_PATTERNS.flatMap((p) => (p.guard === undefined ? [] : [p.guard])),
    ...PATH_GUARDS,
  ];
  const theirs = alternatives(guardPattern(workflow));

  it("finds the guard's pattern and splits it into families", () => {
    expect(theirs.length).toBeGreaterThanOrEqual(9);
    expect(alternatives("a(b|c)|[|]|d\\|e")).toEqual([
      "a(b|c)",
      "[|]",
      "d\\|e",
    ]);
  });

  it("refuses a workflow without a PATTERN line", () => {
    expect(() => guardPattern("name: x")).toThrow(/PATTERN/);
  });

  it("every family in the workflow has an equivalent here", () => {
    for (const alternative of theirs) expect(ours).toContain(alternative);
  });

  it("every guard named here still exists in the workflow", () => {
    for (const guard of ours) expect(theirs).toContain(guard);
  });

  it("names each guard family once", () => {
    expect(new Set(ours).size).toBe(ours.length);
  });

  for (const alternative of theirs) {
    it(`redaction removes what the guard catches: ${alternative.slice(0, 40)}`, () => {
      const sample = SAMPLES[alternative];
      expect(sample, "add a sample for this guard family").toBeDefined();
      const guard = new RegExp(alternative);
      expect(guard.test(sample as string)).toBe(true);
      expect(guard.test(redact(sample as string, { share: "public" }))).toBe(
        false,
      );
    });
  }

  it("covers the provider keys the guard does not know", () => {
    const names = REDACT_PATTERNS.map((p) => p.name);
    expect(names).toContain("xai-key");
    expect(names).toContain("google-api-key");
  });
});
