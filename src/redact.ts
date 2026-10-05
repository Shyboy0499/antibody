// Ported from dsh-errkb, src/redact.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE). Section marks such as §5.1 refer to dsh-errkb's design document.
//
// Mandatory redaction before storage (§4.4).
//
// Every text the plugin writes passes through `redact` first; the unredacted
// original only ever exists in memory, long enough to compute a signature.
// The patterns live in redact-patterns.ts so the CI privacy guard can be checked
// against the same list. Path handling is reused from signature.ts, so a path
// collapses identically whether it is being fingerprinted or stored.
//
// No text-rule redaction is complete (docs/discussions.md §5): internal host
// names, `user@host` in SSH errors and short tokens below the length thresholds
// all pass through. That is why the real knowledge base lives in a private
// repository and this one only carries curated seed entries (§17 Q4).
import { HOME_PREFIX, REDACT_PATTERNS } from "./redact-patterns";
import { collapseAbsolutePaths } from "./signature";

/** How much a stored text may reveal (the `share` setting). */
export type Share = "public" | "private";

/** Options for {@link redact}. */
export interface RedactOptions {
  /** `public` (default) also collapses absolute paths to `<path>`. */
  share?: Share;
}

/** Options for {@link redactSample}. */
export interface RedactSampleOptions extends RedactOptions {
  /** Cap on the stored raw sample in `public` mode, in characters; default 500. */
  maxSampleChars?: number;
}

/** Default for the `maxSampleChars` setting. */
export const DEFAULT_MAX_SAMPLE_CHARS = 500;

/** Appended to a sample that was cut at the cap. */
export const TRUNCATION_MARK = "…";

/**
 * Remove credentials and personal data from a text.
 *
 * Both modes replace every family in {@link REDACT_PATTERNS} and turn a
 * per-user home directory into `~`. `public` additionally collapses every
 * absolute path to `<path>` plus its last segment; `private` keeps paths, which
 * makes self-diagnosis easier and assumes the file stays private.
 *
 * Paths are handled before the credential patterns, so a long path segment can
 * never be mistaken for a base64 token and leave its directory behind.
 *
 * @param text - any text about to be stored.
 * @param options - the share mode.
 * @returns the redacted text; `redact(redact(x))` equals `redact(x)`.
 */
export function redact(text: string, options: RedactOptions = {}): string {
  const share = options.share ?? "public";
  let result =
    share === "public"
      ? collapseAbsolutePaths(text)
      : text.replace(HOME_PREFIX, "~");
  for (const { pattern, replacement } of REDACT_PATTERNS)
    result = result.replace(pattern, replacement);
  return result;
}

/**
 * Cap a text at a number of characters, counted as code points so a surrogate
 * pair is never split. A cut text ends in {@link TRUNCATION_MARK}.
 *
 * @param text - the text to cap.
 * @param max - the cap; a non-positive or non-finite cap leaves the text whole.
 * @returns the capped text; idempotent.
 */
export function capSample(text: string, max: number): string {
  if (!Number.isFinite(max) || max <= 0) return text;
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  if (chars.length === max + 1 && chars[max] === TRUNCATION_MARK) return text;
  return chars.slice(0, max).join("") + TRUNCATION_MARK;
}

/**
 * Redact a raw error sample for storage and, in `public` mode, cap it at
 * `maxSampleChars` (§4.4). Redaction runs first, so the cap can never cut a
 * secret in half and leave a prefix that no longer matches its pattern.
 *
 * @param raw - the captured message.
 * @param options - share mode and cap.
 * @returns the stored form of the sample.
 */
export function redactSample(
  raw: string,
  options: RedactSampleOptions = {},
): string {
  const share = options.share ?? "public";
  const redacted = redact(raw, { share });
  if (share === "private") return redacted;
  return capSample(
    redacted,
    options.maxSampleChars ?? DEFAULT_MAX_SAMPLE_CHARS,
  );
}
