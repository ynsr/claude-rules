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

// Set the omp marker, run the callback, restore the prior value.
function withOmp(marker: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = Bun.env.OMPCODE;
  Bun.env.OMPCODE = marker;
  return fn().finally(() => {
    Bun.env.OMPCODE = prev;
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
    await withOmp("1", async () => {
      const repo = makeRepo();
      const pi = makePi();
      claudeRules(pi as unknown as ExtensionAPI);

      // session_start: discover the security rule for this repo.
      await pi.emit("session_start", {}, { cwd: repo, hasUI: false, ui: {} });

      // before_agent_start on the first prompt: touched is empty → no injection.
      const first = asHookResult(await pi.emit("before_agent_start", { systemPrompt: "BASE" }));
      expect(first).toBeUndefined();

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
    await withOmp("1", async () => {
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

  test("re-injects on a later turn (before_agent_start clears the per-turn set)", async () => {
    await withOmp("1", async () => {
      const repo = makeRepo();
      const pi = makePi();
      claudeRules(pi as unknown as ExtensionAPI);
      await pi.emit("session_start", {}, { cwd: repo, hasUI: false, ui: {} });
      await pi.emit("tool_call", {
        toolName: "read",
        input: { path: "src/security/SecurityConfig.java" },
      });

      // Turn 1: context injects it.
      await pi.emit("context", { messages: [{ role: "user", content: "a" }] });

      // Turn 2: before_agent_start re-injects into the system prompt (fresh set).
      const turn2 = asHookResult(await pi.emit("before_agent_start", { systemPrompt: "BASE" }));
      expect(turn2).not.toBeUndefined();
      expect(turn2?.systemPrompt).toContain("# Security Rules");

      // The rule is now in this turn's system prompt, so the context handler
      // correctly skips it (dedup) — no duplicate instructions block this turn.
      const ctx2 = await pi.emit("context", { messages: [{ role: "user", content: "b" }] });
      expect(ctx2).toBeUndefined();
    });
  });

  test("does not register the context handler when not omp (Pi fallback)", async () => {
    await withOmp(undefined, async () => {
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

      // But before_agent_start still works on subsequent turns.
      const turn2 = asHookResult(await pi.emit("before_agent_start", { systemPrompt: "BASE" }));
      expect(turn2?.systemPrompt).toContain("# Security Rules");
    });
  });
});