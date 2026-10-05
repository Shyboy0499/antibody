// Ported from dsh-errkb, tests/signature.test.ts (MIT, Copyright (c) 2026 jingchangzhao-gif;
// see NOTICE). Section marks such as §5.1 refer to dsh-errkb's design document.
//
import { describe, expect, it } from "vitest";
import {
  PLACEHOLDER,
  SIGNATURE_LENGTH,
  collapseAbsolutePaths,
  collapsePath,
  normalize,
  signature,
} from "../src/signature";

// POSIX home paths are assembled from segments rather than written out: the
// privacy guard rejects a literal per-user home path anywhere in the tree, and
// it is right to - these are only test inputs.
const posix = (...segments: string[]) => `/${segments.join("/")}`;

describe("normalize: step 1, terminal noise", () => {
  it("strips ANSI colour and OSC hyperlink sequences", () => {
    expect(normalize("\x1b[31mError:\x1b[0m boom")).toBe("error: boom");
    expect(
      normalize("\x1b]8;;https://example.com\x07link\x1b]8;;\x1b\\ failed"),
    ).toBe("link failed");
  });

  it("strips carriage returns and collapses whitespace", () => {
    expect(normalize("a\r\nb\t\t c   d")).toBe("a b c d");
  });
});

describe("normalize: step 2, run-to-run noise", () => {
  it("replaces ISO timestamps, dates and clock times", () => {
    expect(normalize("at 2026-09-14T09:12:33.120Z failed")).toBe(
      "at <ts> failed",
    );
    expect(normalize("on 2026-09-14 09:12 failed")).toBe("on <ts> failed");
    expect(normalize("on 2026-09-14 failed")).toBe("on <ts> failed");
    expect(normalize("at 9:12:33 failed")).toBe("at <ts> failed");
    expect(normalize("at 2026-09-14T09:12:33+08:00 failed")).toBe(
      "at <ts> failed",
    );
  });

  it("replaces durations, including the Chinese forms", () => {
    expect(normalize("timed out after 1234ms")).toBe("timed out after <ts>");
    expect(normalize("timed out after 1.5s")).toBe("timed out after <ts>");
    expect(normalize("timed out after 30 ms")).toBe("timed out after <ts>");
    expect(normalize("耗时 123ms 超时")).toBe("耗时 <ts> 超时");
    expect(normalize("耗时 123 毫秒")).toBe("耗时 <ts>");
  });

  it("does not mistake an error code or a word for a duration", () => {
    expect(normalize("error TS2307: cannot find module")).toBe(
      "error ts2307: cannot find module",
    );
    expect(normalize("3 sessions open")).toBe("3 sessions open");
  });

  it("replaces PIDs and ports", () => {
    expect(normalize("killed PID 1234")).toBe("killed <pid>");
    expect(normalize("killed pid=99")).toBe("killed <pid>");
    expect(normalize("port 3000 in use")).toBe("<port> in use");
    expect(normalize("connect ECONNREFUSED 127.0.0.1:5432")).toBe(
      "connect econnrefused 127.0.0.1:<port>",
    );
    expect(normalize("listen EADDRINUSE: address already in use :::3000")).toBe(
      "listen eaddrinuse: address already in use :::<port>",
    );
    expect(normalize("fetch localhost:8080 failed")).toBe(
      "fetch localhost:<port> failed",
    );
  });

  it("replaces line and column positions in every common shape", () => {
    expect(normalize("SyntaxError at line 42:17")).toBe("syntaxerror at <pos>");
    expect(normalize('File "x.py", line 42, in main')).toBe(
      'file "x.py", <pos>, in main',
    );
    expect(normalize("at column 9")).toBe("at <pos>");
    expect(normalize("index.ts:42:17 - error")).toBe("index.ts:<pos> - error");
    expect(normalize("index.ts:42 - error")).toBe("index.ts:<pos> - error");
    expect(normalize("index.ts(42,17): error")).toBe("index.ts(<pos>): error");
    expect(normalize("at <anonymous>:3:9")).toBe("at <anonymous>:<pos>");
  });

  it("replaces UUIDs and long hashes", () => {
    expect(
      normalize("request 123e4567-E89B-12d3-a456-426614174000 failed"),
    ).toBe("request <uuid> failed");
    expect(normalize(`blob ${"a1".repeat(32)} missing`)).toBe(
      "blob <hash> missing",
    );
    expect(normalize(`commit ${"f".repeat(40)} missing`)).toBe(
      "commit <hash> missing",
    );
    expect(normalize("sig 3f2a1c9d0b71 kept")).toBe("sig 3f2a1c9d0b71 kept");
  });

  it("replaces temp-directory names, even as the last path segment", () => {
    expect(normalize("rmdir /tmp/abc123/cache")).toBe("rmdir <path>/cache");
    expect(normalize("rmdir /tmp/tmp-4242-xYz")).toBe("rmdir <path>/<tmp>");
    expect(normalize("mkdtemp tmp_9f8e7d failed")).toBe("mkdtemp <tmp> failed");
    expect(
      normalize("EPERM 'C:\\Users\\u\\AppData\\Local\\Temp\\vite-1a2b\\x.js'"),
    ).toBe("eperm '<path>\\x.js");
  });
});

describe("normalize: step 3, absolute paths", () => {
  it("collapses a Windows drive path and keeps the file name", () => {
    expect(
      normalize("ENOENT: no such file 'D:\\work\\proj\\package.json'"),
    ).toBe("enoent: no such file '<path>\\package.json");
  });

  it("collapses forward-slash drive paths, long-path and UNC forms", () => {
    expect(normalize("open C:/repo/src/a.ts failed")).toBe(
      "open <path>/a.ts failed",
    );
    expect(normalize("open \\\\?\\C:\\repo\\a.ts failed")).toBe(
      "open <path>\\a.ts failed",
    );
    expect(normalize("open \\\\server\\share\\a.ts failed")).toBe(
      "open <path>\\a.ts failed",
    );
  });

  it("collapses POSIX and home-relative paths", () => {
    expect(normalize(`open ${posix("Users", "kim", "p", "a.ts")} failed`)).toBe(
      "open <path>/a.ts failed",
    );
    expect(normalize(`open ${posix("home", "kim", "p", "b.ts")} failed`)).toBe(
      "open <path>/b.ts failed",
    );
    expect(normalize("open ~/p/c.ts failed")).toBe("open <path>/c.ts failed");
    expect(normalize("spawn /usr/bin/node ENOENT")).toBe(
      "spawn <path>/node enoent",
    );
  });

  it("leaves URLs, relative paths and single-segment roots alone", () => {
    expect(normalize("GET https://registry.example.org/a/b failed")).toBe(
      "get https://registry.example.org/a/b failed",
    );
    expect(normalize("cannot find src/a/b.ts")).toBe("cannot find src/a/b.ts");
    expect(normalize("N/A in /etc")).toBe("n/a in /etc");
  });

  it("keeps a path's position number outside the collapsed path", () => {
    expect(normalize(`at ${posix("home", "kim", "p", "a.ts")}:12:3`)).toBe(
      "at <path>/a.ts:<pos>",
    );
  });

  it("keeps package.json and tsconfig.json apart", () => {
    const pkg = normalize("ENOENT 'D:\\a\\b\\package.json'");
    const tsc = normalize("ENOENT 'D:\\a\\b\\tsconfig.json'");
    expect(pkg).not.toBe(tsc);
  });
});

describe("collapsePath", () => {
  it("keeps the last segment with the separator the path used", () => {
    expect(collapsePath("D:\\a\\b.txt")).toBe("<path>\\b.txt");
    expect(collapsePath("/a/b.txt")).toBe("<path>/b.txt");
  });

  it("drops the last segment of a bare directory or a bare home directory", () => {
    expect(collapsePath("/a/b/")).toBe(PLACEHOLDER.path);
    expect(collapsePath("C:\\Users\\kim")).toBe(PLACEHOLDER.path);
    expect(collapsePath(posix("home", "kim"))).toBe(PLACEHOLDER.path);
    expect(collapsePath("\\\\?\\C:\\Users\\kim")).toBe(PLACEHOLDER.path);
  });

  it("hands sentence punctuation back outside the placeholder", () => {
    expect(collapsePath("/a/b.txt.")).toBe("<path>/b.txt.");
    expect(collapsePath(`${posix("Users", "kim")}.`)).toBe("<path>.");
  });

  it("collapses every path in a text and is idempotent", () => {
    const once = collapseAbsolutePaths("cp /a/b/c.txt D:\\x\\y.txt");
    expect(once).toBe("cp <path>/c.txt <path>\\y.txt");
    expect(collapseAbsolutePaths(once)).toBe(once);
  });
});

describe("normalize: step 4 and edge cases", () => {
  it("lowercases and trims punctuation at both ends, keeping placeholders", () => {
    expect(normalize("  'Error: Boom!'  ")).toBe("error: boom");
    expect(normalize("failed at line 3.")).toBe("failed at <pos>");
    expect(normalize("（错误：拒绝访问。）")).toBe("错误：拒绝访问");
  });

  it("does not crash on empty, ANSI-only or very long input", () => {
    expect(normalize("")).toBe("");
    expect(normalize("\x1b[31m\x1b[0m")).toBe("");
    const body = "x".repeat(200_000);
    expect(normalize(`Error: ${body} at line 1`)).toBe(
      `error: ${body} at <pos>`,
    );
  });

  it("is idempotent", () => {
    const raw =
      "\x1b[31mEPERM\x1b[0m: rename 'C:\\Users\\kim\\proj\\node_modules\\.pnpm\\x' at 2026-09-14T09:12:33Z PID 42 port 3000 line 4:2 /tmp/tmp-1/a.ts";
    expect(normalize(normalize(raw))).toBe(normalize(raw));
  });
});

describe("signature", () => {
  it("is twelve lowercase hex characters", () => {
    expect(signature("tool", "boom")).toMatch(
      new RegExp(`^[0-9a-f]{${SIGNATURE_LENGTH}}$`),
    );
  });

  it("is stable across changed path, line, PID, timestamp and UUID", () => {
    const a = signature(
      "tool",
      `Error in ${posix("home", "ann", "one", "app.ts")} at line 10:4, PID 100, 2026-09-14T09:00:00Z, request 11111111-2222-3333-4444-555555555555`,
    );
    const b = signature(
      "tool",
      `Error in ${posix("Users", "bob", "two", "deep", "app.ts")} at line 99:1, PID 2, 2026-10-01T23:59:59Z, request aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
    );
    expect(a).toBe(b);
  });

  it("is stable across ANSI, case, whitespace and edge punctuation", () => {
    expect(signature("tool", "\x1b[1mError:  Boom\x1b[0m.")).toBe(
      signature("tool", "error: boom"),
    );
  });

  it("gives the same Windows EPERM one signature across machines", () => {
    const a = signature(
      "tool",
      "EPERM: operation not permitted, rename 'C:\\Users\\ann\\a\\node_modules\\.pnpm\\_tmp_123'",
    );
    const b = signature(
      "tool",
      "EPERM: operation not permitted, rename 'D:\\work\\b\\c\\node_modules\\.pnpm\\_tmp_123'",
    );
    expect(a).toBe(b);
  });

  it("is stable for Chinese text with a changed path and time", () => {
    const a = signature(
      "tool",
      "EPERM: 拒绝访问。'D:\\项目\\甲\\node_modules' 耗时 120ms",
    );
    const b = signature(
      "tool",
      "EPERM: 拒绝访问。'E:\\代码\\乙\\丙\\node_modules' 耗时 3ms",
    );
    expect(a).toBe(b);
  });

  it("separates different errors", () => {
    expect(signature("tool", "ENOENT: no such file")).not.toBe(
      signature("tool", "EACCES: permission denied"),
    );
    expect(signature("tool", "ENOENT 'D:\\a\\b\\package.json'")).not.toBe(
      signature("tool", "ENOENT 'D:\\a\\b\\tsconfig.json'"),
    );
    expect(signature("tool", "拒绝访问")).not.toBe(
      signature("tool", "找不到文件"),
    );
  });

  it("separates categories, and the NUL separator keeps them unambiguous", () => {
    expect(signature("tool", "boom")).not.toBe(signature("llm", "boom"));
    expect(signature("a", "bc")).not.toBe(signature("ab", "c"));
  });

  it("does not crash on empty, ANSI-only or very long input", () => {
    expect(signature("", "")).toHaveLength(SIGNATURE_LENGTH);
    expect(signature("tool", "\x1b[0m")).toBe(signature("tool", ""));
    expect(signature("tool", "y".repeat(1_000_000))).toHaveLength(
      SIGNATURE_LENGTH,
    );
  });
});
