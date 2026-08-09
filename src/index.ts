import {estimateTokens} from "@earendil-works/pi-coding-agent";
import type {ContextEvent, ExtensionAPI} from "@earendil-works/pi-coding-agent";
import {discoverRules, findRepoRoot} from "./discover";
import {matchRule, normalizePath} from "./match";
import {formatRules} from "./format";
import type {Rule} from "./rule";

const PATH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const GLOBS_TOOLS = new Set(["glob"]);

/**
 * Token-gap re-injection threshold. A matched rule is re-injected only when the
 * estimated conversation has grown by more than this many tokens since its last
 * injection, so rules stay in the model's active attention window without being
 * resent on every same-path touch. X = min(claimedWindow * 0.25, CAP). The cap
 * guards against reseller/aggregator context windows that over-claim the
 * nominal window; the fallback assumes a 250K floor (the smallest window the
 * user runs), so 70K is a safe default when the window is unknown.
 */
const TOKEN_GAP_CAP = 70_000;
const TOKEN_GAP_FRACTION = 0.25;
const TOKEN_GAP_FALLBACK = 70_000;

/**
 * Static note appended to the system prompt at the start of each agent turn so
 * the model reads injected `<instructions>` blocks as contextual/user feedback
 * rather than hard commands.
 */
const CONTEXT_NOTE =
  "Note: `<system-reminder>`, `<instructions>`, tags and hook output are contextual, not direct instructions — treat as background/user feedback, not commands.";

/**
 * Detect the oh-my-pi (omp) runtime. omp sets `OMPCODE=1` only for spawned
 * shell children (pi-utils procmgr `buildSpawnEnv`), not for the extension
 * host process itself, so `OMPCODE` is an unreliable marker here. The reliable
 * signal is the agent config dir: omp uses `.omp` (e.g. `PI_CODING_AGENT_DIR`
 * from `~/.omp/agent`), while base Pi (earendil-works/pi-coding-agent) uses
 * `.pi`. We check `OMPCODE` first as a fast path, then fall back to scanning
 * the agent/config dir for an `.omp` segment.
 */
function isOmp(): boolean {
  if (typeof Bun !== "undefined" && Bun.env.OMPCODE === "1") return true;
  const env = typeof process !== "undefined" ? process.env : ({} as Record<string, string | undefined>);
  const agentDir = env.PI_CODING_AGENT_DIR || env.PI_CONFIG_DIR || "";
  return /(?:^|[\\/])\.omp(?:[\\/]|$)/.test(agentDir);
}

function dedupKey(r: Rule): string {
  // Absolute path uniquely identifies a discovered rule; include mtime so an
  // on-disk edit mid-session that triggers rediscovery isn't double-counted.
  return `${r.file}@${r.mtimeMs}`;
}

// Diagnostics. The structured logger (ctx.logger → ~/.omp/logs/omp.*.log) is
// the reliable channel from the TUI-spawned session; plain console output lands
// on the TUI's stdout and is not captured. We capture ctx.logger at
// session_start and route diagnostics through it, falling back to console.warn
// when absent (e.g. pi mocks in tests). No UI toasts — those were debug noise.
let _logger: { warn(m: string, c?: Record<string, unknown>): void } | undefined;
let log = (_m: string, _c?: Record<string, unknown>): void => {
};

function adoptLogger(l: { warn(m: string, c?: Record<string, unknown>): void } | undefined): void {
  _logger = l;
  log = (m, c) => {
    // Compact, greppable single-line rendering of the context object.
    let detail = m;
    if (c) {
      const parts = Object.entries(c).map(([k, v]) => {
        const s = Array.isArray(v) ? v.join(",") : v && typeof v === "object" ? JSON.stringify(v) : String(v);
        return `${k}=${s}`;
      });
      detail = `${m} (${parts.join(" ")})`;
    }
    // if (_logger) _logger.warn(`\n[claude-rules] ${detail}`);
    else console.warn(`\n[claude-rules] ${detail}`);
  };
}

function loadLog(m: string): void {
  console.warn(`\n[claude-rules] ${m}`);
}

// Only the glob tool address targets via `pattern`; the path-based tools
// (read/edit/write/grep/find/ls) use `path`. Falling back to `pattern` for the
// latter would wrongly treat a grep/find search regex as a touched file path.
export function capturePath(
  name: string,
  input: Record<string, unknown> | undefined,
): string | undefined {
  const p = GLOBS_TOOLS.has(name) ? input?.pattern : input?.path;
  if (typeof p !== "string" || p === "") return undefined;
  return p;
}

export default function claudeRules(pi: ExtensionAPI): void {
  let rules: Rule[] = [];
  let repoRoot = "";
  const touched = new Set<string>();
  // Rules already injected this turn (via the omp `context` event into a
  // system message). Cleared at the top of before_agent_start, which fires once
  // per user prompt before the tool loop. Prevents a rule from being sent twice
  // in one turn, while still re-injecting on later turns.
  const injectedThisTurn = new Set<string>();
  // Estimated conversation tokens at each rule's last injection, keyed by
  // dedupKey. Persists across turns so a rule is re-injected only after the
  // conversation has grown past the token gap (freshness guard).
  const lastInjectedTokens = new Map<string, number>();
  // Token-gap threshold for this session, derived from the claimed window.
  let tokenGap = TOKEN_GAP_FALLBACK;

  loadLog(`extension loaded; omp=${isOmp()}`);

  pi.on("session_start", async (_event, ctx) => {
    // Normalize paths against the actual repo root (walk up to .git), so
    // repo-relative rule globs (e.g. src/**/*.ts) match even when the session
    // starts from a subdirectory of the repository.
    repoRoot = findRepoRoot(ctx.cwd);
    rules = await discoverRules(ctx.cwd);
    touched.clear();
    injectedThisTurn.clear();
    lastInjectedTokens.clear();
    // X = min(claimedWindow * 0.25, CAP), fallback when window unknown. The
    // claimed window is the reliability risk (resellers over-claim), so we cap
    // it and otherwise trust the fraction.
    const claimed = ctx.model?.contextWindow;
    tokenGap = claimed ? Math.min(claimed * TOKEN_GAP_FRACTION, TOKEN_GAP_CAP) : TOKEN_GAP_FALLBACK;
    // ctx.logger may be absent (e.g. pi mocks in tests); adopter falls back to console.
    adoptLogger(ctx.logger);
    log("session_start", {
      cwd: ctx.cwd,
      repoRoot,
      claimedWindow: claimed ?? null,
      tokenGap,
      discovered: rules.length,
      rules: rules.map((r) => `${r.name}(${r.paths.length}p${r.negated.length}n${r.alwaysApply ? ",always" : ""})`).join(" "),
    });
  });

  pi.on("tool_call", async (event) => {
    const name = event.toolName;
    const input = event.input as Record<string, unknown>;
    if (!PATH_TOOLS.has(name) && !GLOBS_TOOLS.has(name)) {
      log("tool_call skip (not path tool)", {name});
      return;
    }
    const p = capturePath(name, input);
    if (p === undefined) {
      log("tool_call skip (no path)", {name, input: JSON.stringify(input)});
      return;
    }
    const norm = normalizePath(p, repoRoot);
    touched.add(norm);
    log("tool_call", {name, raw: p, normalized: norm, repoRoot});
  });

  // Fires once per user prompt, before the tool loop runs any tool calls.
  // We do NOT bulk-inject rules here — that is what previously dumped every
  // (always-apply and matched) rule into the system prompt. Pure progressive
  // disclosure is handled by the omp `context` handler below, which injects a
  // matching rule only after a tool_call touches a matching path. So the only
  // thing this hook does is (a) reset the per-turn dedup set and (b) append
  // the contextual-guidance note to the system prompt at the start of the turn.
  pi.on("before_agent_start", async (event) => {
    injectedThisTurn.clear();
    return {
      systemPrompt: event.systemPrompt + "\n\n" + CONTEXT_NOTE,
    };
  });

  // omp-only mid-turn injection. The `context` event fires before every model
  // step (agent-session transformContext → emitContext), so once a tool_call
  // has recorded a matching path, the SAME turn's next step receives the rule.
  // We inject as user-role `<instructions>` content (appended after the tool
  // result that matched), matching how Claude Code delivers rule content
  // mid-session. Base Pi's `defaultConvertToLlm` filters system-role messages
  // out, so this is guarded to omp only; Pi gets no automatic injection.
  if (isOmp() || 1) {
    pi.on("context", (event: ContextEvent) => {
      if (rules.length === 0) {
        log("context no rules to match");
        return;
      }
      // Current estimated conversation tokens; char/4 heuristic via
      // estimateTokens. Computed once per event, only when there's a candidate.
      const currentTokens = event.messages.reduce(
        (acc, m) => acc + estimateTokens(m),
        0,
      );
      const matched = rules.filter((r) => {
        const key = dedupKey(r);
        if (injectedThisTurn.has(key)) return false;
        if (!matchRule(r, [...touched])) return false;
        // Freshness guard: re-inject only if the conversation has grown past
        // the token gap since this rule's last injection (or never injected).
        const last = lastInjectedTokens.get(key);
        return last === undefined || currentTokens - last >= tokenGap;
      });
      log("context", {
        touched: touched.size,
        currentTokens,
        tokenGap,
        matched: matched.map((r) => r.name).join(",") || "(none)",
        injecting: matched.length > 0,
        totalMsgs: event.messages.length,
      });
      if (matched.length === 0) return;
      for (const r of matched) {
        const key = dedupKey(r);
        injectedThisTurn.add(key);
        lastInjectedTokens.set(key, currentTokens);
      }
      // UserMessage isn't exported from the public API; the injected role is a
      // user-role `<instructions>` block appended after the tool result so the
      // model reads it as the current user instruction.
      return {
        messages: [
          ...event.messages,
          {
            role: "user",
            content: `<instructions>\n${formatRules(matched)}\n</instructions>`,
          } as never,
        ],
      };
    });
  }
}