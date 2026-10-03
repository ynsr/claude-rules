import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { findRepoRoot } from "./discover.ts";

export interface AgentDoc {
  file: string; // absolute path
  scopeDir: string; // directory whose subtree this doc governs (absolute)
  body: string; // raw markdown content (no frontmatter stripping: AGENTS.md has none)
  mtimeMs: number;
}

const cache = new Map<string, { mtimeMs: number; doc: AgentDoc }>();

export function clearAgentCache(): void {
  cache.clear();
}

export function dedupKeyAgent(doc: AgentDoc): string {
  return `${doc.file}@${doc.mtimeMs}`;
}

function readAgentFile(full: string, scopeDir: string): AgentDoc | undefined {
  try {
    const st = statSync(full);
    const cached = cache.get(full);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.doc;
    const doc: AgentDoc = {
      file: full,
      scopeDir,
      body: readFileSync(full, "utf8"),
      mtimeMs: st.mtimeMs,
    };
    cache.set(full, { mtimeMs: st.mtimeMs, doc });
    return doc;
  } catch {
    return undefined;
  }
}

/**
 * Discover nested AGENTS.md files depth-first (root → leaf).
 *
 * Walks from repoRoot down to cwd, collecting `<dir>/AGENTS.md` at each depth
 * in order so ancestors come first and the nearest (leaf) doc comes last
 * (leaf wins by position when stacked). The harness itself injects the
 * session-startup (cwd-root) AGENTS.md, so the file exactly at `cwd` is
 * skipped — only strictly-nested AGENTS.md files below the session root are
 * returned. Home-global `~/AGENTS.md` is never collected (harness-owned).
 */
export function discoverAgents(cwd: string): AgentDoc[] {
  const resolvedCwd = path.resolve(cwd);
  const root = findRepoRoot(resolvedCwd);
  // Depths from root → cwd.
  const depths: string[] = [];
  let dir = resolvedCwd;
  for (;;) {
    depths.push(dir);
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  depths.reverse();

  const out: AgentDoc[] = [];
  const seen = new Set<string>();
  for (const d of depths) {
    if (path.resolve(d) === resolvedCwd) continue; // harness-owned, skip
    const full = path.join(d, "AGENTS.md");
    if (seen.has(full) || !existsSync(full)) continue;
    seen.add(full);
    const doc = readAgentFile(full, d);
    if (doc) out.push(doc);
  }
  return out;
}

/**
 * A nested AGENTS.md applies when a touched path is inside its scope
 * directory. `touchedPath` is repo-relative (see normalizePath); scopeDir is
 * absolute — resolve the touched path against repoRoot first.
 */
export function matchAgent(doc: AgentDoc, touchedPaths: string[], repoRoot: string): boolean {
  return touchedPaths.some((tp) => {
    const abs = path.isAbsolute(tp) ? tp : path.resolve(repoRoot, tp);
    const rel = path.relative(doc.scopeDir, abs);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}
