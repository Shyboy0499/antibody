// Ported from dsh-errkb, src/redact-patterns.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE). Section marks such as §5.1 refer to dsh-errkb's design document.
//
// The one list of credential and personal-data patterns (§4.4, and §17 Q4).
//
// Two consumers read the same facts. `redact.ts` applies these patterns to every
// text before it is stored. `.github/workflows/privacy-guard.yml` greps the
// repository for leaks, and as a shell step it cannot import TypeScript, so its
// regular expression is a hand-kept copy. Every family below names the workflow
// alternative it covers in `guard`; tests/redact-patterns.test.ts parses the
// workflow and fails when an alternative there has no family here, or when a
// family's `guard` no longer appears there. That keeps the two from drifting
// apart again, as they had before any code existed (docs/discussions.md §5).
//
// Redaction here is deliberately broader than the guard: the guard must stay
// quiet on prose that *mentions* `sk-` or `Bearer`, while redaction can afford
// to replace a little too much.
//
// No pattern in this file may match its own source text, or the privacy guard
// would fail on this file: every literal prefix is followed by a character
// class, never by the characters it describes.

/** A family of credential or personal-data text, and what replaces it. */
export interface RedactPattern {
  /** Stable family name, used in tests and in documentation. */
  readonly name: string;
  /** Global regular expression. */
  readonly pattern: RegExp;
  /** Replacement string; `$1`-style references keep a matched key name. */
  readonly replacement: string;
  /** The alternative in privacy-guard.yml this family covers, if any. */
  readonly guard?: string;
}

/** Placeholders written in place of redacted text. */
export const REDACTED = {
  secret: "<secret>",
  email: "<email>",
  requestId: "<request-id>",
  hex: "<hex>",
  base64: "<base64>",
} as const;

/**
 * Credential and personal-data families, in the order they are applied.
 *
 * Order matters in two places. Header and `key=value` forms run before the bare
 * token shapes, so `Authorization: Bearer x` loses the whole value at once. The
 * generic long-hex and long-base64 runs go last, as a net for whatever the named
 * families did not recognise.
 */
export const REDACT_PATTERNS: readonly RedactPattern[] = [
  {
    name: "authorization-header",
    pattern:
      /\b((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)(?:(?:basic|bearer|token|digest)\s+)?[^\s"',;]+/gi,
    replacement: `$1$2${REDACTED.secret}`,
  },
  {
    name: "api-key-assignment",
    pattern: /\b((?:x-)?api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi,
    replacement: `$1$2${REDACTED.secret}`,
  },
  {
    // `token=x`, and `"token": "x"` with a quoted key as in JSON. A bare
    // `token:` is left alone: "Unexpected token: }" is prose, not a credential.
    name: "secret-assignment",
    pattern:
      /\b((?:access_|refresh_|id_|auth_)?token|password|passwd|client_secret|secret)(["']?\s*=\s*["']?|["']\s*:\s*["']?)[^\s"'&,;]+/gi,
    replacement: `$1$2${REDACTED.secret}`,
  },
  {
    name: "bearer-token",
    pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: `$1 ${REDACTED.secret}`,
    guard: "Bearer [A-Za-z0-9._~+/-]{20,}",
  },
  {
    name: "openai-style-key",
    pattern: /\bsk-[A-Za-z0-9_-]{16,}/g,
    replacement: REDACTED.secret,
    guard: "sk-[A-Za-z0-9]{16,}",
  },
  {
    name: "xai-key",
    pattern: /\bxai-[A-Za-z0-9_-]{16,}/g,
    replacement: REDACTED.secret,
  },
  {
    name: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{30,}/g,
    replacement: REDACTED.secret,
  },
  {
    // ghp_ is the one the guard names; gho_, ghu_, ghs_ and ghr_ are the other
    // classic GitHub token prefixes and are just as secret.
    name: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    replacement: REDACTED.secret,
    guard: "ghp_[A-Za-z0-9]{20,}",
  },
  {
    name: "github-fine-grained-token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    replacement: REDACTED.secret,
    guard: "github_pat_[A-Za-z0-9_]{20,}",
  },
  {
    name: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}/g,
    replacement: REDACTED.secret,
    guard: "AKIA[0-9A-Z]{16}",
  },
  {
    // Every address, not only the personal domains the guard lists: an address
    // at a company domain identifies a person just as well.
    name: "email",
    pattern:
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    replacement: REDACTED.email,
    guard:
      "[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\\.)*(edu|edu\\.[a-z]{2}|ac\\.[a-z]{2}|gmail\\.com|outlook\\.com|hotmail\\.com|qq\\.com|163\\.com|126\\.com)",
  },
  {
    // The raw request ID (§4.4, §13): a provider can map it back to an account.
    name: "request-id",
    pattern: /\b((?:x-)?request[_-]?id)(["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]+/gi,
    replacement: `$1$2${REDACTED.requestId}`,
  },
  {
    name: "request-id-token",
    pattern: /\breq_[A-Za-z0-9]{16,}/g,
    replacement: REDACTED.requestId,
  },
  {
    name: "long-hex",
    pattern: /(?<![0-9A-Fa-f])[0-9A-Fa-f]{32,}(?![0-9A-Fa-f])/g,
    replacement: REDACTED.hex,
  },
  {
    // Forty or more base64 characters with upper case, lower case and a digit
    // all present - the mix is what separates a random token from a long
    // identifier or a word.
    name: "long-base64",
    pattern:
      /(?<![A-Za-z0-9+/_=-])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{40,}={0,2}/g,
    replacement: REDACTED.base64,
  },
];

/**
 * Per-user home directories, the personal part of an absolute path. In
 * `share: 'private'` mode paths are kept, but this prefix still becomes `~`, so
 * a user name never reaches the disk in either mode.
 */
export const HOME_PREFIX =
  /(?:\b[A-Za-z]:[\\/]Users|(?<![\w.~-])\/Users|(?<![\w.~-])\/home)[\\/][^\\/\s'"`<>|:*?]+/g;

/**
 * The privacy-guard alternatives that the path logic covers rather than a
 * pattern above: in `share: 'public'` mode every absolute path is collapsed to
 * `<path>` by the same code that normalizes signatures (src/signature.ts).
 */
export const PATH_GUARDS: readonly string[] = [
  "[A-Za-z]:\\\\[^\\\\`]+\\\\",
  "/Users/[A-Za-z0-9._-]+/",
  "/home/[A-Za-z0-9._-]+/",
];
