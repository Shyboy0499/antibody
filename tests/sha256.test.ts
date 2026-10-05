import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/sha256";

const reference = (text: string) =>
  createHash("sha256").update(text).digest("hex");

describe("sha256Hex", () => {
  it("gives the FIPS 180-4 test vectors", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(
      sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("matches node:crypto at every padding boundary", () => {
    for (let n = 0; n <= 200; n++) {
      const text = "x".repeat(n);
      expect(sha256Hex(text), `length ${n}`).toBe(reference(text));
    }
  });

  it("hashes the UTF-8 bytes of any string", () => {
    for (const text of [
      "错误：拒绝访问",
      "emoji 😀 and accents: é, ñ",
      "lone surrogate \ud800 becomes U+FFFD",
      "a\u0000b",
      "ENOENT: no such file or directory, open '<path>/.env'",
    ])
      expect(sha256Hex(text)).toBe(reference(text));
  });

  it("matches node:crypto on random and long input", () => {
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    for (let i = 0; i < 2000; i++) {
      const length = next() % 300;
      const text = Array.from({ length }, () =>
        String.fromCodePoint(next() % 0x2fff),
      ).join("");
      expect(sha256Hex(text)).toBe(reference(text));
    }
    const long = "antibody ".repeat(120_000);
    expect(sha256Hex(long)).toBe(reference(long));
  });
});
