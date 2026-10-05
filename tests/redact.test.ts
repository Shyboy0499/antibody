// Ported from dsh-errkb, tests/redact.test.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE). Section marks such as §5.1 refer to dsh-errkb's design document.
//
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_SAMPLE_CHARS,
  TRUNCATION_MARK,
  capSample,
  redact,
  redactSample,
} from "../src/redact";
import { REDACTED, REDACT_PATTERNS } from "../src/redact-patterns";

// Every credential-shaped sample is assembled at run time. Written out whole,
// it would trip the privacy guard on this very file - which is the guard
// working, not a false positive.
const join2 = (...parts: string[]) => parts.join("");
const posix = (...segments: string[]) => `/${segments.join("/")}`;
const RANDOM = "Zq7Xw2Lp9Rt4Vb8Nm3Kd6Hs1";

/** One secret per family, embedded in a realistic message. */
const SECRETS: ReadonlyArray<{ family: string; secret: string; text: string }> =
  [
    {
      family: "authorization-header",
      secret: join2("dXNlcjpw", "YXNz"),
      text: join2(
        "401 Unauthorized; Authorization: Basic ",
        "dXNlcjpw",
        "YXNz",
      ),
    },
    {
      family: "api-key-assignment",
      secret: "k3y-Value-77",
      text: "GET /v1/models?api_key=k3y-Value-77 failed",
    },
    {
      family: "api-key-assignment",
      secret: "hdr-Value-88",
      text: "x-api-key: hdr-Value-88 rejected",
    },
    {
      family: "secret-assignment",
      secret: "tok-Value-99",
      text: "callback?token=tok-Value-99&state=1",
    },
    {
      family: "secret-assignment",
      secret: "json-Value-11",
      text: '{"access_token": "json-Value-11"}',
    },
    {
      family: "secret-assignment",
      secret: "pw-Value-22",
      text: "connect failed: password=pw-Value-22",
    },
    {
      family: "bearer-token",
      secret: join2("eyJhbGciOi", "Jfoo.bar.baz"),
      text: join2("header Bearer ", "eyJhbGciOi", "Jfoo.bar.baz", " expired"),
    },
    {
      family: "openai-style-key",
      secret: join2("sk-", "proj-", RANDOM),
      text: join2("Incorrect API key provided: sk-", "proj-", RANDOM, "."),
    },
    {
      family: "xai-key",
      secret: join2("xai-", RANDOM),
      text: join2("invalid key xai-", RANDOM),
    },
    {
      family: "google-api-key",
      secret: join2("AIza", RANDOM, "AbCdEfGhIjK"),
      text: join2("key=AIza", RANDOM, "AbCdEfGhIjK is invalid"),
    },
    {
      family: "github-token",
      secret: join2("ghp_", RANDOM),
      text: join2("remote: token ghp_", RANDOM, " revoked"),
    },
    {
      family: "github-token",
      secret: join2("gho_", RANDOM),
      text: join2("oauth gho_", RANDOM),
    },
    {
      family: "github-fine-grained-token",
      secret: join2("github_pat_", RANDOM, "_x"),
      text: join2("auth github_pat_", RANDOM, "_x denied"),
    },
    {
      family: "aws-access-key",
      secret: join2("AKIA", "IOSFODNN7EXAMPLE"),
      text: join2(
        "The AWS Access Key Id AKIA",
        "IOSFODNN7EXAMPLE does not exist",
      ),
    },
    {
      family: "email",
      secret: join2("kim.lee", "@", "gmail.com"),
      text: join2("commit author kim.lee", "@", "gmail.com rejected"),
    },
    {
      family: "email",
      secret: join2("ops", "@", "corp.example.co.uk"),
      text: join2("notify ops", "@", "corp.example.co.uk"),
    },
    {
      family: "request-id",
      secret: "abc-123-def",
      text: "server error (request_id: abc-123-def)",
    },
    {
      family: "request-id-token",
      secret: join2("req_", RANDOM),
      text: join2("overloaded req_", RANDOM),
    },
    {
      family: "long-hex",
      secret: "0123456789abcdef0123456789ABCDEF",
      text: "session 0123456789abcdef0123456789ABCDEF expired",
    },
    {
      family: "long-base64",
      secret: join2(RANDOM, RANDOM, "=="),
      text: join2("blob ", RANDOM, RANDOM, "== rejected"),
    },
  ];

describe("redact: every family", () => {
  it("has at least one sample per family", () => {
    const covered = new Set(SECRETS.map((s) => s.family));
    for (const { name } of REDACT_PATTERNS) expect(covered).toContain(name);
  });

  for (const { family, secret, text } of SECRETS) {
    it(`${family}: the secret is gone in both modes - zero hits`, () => {
      for (const share of ["public", "private"] as const) {
        const out = redact(text, { share });
        expect(out).not.toContain(secret);
        expect(out).toMatch(/<(secret|email|request-id|hex|base64)>/);
      }
    });
  }

  it("leaves no hit for any family's pattern on bare tokens", () => {
    const bare = SECRETS.filter((s) =>
      [
        "openai-style-key",
        "xai-key",
        "google-api-key",
        "github-token",
        "github-fine-grained-token",
        "aws-access-key",
        "email",
        "request-id-token",
        "long-hex",
        "long-base64",
      ].includes(s.family),
    );
    const out = redact(bare.map((s) => s.text).join("\n"));
    for (const { name, pattern } of REDACT_PATTERNS)
      expect(out.match(pattern), name).toBeNull();
  });

  it("keeps the key name of a key=value pair", () => {
    expect(redact("x?api_key=abc123def")).toBe(`x?api_key=${REDACTED.secret}`);
    expect(redact(join2("Authorization: Bearer ", RANDOM))).toBe(
      `Authorization: ${REDACTED.secret}`,
    );
    expect(redact(join2("Bearer ", RANDOM))).toBe(`Bearer ${REDACTED.secret}`);
  });
});

describe("redact: what stays", () => {
  it("leaves ordinary error text untouched", () => {
    for (const text of [
      "EPERM: operation not permitted, rename",
      "Unexpected token: } in JSON at position 4",
      "error TS2307: Cannot find module 'react'",
      "signature 3f2a1c9d0b71 has twelve hex characters",
      "Bearer token missing",
      "the task-runner exited with code 1",
      "installed typescript@5.7.2",
      "拒绝访问。",
    ])
      expect(redact(text, { share: "private" })).toBe(text);
  });

  it("does not take a long identifier or a long word for base64", () => {
    const ident = "ThisIsAVeryLongIdentifierWithoutAnyDigitsAtAll";
    expect(redact(ident)).toBe(ident);
    const lower = "q".repeat(60);
    expect(redact(lower)).toBe(lower);
  });
});

describe("redact: share modes and paths", () => {
  const windows = "ENOENT 'D:\\work\\proj\\package.json'";
  const home = `ENOENT '${posix("home", "kim", "proj", "a.ts")}'`;

  it("public collapses absolute paths, keeping the last segment", () => {
    expect(redact(windows)).toBe("ENOENT '<path>\\package.json'");
    expect(redact(home, { share: "public" })).toBe("ENOENT '<path>/a.ts'");
  });

  it("private keeps paths but never the user name of a home directory", () => {
    expect(redact(windows, { share: "private" })).toBe(windows);
    expect(redact(home, { share: "private" })).toBe("ENOENT '~/proj/a.ts'");
    expect(
      redact("open C:\\Users\\kim\\proj\\a.ts", { share: "private" }),
    ).toBe("open ~\\proj\\a.ts");
    expect(
      redact(`open ${posix("Users", "kim", "p")}`, { share: "private" }),
    ).toBe("open ~/p");
  });

  it("private keeps project-relative paths", () => {
    const text = "cannot find src/feature/a.ts";
    expect(redact(text, { share: "private" })).toBe(text);
  });

  it("defaults to public", () => {
    expect(redact(windows)).toBe(redact(windows, { share: "public" }));
  });
});

describe("redact: idempotence", () => {
  const all = SECRETS.map((s) => s.text).join(" | ");
  const mixed = `${all} at 'C:\\Users\\kim\\p\\x.ts' and ${posix("home", "kim", "q")}`;

  it("redact(redact(x)) === redact(x) in both modes", () => {
    for (const share of ["public", "private"] as const) {
      const once = redact(mixed, { share });
      expect(redact(once, { share })).toBe(once);
    }
  });

  it("holds for every family on its own", () => {
    for (const { text } of SECRETS) {
      const once = redact(text);
      expect(redact(once)).toBe(once);
    }
  });
});

describe("capSample and redactSample", () => {
  it("caps by code points and marks the cut", () => {
    expect(capSample("abcdef", 3)).toBe(`abc${TRUNCATION_MARK}`);
    expect(capSample("abc", 3)).toBe("abc");
    expect(capSample("😀😀😀😀", 2)).toBe(`😀😀${TRUNCATION_MARK}`);
  });

  it("is idempotent, and a non-positive or infinite cap leaves the text whole", () => {
    const once = capSample("x".repeat(10), 4);
    expect(capSample(once, 4)).toBe(once);
    expect(capSample("abc", 0)).toBe("abc");
    expect(capSample("abc", Number.POSITIVE_INFINITY)).toBe("abc");
  });

  it("public: redacts, then caps at maxSampleChars (default 500)", () => {
    const raw = join2("key sk-", RANDOM, " ", "y".repeat(1000));
    const out = redactSample(raw);
    expect(out).not.toContain(RANDOM);
    expect(Array.from(out)).toHaveLength(DEFAULT_MAX_SAMPLE_CHARS + 1);
    expect(out.endsWith(TRUNCATION_MARK)).toBe(true);
    expect(redactSample(raw, { maxSampleChars: 20 })).toBe(
      `key ${REDACTED.secret} yyyyyyy${TRUNCATION_MARK}`,
    );
  });

  it("private: redacts but does not cap", () => {
    const raw = join2("key sk-", RANDOM, " ", "y".repeat(1000));
    const out = redactSample(raw, { share: "private", maxSampleChars: 20 });
    expect(out).toBe(`key ${REDACTED.secret} ${"y".repeat(1000)}`);
  });

  it("is idempotent", () => {
    const raw = join2("sk-", RANDOM, " at D:\\a\\b\\c.ts ", "z".repeat(900));
    const once = redactSample(raw);
    expect(redactSample(once)).toBe(once);
  });
});

describe("committed seeds", () => {
  // The public repository only carries curated seed entries. Anything
  // committed there must already be in its redacted form, so running redaction
  // over it (in the strictest mode) must change nothing.
  const seedsDir = resolve(
    fileURLToPath(new URL("..", import.meta.url)),
    "seeds",
  );
  const seeds = readdirSync(seedsDir).filter((name) => name.endsWith(".md"));

  it("every seeds/*.md is unchanged by redact()", () => {
    expect(seeds.length).toBeGreaterThan(0);
    for (const name of seeds) {
      const text = readFileSync(join(seedsDir, name), "utf8");
      expect(redact(text, { share: "public" }), name).toBe(text);
    }
  });
});
