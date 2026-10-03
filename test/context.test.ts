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
  tmp = mkdtempSync(path.join(tmpdir(), "claude-rules-for-omp-ctx-"));
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
      const injected = ctx1?.messages?.find(isInstructionsMessage);
      expect(injected).toBeDefined();
      if (!injected) throw new Error("expected an injected <instructions> message");
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

  test("records a glob tool_call sent as { path } (real omp shape)", async () => {
    await withOmp(true, async () => {
      const repo = makeRepo();
      const pi = makePi();
      claudeRules(pi as unknown as ExtensionAPI);
      await pi.emit("session_start", {}, { cwd: repo, hasUI: false, ui: {} });
      await pi.emit("before_agent_start", { systemPrompt: "BASE", prompt: "Summarize SecurityConfig.java" });
      // Real 2026-10-03 session: omp sends the glob target as `path`, not
      // `pattern`. This must still count as touching the file's directory so
      // a later `read` of the resolved file matches (and the glob alone must
      // not crash or match spuriously).
      await pi.emit("tool_call", {
        toolName: "glob",
        input: { i: "Locating SecurityConfig file", path: "src/security/SecurityConfig.java" },
      });
      const ctx = asHookResult(
        await pi.emit("context", { messages: [{ role: "user", content: "summarize" }] }),
      );
      const injected = ctx?.messages?.find(isInstructionsMessage);
      expect(injected).toBeDefined();
      if (injected) expect(injected.content).toContain("BE SECURE");
    });
  });

  test("appends matching rules to the read tool_result (guaranteed-delivery path)", async () => {
    await withOmp(true, async () => {
      const repo = makeRepo();
      const pi = makePi();
      claudeRules(pi as unknown as ExtensionAPI);
      await pi.emit("session_start", {}, { cwd: repo, hasUI: false, ui: {} });
      await pi.emit("before_agent_start", { systemPrompt: "BASE", prompt: "summarize the file" });
      await pi.emit("tool_call", {
        toolName: "read",
        input: { path: "src/security/SecurityConfig.java" },
      });
      // tool_result returns replacement content: original entries preserved
      // plus a trailing `<instructions>` block with the matched rule.
      const res = (await pi.emit("tool_result", {
        toolName: "read",
        content: [{ type: "text", text: "file body" }],
      })) as { content?: unknown[] } | undefined;
      expect(res?.content?.length).toBe(2);
      const block = res?.content?.[1];
      expect(block !== null && typeof block === "object" && "text" in block).toBe(true);
      if (block !== null && typeof block === "object" && "text" in block) {
        expect(String((block as { text: unknown }).text)).toContain("BE SECURE");
      }
      // Inject-once: a second tool_result for the same content injects nothing.
      const res2 = await pi.emit("tool_result", {
        toolName: "read",
        content: [{ type: "text", text: "file body" }],
      });
      expect(res2).toBeUndefined();
    });
  });

  test("injects descendant AGENTS.md below session root for a touched file (no tool read)", async () => {
    await withOmp(true, async () => {
      const repo = makeRepo();
      mkdirSync(path.join(repo, "src", "main", "java"), { recursive: true });
      writeFileSync(path.join(repo, "src", "main", "java", "AGENTS.md"), "# Java scope\nJAVA SCOPE\n");
      const pi = makePi();
      claudeRules(pi as unknown as ExtensionAPI);
      await pi.emit("session_start", {}, { cwd: repo, hasUI: false, ui: {} });
      // Exact 2026-10-03 failure shape: session at repo root, `@path` prompt
      // mention only — no tool_call ever runs before the summary step.
      await pi.emit("before_agent_start", {
        systemPrompt: "BASE",
        prompt: "Summarize @src/main/java/ir/jibit/projectx/config/security/SecurityConfig.java",
      });
      const ctx = asHookResult(
        await pi.emit("context", {
          messages: [{ role: "user", content: "Summarize @src/main/java/ir/jibit/projectx/config/security/SecurityConfig.java" }],
        }),
      );
      const injected = ctx?.messages?.find(isInstructionsMessage);
      expect(injected).toBeDefined();
      if (injected) expect(injected.content).toContain("JAVA SCOPE");
    });
  });

  test("injects rule + descendant AGENTS.md from a fileMention message (omp @path shape)", async () => {
    await withOmp(true, async () => {
      const repo = makeRepo();
      mkdirSync(path.join(repo, "src", "security"), { recursive: true });
      writeFileSync(path.join(repo, "src", "security", "AGENTS.md"), "# Sec scope\nSEC SCOPE\n");
      const pi = makePi();
      claudeRules(pi as unknown as ExtensionAPI);
      await pi.emit("session_start", {}, { cwd: repo, hasUI: false, ui: {} });
      await pi.emit("before_agent_start", {
        systemPrompt: "BASE",
        prompt: "Summarize @src/security/SecurityConfig.java",
      });
      // Exact 2026-10-03 session shape: omp expands the `@path` mention into
      // a structured fileMention message (files[].path, no text content).
      const ctx = asHookResult(
        await pi.emit("context", {
          messages: [
            { role: "user", content: "Summarize @src/security/SecurityConfig.java" },
            { role: "fileMention", files: [{ path: "src/security/SecurityConfig.java" }] },
          ],
        }),
      );
      const injected = ctx?.messages?.find(isInstructionsMessage);
      expect(injected).toBeDefined();
      if (injected) {
        expect(injected.content).toContain("BE SECURE");
        expect(injected.content).toContain("SEC SCOPE");
      }
    });
  });

  test("inject-once: growth never re-injects; compaction (>30% drop) re-injects", async () => {
    await withOmp(true, async () => {
      const repo = makeRepo();
      const pi = makePi();
      claudeRules(pi as unknown as ExtensionAPI);
      await pi.emit("session_start", {}, { cwd: repo, hasUI: false, ui: {} });
      await pi.emit("tool_call", {
        toolName: "read",
        input: { path: "src/security/SecurityConfig.java" },
      });

      // First context injects it.
      const ctx1 = asHookResult(
        await pi.emit("context", { messages: [{ role: "user", content: "a" }] }),
      );
      expect(ctx1?.messages?.filter(isInstructionsMessage).length).toBe(1);

      // New turn, same matching path, small conversation: no re-injection.
      await pi.emit("before_agent_start", { systemPrompt: "BASE" });
      const ctxSmall = asHookResult(
        await pi.emit("context", { messages: [{ role: "user", content: "b" }] }),
      );
      expect(ctxSmall).toBeUndefined();

      // Growth alone (even +70K tokens) never re-injects.
      const ctxGrown = asHookResult(
        await pi.emit("context", { messages: [{ role: "user", content: "x".repeat(280000) }] }),
      );
      expect(ctxGrown).toBeUndefined();

      // Compaction: conversation drops >30% and >5K tokens → re-inject.
      const ctxCompacted = asHookResult(
        await pi.emit("context", { messages: [{ role: "user", content: "short again" }] }),
      );
      expect(ctxCompacted?.messages?.filter(isInstructionsMessage).length).toBe(1);
    });
  });

  test("matches a rule for a file referenced via `@path` in the prompt, without any tool_call", async () => {
    await withOmp(true, async () => {
      const repo = makeRepo();
      const pi = makePi();
      claudeRules(pi as unknown as ExtensionAPI);
      await pi.emit("session_start", {}, { cwd: repo, hasUI: false, ui: {} });

      // Prompt references the file via `@path`; no tool_call touches it.
      const first = asHookResult(
        await pi.emit("before_agent_start", {
          systemPrompt: "BASE",
          prompt: "summarize @src/security/SecurityConfig.java",
        }),
      );
      expect(first?.systemPrompt).toContain("contextual");
      expect(first?.systemPrompt).not.toContain("BE SECURE");

      const ctx = asHookResult(
        await pi.emit("context", { messages: [{ role: "user", content: "summarize @src/security/SecurityConfig.java" }] }),
      );
      const injected = ctx?.messages?.find(isInstructionsMessage);
      expect(injected).toBeDefined();
      if (injected) expect(injected.content).toContain("BE SECURE");
    });
  });

  test("matches a rule when omp injects the file as a `<file path=...>` message", async () => {
    await withOmp(true, async () => {
      const repo = makeRepo();
      const pi = makePi();
      claudeRules(pi as unknown as ExtensionAPI);
      await pi.emit("session_start", {}, { cwd: repo, hasUI: false, ui: {} });

      await pi.emit("before_agent_start", { systemPrompt: "BASE", prompt: "summarize the file" });

      // omp injects the file content as a separate user message with a
      // `<file path="…">` block, in the same request as the prompt.
      const ctx = asHookResult(
        await pi.emit("context", {
          messages: [
            { role: "user", content: "summarize the file" },
            {
              role: "user",
              content: '<file path="src/security/SecurityConfig.java">\n[SecurityConfig.java]\n1:package ir.jibit.projectx.config.security;\n</file>',
            },
          ],
        }),
      );
      const injected = ctx?.messages?.filter(isInstructionsMessage);
      expect(injected?.length).toBe(1);
      if (injected?.[0]) expect(injected[0].content).toContain("BE SECURE");
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