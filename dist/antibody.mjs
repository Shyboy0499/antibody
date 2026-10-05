#!/usr/bin/env node
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import { appendFile, mkdir } from "node:fs/promises";
//#region src/notice.ts
/** How every notice introduces itself to the agent. */
const NOTICE_PREFIX = "[antibody]";
/** The closing sentences, exactly as the model reads them. */
const WORDING = {
	hit: "Known fix: try this first, before re-diagnosing or researching.",
	approximate: "Approximate match, verify first.",
	doubted: "This fix failed here last time; verify before applying."
};
const NON_ASCII = /[^ -~\t\n\r]/gu;
/**
* A conservative token estimate that needs no tokenizer: every non-ASCII code
* point counts as one token, ASCII as one per {@link ASCII_CHARS_PER_TOKEN}
* characters, rounded up. It overestimates English by about a quarter and
* Chinese by a little more, so a notice inside the cap is inside it for real.
*
* @param text - any text.
* @returns the estimated token count.
*/
function estimateTokens(text) {
	const wide = text.match(NON_ASCII)?.length ?? 0;
	const ascii = text.length - wide - surrogateUnits(text);
	return Math.ceil(ascii / 3) + wide;
}
function surrogateUnits(text) {
	return text.length - Array.from(text).length;
}
/**
* Whether a body is inside both caps.
*
* @param text - a notice body.
*/
function withinCaps(text) {
	return Array.from(text).length <= 400 && estimateTokens(text) <= 120;
}
/** Collapse runs of whitespace, newlines included, to one space. */
function oneLine(text) {
	return text.replace(/\s+/g, " ").trim();
}
/**
* Clip text to at most `max` code points, the last of them an ellipsis when
* anything was cut.
*
* @param text - the text.
* @param max - the limit in code points; 0 or less gives the empty string.
*/
function clip(text, max) {
	const chars = Array.from(text);
	if (chars.length <= max) return text;
	if (max <= 0) return "";
	return `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}
function largest(low, high, ok) {
	if (!ok(low)) return void 0;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (ok(mid)) low = mid;
		else high = mid - 1;
	}
	return low;
}
/**
* Fit a cause and a fix into a template within both caps. The cause is first
* clipped to {@link CAUSE_MAX_CHARS}; if the result is still too long the cause
* shrinks towards {@link CAUSE_MIN_CHARS}, and only then does the fix shrink.
* Whatever the template adds stays whole. A template too long on its own (an
* absurd ID) is clipped as a last resort.
*
* @param render - builds the body from a clipped cause and fix.
* @param cause - the cause, one line.
* @param fix - the fix, one line.
* @returns a body inside both caps.
*/
function fitNotice(render, cause, fix) {
	const causeChars = Math.min(Array.from(cause).length, 100);
	const fixChars = Array.from(fix).length;
	const fits = (c, f) => withinCaps(render(clip(cause, c), clip(fix, f)));
	if (fits(causeChars, fixChars)) return render(clip(cause, causeChars), fix);
	const floor = Math.min(causeChars, 40);
	const c = largest(floor, causeChars, (n) => fits(n, fixChars));
	if (c !== void 0) return render(clip(cause, c), fix);
	const f = largest(0, fixChars, (n) => fits(floor, n));
	if (f !== void 0) return render(clip(cause, floor), clip(fix, f));
	return hardClip(render(clip(cause, floor), ""));
}
/**
* Clip a whole body until it is inside both caps.
*
* @param text - a notice body.
* @returns the longest clip of it that fits.
*/
function hardClip(text) {
	return clip(text, largest(0, Array.from(text).length, (m) => withinCaps(clip(text, m))));
}
const hitsText = (hits) => `${hits} ${hits === 1 ? "hit" : "hits"}`;
/**
* The body of a notice. Pure; caps are applied here, counts are not.
*
* @param event - the hit or miss.
* @param trust - the fix's trust level; ignored for a miss or an entry
*   without a fix.
* @returns the kind and the body.
*/
function noticeText(event, trust = "trusted") {
	if (event.kind === "miss") return {
		kind: "miss",
		text: hardClip(`${NOTICE_PREFIX} recorded as ${event.id} (no fix yet).`)
	};
	const { hit } = event;
	const { id, entry } = hit;
	const fix = oneLine(entry.fix);
	const near = hit.approximate ? ", approximate match" : "";
	if (fix === "") return {
		kind: "no-fix",
		text: hardClip(`${NOTICE_PREFIX} ${id} seen before (${hitsText(entry.hits)}${near}), no fix recorded yet.`)
	};
	const doubted = trust !== "trusted";
	const closing = [...hit.approximate ? [WORDING.approximate] : [], ...doubted ? [WORDING.doubted] : []];
	if (closing.length === 0) closing.push(WORDING.hit);
	const kind = doubted ? "doubted" : hit.approximate ? "near" : "hit";
	const cause = oneLine(entry.trigger);
	const head = `${NOTICE_PREFIX} ${id} known (${hitsText(entry.hits)})`;
	const tail = closing.join(" ");
	const render = (c, f) => `${head}${c === "" ? "" : ` | cause: ${c}`} | fix: ${f} ${tail}`;
	return {
		kind,
		text: fitNotice(render, cause, fix)
	};
}
/** How long ago, as a hint says it: seconds, then minutes, then hours. */
function elapsedText(ms) {
	const s = Math.max(0, Math.floor(ms / 1e3));
	if (s < 60) return `${s} s`;
	if (s < 3600) return `${Math.floor(s / 60)} min`;
	return `${Math.floor(s / 3600)} h`;
}
/**
* The notice for an agent that hit an entry another agent is diagnosing: who,
* for how long, and that the fix will follow. It only informs (design Q4).
*
* @param id - the entry.
* @param holder - the diagnosing agent's name.
* @param elapsedMs - how long the holder has been on it.
*/
function claimHintText(id, holder, elapsedMs) {
	const render = (name) => `${NOTICE_PREFIX} ${id}: ${name} has been diagnosing this for ${elapsedText(elapsedMs)}. Its fix will be passed to you when it is recorded.`;
	const fits = (n) => {
		const text = render(clip(holder, n));
		return withinCaps(text) && estimateTokens(text) <= 60;
	};
	return hardClip(render(clip(holder, largest(1, Math.max(1, Array.from(holder).length), fits) ?? 1)));
}
const DEFAULT_CAP_LIMITS = {
	perStep: 1,
	perTurn: 3,
	perIdPerSession: 2,
	fixedPerSession: 1
};
const count = (value) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
/**
* Counts one session's notices. Create one per session; call beginTurn() and
* beginStep() at those boundaries, and tryEmit() before each notice.
*/
var CapTracker = class CapTracker {
	limits;
	step = 0;
	turn = 0;
	perId = /* @__PURE__ */ new Map();
	/** @param limits - lower limits; a value above the default is ignored. */
	constructor(limits = {}) {
		const l = { ...DEFAULT_CAP_LIMITS };
		for (const key of Object.keys(l)) l[key] = Math.min(l[key], limits[key] ?? l[key]);
		this.limits = l;
	}
	/**
	* A tracker carrying on from saved counts. Anything malformed in the
	* snapshot counts as zero, so a damaged file can only make antibody quieter
	* for a moment, never louder.
	*
	* @param snapshot - what snapshot() returned, or undefined for a new session.
	* @param limits - as for the constructor.
	*/
	static restore(snapshot, limits = {}) {
		const caps = new CapTracker(limits);
		caps.step = count(snapshot?.step);
		caps.turn = count(snapshot?.turn);
		const perId = snapshot?.perId;
		if (typeof perId === "object" && perId !== null) {
			for (const [id, used] of Object.entries(perId)) if (count(used) > 0) caps.perId.set(id, count(used));
		}
		return caps;
	}
	/** The counts, for restore() in the next hook process. */
	snapshot() {
		return {
			step: this.step,
			turn: this.turn,
			perId: Object.fromEntries(this.perId)
		};
	}
	/** A new turn: the turn and step budgets start again. */
	beginTurn() {
		this.turn = 0;
		this.step = 0;
	}
	/** A new step within the turn: the step budget starts again. */
	beginStep() {
		this.step = 0;
	}
	/**
	* Take one notice from every budget, if every budget has one left.
	*
	* @param id - the entry the notice is about.
	* @param fixed - whether the entry's status is `fixed`.
	* @returns whether the notice may be emitted; nothing is taken when not.
	*/
	tryEmit(id, fixed = false) {
		const used = this.perId.get(id) ?? 0;
		const perId = fixed ? this.limits.fixedPerSession : this.limits.perIdPerSession;
		if (this.step >= this.limits.perStep || this.turn >= this.limits.perTurn || used >= perId) return false;
		this.step++;
		this.turn++;
		this.perId.set(id, used + 1);
		return true;
	}
};
//#endregion
//#region src/paths.ts
/** The file names the memory directory holds. */
const KB_FILE = {
	errors: "ANTIBODIES.md",
	archive: "ANTIBODIES.archive.md",
	index: "antibodies.index.json",
	state: "state.json",
	machine: ".machine.json",
	lock: ".lock",
	events: "events.jsonl",
	claims: "claims.json"
};
/**
* Build the absolute file paths inside a memory directory.
*
* @param dir - the resolved knowledge base directory.
* @returns the file paths.
*/
function filesIn(dir) {
	return {
		errors: join(dir, KB_FILE.errors),
		archive: join(dir, KB_FILE.archive),
		index: join(dir, KB_FILE.index),
		state: join(dir, KB_FILE.state),
		machine: join(dir, KB_FILE.machine),
		lock: join(dir, KB_FILE.lock),
		events: join(dir, KB_FILE.events),
		claims: join(dir, KB_FILE.claims)
	};
}
/**
* Name for the copy of a document that could not be parsed.
*
* Colons and dots are replaced so the name is legal on Windows, and the whole
* stamp is derived from the argument so the caller can pin it in a test.
*
* @param now - timestamp to embed; defaults to the current time.
* @returns a file name, never a path.
*/
function corruptFileName(now = /* @__PURE__ */ new Date()) {
	return `ANTIBODIES.corrupt-${now.toISOString().replace(/[:.]/g, "-")}.md`;
}
/** The directory inside the git common directory that holds antibody's memory. */
const MEMORY_DIR_NAME = "antibody";
/** The real git, found on PATH. Its error output is discarded. */
const runGit = (args, cwd) => execFileSync("git", args, {
	cwd,
	encoding: "utf8",
	stdio: [
		"ignore",
		"pipe",
		"ignore"
	]
}).trim();
/** `cwd` is not inside a git working tree, so there is no memory to share. */
var NotInGitRepoError = class extends Error {
	cwd;
	constructor(cwd) {
		super(`not inside a git repository: ${cwd}`);
		this.cwd = cwd;
		this.name = "NotInGitRepoError";
	}
};
/**
* Find the repository `cwd` belongs to by reading `.git`, without starting
* git: a hook runs on every tool call, and two git processes cost more than
* the rest of the hook. Walking up from `cwd`, a `.git` directory is a main
* checkout; a `.git` file is a linked worktree (or a submodule) naming its
* gitdir, whose `commondir` file names the shared directory. The common
* directory is resolved through symlinks, so every agent computes the same
* path for it.
*
* @param cwd - any directory.
* @returns the directories, or undefined when `cwd` is in no repository or
*   its `.git` file cannot be read.
*/
function findGitDirs(cwd) {
	let dir = resolve(cwd);
	let previous;
	while (dir !== previous) {
		const dotGit = join(dir, ".git");
		const stat = statSync(dotGit, { throwIfNoEntry: false });
		if (stat?.isDirectory()) return {
			worktree: dir,
			commonDir: realpathSync(dotGit)
		};
		if (stat?.isFile()) {
			const pointer = /^gitdir:[ \t]*(\S.*?)[ \t\r]*$/m.exec(readFileSync(dotGit, "utf8"));
			if (pointer === null) return void 0;
			const gitdir = resolve(dir, pointer[1]);
			let common = gitdir;
			try {
				common = resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim());
			} catch {}
			try {
				return {
					worktree: dir,
					commonDir: realpathSync(common)
				};
			} catch {
				return;
			}
		}
		previous = dir;
		dir = dirname(dir);
	}
}
const GIT_DIR_VARIABLES = ["GIT_DIR", "GIT_COMMON_DIR"];
/**
* The memory directory for the repository `cwd` belongs to: the same path from
* the main checkout, from any linked worktree and from any subdirectory.
*
* @param cwd - any directory inside the repository.
* @param git - runs git instead of reading `.git`; also used when GIT_DIR or
*   GIT_COMMON_DIR is set.
* @param env - the environment.
* @returns `<git common dir>/antibody`, absolute.
* @throws NotInGitRepoError when `cwd` is not inside a repository.
*/
function memoryDir(cwd, git, env = process.env) {
	if (git === void 0 && !GIT_DIR_VARIABLES.some((v) => env[v])) {
		const found = findGitDirs(cwd);
		if (found === void 0) throw new NotInGitRepoError(cwd);
		return join(found.commonDir, MEMORY_DIR_NAME);
	}
	let common;
	try {
		common = (git ?? runGit)([
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir"
		], cwd);
	} catch {
		throw new NotInGitRepoError(cwd);
	}
	if (common === "") throw new NotInGitRepoError(cwd);
	return join(resolve(cwd, common), MEMORY_DIR_NAME);
}
/**
* The root of the worktree `cwd` is in, or `cwd` itself outside a repository.
* It reads `.git` (findGitDirs()) unless a git runner is given.
*
* @param cwd - any directory.
* @param git - runs git instead of reading `.git`.
*/
function worktreeRoot(cwd, git) {
	if (git === void 0) return findGitDirs(cwd)?.worktree ?? cwd;
	try {
		return git(["rev-parse", "--show-toplevel"], cwd) || cwd;
	} catch {
		return cwd;
	}
}
/**
* An agent's display name.
*
* @param harness - the harness, e.g. `claude-code`.
* @param worktree - the worktree root the agent works in.
* @param env - the environment; ANTIBODY_AGENT wins when it is not blank.
*/
function agentName(harness, worktree, env = process.env) {
	const chosen = oneLine(env["ANTIBODY_AGENT"] ?? "");
	return clip(chosen !== "" ? chosen : `${harness}@${basename(worktree) || worktree}`, 64);
}
//#endregion
//#region src/claude-code.ts
/** The harness name, as agent names and events use it. */
const CLAUDE_CODE = "claude-code";
/** The hook events antibody handles. */
const HOOK_EVENTS = [
	"SessionStart",
	"UserPromptSubmit",
	"PostToolUse",
	"PostToolUseFailure",
	"SessionEnd"
];
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value) => typeof value === "string" ? value : void 0;
function outputText(value) {
	if (value === void 0 || value === null) return void 0;
	if (typeof value === "string") return value;
	if (isRecord(value)) {
		const streams = [str(value.stdout), str(value.stderr)].filter((s) => s !== void 0 && s !== "");
		if (streams.length > 0) return streams.join("\n");
	}
	return JSON.stringify(value);
}
const EXIT_KEYS = [
	"exitCode",
	"exit_code",
	"returnCode",
	"return_code"
];
function outputExitCode(value) {
	if (!isRecord(value)) return void 0;
	for (const key of EXIT_KEYS) {
		const n = value[key];
		if (typeof n === "number" && Number.isInteger(n)) return n;
	}
}
/**
* Parse a hook's stdin.
*
* @param text - the JSON Claude Code wrote.
* @returns the hook call, or undefined for an event antibody does not handle
*   or a payload it cannot read.
*/
function parseHookInput(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return;
	}
	if (!isRecord(value)) return void 0;
	const event = value.hook_event_name;
	const sessionId = str(value.session_id);
	const cwd = str(value.cwd);
	if (!HOOK_EVENTS.includes(event) || sessionId === void 0 || sessionId === "" || cwd === void 0) return void 0;
	const input = {
		event,
		sessionId,
		cwd
	};
	const agentId = str(value.agent_id);
	if (agentId !== void 0 && agentId !== "") input.agentId = agentId;
	const toolName = str(value.tool_name);
	if (toolName !== void 0) input.toolName = toolName;
	if (isRecord(value.tool_input)) {
		const command = str(value.tool_input.command);
		if (command !== void 0 && command.trim() !== "") input.command = command;
	}
	const result = value.tool_output ?? value.tool_response;
	const output = outputText(result);
	if (output !== void 0) input.output = output;
	const exitCode = outputExitCode(result);
	if (exitCode !== void 0) input.exitCode = exitCode;
	const error = str(value.error);
	if (error !== void 0) input.error = error;
	return input;
}
const EXIT_LINE = /^Exit code (\d+)[^\S\n]*\n?/;
const withMarker = (body, code) => `${body.trimEnd()}\n[exit code: ${code}]`;
/** The exit code and output of a failed shell command, when the call is one. */
function commandFailure(input) {
	if (input.event === "PostToolUseFailure") {
		const match = EXIT_LINE.exec(input.error ?? "");
		if (match === null) return void 0;
		return {
			code: Number(match[1]),
			body: (input.error ?? "").slice(match[0].length)
		};
	}
	if (input.event === "PostToolUse" && input.exitCode !== void 0 && input.exitCode !== 0) return {
		code: input.exitCode,
		body: input.output ?? ""
	};
}
/**
* The capture input for a failed call, or undefined when the call succeeded or
* the event is not a tool result.
*
* @param input - a parsed hook call.
*/
function toCapture(input) {
	const toolName = input.toolName ?? "unknown";
	const failed = commandFailure(input);
	if (failed !== void 0) {
		const capture = {
			kind: "command",
			toolName,
			text: withMarker(failed.body, failed.code)
		};
		if (input.command !== void 0) capture.command = input.command;
		return capture;
	}
	if (input.event !== "PostToolUseFailure") return void 0;
	return {
		kind: "tool",
		toolName,
		isError: true,
		message: input.error ?? ""
	};
}
/**
* The tool call resolution detection reads, for a PostToolUse or a
* PostToolUseFailure; undefined for any other event.
*
* @param input - a parsed hook call.
*/
function toToolCall(input) {
	if (input.event !== "PostToolUse" && input.event !== "PostToolUseFailure") return void 0;
	const call = {
		toolName: input.toolName ?? "unknown",
		isError: false,
		text: input.output ?? ""
	};
	if (input.command !== void 0) call.command = input.command;
	const failed = commandFailure(input);
	if (failed !== void 0) call.text = withMarker(failed.body, failed.code);
	else if (input.event === "PostToolUseFailure") {
		call.isError = true;
		call.text = input.error ?? "";
	}
	return call;
}
/** Claude Code caps each additionalContext at this many characters. */
const ADDITIONAL_CONTEXT_MAX_CHARS = 1e4;
/** The events whose hook output can carry additionalContext. */
const CONTEXT_EVENTS = /* @__PURE__ */ new Set([
	"SessionStart",
	"UserPromptSubmit",
	"PostToolUse",
	"PostToolUseFailure"
]);
/**
* The stdout for a hook: the notices as `hookSpecificOutput.additionalContext`,
* one per line, or the empty string when there is nothing to say or the event
* cannot carry context. An empty stdout with exit code 0 leaves Claude Code's
* behaviour unchanged.
*
* @param event - the event the hook answers.
* @param notices - notice bodies, each already inside the notice caps.
*/
function hookResponse(event, notices) {
	const lines = notices.filter((n) => n.trim() !== "");
	if (lines.length === 0 || !CONTEXT_EVENTS.has(event)) return "";
	return JSON.stringify({ hookSpecificOutput: {
		hookEventName: event,
		additionalContext: clip(lines.join("\n"), ADDITIONAL_CONTEXT_MAX_CHARS)
	} });
}
//#endregion
//#region src/signature.ts
/** The placeholders normalization writes, one per class of run-to-run noise. */
const PLACEHOLDER = {
	ts: "<ts>",
	pid: "<pid>",
	port: "<port>",
	pos: "<pos>",
	uuid: "<uuid>",
	hash: "<hash>",
	tmp: "<tmp>",
	path: "<path>"
};
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const SEGMENT = String.raw`(?:<[a-z-]+>|[^\s'"\x60<>|:*?\\/()\[\]{},;])+`;
/**
* Absolute paths, in four shapes: a Windows drive path (optionally behind the
* `\\?\` long-path prefix), a UNC share, a `~` home path, and a POSIX path with
* at least two segments. The POSIX form refuses to start right after a word
* character, a dot, a colon or a slash, which keeps `https://host/a/b`,
* `a/b/c` and an already-collapsed `<path>/x` out of it.
*
* Exported so redaction collapses exactly the same paths (§4.4 `share: 'public'`).
*/
const ABSOLUTE_PATH = new RegExp([
	String.raw`(?<![\w\\])(?:\\\\\?\\)?[A-Za-z]:[\\/]${SEGMENT}(?:[\\/]${SEGMENT})*[\\/]?`,
	String.raw`(?<![\w\\])\\\\${SEGMENT}(?:\\${SEGMENT})+\\?`,
	String.raw`(?<![\w.:/\\<>~-])~[\\/]${SEGMENT}(?:[\\/]${SEGMENT})*[\\/]?`,
	String.raw`(?<![\w.:/\\<>~-])\/${SEGMENT}(?:\/${SEGMENT})+\/?`
].join("|"), "g");
const HOME_ROOTS = /* @__PURE__ */ new Set(["users", "home"]);
/**
* Collapse one absolute path to `<path>` plus its last segment, written with the
* separator the path used: `<path>\package.json`, `<path>/tsconfig.json`.
*
* The last segment is kept because it is what tells `ENOENT ... package.json`
* from `ENOENT ... tsconfig.json`. Two exceptions drop it: a path that is only a
* directory (trailing separator), and a bare home directory such as
* `C:/Users/<name>`, whose last segment is a user name. Sentence punctuation
* that the segment class swallowed (a trailing `.`) is handed back outside the
* placeholder.
*
* @param path - one match of {@link ABSOLUTE_PATH}.
* @returns the collapsed form.
*/
function collapsePath(path) {
	const trailing = /\.+$/.exec(path)?.[0] ?? "";
	const body = path.slice(0, path.length - trailing.length);
	const segments = body.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== "?" && segment !== "~").filter((segment) => !/^[A-Za-z]:$/.test(segment));
	if (/[\\/]$/.test(body)) return PLACEHOLDER.path + trailing;
	const [root = "", ...rest] = segments;
	if (rest.length === 1 && HOME_ROOTS.has(root.toLowerCase())) return PLACEHOLDER.path + trailing;
	const cut = Math.max(body.lastIndexOf("/"), body.lastIndexOf("\\"));
	return `${PLACEHOLDER.path}${body.slice(cut)}${trailing}`;
}
/**
* Replace every absolute path in a text with its collapsed form.
*
* @param text - any text.
* @returns the text with paths collapsed; idempotent.
*/
function collapseAbsolutePaths(text) {
	return text.replace(ABSOLUTE_PATH, collapsePath);
}
const NOISE = [
	[/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, PLACEHOLDER.uuid],
	[/(?<![0-9a-f])[0-9a-f]{32,}(?![0-9a-f])/gi, PLACEHOLDER.hash],
	[/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, PLACEHOLDER.ts],
	[/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, PLACEHOLDER.ts],
	[/\b\d+(?:\.\d+)?\s?(?:ms|s)\b|\d+(?:\.\d+)?\s?毫?秒/g, PLACEHOLDER.ts],
	[/\bpid\s*[:=#]?\s*\d+/gi, PLACEHOLDER.pid],
	[/\bport\s*[:=#]?\s*\d+/gi, PLACEHOLDER.port],
	[/(localhost|\b\d{1,3}(?:\.\d{1,3}){3}|\]|::):\d{1,5}\b/gi, `$1:${PLACEHOLDER.port}`],
	[/\bline\s+\d+(?:\s*[:,]\s*\d+)?/gi, PLACEHOLDER.pos],
	[/\bcol(?:umn)?\s+\d+/gi, PLACEHOLDER.pos],
	[/(\.[A-Za-z]\w*):\d+(?::\d+)?\b/g, `$1:${PLACEHOLDER.pos}`],
	[/:\d+:\d+\b/g, `:${PLACEHOLDER.pos}`],
	[/\(\d+,\s?\d+\)/g, `(${PLACEHOLDER.pos})`],
	[/([\\/](?:tmp|temp)[\\/])[^\\/\s'"`]+/gi, `$1${PLACEHOLDER.tmp}`],
	[/\btmp[-_][\w-]+/gi, PLACEHOLDER.tmp]
];
const EDGE_PUNCTUATION = /^[\p{P}\s]+|[\p{P}\s]+$/gu;
/**
* Normalize one raw error message (§5.1):
*
* 1. strip ANSI escapes and `\r`, collapse whitespace;
* 2. replace timestamps, durations, PIDs, ports, line/column positions, UUIDs,
*    hashes and temp-directory names with placeholders;
* 3. collapse absolute paths to `<path>`, keeping the last segment;
* 4. lowercase, and trim punctuation from both ends.
*
* @param raw - the message as captured; any string, including empty.
* @returns the normalized form; idempotent.
*/
function normalize(raw) {
	let text = raw.replace(ANSI, "").replace(/\r/g, "").replace(/\s+/g, " ");
	for (const [pattern, replacement] of NOISE) text = text.replace(pattern, replacement);
	text = collapseAbsolutePaths(text);
	return text.toLowerCase().replace(EDGE_PUNCTUATION, "");
}
/**
* The signature of an error (§5.2): the first twelve hex characters of
* `sha256(category + "\u0000" + normalize(message))`.
*
* Only the message is hashed, never a stack: stack lines carry the most noise,
* and `LlmFailure` only reports a normalized message plus a code anyway. The NUL
* separator keeps `("a", "bc")` and `("ab", "c")` apart.
*
* @param category - the capture category, e.g. `tool` or `llm`.
* @param message - the raw message.
* @returns twelve lowercase hex characters.
*/
function signature(category, message) {
	return createHash("sha256").update(`${category}\u0000${normalize(message)}`).digest("hex").slice(0, 12);
}
//#endregion
//#region src/capture.ts
/** The capture sources, as named by the `capture` setting. */
const CAPTURE_SOURCES = [
	"tool",
	"command",
	"llm",
	"agent"
];
const TRANSIENT = /* @__PURE__ */ new Set([
	"RATE_LIMIT",
	"SERVER",
	"TIMEOUT",
	"TRANSPORT",
	"EMPTY_RESPONSE"
]);
const DEFAULT_CAPTURE_OPTIONS = {
	capture: CAPTURE_SOURCES,
	captureExitCodes: true,
	transientThreshold: 5
};
/** Run a getter-like function; a throw yields `undefined`. */
function attempt(read) {
	try {
		return read();
	} catch {
		return;
	}
}
/** A string or finite number as text; anything else is ignored. */
function scalar(value) {
	if (typeof value === "string") return value === "" ? void 0 : value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
}
/**
* Text for any value: JSON for plain data, `String()` otherwise, and a fixed
* placeholder when both throw (circular objects, hostile `toString`).
*/
function text(value) {
	if (typeof value === "function") return "[function]";
	if (typeof value === "object" && value !== null) {
		const json = attempt(() => JSON.stringify(value));
		if (typeof json === "string") return json;
	}
	return attempt(() => String(value)) ?? "[unprintable value]";
}
/**
* Read a thrown value safely (§6, `agent/error`): an Error gives its message,
* name and code; a string is the message; an object with a string `message`
* reads like an Error; anything else is stringified. Never throws - not on
* circular objects, throwing getters or a Proxy whose every trap throws.
*
* @param error - whatever was thrown.
* @returns the message, plus a name and code when there are any.
*/
function safeErrorText(error) {
	if (typeof error === "string") return { message: error };
	if (typeof error !== "object" || error === null) return { message: text(error) };
	const message = attempt(() => error.message);
	const name = scalar(attempt(() => error.name));
	const code = scalar(attempt(() => error.code));
	const extras = {
		...name === void 0 ? {} : { name },
		...code === void 0 ? {} : { code }
	};
	if (typeof message === "string") return {
		message,
		...extras
	};
	if (message !== void 0) return {
		message: text(message),
		...extras
	};
	return {
		message: text(error),
		...extras
	};
}
/**
* A line that names its error: a Node/pnpm code (`ERR_PNPM_…`), an errno
* (`EPERM`), an exception class (`ModuleNotFoundError`) or a TypeScript error
* (`error TS2307`). ERR_ codes may carry digits (`ERR_PNPM_FETCH_404`).
*/
const CODE = /\b(?:ERR_[A-Z0-9_]+|E[A-Z]{2,}|[A-Z]\w*Error|error TS\d+)\b/g;
const NOT_A_CODE = /* @__PURE__ */ new Set([
	"ERR",
	"ERROR",
	"ERRORS",
	"EXIT"
]);
const TRACEBACK = "Traceback (most recent call last):";
/** The first real code in a line, as stored: `error TS2307` → `TS2307`. */
function codeIn(line) {
	for (const [found] of line.matchAll(CODE)) {
		if (NOT_A_CODE.has(found)) continue;
		return found.startsWith("error ") ? found.slice(6) : found;
	}
}
/** Cut a line to `max` characters, the last one an ellipsis. */
function cap(line, max = 200) {
	const chars = Array.from(line);
	if (chars.length <= max) return line;
	return `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}
/**
* Pick the one line of a (possibly multi-line) error text that identifies it
* (docs/discussions.md §2a):
*
* 1. a Python traceback gives its last non-empty line, the exception itself;
* 2. otherwise the first line naming a code (see {@link CODE});
* 3. otherwise the last non-empty line.
*
* The traceback rule runs first because a traceback quotes source lines, and a
* quoted `raise ValueError(...)` would otherwise win rule 2. ANSI escapes are
* stripped, lines are trimmed and the result is capped at
* {@link HEADLINE_MAX_CHARS}.
*
* @param raw - the full text.
* @returns the headline, empty for blank text, and its code if it names one.
*/
function extractHeadline(raw) {
	const lines = raw.replace(ANSI, "").split(/\r?\n|\r/).map((line) => line.trim()).filter((line) => line !== "");
	const last = lines.at(-1) ?? "";
	const pick = (line) => {
		const code = codeIn(line);
		return {
			line: cap(line),
			...code === void 0 ? {} : { code }
		};
	};
	if (raw.includes(TRACEBACK)) return pick(last);
	return pick(lines.find((line) => codeIn(line) !== void 0) ?? last);
}
const EXIT_MARKER = /\[exit code: (\d+)\]/g;
/**
* The exit code a tool result reports, from its last `[exit code: N]` marker.
*
* @param text - the tool result text.
* @returns N, or `undefined` when there is no marker.
*/
function exitCode(text) {
	const last = Array.from(text.matchAll(EXIT_MARKER)).at(-1);
	return last === void 0 ? void 0 : Number(last[1]);
}
/**
* Per-session occurrence counts of transient errors, by signature. T11 holds
* one per session; the Map is injectable so a test or a caller can see it.
*/
var TransientCounter = class {
	counts;
	constructor(counts = /* @__PURE__ */ new Map()) {
		this.counts = counts;
	}
	/** Count one more occurrence; returns the new count. */
	bump(sig) {
		const next = (this.counts.get(sig) ?? 0) + 1;
		this.counts.set(sig, next);
		return next;
	}
	/** Occurrences so far, 0 for a signature never seen. */
	count(sig) {
		return this.counts.get(sig) ?? 0;
	}
};
/**
* The `transientThreshold` actually applied: a whole number of at least 1.
* index.ts reports a setting this changes; this stays the one rule for it.
*/
function effectiveTransientThreshold(value) {
	if (!Number.isFinite(value)) return DEFAULT_CAPTURE_OPTIONS.transientThreshold;
	return Math.max(1, Math.ceil(value));
}
const NO_MESSAGE = "(no message)";
/** Build a record from a source's category, tag and full text. */
function build(category, tag, displayCategory, raw, code, prefix = "", headline = extractHeadline(raw)) {
	const finalCode = code ?? headline.code;
	const line = headline.line === "" ? NO_MESSAGE : headline.line;
	const message = prefix !== "" && !line.startsWith(prefix) ? `${prefix}: ${line}` : line;
	return {
		category,
		...finalCode === void 0 ? {} : { code: finalCode },
		message,
		raw,
		title: `[${tag}] ${message}`,
		displayCategory,
		signature: signature(category, message)
	};
}
/**
* The command as it leads a headline: its first non-blank line, without ANSI
* escapes, cut to {@link COMMAND_MAX_CHARS}; `undefined` when there is none.
*/
function commandLine(command) {
	const first = (command ?? "").replace(ANSI, "").split(/\r?\n|\r/).map((line) => line.trim()).find((line) => line !== "");
	return first === void 0 ? void 0 : cap(first, 120);
}
/** The record for one input, or `undefined` when it is not an error at all. */
function recordFor(input, options) {
	switch (input.kind) {
		case "llm": {
			const code = input.code.trim().toUpperCase() || "UNKNOWN";
			return build("llm", "llm", `llm / ${code}`, input.message, code, code);
		}
		case "agent": {
			const { message, name, code } = safeErrorText(input.error);
			return build("agent", "agent", "agent", name !== void 0 && name !== "Error" && !message.startsWith(name) ? `${name}: ${message}` : message, code);
		}
		case "tool": {
			if (!input.isError) return void 0;
			const code = input.code?.trim() || void 0;
			return build("tool", `tool:${input.toolName}`, `tool / ${input.toolName}`, input.message, code);
		}
		case "command": {
			const n = exitCode(input.text);
			if (n === void 0 || n === 0 || !options.captureExitCodes) return void 0;
			const body = input.text.replace(EXIT_MARKER, "");
			const text = body.trim() === "" ? `exit code ${n}` : body;
			const headline = extractHeadline(text);
			const command = commandLine(input.command);
			const line = command !== void 0 && headline.code === void 0 ? { line: cap(`${command} → ${headline.line}`) } : headline;
			return {
				...build("command-exit", `command-exit:${input.toolName}`, `command-exit / ${input.toolName}`, text, void 0, "", line),
				raw: input.text,
				exitCode: n
			};
		}
	}
}
/**
* Classify one captured error (§6).
*
* @param input - one of the four source shapes.
* @param counter - this session's transient counter; bumped for transient
*   LLM failures only.
* @param options - settings; anything missing takes its default.
* @returns the record and its decision, or `undefined` when nothing is
*   captured: the source is off in `capture`, a tool result is not an error,
*   a command exited 0 or reported no exit code, or `captureExitCodes` is off.
*/
function classify(input, counter, options = {}) {
	const o = {
		...DEFAULT_CAPTURE_OPTIONS,
		...options
	};
	if (!o.capture.includes(input.kind)) return void 0;
	const record = recordFor(input, o);
	if (record === void 0) return void 0;
	const transient = input.kind === "llm" && TRANSIENT.has(record.code);
	if (!transient) return {
		decision: "record",
		record,
		transient
	};
	const count = counter.bump(record.signature);
	const promoted = count === effectiveTransientThreshold(o.transientThreshold);
	return {
		decision: promoted ? "record" : "count-only",
		record,
		transient,
		count,
		promoted
	};
}
//#endregion
//#region src/redact-patterns.ts
/** Placeholders written in place of redacted text. */
const REDACTED = {
	secret: "<secret>",
	email: "<email>",
	requestId: "<request-id>",
	hex: "<hex>",
	base64: "<base64>"
};
/**
* Credential and personal-data families, in the order they are applied.
*
* Order matters in two places. Header and `key=value` forms run before the bare
* token shapes, so `Authorization: Bearer x` loses the whole value at once. The
* generic long-hex and long-base64 runs go last, as a net for whatever the named
* families did not recognise.
*/
const REDACT_PATTERNS = [
	{
		name: "authorization-header",
		pattern: /\b((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)(?:(?:basic|bearer|token|digest)\s+)?[^\s"',;]+/gi,
		replacement: `$1$2${REDACTED.secret}`
	},
	{
		name: "api-key-assignment",
		pattern: /\b((?:x-)?api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi,
		replacement: `$1$2${REDACTED.secret}`
	},
	{
		name: "secret-assignment",
		pattern: /\b((?:access_|refresh_|id_|auth_)?token|password|passwd|client_secret|secret)(["']?\s*=\s*["']?|["']\s*:\s*["']?)[^\s"'&,;]+/gi,
		replacement: `$1$2${REDACTED.secret}`
	},
	{
		name: "bearer-token",
		pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
		replacement: `$1 ${REDACTED.secret}`,
		guard: "Bearer [A-Za-z0-9._~+/-]{20,}"
	},
	{
		name: "openai-style-key",
		pattern: /\bsk-[A-Za-z0-9_-]{16,}/g,
		replacement: REDACTED.secret,
		guard: "sk-[A-Za-z0-9]{16,}"
	},
	{
		name: "xai-key",
		pattern: /\bxai-[A-Za-z0-9_-]{16,}/g,
		replacement: REDACTED.secret
	},
	{
		name: "google-api-key",
		pattern: /\bAIza[0-9A-Za-z_-]{30,}/g,
		replacement: REDACTED.secret
	},
	{
		name: "github-token",
		pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
		replacement: REDACTED.secret,
		guard: "ghp_[A-Za-z0-9]{20,}"
	},
	{
		name: "github-fine-grained-token",
		pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
		replacement: REDACTED.secret,
		guard: "github_pat_[A-Za-z0-9_]{20,}"
	},
	{
		name: "aws-access-key",
		pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}/g,
		replacement: REDACTED.secret,
		guard: "AKIA[0-9A-Z]{16}"
	},
	{
		name: "email",
		pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
		replacement: REDACTED.email,
		guard: "[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\\.)*(edu|edu\\.[a-z]{2}|ac\\.[a-z]{2}|gmail\\.com|outlook\\.com|hotmail\\.com|qq\\.com|163\\.com|126\\.com)"
	},
	{
		name: "request-id",
		pattern: /\b((?:x-)?request[_-]?id)(["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]+/gi,
		replacement: `$1$2${REDACTED.requestId}`
	},
	{
		name: "request-id-token",
		pattern: /\breq_[A-Za-z0-9]{16,}/g,
		replacement: REDACTED.requestId
	},
	{
		name: "long-hex",
		pattern: /(?<![0-9A-Fa-f])[0-9A-Fa-f]{32,}(?![0-9A-Fa-f])/g,
		replacement: REDACTED.hex
	},
	{
		name: "long-base64",
		pattern: /(?<![A-Za-z0-9+/_=-])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{40,}={0,2}/g,
		replacement: REDACTED.base64
	}
];
/**
* Per-user home directories, the personal part of an absolute path. In
* `share: 'private'` mode paths are kept, but this prefix still becomes `~`, so
* a user name never reaches the disk in either mode.
*/
const HOME_PREFIX = /(?:\b[A-Za-z]:[\\/]Users|(?<![\w.~-])\/Users|(?<![\w.~-])\/home)[\\/][^\\/\s'"`<>|:*?]+/g;
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
function redact(text, options = {}) {
	let result = (options.share ?? "public") === "public" ? collapseAbsolutePaths(text) : text.replace(HOME_PREFIX, "~");
	for (const { pattern, replacement } of REDACT_PATTERNS) result = result.replace(pattern, replacement);
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
function capSample(text, max) {
	if (!Number.isFinite(max) || max <= 0) return text;
	const chars = Array.from(text);
	if (chars.length <= max) return text;
	if (chars.length === max + 1 && chars[max] === "…") return text;
	return chars.slice(0, max).join("") + "…";
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
function redactSample(raw, options = {}) {
	const share = options.share ?? "public";
	const redacted = redact(raw, { share });
	if (share === "private") return redacted;
	return capSample(redacted, options.maxSampleChars ?? 500);
}
//#endregion
//#region src/store.ts
/** Entry status values (§8). */
const ENTRY_STATUSES = [
	"open",
	"fixed",
	"wontfix"
];
/** The human-readable field labels, in both languages (§8, §17 Q2). */
const LABELS = {
	en: {
		fingerprint: "Fingerprint",
		category: "Category",
		firstSeen: "First seen",
		lastSeen: "Last seen",
		hits: "Hits",
		trigger: "Trigger",
		raw: "Raw message",
		fix: "Fix",
		status: "Status",
		notes: "Notes"
	},
	zh: {
		fingerprint: "指纹",
		category: "分类",
		firstSeen: "首次",
		lastSeen: "最近",
		hits: "命中",
		trigger: "触发",
		raw: "原始信息",
		fix: "解法",
		status: "状态",
		notes: "备注"
	}
};
const FIELD_BY_LABEL = /* @__PURE__ */ new Map();
for (const set of Object.values(LABELS)) for (const key of [
	"fingerprint",
	"category",
	"firstSeen",
	"trigger",
	"raw",
	"fix",
	"status",
	"notes"
]) FIELD_BY_LABEL.set(set[key], key);
/** A document that cannot be parsed. `line` is 1-based. */
var ParseError = class extends Error {
	line;
	constructor(message, line) {
		super(`ANTIBODIES.md line ${line}: ${message}`);
		this.line = line;
		this.name = "ParseError";
	}
};
/** Header of a new document, and of a new archive. */
const DOCUMENT_HEADER = "# ANTIBODIES\n";
const ARCHIVE_HEADER = "# ANTIBODIES archive\n";
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const headerPattern = (idPrefix) => new RegExp(`^## (${escapeRegExp(idPrefix)}\\d+) ·(?: (.*))?$`);
const CONFLICT_MARKER = /^(?:<{7}|>{7})(?: |$)|^={7}$/;
const META_PREFIX = "antibody";
const META_LINE = /^<!-- (?:antibody|errkb):(.*)-->\s*$/;
const FIELD_LINE = /^- ([^:：]+)[:：] ?(.*)$/;
/**
* Encode a machine-field value: `%`, whitespace and `>` are percent-encoded so a
* value can never end the comment or split into two fields.
*/
function encodeMetaValue(value) {
	return value.replace(/[%\s>]/g, (ch) => encodeURIComponent(ch));
}
/** Inverse of {@link encodeMetaValue}; a malformed escape is kept literally. */
function decodeMetaValue(value) {
	return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
		try {
			return decodeURIComponent(run);
		} catch {
			return run;
		}
	});
}
/**
* Format an entry ID: prefix plus zero-padded number.
*
* @param n - the ID number, from 1.
* @param idPrefix - the `idPrefix` setting.
* @param idWidth - the `idWidth` setting.
* @returns e.g. `E-0007`.
*/
function formatId(n, idPrefix = "E-", idWidth = 4) {
	return `${idPrefix}${String(n).padStart(idWidth, "0")}`;
}
/**
* Every ID number in a text's entry headers, found leniently - this is what
* still works on a document that does not parse, and on the archive.
*
* @param text - a document or archive.
* @param idPrefix - the `idPrefix` setting.
* @returns the numbers, in document order.
*/
function scanIdNumbers(text, idPrefix = "E-") {
	const pattern = new RegExp(`^## ${escapeRegExp(idPrefix)}(\\d+) ·`, "gm");
	return Array.from(text.matchAll(pattern), (m) => Number(m[1]));
}
/**
* The next ID number: one more than the highest anywhere, so IDs only ever
* increase and an archived ID is never reused (§4.3, §8).
*
* @param texts - the document and the archive.
* @returns the next number, at least 1.
*/
function nextIdNumber(texts, idPrefix = "E-") {
	let max = 0;
	for (const text of texts) for (const n of scanIdNumbers(text, idPrefix)) max = Math.max(max, n);
	return max + 1;
}
const unwrapCode = (value) => /^`([^`]*)`$/.exec(value)?.[1] ?? value;
const wrapCode = (value) => value === "" ? "" : value.includes("`") ? value : `\`${value}\``;
function dedent(line) {
	if (line.startsWith("  ")) return line.slice(2);
	if (line.startsWith("	")) return line.slice(1);
	return line;
}
function trimBlankLines(lines) {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].trim() === "") start++;
	while (end > start && lines[end - 1].trim() === "") end--;
	return lines.slice(start, end);
}
function parseMeta(content, line) {
	const meta = {};
	for (const pair of content.trim().split(/\s+/).filter(Boolean)) {
		const eq = pair.indexOf("=");
		if (eq <= 0) throw new ParseError(`malformed machine field "${pair}"`, line);
		meta[pair.slice(0, eq)] = decodeMetaValue(pair.slice(eq + 1));
	}
	return meta;
}
function parseRaw(lines, line) {
	const open = /^(`{3,})/.exec(lines[0] ?? "");
	if (open === null) return lines.join("\n");
	const fence = open[1];
	const close = lines.findIndex((text, i) => i > 0 && new RegExp(`^${fence}\`*\\s*$`).test(text));
	if (close === -1) throw new ParseError("unterminated code fence", line);
	return lines.slice(1, close).join("\n");
}
function parseSeen(value, line) {
	const last = `(?:${LABELS.en.lastSeen}|${LABELS.zh.lastSeen})`;
	const hits = `(?:${LABELS.en.hits}|${LABELS.zh.hits})`;
	const match = new RegExp(`^(.*?)\\s*·\\s*${last}[:：]\\s*(.*?)\\s*·\\s*${hits}[:：]\\s*(\\S*)$`).exec(value);
	if (match === null) throw new ParseError("malformed first-seen / last-seen / hits line", line);
	if (!/^\d+$/.test(match[3])) throw new ParseError(`hit count "${match[3]}" is not a number`, line);
	return {
		firstSeen: match[1],
		lastSeen: match[2],
		hits: Number(match[3])
	};
}
/**
* Parse one block: a header line, the machine comment, and the labelled fields.
* A field runs until the next line that opens a known field (§8), so a fix may
* hold blank lines, bullets and code. Missing fields read as empty, a missing
* status as `open`.
*/
function parseBlock(source, firstLine, header) {
	const lines = source.split("\n").map((line) => line.replace(/\r$/, ""));
	const head = header.exec(lines[0]);
	let meta;
	const fields = /* @__PURE__ */ new Map();
	let current;
	for (let i = 1; i < lines.length; i++) {
		const text = lines[i];
		const lineNo = firstLine + i;
		const metaMatch = META_LINE.exec(text);
		if (metaMatch !== null) {
			if (meta !== void 0) throw new ParseError("second machine-field comment", lineNo);
			meta = parseMeta(metaMatch[1], lineNo);
			current = void 0;
			continue;
		}
		const field = FIELD_LINE.exec(text);
		const key = field && FIELD_BY_LABEL.get(field[1].trim());
		if (field && key) {
			if (fields.has(key)) throw new ParseError(`field "${field[1]}" appears twice`, lineNo);
			current = [field[2]];
			fields.set(key, {
				lines: current,
				line: lineNo
			});
			continue;
		}
		current?.push(dedent(text));
	}
	if (meta === void 0) throw new ParseError("entry has no <!-- antibody: ... --> comment", firstLine);
	const fieldText = (key) => trimBlankLines(fields.get(key)?.lines ?? []).join("\n");
	const seenField = fields.get("firstSeen");
	const seen = seenField ? parseSeen(fieldText("firstSeen"), seenField.line) : {
		firstSeen: "",
		lastSeen: "",
		hits: 0
	};
	const rawField = fields.get("raw");
	const raw = rawField ? parseRaw(trimBlankLines(rawField.lines), rawField.line) : "";
	const statusText = unwrapCode(fieldText("status")).trim().toLowerCase() || "open";
	if (!ENTRY_STATUSES.includes(statusText)) throw new ParseError(`unknown status "${statusText}"`, fields.get("status").line);
	return {
		id: head[1],
		title: (head[2] ?? "").trim(),
		meta,
		fingerprint: unwrapCode(fieldText("fingerprint")),
		category: unwrapCode(fieldText("category")),
		...seen,
		trigger: fieldText("trigger"),
		raw,
		fix: fieldText("fix"),
		status: statusText,
		notes: fieldText("notes")
	};
}
/**
* Parse a whole document (§8): blocks split on `^## <prefix><digits> ·`.
*
* Parsing is strict about what would make a write unsafe - a git conflict
* marker, a malformed entry header, a missing machine comment, a duplicate ID,
* an unknown status, a broken first-seen line, an unterminated fence - and
* lenient about everything a human might reasonably type: either label set,
* either colon, a fix on the label's own line or below it, missing fields.
*
* @param text - the document; empty is a valid, empty document.
* @param idPrefix - the `idPrefix` setting.
* @returns the preamble and the blocks, each with its exact source.
* @throws ParseError when the document is not safe to rewrite.
*/
function parseDocument(text, idPrefix = "E-") {
	const header = headerPattern(idPrefix);
	const headerStart = `## ${idPrefix}`;
	const lines = text.split("\n");
	const starts = [];
	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].replace(/\r$/, "");
		if (CONFLICT_MARKER.test(line)) throw new ParseError("git conflict marker", i + 1);
		if (line.startsWith(headerStart) && /\d/.test(line.charAt(headerStart.length))) {
			if (!header.test(line)) throw new ParseError(`malformed entry header "${line}"`, i + 1);
			starts.push({
				offset,
				line: i + 1
			});
		}
		offset += lines[i].length + 1;
	}
	const blocks = [];
	const seen = /* @__PURE__ */ new Set();
	for (let b = 0; b < starts.length; b++) {
		const start = starts[b];
		const source = text.slice(start.offset, starts[b + 1]?.offset);
		const entry = parseBlock(source, start.line, header);
		if (seen.has(entry.id)) throw new ParseError(`duplicate ID ${entry.id}`, start.line);
		seen.add(entry.id);
		blocks.push({
			entry,
			source
		});
	}
	return {
		preamble: text.slice(0, starts[0]?.offset ?? text.length),
		blocks
	};
}
/**
* Render a document: the preamble, then every block's source. For a parsed
* document this is the exact input text.
*/
function renderDocument(document) {
	return document.preamble + document.blocks.map((b) => b.source).join("");
}
function renderTextBlock(label, value) {
	if (value === "") return [`- ${label}:`];
	return [`- ${label}:`, ...value.split("\n").map((line) => line === "" ? "" : `  ${line}`)];
}
function renderInline(label, value) {
	if (value.includes("\n")) return renderTextBlock(label, value);
	return [value === "" ? `- ${label}:` : `- ${label}: ${value}`];
}
/**
* Render one entry as a block (§8), ending in a newline. The raw sample's fence
* is longer than any backtick run inside it, so a sample can never close it.
*
* @param entry - the entry.
* @param labels - which label set to write.
* @returns the block text.
*/
function renderEntry(entry, labels = "en") {
	const l = LABELS[labels];
	const runs = entry.raw.match(/`+/g) ?? [];
	const fence = "`".repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
	const meta = Object.entries(entry.meta).map(([key, value]) => `${key}=${encodeMetaValue(value)}`).join(" ");
	const raw = entry.raw.split("\n").map((line) => line === "" ? "" : `  ${line}`);
	return [
		`## ${entry.id} · ${entry.title}`,
		`<!-- ${META_PREFIX}: ${meta} -->`,
		"",
		...renderInline(l.fingerprint, wrapCode(entry.fingerprint)),
		...renderInline(l.category, wrapCode(entry.category)),
		`- ${l.firstSeen}: ${entry.firstSeen} · ${l.lastSeen}: ${entry.lastSeen} · ${l.hits}: ${entry.hits}`,
		...renderInline(l.trigger, entry.trigger),
		`- ${l.raw}:`,
		`  ${fence}text`,
		...raw,
		`  ${fence}`,
		...renderTextBlock(l.fix, entry.fix),
		`- ${l.status}: \`${entry.status}\``,
		...renderTextBlock(l.notes, entry.notes),
		""
	].join("\n");
}
/**
* Which label set a block was written in, so an update rewrites it in the same
* language instead of switching one entry over.
*/
function detectLabels(source) {
	for (const line of source.split("\n")) {
		const field = FIELD_LINE.exec(line.replace(/\r$/, ""));
		if (field === null) continue;
		const label = field[1].trim();
		if (Object.values(LABELS.zh).includes(label)) return "zh";
		if (Object.values(LABELS.en).includes(label)) return "en";
	}
}
/** The separator that puts one blank line between `text` and what follows. */
function separatorAfter(text) {
	if (text === "" || text.endsWith("\n\n")) return "";
	return text.endsWith("\n") ? "\n" : "\n\n";
}
/** Display form of a timestamp in an entry: `2026-09-14 09:12` (UTC). */
function formatSeen(date) {
	return date.toISOString().slice(0, 16).replace("T", " ");
}
/** Machine-field form of a timestamp: `2026-09-14T09:12:33Z`. */
function formatFirst(date) {
	return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
const DEFAULT_STORE_OPTIONS = {
	idPrefix: "E-",
	idWidth: 4,
	maxEntries: 200,
	labels: "en",
	share: "public",
	maxSampleChars: 500,
	lockStaleMs: 1e4,
	lockTimeoutMs: 1e4,
	lockRetryMs: 10
};
/** The lock could not be taken in time. */
var LockTimeoutError = class extends Error {
	path;
	constructor(path) {
		super(`timed out waiting for the lock ${path}`);
		this.path = path;
		this.name = "LockTimeoutError";
	}
};
/** An update was refused because the document does not parse. */
var StoreCorruptError = class extends Error {
	parseError;
	savedAs;
	constructor(parseError, savedAs) {
		super(`refusing to rewrite a document that does not parse: ${parseError.message}`);
		this.parseError = parseError;
		this.savedAs = savedAs;
		this.name = "StoreCorruptError";
	}
};
/**
* Run `fn` holding the knowledge base's `.lock` (§13): created with `wx`, one
* older than `lockStaleMs` is taken over, and waiting gives up after
* `lockTimeoutMs` with a LockTimeoutError. The store and state.json take the
* same lock, so one process never writes either while another is mid-write.
*
* @param lock - the `.lock` path; its directory is created first.
*/
async function withFileLock(lock, o, fs, clock, fn) {
	async function removeIfUnchanged(held) {
		if (await fs.readFile(lock) === held) await fs.remove(lock);
	}
	await fs.mkdir(dirname(lock));
	const token = `${process.pid}-${randomBytes(6).toString("hex")}`;
	const deadline = clock.now().getTime() + o.lockTimeoutMs;
	for (;;) {
		if (await fs.createExclusive(lock, token)) break;
		const held = await fs.readFile(lock);
		const mtime = await fs.mtimeMs(lock);
		const now = clock.now().getTime();
		if (mtime !== void 0 && now - mtime > o.lockStaleMs) {
			await removeIfUnchanged(held);
			continue;
		}
		if (now >= deadline) throw new LockTimeoutError(lock);
		await clock.sleep(o.lockRetryMs * (.5 + clock.random()));
	}
	try {
		return await fn();
	} finally {
		if (await fs.readFile(lock) === token) await fs.remove(lock);
	}
}
/** Write `data` to a temp file beside `path`, then rename it over `path`. */
async function writeFileAtomic(fs, path, data) {
	const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	await fs.writeFile(temp, data);
	try {
		await fs.rename(temp, path);
	} catch (error) {
		await fs.remove(temp);
		throw error;
	}
}
const CORRUPT_COPY$1 = /^ANTIBODIES\.corrupt-.*\.md$/;
/**
* Bind a store to a knowledge base directory.
*
* Every write takes `.lock` (created with `wx`; one older than `lockStaleMs`
* is taken over), reads the current files, and writes `ANTIBODIES.md` to a temp
* file that is then renamed over the original. A document that does not parse
* is saved aside as `ANTIBODIES.corrupt-<ts>.md` once, after which new entries are
* only appended to it and updates are refused - it is never rewritten (§13).
*
* Archiving appends the oldest blocks to `ANTIBODIES.archive.md` before the
* shortened document replaces the old one, so a crash in between duplicates an
* entry across the two files rather than losing it.
*
* @param files - paths from resolveKbDir().
* @param options - settings; anything missing takes its default.
* @param fs - filesystem; defaults to the real one.
* @param clock - time; defaults to the real one.
*/
function createStore(files, options = {}, fs = nodeStoreFs(), clock = systemClock()) {
	const o = {
		...DEFAULT_STORE_OPTIONS,
		...options
	};
	const dir = dirname(files.errors);
	const clean = (text) => redact(text.replace(/\r/g, ""), o).trim();
	const withLock = (fn) => withFileLock(files.lock, o, fs, clock, fn);
	const writeAtomic = (path, data) => writeFileAtomic(fs, path, data);
	async function saveAside(text) {
		for (const name of await fs.list(dir)) {
			if (!CORRUPT_COPY$1.test(name)) continue;
			const copy = await fs.readFile(join(dir, name));
			if (copy !== void 0 && copy !== "" && text.startsWith(copy)) return;
		}
		const name = corruptFileName(clock.now());
		await fs.writeFile(join(dir, name), text);
		return name;
	}
	function build(id, input) {
		const now = clock.now();
		const meta = { sig: input.signature };
		for (const [key, value] of Object.entries(input.meta ?? {})) meta[key] = clean(value);
		meta.first ??= formatFirst(now);
		return {
			id,
			title: clean(input.title).replace(/\s+/g, " "),
			meta,
			fingerprint: input.signature,
			category: clean(input.category),
			firstSeen: formatSeen(now),
			lastSeen: formatSeen(now),
			hits: 1,
			trigger: clean(input.trigger ?? ""),
			raw: redactSample((input.raw ?? "").replace(/\r/g, ""), o).replace(/^\n+|\n+$/g, ""),
			fix: clean(input.fix ?? ""),
			status: input.status ?? "open",
			notes: clean(input.notes ?? "")
		};
	}
	/** The current document, for a rewrite; one that does not parse is refused. */
	async function readForRewrite() {
		const text = await fs.readFile(files.errors) ?? "";
		try {
			return parseDocument(text, o.idPrefix);
		} catch (error) {
			if (!(error instanceof ParseError)) throw error;
			throw new StoreCorruptError(error, await saveAside(text));
		}
	}
	/** Re-render one block in its own label set, keeping its trailing blank lines. */
	function rewrite(block, entry) {
		const trailing = /\n*$/.exec(block.source)[0];
		const labels = detectLabels(block.source) ?? o.labels;
		block.entry = entry;
		block.source = renderEntry(entry, labels).replace(/\n$/, trailing.length > 0 ? trailing : "\n");
	}
	return {
		async read() {
			return parseDocument(await fs.readFile(files.errors) ?? "", o.idPrefix);
		},
		append(input) {
			return withLock(async () => {
				const text = await fs.readFile(files.errors) ?? "";
				const archiveText = await fs.readFile(files.archive) ?? "";
				const id = formatId(nextIdNumber([text, archiveText], o.idPrefix), o.idPrefix, o.idWidth);
				const block = renderEntry(build(id, input), o.labels);
				try {
					parseDocument(text, o.idPrefix);
				} catch (error) {
					if (!(error instanceof ParseError)) throw error;
					const savedAs = await saveAside(text);
					await fs.appendFile(files.errors, separatorAfter(text) + block);
					return {
						id,
						archived: [],
						corrupt: true,
						savedAs
					};
				}
				const base = text === "" ? DOCUMENT_HEADER : text;
				const next = parseDocument(base + separatorAfter(base) + block, o.idPrefix);
				const excess = next.blocks.length - o.maxEntries;
				const moved = excess > 0 ? next.blocks.splice(0, excess) : [];
				if (moved.length > 0) {
					const lead = (archiveText === "" ? ARCHIVE_HEADER : "") + separatorAfter(archiveText || "# ANTIBODIES archive\n");
					const body = moved.map((b) => b.source).join("");
					await fs.appendFile(files.archive, lead + body.replace(/\n*$/, "\n"));
				}
				await writeAtomic(files.errors, renderDocument(next));
				return {
					id,
					archived: moved.map((b) => b.entry.id),
					corrupt: false
				};
			});
		},
		update(id, patch) {
			return withLock(async () => {
				const document = await readForRewrite();
				const block = document.blocks.find((b) => b.entry.id === id);
				if (block === void 0) return void 0;
				const entry = { ...block.entry };
				if (patch.fix !== void 0) entry.fix = clean(patch.fix);
				if (patch.notes !== void 0) entry.notes = clean(patch.notes);
				if (patch.trigger !== void 0) entry.trigger = clean(patch.trigger);
				if (patch.lastSeen !== void 0) entry.lastSeen = clean(patch.lastSeen);
				if (patch.status !== void 0) entry.status = patch.status;
				if (patch.hits !== void 0) entry.hits = patch.hits;
				rewrite(block, entry);
				await writeAtomic(files.errors, renderDocument(document));
				return entry;
			});
		},
		archive(id, reason) {
			return withLock(async () => {
				const document = await readForRewrite();
				const index = document.blocks.findIndex((b) => b.entry.id === id);
				if (index === -1) return void 0;
				const block = document.blocks[index];
				const why = clean(reason ?? "").replace(/\s+/g, " ");
				const line = `Archived ${formatSeen(clock.now())}${why === "" ? "" : `: ${why}`}`;
				const notes = block.entry.notes === "" ? line : `${block.entry.notes}\n${line}`;
				const entry = {
					...block.entry,
					notes
				};
				rewrite(block, entry);
				const archiveText = await fs.readFile(files.archive) ?? "";
				const lead = (archiveText === "" ? ARCHIVE_HEADER : "") + separatorAfter(archiveText || "# ANTIBODIES archive\n");
				await fs.appendFile(files.archive, lead + block.source.replace(/\n*$/, "\n"));
				document.blocks.splice(index, 1);
				await writeAtomic(files.errors, renderDocument(document));
				return entry;
			});
		}
	};
}
const errorCode = (error) => error.code;
/**
* The real filesystem. Every "missing" case (ENOENT) is a value, not an error;
* anything else - a directory where a file should be, a permission denial -
* propagates.
*/
function nodeStoreFs() {
	return {
		async readFile(path) {
			try {
				return await fsp.readFile(path, "utf8");
			} catch (error) {
				if (errorCode(error) === "ENOENT") return void 0;
				throw error;
			}
		},
		writeFile: (path, data) => fsp.writeFile(path, data, "utf8"),
		appendFile: (path, data) => fsp.appendFile(path, data, "utf8"),
		rename: (from, to) => fsp.rename(from, to),
		async createExclusive(path, data) {
			try {
				await fsp.writeFile(path, data, {
					encoding: "utf8",
					flag: "wx"
				});
				return true;
			} catch (error) {
				if (errorCode(error) === "EEXIST") return false;
				throw error;
			}
		},
		async mtimeMs(path) {
			try {
				return (await fsp.stat(path)).mtimeMs;
			} catch (error) {
				if (errorCode(error) === "ENOENT") return void 0;
				throw error;
			}
		},
		remove: (path) => fsp.rm(path, { force: true }),
		async list(dir) {
			try {
				return await fsp.readdir(dir);
			} catch (error) {
				if (errorCode(error) === "ENOENT") return [];
				throw error;
			}
		},
		mkdir: async (dir) => {
			await fsp.mkdir(dir, { recursive: true });
		}
	};
}
/** The real clock. */
function systemClock() {
	return {
		now: () => /* @__PURE__ */ new Date(),
		sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
		random: Math.random
	};
}
/** How long a claim lasts unless its holder renews or releases it. */
const CLAIM_TTL_MS = 600 * 1e3;
/** An empty state: nobody is working on anything. */
function emptyClaims() {
	return {
		version: 1,
		claims: {}
	};
}
function isClaim(value, id) {
	if (typeof value !== "object" || value === null) return false;
	const c = value;
	return c.id === id && typeof c.agent === "string" && typeof c.session === "string" && typeof c.since === "string" && typeof c.expires === "string" && !Number.isNaN(Date.parse(c.expires));
}
/**
* Parse claims.json. A record of the wrong shape is dropped on its own.
*
* @param text - the file's contents.
* @returns the state, or undefined when the file is not version 1 JSON.
*/
function parseClaims(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof value !== "object" || value === null) return void 0;
	const raw = value;
	if (raw.version !== 1) return void 0;
	const state = emptyClaims();
	if (typeof raw.claims === "object" && raw.claims !== null) {
		for (const [id, claim] of Object.entries(raw.claims)) if (isClaim(claim, id)) state.claims[id] = claim;
	}
	return state;
}
/** claims.json's text for a state. */
function renderClaims(state) {
	return `${JSON.stringify(state, null, 2)}\n`;
}
/**
* The live claim on an entry, if there is one.
*
* @param state - the claims.
* @param id - the entry.
* @param now - the current time.
*/
function activeClaim(state, id, now) {
	const claim = state.claims[id];
	return claim !== void 0 && Date.parse(claim.expires) > now.getTime() ? claim : void 0;
}
/**
* Drop every claim whose time has run out.
*
* @returns the IDs that were released.
*/
function pruneExpired(state, now) {
	const released = [];
	for (const id of Object.keys(state.claims)) if (activeClaim(state, id, now) === void 0) {
		delete state.claims[id];
		released.push(id);
	}
	return released;
}
/**
* Ask to work on an entry. The asker gets the claim when nobody else holds a
* live one; asking again from the holder's own session renews it, keeping
* when it began.
*
* @param state - the claims; changed in place.
* @param request - who asks for which entry.
* @param now - the current time.
* @param ttlMs - how long the claim lasts.
*/
function claim(state, request, now, ttlMs = CLAIM_TTL_MS) {
	const held = activeClaim(state, request.id, now);
	if (held !== void 0 && held.session !== request.session) return {
		granted: false,
		holder: held
	};
	const granted = {
		id: request.id,
		agent: request.agent,
		session: request.session,
		since: held?.since ?? now.toISOString(),
		expires: new Date(now.getTime() + ttlMs).toISOString()
	};
	state.claims[request.id] = granted;
	return {
		granted: true,
		claim: granted
	};
}
/**
* End the claim on an entry: when it is held by `session`, or by anyone when no
* session is given (the fix was recorded, whoever held it).
*
* @returns whether a claim was removed.
*/
function release(state, id, session) {
	const held = state.claims[id];
	if (held === void 0 || session !== void 0 && held.session !== session) return false;
	delete state.claims[id];
	return true;
}
/**
* End every claim a session holds, when that session ends.
*
* @returns the IDs that were released.
*/
function releaseSession(state, session) {
	const released = Object.values(state.claims).filter((c) => c.session === session).map((c) => c.id);
	for (const id of released) delete state.claims[id];
	return released;
}
/**
* Bind claims.json to a memory directory. Every change takes the store's lock,
* drops expired claims, and replaces the file atomically; an unreadable file
* is treated as empty and replaced.
*
* @param files - paths from filesIn().
* @param options - lock settings and the claim time to live.
* @param fs - filesystem; defaults to the real one.
* @param clock - time; defaults to the real one.
*/
function createClaimsFile(files, options = {}, fs = nodeStoreFs(), clock = systemClock()) {
	const o = {
		...DEFAULT_STORE_OPTIONS,
		ttlMs: CLAIM_TTL_MS,
		...options
	};
	async function load() {
		const text = await fs.readFile(files.claims);
		return (text === void 0 ? void 0 : parseClaims(text)) ?? emptyClaims();
	}
	async function update(mutate) {
		return withFileLock(files.lock, o, fs, clock, async () => {
			const state = await load();
			const now = clock.now();
			pruneExpired(state, now);
			const result = mutate(state, now);
			await writeFileAtomic(fs, files.claims, renderClaims(state));
			return result;
		});
	}
	return {
		read: load,
		claim: (request) => update((state, now) => claim(state, request, now, o.ttlMs)),
		release: (id, session) => update((state) => release(state, id, session)),
		releaseSession: (session) => update((state) => releaseSession(state, session))
	};
}
const bytes = (text) => Buffer.byteLength(text, "utf8");
/**
* One event as a line of events.jsonl: redacted, clipped to fit
* {@link EVENT_MAX_BYTES}, and ending in a newline.
*
* @param event - the event.
* @param now - the time to stamp when the event has none.
* @returns the line.
*/
function encodeEvent(event, now = /* @__PURE__ */ new Date()) {
	const base = {
		v: 1,
		t: event.t ?? now.toISOString(),
		kind: event.kind,
		agent: clip(event.agent, 200),
		session: clip(event.session, 200)
	};
	if (event.id !== void 0) base.id = clip(event.id, 200);
	if (event.tokens !== void 0) base.tokens = event.tokens;
	const line = (text) => `${JSON.stringify(text === void 0 ? base : {
		...base,
		text
	})}\n`;
	if (event.text === void 0) return line(void 0);
	const text = redact(event.text);
	if (bytes(line(text)) <= 4096) return line(text);
	let low = 0;
	let high = Array.from(text).length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (bytes(line(clip(text, mid))) <= 4096) low = mid;
		else high = mid - 1;
	}
	return line(clip(text, low));
}
/**
* Append one event to the log, creating its directory when needed.
*
* @param file - the events.jsonl path.
* @param event - the event.
* @param now - the time to stamp when the event has none.
*/
async function appendEvent(file, event, now = /* @__PURE__ */ new Date()) {
	await mkdir(dirname(file), { recursive: true });
	await appendFile(file, encodeEvent(event, now), { flag: "a" });
}
/**
* The one-shot prompt for an entry that looks resolved and has no fix. It
* names `antibody_record` (T15), the one tool that writes a fix.
*
* @param id - the entry.
*/
function askFixText(id) {
	return `${NOTICE_PREFIX} ${id} looks resolved. Record the fix with antibody_record in one sentence so it can be reused.`;
}
const toolKey = (toolName) => `tool:${toolName}`;
const commandKey = (command) => `command:${command.replace(/\s+/g, " ").trim()}`;
/**
* Classify one tool call for resolution. A tool failure is keyed by the tool,
* a non-zero exit by its command (by the tool when the call names none), and
* anything else is a success for both its tool and its command.
*
* @param call - the tool name, command and result.
*/
function callOutcome(call) {
	const command = call.command === void 0 || call.command.trim() === "" ? void 0 : call.command;
	if (call.isError) return {
		ok: false,
		key: toolKey(call.toolName)
	};
	const code = exitCode(call.text);
	if (code !== void 0 && code !== 0) return {
		ok: false,
		key: command === void 0 ? toolKey(call.toolName) : commandKey(command)
	};
	return {
		ok: true,
		keys: [toolKey(call.toolName), ...command === void 0 ? [] : [commandKey(command)]]
	};
}
const turnNumber = (value) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : void 0;
/**
* One session's resolution state: the watched entries, the turn count, and
* the entries already asked for a fix. Call beginTurn() at every new turn.
* Every method that takes a turn defaults to the current one; the plugin
* passes the turn an event happened in, since it acts on it a little later.
*/
var ResolutionTracker = class ResolutionTracker {
	current = 0;
	watches = /* @__PURE__ */ new Map();
	asked = /* @__PURE__ */ new Set();
	/**
	* A tracker carrying on from saved state. Malformed watches are dropped and
	* a malformed turn reads as 0; at most MAX_WATCHES of the newest watches are
	* kept.
	*
	* @param snapshot - what snapshot() returned, or undefined for a new session.
	*/
	static restore(snapshot) {
		const tracker = new ResolutionTracker();
		tracker.current = turnNumber(snapshot?.turn) ?? 0;
		const watches = Array.isArray(snapshot?.watches) ? snapshot.watches : [];
		for (const w of watches.slice(-32)) {
			const turn = turnNumber(w?.turn);
			if (typeof w?.id === "string" && typeof w.key === "string" && turn !== void 0) tracker.watches.set(w.id, {
				key: w.key,
				turn
			});
		}
		const asked = Array.isArray(snapshot?.asked) ? snapshot.asked : [];
		for (const id of asked) if (typeof id === "string") tracker.asked.add(id);
		return tracker;
	}
	/** The state, for restore() in the next hook process. */
	snapshot() {
		return {
			turn: this.current,
			watches: [...this.watches].map(([id, w]) => ({
				id,
				key: w.key,
				turn: w.turn
			})),
			asked: [...this.asked]
		};
	}
	/** The turns begun so far; 0 before the first. */
	get turn() {
		return this.current;
	}
	/** A new turn: watches older than the window lapse. */
	beginTurn() {
		this.current++;
		for (const [id, watch] of this.watches) if (!this.open(watch.turn)) this.watches.delete(id);
	}
	/** Whether something from `turn` is still inside the window. */
	open(turn) {
		return this.current - turn <= 1;
	}
	/**
	* A call failing under `key` was recorded against `id`: watch it, from
	* `turn`. A watch already on `id` is replaced - a recurrence.
	*/
	occurred(id, key, turn = this.current) {
		this.watches.delete(id);
		this.watches.set(id, {
			key,
			turn
		});
		if (this.watches.size > 32) this.watches.delete(this.watches.keys().next().value);
	}
	/**
	* A call succeeded under `keys` in `turn`.
	*
	* @returns the entries it resolves, in the order they were recorded; each
	*   stops being watched.
	*/
	succeeded(keys, turn = this.current) {
		const resolved = [];
		for (const [id, watch] of this.watches) {
			if (!keys.includes(watch.key)) continue;
			const after = turn - watch.turn;
			if (after < 0 || after > 1) continue;
			this.watches.delete(id);
			resolved.push(id);
		}
		return resolved;
	}
	/** The entries being watched, for tests and `antibody_stats`. */
	watched() {
		return [...this.watches.keys()];
	}
	/**
	* Take the one fix prompt `id` gets in this session.
	*
	* @returns true the first time for `id`, false ever after.
	*/
	ask(id) {
		if (this.asked.has(id)) return false;
		this.asked.add(id);
		return true;
	}
};
//#endregion
//#region src/trust.ts
/**
* A TrustStore in memory. It saves a deep copy, so later changes to the saved
* object do not leak in.
*
* @param initial - the state to start from.
*/
function memoryTrustStore(initial = { entries: {} }) {
	let state = structuredClone(initial);
	return {
		load: () => structuredClone(state),
		save: (next) => {
			state = structuredClone(next);
		}
	};
}
/**
* Hash a fix text, so an edited fix starts trusted again.
*
* @param fix - the entry's fix field.
*/
function fixSig(fix) {
	return createHash("sha256").update(oneLine(fix)).digest("hex").slice(0, 12);
}
/**
* The trust level a record gives.
*
* @param record - the record, if there is one.
*/
function trustLevel(record) {
	if (record === void 0) return "trusted";
	if (record.recurredAfterInject >= 2 && record.succeeded === 0) return "suppressed";
	return record.recurredAfterInject >= 1 ? "doubted" : "trusted";
}
/**
* Per-machine fix trust. Call beginTurn() at each turn, seen() whenever a
* captured error matches an entry, and injected() when a notice carried that
* entry's fix.
*/
var FixTrust = class {
	store;
	state;
	injectedThisTurn = /* @__PURE__ */ new Set();
	/** Settles once the store's asynchronous state, if any, has joined in. */
	ready;
	constructor(store = memoryTrustStore()) {
		this.store = store;
		this.state = store.load();
		this.ready = (store.loaded ?? Promise.resolve(void 0)).then((saved) => {
			for (const [id, record] of Object.entries(saved?.entries ?? {})) this.state.entries[id] ??= record;
		});
	}
	/** The record for an entry, or undefined when none applies to this fix. */
	record(id, fix) {
		const record = this.state.entries[id];
		return record?.fixSig === fixSig(fix) ? record : void 0;
	}
	/** The trust level of an entry's current fix. */
	level(id, fix) {
		return trustLevel(this.record(id, fix));
	}
	/**
	* A new turn in `scope`: recurrence is counted within one turn.
	*
	* @param scope - the session whose turn began; the default scope serves a
	*   caller with one session.
	*/
	beginTurn(scope = "") {
		const prefix = `${scope}\0`;
		for (const key of this.injectedThisTurn) if (key.startsWith(prefix)) this.injectedThisTurn.delete(key);
	}
	/**
	* A captured error matched `id`. If its fix was injected earlier in this
	* turn of the same scope, the fix did not hold: count a recurrence.
	*/
	seen(id, fix, scope = "") {
		const key = `${scope}\0${id}`;
		const record = this.record(id, fix);
		if (record === void 0 || !this.injectedThisTurn.has(key)) return;
		record.recurredAfterInject++;
		this.injectedThisTurn.delete(key);
		this.store.save(this.state);
	}
	/** A notice carried `id`'s fix, in `scope`'s current turn. */
	injected(id, fix, scope = "") {
		const record = this.record(id, fix) ?? {
			injected: 0,
			recurredAfterInject: 0,
			succeeded: 0,
			fixSig: fixSig(fix)
		};
		record.injected++;
		this.state.entries[id] = record;
		this.injectedThisTurn.add(`${scope}\0${id}`);
		this.store.save(this.state);
	}
	/** The fix for `id` was confirmed to work (resolution detection, T14). */
	succeeded(id, fix) {
		const record = this.record(id, fix);
		if (record === void 0) return;
		record.succeeded++;
		this.store.save(this.state);
	}
	/**
	* The entries whose fix was injected in `scope`'s current turn, so a hook
	* process can save them for the next call in the same turn.
	*
	* @param scope - the session.
	*/
	injectedInTurn(scope = "") {
		const prefix = `${scope}\0`;
		return [...this.injectedThisTurn].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
	}
	/**
	* Carry on `scope`'s current turn from what injectedInTurn() saved.
	*
	* @param ids - entries injected earlier in the turn.
	* @param scope - the session.
	*/
	restoreTurn(ids, scope = "") {
		for (const id of ids) if (typeof id === "string") this.injectedThisTurn.add(`${scope}\0${id}`);
	}
	/** A copy of the whole state, for persistence or `antibody_stats`. */
	snapshot() {
		return structuredClone(this.state);
	}
};
//#endregion
//#region src/injector.ts
/**
* Decides, per session, which captured errors become notices: the `inject`
* setting, non-injectable entries, fix trust and the caps, in that order.
*/
var Injector = class {
	mode;
	caps;
	trust;
	scope;
	constructor(deps = {}) {
		this.mode = deps.mode ?? "hit-only";
		this.caps = deps.caps ?? new CapTracker();
		this.trust = deps.trust ?? new FixTrust();
		this.scope = deps.scope ?? "";
	}
	beginTurn() {
		this.caps.beginTurn();
		this.trust.beginTurn(this.scope);
	}
	beginStep() {
		this.caps.beginStep();
	}
	/**
	* Tell fix trust that a captured error matched `hit`, without offering a
	* notice yet. For a notice that rides a later step (T13: a dead turn's
	* error): the capture is observed when it happens, the notice offered when
	* the next step opens, with `observed` set.
	*/
	observe(hit) {
		this.trust.seen(hit.id, hit.entry.fix, this.scope);
	}
	/**
	* Offer a captured error.
	*
	* @param event - the hit or the miss.
	* @param observed - observe() already saw this hit; do not count it again.
	* @returns the notice to inject, or undefined to stay silent.
	*/
	offer(event, observed = false) {
		if (this.mode === "off") return void 0;
		if (event.kind === "miss") {
			if (this.mode !== "always" || !this.caps.tryEmit(event.id)) return void 0;
			return notice(event.id, noticeText(event));
		}
		const { id, entry, injectable } = event.hit;
		if (!observed) this.observe(event.hit);
		if (!injectable) return void 0;
		const carriesFix = oneLine(entry.fix) !== "";
		const level = carriesFix ? this.trust.level(id, entry.fix) : "trusted";
		if (level === "suppressed") return void 0;
		if (!this.caps.tryEmit(id, entry.status === "fixed")) return void 0;
		if (carriesFix) this.trust.injected(id, entry.fix, this.scope);
		return notice(id, noticeText(event, level));
	}
	/**
	* Offer the one-shot fix prompt for `id`, which looks resolved (T14). It
	* spends the step and turn budgets like any notice. Its per-ID budget is
	* its own, not the entry's: the prompt is a different message, asked once
	* by construction, and an entry whose "no fix recorded yet" notices used up
	* its two would otherwise never be asked.
	*
	* @returns the notice, or undefined when `inject` is off or a cap refuses.
	*/
	ask(id) {
		if (this.mode === "off" || !this.caps.tryEmit(`${id}\0ask`)) return void 0;
		return notice(id, {
			kind: "ask-fix",
			text: hardClip(askFixText(id))
		});
	}
};
function notice(id, { kind, text }) {
	return {
		id,
		kind,
		text
	};
}
const DEFAULT_MATCH_OPTIONS = { fuzzyThreshold: .72 };
const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;
const TOKEN = new RegExp(String.raw`<[a-z]+>|[${CJK}]+|(?:(?![${CJK}])[\p{L}\p{N}_])+`, "gu");
const CJK_RUN = new RegExp(String.raw`^[${CJK}]`, "u");
/**
* Split a normalized message into its token set.
*
* Words and placeholders are tokens as they stand. A CJK run becomes its
* character bigrams (`拒绝访问` → `拒绝`, `绝访`, `访问`), and a single CJK
* character stays a unigram. Punctuation and whitespace only separate tokens.
*
* @param text - normalize() output; other text works but is not lowercased.
* @returns the distinct tokens.
*/
function tokenize(text) {
	const tokens = /* @__PURE__ */ new Set();
	for (const [run] of text.matchAll(TOKEN)) {
		if (!CJK_RUN.test(run)) {
			tokens.add(run);
			continue;
		}
		const chars = Array.from(run);
		if (chars.length === 1) tokens.add(run);
		for (let i = 0; i + 1 < chars.length; i++) tokens.add(`${chars[i]}${chars[i + 1]}`);
	}
	return tokens;
}
/**
* Jaccard similarity: shared tokens over all tokens.
*
* @returns a number from 0 to 1; 0 when both sets are empty, since two empty
*   messages give nothing to go on.
*/
function jaccard(a, b) {
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	let shared = 0;
	for (const token of small) if (large.has(token)) shared++;
	const union = a.size + b.size - shared;
	return union === 0 ? 0 : shared / union;
}
/**
* The message an entry is compared by: its raw sample, or its title when the
* sample is empty (a hand-written entry may have none).
*/
function entryMessage(entry) {
	return entry.raw.trim() === "" ? entry.title : entry.raw;
}
/**
* Prepare entries for matching. The category is the `cat=` machine field, or
* the part of the display category before ` / ` when an entry lacks one.
*
* @param entries - parsed entries, e.g. from store.read().
* @returns one indexed entry per input, in the same order.
*/
function indexEntries(entries) {
	return entries.map((entry) => {
		const message = normalize(entryMessage(entry));
		const misjudged = entry.meta.misjudged?.toLowerCase() === "true";
		return {
			entry,
			sig: entry.meta.sig ?? entry.fingerprint,
			category: entry.meta.cat ?? entry.category.split("/")[0].trim(),
			code: entry.meta.code,
			proj: entry.meta.proj,
			tokens: tokenize(message),
			length: Array.from(message).length,
			excluded: entry.status === "wontfix" ? "wontfix" : misjudged ? "misjudged" : void 0
		};
	});
}
const idNumber = (id) => Number(/\d+$/.exec(id)?.[0] ?? Infinity);
/**
* Pick the best candidate: highest similarity, then the error's own project,
* then the lowest ID (the oldest entry, which is the one people have edited).
*/
function best(candidates, proj) {
	const sameProj = (c) => proj !== void 0 && c.indexed.proj === proj ? 1 : 0;
	return candidates.reduce((winner, c) => {
		if (winner === void 0) return c;
		if (c.similarity !== winner.similarity) return c.similarity > winner.similarity ? c : winner;
		if (sameProj(c) !== sameProj(winner)) return sameProj(c) > sameProj(winner) ? c : winner;
		return idNumber(c.indexed.entry.id) < idNumber(winner.indexed.entry.id) ? c : winner;
	}, void 0);
}
function hit(winner, via) {
	const { entry, excluded } = winner.indexed;
	return {
		matched: true,
		id: entry.id,
		entry,
		via,
		approximate: via !== "exact",
		similarity: winner.similarity,
		injectable: excluded === void 0,
		...excluded === void 0 ? {} : { excluded }
	};
}
/**
* Match one captured error against the knowledge base (§5.3).
*
* @param error - the captured error.
* @param index - from indexEntries().
* @param options - settings; anything missing takes its default.
* @returns the best hit or near hit, or a miss.
*/
function match(error, index, options = {}) {
	const o = {
		...DEFAULT_MATCH_OPTIONS,
		...options
	};
	const normalized = normalize(error.message);
	const tokens = tokenize(normalized);
	const score = (indexed) => ({
		indexed,
		similarity: jaccard(tokens, indexed.tokens)
	});
	const sig = signature(error.category, error.message);
	const exact = best(index.filter((indexed) => indexed.sig === sig).map((indexed) => ({
		indexed,
		similarity: 1
	})), error.proj);
	if (exact !== void 0) return hit(exact, "exact");
	const sameCategory = index.filter((i) => i.category === error.category);
	const fuzzy = best(sameCategory.map(score).filter((c) => c.similarity >= o.fuzzyThreshold), error.proj);
	if (fuzzy !== void 0) return hit(fuzzy, "fuzzy");
	const short = Array.from(normalized).length < 40;
	const code = error.code;
	const sameCode = best(sameCategory.filter((i) => short && code !== void 0 && code !== "" && i.code === code && i.length < 40).map(score), error.proj);
	if (sameCode !== void 0) return hit(sameCode, "code");
	return { matched: false };
}
/** The directory, inside the memory directory, that holds the session files. */
const SESSIONS_DIR_NAME = "sessions";
/** A session with nothing remembered yet. */
function freshSession(session) {
	return {
		version: 1,
		session,
		caps: {
			step: 0,
			turn: 0,
			perId: {}
		},
		resolution: {
			turn: 0,
			watches: [],
			asked: []
		},
		trustTurn: [],
		holding: []
	};
}
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
/**
* The file name a session's state is kept under. A session id that is not a
* plain token is hashed, so no id can name a path outside the directory.
*
* @param session - the harness's session id.
*/
function sessionFileName(session) {
	return `${SAFE_ID.test(session) ? session : createHash("sha256").update(session).digest("hex").slice(0, 32)}.json`;
}
const strings = (value) => Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
/**
* Parse a session file. Snapshots are passed through for their own restore()
* to validate; the lists are filtered to strings.
*
* @param text - the file's contents.
* @param session - the session it should belong to.
* @returns the state, or undefined when the file is not this session's.
*/
function parseSession(text, session) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof value !== "object" || value === null) return void 0;
	const raw = value;
	if (raw.version !== 1 || raw.session !== session) return void 0;
	const fresh = freshSession(session);
	const record = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
	return {
		...fresh,
		caps: record(raw.caps) ? raw.caps : fresh.caps,
		resolution: record(raw.resolution) ? raw.resolution : fresh.resolution,
		trustTurn: strings(raw.trustTurn),
		holding: strings(raw.holding)
	};
}
/**
* Bind one session's state file inside a memory directory.
*
* @param memory - the memory directory, from memoryDir().
* @param session - the harness's session id.
* @param options - lock settings; anything missing takes the store's default.
* @param fs - filesystem; defaults to the real one.
* @param clock - time; defaults to the real one.
*/
function createSessionFile(memory, session, options = {}, fs = nodeStoreFs(), clock = systemClock()) {
	const o = {
		...DEFAULT_STORE_OPTIONS,
		...options
	};
	const file = join(memory, SESSIONS_DIR_NAME, sessionFileName(session));
	const lock = `${file}.lock`;
	async function read() {
		const text = await fs.readFile(file);
		return (text === void 0 ? void 0 : parseSession(text, session)) ?? freshSession(session);
	}
	return {
		read,
		update: (mutate) => withFileLock(lock, o, fs, clock, async () => {
			const state = await read();
			const result = await mutate(state);
			await writeFileAtomic(fs, file, `${JSON.stringify(state)}\n`);
			return result;
		}),
		remove: () => fs.remove(file)
	};
}
/** A state with nothing in it. */
function emptyState() {
	return {
		version: 1,
		entries: {},
		trust: {}
	};
}
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value) => typeof value === "number" && Number.isInteger(value) && value >= 0;
function isHitCounter(value) {
	return isObject(value) && isCount(value.hits) && typeof value.lastSeen === "string";
}
function isTrustRecord(value) {
	return isObject(value) && isCount(value.injected) && isCount(value.recurredAfterInject) && isCount(value.succeeded) && typeof value.fixSig === "string";
}
/**
* The records of a map that pass `valid`, copied field by field. A missing
* map is empty; anything else that is not an object makes the file invalid.
*/
function records(value, valid, pick) {
	if (value === void 0) return {};
	if (!isObject(value)) return void 0;
	return Object.fromEntries(Object.entries(value).filter((pair) => valid(pair[1])).map(([id, record]) => [id, pick(record)]));
}
/**
* Parse `state.json`.
*
* @param text - the file's contents.
* @returns the state, or undefined when the text is not JSON, not an object,
*   not version 1, or has an `entries` or `trust` that is not an object.
*/
function parseState(text) {
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		return;
	}
	if (!isObject(data) || data.version !== 1) return void 0;
	const entries = records(data.entries, isHitCounter, (r) => ({
		hits: r.hits,
		lastSeen: r.lastSeen
	}));
	const trust = records(data.trust, isTrustRecord, (r) => ({
		injected: r.injected,
		recurredAfterInject: r.recurredAfterInject,
		succeeded: r.succeeded,
		fixSig: r.fixSig
	}));
	if (entries === void 0 || trust === void 0) return void 0;
	return {
		version: 1,
		entries,
		trust
	};
}
/** Render a state as `state.json`: indented JSON and a final newline. */
function renderState(state) {
	return `${JSON.stringify(state, null, 2)}\n`;
}
/**
* The later of two last-seen times. Both are in the block's display form
* (`2026-09-14 09:12`, UTC), which sorts as text; an empty one loses.
*/
function laterSeen(a, b) {
	return b > a ? b : a;
}
/**
* An entry as every display shows it: the hits written in its block plus this
* machine's delta, and the later of the two last-seen times. Without a
* counter it is the entry itself.
*
* @param entry - the entry as parsed from ANTIBODIES.md: the baseline.
* @param counter - this machine's counters for it, if any.
*/
function effectiveEntry(entry, counter) {
	if (counter === void 0) return entry;
	return {
		...entry,
		hits: entry.hits + counter.hits,
		lastSeen: laterSeen(entry.lastSeen, counter.lastSeen)
	};
}
/**
* Count one more repeat of `id`, seen at `at`.
*
* @param state - changed in place.
* @returns the entry's counter after the change.
*/
function addHit(state, id, at) {
	const counter = state.entries[id] ?? {
		hits: 0,
		lastSeen: ""
	};
	const next = {
		hits: counter.hits + 1,
		lastSeen: laterSeen(counter.lastSeen, at)
	};
	state.entries[id] = next;
	return next;
}
/**
* Name for the copy of a `state.json` that could not be read, like
* corruptFileName() for ANTIBODIES.md.
*
* @param now - timestamp to embed.
* @returns a file name, never a path.
*/
function corruptStateFileName(now) {
	return `state.corrupt-${now.toISOString().replace(/[:.]/g, "-")}.json`;
}
const CORRUPT_COPY = /^state\.corrupt-.*\.json$/;
/**
* Bind `state.json` to a knowledge base directory.
*
* @param files - paths from resolveKbDir().
* @param options - the lock settings; anything missing takes the store's default.
* @param fs - filesystem; defaults to the real one.
* @param clock - time; defaults to the real one.
*/
function createStateFile(files, options = {}, fs = nodeStoreFs(), clock = systemClock()) {
	const o = {
		...DEFAULT_STORE_OPTIONS,
		...options
	};
	const dir = dirname(files.state);
	async function load() {
		const text = await fs.readFile(files.state);
		if (text === void 0) return {
			state: emptyState(),
			corrupt: false
		};
		const state = parseState(text);
		return state === void 0 ? {
			state: emptyState(),
			corrupt: true,
			text
		} : {
			state,
			corrupt: false
		};
	}
	/** Save a corrupt file aside, unless an identical copy is already there. */
	async function saveAside(text) {
		for (const name of await fs.list(dir)) if (CORRUPT_COPY.test(name) && await fs.readFile(join(dir, name)) === text) return void 0;
		const name = corruptStateFileName(clock.now());
		await fs.writeFile(join(dir, name), text);
		return name;
	}
	return {
		async read() {
			const { state, corrupt } = await load();
			return {
				state,
				corrupt
			};
		},
		update(mutate) {
			return withFileLock(files.lock, o, fs, clock, async () => {
				const { state, text } = await load();
				const savedAs = text === void 0 ? void 0 : await saveAside(text);
				mutate(state);
				await writeFileAtomic(fs, files.state, renderState(state));
				return savedAs === void 0 ? { state } : {
					state,
					savedAs
				};
			});
		}
	};
}
//#endregion
//#region src/fleet.ts
const DEFAULT_FLEET_OPTIONS = {
	inject: "hit-only",
	match: {},
	capture: {},
	lockTimeoutMs: 2e3,
	claimTtlMs: CLAIM_TTL_MS
};
/**
* Bind the fleet loop to one agent session.
*
* @param memory - the memory directory, from memoryDir().
* @param agent - the agent's display name.
* @param session - the harness's session id.
* @param options - settings; anything missing takes its default.
* @param deps - filesystem and clock; default to the real ones.
*/
function createFleet(memory, agent, session, options = {}, deps = {}) {
	const o = {
		...DEFAULT_FLEET_OPTIONS,
		...options
	};
	const fs = deps.fs ?? nodeStoreFs();
	const clock = deps.clock ?? systemClock();
	const files = filesIn(memory);
	const lock = { lockTimeoutMs: o.lockTimeoutMs };
	const store = createStore(files, lock, fs, clock);
	const state = createStateFile(files, lock, fs, clock);
	const sessionFile = createSessionFile(memory, session, lock, fs, clock);
	const claims = createClaimsFile(files, {
		...lock,
		ttlMs: o.claimTtlMs
	}, fs, clock);
	const fresh = (outcome) => outcome.granted && Date.parse(outcome.claim.expires) - Date.parse(outcome.claim.since) === o.claimTtlMs;
	const log = (event) => appendEvent(files.events, {
		...event,
		agent,
		session
	}, clock.now());
	async function readEntries(machine) {
		return (await store.read()).blocks.map((b) => effectiveEntry(b.entry, machine.entries[b.entry.id]));
	}
	function restore(s, trust) {
		const caps = CapTracker.restore(s.caps);
		const tracker = ResolutionTracker.restore(s.resolution);
		const fixTrust = new FixTrust(memoryTrustStore({ entries: trust }));
		fixTrust.restoreTurn(s.trustTurn, session);
		return {
			caps,
			tracker,
			trust: fixTrust,
			injector: new Injector({
				mode: o.inject,
				caps,
				trust: fixTrust,
				scope: session
			})
		};
	}
	async function persist(s, rt, before) {
		s.caps = rt.caps.snapshot();
		s.resolution = rt.tracker.snapshot();
		s.trustTurn = rt.trust.injectedInTurn(session);
		const after = rt.trust.snapshot().entries;
		const changed = Object.keys(after).filter((id) => JSON.stringify(after[id]) !== JSON.stringify(before[id]));
		if (changed.length > 0) await state.update((m) => {
			for (const id of changed) m.trust[id] = after[id];
		});
	}
	async function tell(notice, notices) {
		if (notice === void 0) return;
		notices.push(notice.text);
		await log({
			kind: "notice",
			id: notice.id,
			tokens: estimateTokens(notice.text),
			text: notice.text
		});
	}
	async function hold(s, rt, fingerprint, label, outcome, notices) {
		if (!s.holding.includes(fingerprint)) s.holding.push(fingerprint);
		await log({
			kind: "hold",
			id: label,
			text: `held by ${outcome.holder.agent}`
		});
		if (!rt.caps.tryEmit(`${fingerprint}\0hold`)) return;
		const elapsed = clock.now().getTime() - Date.parse(outcome.holder.since);
		const text = claimHintText(label, outcome.holder.agent, elapsed);
		notices.push(text);
		await log({
			kind: "notice",
			id: label,
			tokens: estimateTokens(text),
			text
		});
	}
	async function onHit(s, rt, found, record, notices) {
		const at = formatSeen(clock.now());
		await state.update((m) => void addHit(m, found.id, at));
		await log({
			kind: "hit",
			id: found.id,
			text: record.message
		});
		const entry = {
			...found.entry,
			hits: found.entry.hits + 1,
			lastSeen: laterSeen(found.entry.lastSeen, at)
		};
		if (oneLine(entry.fix) !== "") s.holding = s.holding.filter((f) => f !== entry.fingerprint);
		else if (found.injectable) {
			const outcome = await claims.claim({
				id: entry.fingerprint,
				agent,
				session
			});
			if (!outcome.granted) return hold(s, rt, entry.fingerprint, found.id, outcome, notices);
			if (fresh(outcome)) await log({
				kind: "claim",
				id: found.id
			});
		}
		await tell(rt.injector.offer({
			kind: "hit",
			hit: {
				...found,
				entry
			}
		}), notices);
	}
	async function onMiss(s, rt, record, notices) {
		const outcome = await claims.claim({
			id: record.signature,
			agent,
			session
		});
		if (!outcome.granted) {
			await hold(s, rt, record.signature, `new error ${record.signature}`, outcome, notices);
			return;
		}
		const { id } = await store.append({
			title: record.title,
			signature: record.signature,
			category: record.displayCategory,
			meta: {
				cat: record.category,
				...record.code === void 0 ? {} : { code: record.code }
			},
			raw: record.raw
		});
		await log({
			kind: "miss",
			id,
			text: record.message
		});
		await log({
			kind: "claim",
			id
		});
		await tell(rt.injector.offer({
			kind: "miss",
			id
		}), notices);
		return id;
	}
	async function deliver(s, rt, machine, notices) {
		if (s.holding.length === 0) return;
		const entries = await readEntries(machine);
		const live = await claims.read();
		const now = clock.now();
		const waiting = [];
		for (const fingerprint of s.holding) {
			const entry = entries.find((e) => e.fingerprint === fingerprint);
			if (entry === void 0 || oneLine(entry.fix) === "") {
				if (activeClaim(live, fingerprint, now) !== void 0) waiting.push(fingerprint);
				continue;
			}
			const hit = {
				matched: true,
				id: entry.id,
				entry,
				via: "exact",
				approximate: false,
				similarity: 1,
				injectable: entry.status !== "wontfix"
			};
			const notice = rt.injector.offer({
				kind: "hit",
				hit
			}, true);
			if (notice === void 0 && entry.status !== "wontfix") waiting.push(fingerprint);
			await tell(notice, notices);
		}
		s.holding = waiting;
	}
	return {
		async poll() {
			return sessionFile.update(async (s) => {
				if (s.holding.length === 0) return [];
				const machine = (await state.read()).state;
				const before = structuredClone(machine.trust);
				const rt = restore(s, machine.trust);
				rt.injector.beginStep();
				const notices = [];
				await deliver(s, rt, machine, notices);
				await persist(s, rt, before);
				return notices;
			});
		},
		async recordFix(id, fix) {
			if (oneLine(fix) === "") throw new RangeError("a fix cannot be blank");
			const entry = await store.update(id, {
				fix: fix.trim(),
				status: "fixed"
			});
			if (entry === void 0) return void 0;
			await log({
				kind: "fix",
				id,
				text: entry.fix
			});
			if (await claims.release(entry.fingerprint)) await log({
				kind: "release",
				id,
				text: "fix recorded"
			});
			return entry;
		},
		async beginTurn() {
			return sessionFile.update(async (s) => {
				const machine = (await state.read()).state;
				const before = structuredClone(machine.trust);
				const rt = restore(s, machine.trust);
				rt.injector.beginTurn();
				rt.tracker.beginTurn();
				const notices = [];
				await deliver(s, rt, machine, notices);
				await persist(s, rt, before);
				return notices;
			});
		},
		async endSession() {
			const released = await claims.releaseSession(session);
			for (const fingerprint of released) await log({
				kind: "release",
				id: fingerprint,
				text: "session ended"
			});
			await sessionFile.remove();
			return released;
		},
		async success(call) {
			const outcome = callOutcome(call);
			if (!outcome.ok) return [];
			return sessionFile.update(async (s) => {
				const machine = (await state.read()).state;
				const before = structuredClone(machine.trust);
				const rt = restore(s, machine.trust);
				rt.injector.beginStep();
				const notices = [];
				const resolved = rt.tracker.succeeded(outcome.keys);
				if (resolved.length > 0) {
					const entries = await readEntries(machine);
					for (const id of resolved) {
						const entry = entries.find((e) => e.id === id);
						if (entry === void 0) continue;
						await log({
							kind: "resolve",
							id
						});
						if (oneLine(entry.fix) !== "") rt.trust.succeeded(id, entry.fix);
						else if (rt.tracker.ask(id)) await tell(rt.injector.ask(id), notices);
					}
				}
				await deliver(s, rt, machine, notices);
				await persist(s, rt, before);
				return notices;
			});
		},
		async failure(capture, call) {
			const classified = classify(capture, new TransientCounter(), o.capture);
			if (classified === void 0 || classified.decision !== "record") return [];
			const { record } = classified;
			const outcome = callOutcome(call);
			return sessionFile.update(async (s) => {
				const machine = (await state.read()).state;
				const before = structuredClone(machine.trust);
				const rt = restore(s, machine.trust);
				rt.injector.beginStep();
				const notices = [];
				const found = match({
					category: record.category,
					code: record.code,
					message: record.message
				}, indexEntries(await readEntries(machine)), o.match);
				let id;
				if (found.matched) {
					id = found.id;
					await onHit(s, rt, found, record, notices);
				} else id = await onMiss(s, rt, record, notices);
				if (!outcome.ok && id !== void 0) rt.tracker.occurred(id, outcome.key);
				await deliver(s, rt, machine, notices);
				await persist(s, rt, before);
				return notices;
			});
		}
	};
}
//#endregion
//#region src/cli.ts
/** The version `antibody --version` prints. */
const VERSION = "0.0.0";
/**
* Route one hook call into the fleet loop.
*
* @param input - the parsed hook call.
* @param fleet - the session's fleet loop.
* @returns the notices for the agent.
*/
async function dispatch(input, fleet) {
	switch (input.event) {
		case "SessionStart": return fleet.poll();
		case "UserPromptSubmit": return fleet.beginTurn();
		case "SessionEnd":
			await fleet.endSession();
			return [];
		case "PostToolUse":
		case "PostToolUseFailure": {
			const call = toToolCall(input);
			const capture = toCapture(input);
			return capture === void 0 ? fleet.success(call) : fleet.failure(capture, call);
		}
	}
}
const TIMEOUT = Symbol("timeout");
/**
* `antibody hook <harness>`: handle one hook call. Always exits 0.
*
* @param harness - the harness whose hook called; only `claude-code` today.
* @param io - stdin, stdout, stderr and the environment.
* @param deps - git, the deadline and the fleet factory.
*/
async function runHook(harness, io, deps = {}) {
	const debug = io.env.ANTIBODY_DEBUG === "1";
	let timer;
	const work = async () => {
		if (harness !== "claude-code") throw new Error(`unknown harness: ${harness}`);
		const input = parseHookInput(await io.readStdin());
		if (input === void 0) return "";
		let memory;
		try {
			memory = memoryDir(input.cwd, deps.git, io.env);
		} catch {
			return "";
		}
		const agent = agentName(CLAUDE_CODE, worktreeRoot(input.cwd, deps.git), io.env);
		const fleet = (deps.fleet ?? ((m, a, s) => createFleet(m, a, s)))(memory, agent, input.sessionId);
		return hookResponse(input.event, await dispatch(input, fleet));
	};
	try {
		const deadline = new Promise((resolve) => {
			timer = setTimeout(() => resolve(TIMEOUT), deps.deadlineMs ?? 3e3);
			timer.unref?.();
		});
		const out = await Promise.race([work(), deadline]);
		if (out === TIMEOUT) {
			if (debug) io.stderr("antibody: hook ran past its deadline; said nothing\n");
		} else if (out !== "") io.stdout(out);
	} catch (error) {
		if (debug) io.stderr(`antibody: ${error instanceof Error ? error.message : String(error)}\n`);
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
	return 0;
}
const USAGE = `usage: antibody hook claude-code   handle one Claude Code hook call
       antibody --version
`;
/**
* The command line's entry point.
*
* @param argv - the arguments after the program name.
* @param io - stdin, stdout, stderr and the environment.
* @param deps - passed to the hook command.
* @returns the exit code.
*/
async function main(argv, io, deps = {}) {
	const [command, ...rest] = argv;
	if (command === "hook") return runHook(rest[0] ?? "", io, deps);
	if (command === "--version" || command === "-v") {
		io.stdout(`${VERSION}\n`);
		return 0;
	}
	if (command === "--help" || command === "-h" || command === void 0) {
		io.stdout(USAGE);
		return command === void 0 ? 2 : 0;
	}
	io.stderr(`antibody: unknown command: ${command}\n${USAGE}`);
	return 2;
}
//#endregion
//#region src/bin.ts
const readStdin = async () => {
	if (process.stdin.isTTY) return "";
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
};
process.exitCode = await main(process.argv.slice(2), {
	readStdin,
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
	env: process.env
});
//#endregion
export {};
