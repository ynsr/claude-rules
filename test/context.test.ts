import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import claudeRules from "../src/index";

type Handler = (...args: unknown[]) => unknown;

// Narrow helper: treat an arbitrary emit result as the object shape the
// handlers return ({ systemPrompt } or { messages }), or undefined.
type HookResult = { systemPrompt?: string; messages?: unknown[] } | undefined;
function asHookResult(value: unknown): HookResult {
  if (value === undefined) return undefined;
  if (typeof value === "object" && value !== null) return value as HookResult;
  return undefined;
}

interface MockPi {
  on(name: string, h: Handler): void;
  emit(name: string, ...args: unknown[]): Promise<unknown>;
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "claude-rules-ctx-"));
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// Build a repo fixture with one rule matching src/security/**.
function makeRepo(): string {
  const repo = path.join(tmp, "r");
  mkdirSync(path.join(repo, ".claude", "rules"), { recursive: true });
  writeFileSync(path.join(repo, ".git"), "");
  writeFileSync(
    path.join(repo, ".claude", "rules", "security.md"),
    "---\npaths: [src/security/**]\n---\n# Security Rules\nBE SECURE\n",
  );
  return repo;
}

// Minimal pi mock: registers handlers so the test can drive them.
function makePi(): MockPi {
  const handlers = new Map<string, Handler[]>();
  return {
    on(name: string, h: Handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name)!.push(h);
    },
    async emit(name: string, ...args: unknown[]) {
      // Await async handlers so discovery (session_start) completes before the
      // next event is emitted.
      let out: unknown;
      for (const h of handlers.get(name) ?? []) out = await h(...args);
      return out;
    },
  };
}

// Set the omp markers (OMPCODE + an .omp agent dir), run the callback, restore
// the prior values. isOmp() checks BOTH, so the helper must control both:
// setting only OMPCODE would leave a real PI_CODING_AGENT_DIR (inherited from
// the host omp session) making isOmp() true even in the "not omp" case.
function withOmp(omp: boolean, fn: () => Promise<void>): Promise<void> {
  const prevCode = Bun.env.OMPCODE;
  const prevDir = Bun.env.PI_CODING_AGENT_DIR;
  Bun.env.OMPCODE = omp ? "1" : undefined;
  Bun.env.PI_CODING_AGENT_DIR = omp ? "/home/u/.omp/agent" : undefined;
  return fn().finally(() => {
    Bun.env.OMPCODE = prevCode;
    Bun.env.PI_CODING_AGENT_DIR = prevDir;
  });
}

// Type guard: a user-role message whose string content is an `<instructions>` block.
function isInstructionsMessage(m: unknown): m is { role: "user"; content: string } {
  return (
    m !== null &&
    typeof m === "object" &&
    "role" in m &&
    (m as { role: unknown }).role === "user" &&
    "content" in m &&
    typeof (m as { content: unknown }).content === "string" &&
    (m as { content: string }).content.includes("<instructions>")
  );
}

describe("context-event mid-turn injection (omp)", () => {
  test("injects matching rule as a user `<instructions>` message after a tool_call touches the file", async () => {
    await withOmp(true, async () => {
      const repo = makeRepo();
      const pi = makePi();
      claudeRules(pi as unknown as ExtensionAPI);

      // session_start: discover the security rule for this repo.
      await pi.emit("session_start", {}, { cwd: repo, hasUI: false, ui: {} });

      // before_agent_start on the first prompt: appends the contextual note,
      // but does NOT inject rules (progressive disclosure is context-only).
      const first = asHookResult(await pi.emit("before_agent_start", { systemPrompt: "BASE" }));
      expect(first?.systemPrompt).toContain("contextual");
      expect(first?.systemPrompt).not.toContain("BE SECURE");

      // tool_call records the just-read file.
      await pi.emit("tool_call", {
        toolName: "read",
        input: { path: "src/security/SecurityConfig.java" },
      });

      // context fires before the next model step → same-turn injection.
      const ctx1 = asHookResult(
        await pi.emit("context", { messages: [{ role: "user", content: "summarize" }] }),
      );
      expect(ctx1).not.toBeUndefined();
      const injected = ctx1?.messages?.find(isInstructionsMessage);
      expect(injected).toBeDefined();
      if (!injected) throw new Error("expected an injected <instructions> message");
      // The injected rule's first line is the FULL path of the rule file.
      expect(injected.content).toContain(`Contents of ${path.join(repo, ".claude", "rules", "security.md")}:`);
      expect(injected.content).toContain("# Security Rules");
      expect(injected.content).toContain("BE SECURE");
      expect(injected.content.startsWith("<instructions>")).toBe(true);
      expect(injected.content.endsWith("</instructions>")).toBe(true);
      // appended after the existing user message (alongside the tool result)
      expect(ctx1?.messages?.[ctx1.messages!.length - 1]).toBe(injected);
      const firstMsg = ctx1?.messages?.[0];
      expect(firstMsg).not.toBeUndefined();
      if (firstMsg && typeof firstMsg === "object" && "role" in firstMsg) {
        expect(firstMsg.role).toBe("user");
      }
    });
  });

  test("dedups: a rule injected once this turn is not re-injected on later context events", async () => {
    await withOmp(true, async () => {
      const repo = makeRepo();
      const pi = makePi();
      claudeRules(pi as unknown as ExtensionAPI);
      await pi.emit("session_start", {}, { cwd: repo, hasUI: false, ui: {} });
      await pi.emit("tool_call", {
        toolName: "read",
        input: { path: "src/security/SecurityConfig.java" },
      });

      const ctx1 = asHookResult(
        await pi.emit("context", { messages: [{ role: "user", content: "a" }] }),
      );
      expect(ctx1?.messages?.filter(isInstructionsMessage).length).toBe(1);

      // Same turn, another model step: rule already injected → no instructions block.
      const ctx2 = await pi.emit("context", { messages: [{ role: "user", content: "b" }] });
      expect(ctx2).toBeUndefined();
    });
  });

  test("re-injects on a later turn once the token gap is exceeded", async () => {
    await withOmp(true, async () => {
      const repo = makeRepo();
      const pi = makePi();
      claudeRules(pi as unknown as ExtensionAPI);
      // Mock model claims a 4K window → tokenGap = min(4000*0.25, 70K) = 1000.
      await pi.emit("session_start", {}, { cwd: repo, hasUI: false, ui: {}, model: { contextWindow: 4000 } });
      await pi.emit("tool_call", {
        toolName: "read",
        input: { path: "src/security/SecurityConfig.java" },
      });

      // Turn 1: context injects it. currentTokens = ceil(1/4) = 1.
      const turn1 = asHookResult(
        await pi.emit("context", { messages: [{ role: "user", content: "a" }] }),
      );
      expect(turn1?.messages?.filter(isInstructionsMessage).length).toBe(1);

      // Turn 2: before_agent_start clears the per-turn set (and appends the
      // note, but does NOT inject rules into the system prompt).
      const turn2 = asHookResult(await pi.emit("before_agent_start", { systemPrompt: "BASE" }));
      expect(turn2?.systemPrompt).toContain("contextual");
      expect(turn2?.systemPrompt).not.toContain("BE SECURE");

      // Same matching path, but conversation grew only 1 token since the last
      // injection → gap (0) < tokenGap (1000), so no re-injection.
      const ctxSmall = asHookResult(
        await pi.emit("context", { messages: [{ role: "user", content: "b" }] }),
      );
      expect(ctxSmall).toBeUndefined();

      // Conversation grows past the token gap (content "x"*5000 → ceil(5000/4)
      // = 1250 tokens; 1250 - 1 >= 1000) → the rule re-injects this turn.
      const ctxGrown = asHookResult(
        await pi.emit("context", { messages: [{ role: "user", content: "x".repeat(5000) }] }),
      );
      expect(ctxGrown?.messages?.filter(isInstructionsMessage).length).toBe(1);
    });
  });

  test("does not register the context handler when not omp (Pi fallback)", async () => {
    await withOmp(false, async () => {
      const repo = makeRepo();
      const pi = makePi();
      claudeRules(pi as unknown as ExtensionAPI);
      await pi.emit("session_start", {}, { cwd: repo, hasUI: false, ui: {} });
      await pi.emit("tool_call", {
        toolName: "read",
        input: { path: "src/security/SecurityConfig.java" },
      });

      // No context handler registered in Pi → emit does nothing, returns undefined.
      const ctx = await pi.emit("context", { messages: [{ role: "user", content: "a" }] });
      expect(ctx).toBeUndefined();

      // before_agent_start still appends the contextual note.
      const turn2 = asHookResult(await pi.emit("before_agent_start", { systemPrompt: "BASE" }));
      expect(turn2?.systemPrompt).toContain("contextual");
    });
  });
});