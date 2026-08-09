import type {ContextEvent, ExtensionAPI} from "@earendil-works/pi-coding-agent";
import {discoverRules, findRepoRoot} from "./discover";
import {matchRule, normalizePath} from "./match";
import {formatRules} from "./format";
import type {Rule} from "./rule";

const PATH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const GLOBS_TOOLS = new Set(["glob"]);

/**
 * Detect the oh-my-pi (omp) runtime. omp sets `OMPCODE=1`; base Pi
 * (earendil-works/pi-coding-agent) does not. The `context`-event system-role
 * injection below is only honored by omp's `convertToLlm`; base Pi's
 * `defaultConvertToLlm` filters system-role messages out (silently dropped).
 * Defaulting to false keeps Pi safe: without the marker we don't register the
 * context handler and fall back to `before_agent_start` only.
 */
function isOmp(): boolean {
    return typeof Bun !== "undefined" && Bun.env.OMPCODE === "1";
}

function dedupKey(r: Rule): string {
    // Absolute path uniquely identifies a discovered rule; include mtime so an
    // on-disk edit mid-session that triggers rediscovery isn't double-counted.
    return `${r.file}@${r.mtimeMs}`;
}

// Contextual diagnostics. The structured logger (ctx.logger → ~/.omp/logs/omp.*.log)
// is the reliable channel from the TUI-spawned session; plain console output lands
// on the TUI's stdout and is not captured. We capture ctx at session_start and route
// every diagnostic through BOTH the UI toast (ctx.ui.notify) and the structured
// logger, so the event is visible live in the TUI and still tailable from the log
// file. The module-load line (before any ctx) falls back to console.warn so loading
// is still visible.
let _logger: { warn(m: string, c?: Record<string, unknown>): void } | undefined;
let _notify: ((m: string, t?: string) => void) | undefined;
let log = (_m: string, _c?: Record<string, unknown>): void => {
};

function adoptUi(ctx: { hasUI?: boolean; ui?: { notify(m: string, t?: string): void } }): void {
    if (ctx.hasUI && typeof ctx.ui?.notify === "function") {
        _notify = (m, t) => ctx.ui!.notify(m, t ?? "info");
    } else {
        _notify = undefined;
    }
}

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
        if (_notify) {
            try {
                _notify(`[claude-rules] ${detail}`);
            } catch {
                /* toast failure must not break the handler */
            }
        }
        if (_logger) _logger.warn(`\n[claude-rules] ${m}`, c);
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
    // Rules already injected this turn (via before_agent_start into the system
    // prompt, or via the omp `context` event into a system message). Cleared at
    // the top of before_agent_start, which fires once per user prompt before the
    // tool loop. Prevents a rule from being sent twice in one turn (systemPrompt
    // AND a context system message), while still re-injecting on later turns.
    const injectedThisTurn = new Set<string>();

    loadLog(`extension loaded; omp=${isOmp()} OMPCODE=${Bun.env.OMPCODE}`);

    pi.on("session_start", async (_event, ctx) => {
        // Normalize paths against the actual repo root (walk up to .git), so
        // repo-relative rule globs (e.g. src/**/*.ts) match even when the session
        // starts from a subdirectory of the repository.
        repoRoot = findRepoRoot(ctx.cwd);
        rules = await discoverRules(ctx.cwd);
        touched.clear();
        injectedThisTurn.clear();
        // ctx.logger/ui may be absent (e.g. pi mocks in tests); adopters fall back to console.
        adoptLogger(ctx.logger);
        adoptUi(ctx);
        log("session_start", {
            cwd: ctx.cwd,
            repoRoot,
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

    pi.on("before_agent_start", async (event) => {
        // Fires once per user prompt, before the tool loop runs any tool calls.
        // `touched` only holds paths from PRIOR turns here, so a file touched for
        // the first time this turn can't be injected by this hook — the `context`
        // handler below fixes that in omp.
        injectedThisTurn.clear();
        if (rules.length === 0) {
            log("before_agent_start no rules to match");
            return;
        }
        const matched = rules.filter((r) => matchRule(r, [...touched]));
        log("before_agent_start", {
            touched: touched.size,
            matched: matched.map((r) => r.name).join(",") || "(none)",
            injecting: matched.length > 0,
        });
        if (matched.length === 0) return;
        for (const r of matched) injectedThisTurn.add(dedupKey(r));
        return {
            /**
             * In mid-session below doesn't work. I checked the Claude Code Agent and it send the .claude/rules content in side a <instructions> tag as a user content alongside sending the next tool result. Claude Code will not wait until next turn (before_agent_start) to inject the rules. Example:
             <instructions>
             Contents of /home/bs/projects/jibit/cloud/projectx/.claude/rules/security.md:
             ...
             </instructions>
             <instructions>
             Contents of /home/bs/projects/jibit/cloud/projectx/.claude/rules/another-rule.md:
             ...
             </instructions>
             */
            systemPrompt: event.systemPrompt + "\n\n" + formatRules(matched),
        };
    });

    // omp-only mid-turn injection. The `context` event fires before every model
    // step (agent-session transformContext → emitContext), so once a tool_call
    // has recorded a matching path, the SAME turn's next step receives the rule —
    // fixing the one-turn-behind limitation of before_agent_start. Base Pi's
    // `defaultConvertToLlm` filters system-role messages out, so this is guarded
    // to omp only; Pi relies on before_agent_start.
    if (isOmp()) {
        pi.on("context", (event: ContextEvent) => {
            if (rules.length === 0) {
                log("context no rules to match");
                return;
            }
            const matched = rules.filter(
                (r) => !injectedThisTurn.has(dedupKey(r)) && matchRule(r, [...touched]),
            );
            log("context", {
                touched: touched.size,
                matched: matched.map((r) => r.name).join(",") || "(none)",
                injecting: matched.length > 0,
                totalMsgs: event.messages.length,
            });
            if (matched.length === 0) return;
            for (const r of matched) injectedThisTurn.add(dedupKey(r));
            // AgentMessage isn't exported from the public API; the system role is
            // omp-only and not part of the base Message union, so cast it.
            return {
                messages: [
                    {role: "system", content: formatRules(matched)} as never,
                    ...event.messages,
                ],
            };
        });
    }
}