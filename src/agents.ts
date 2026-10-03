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
 * Two sources, both ancestor-ordered:
 *   1. Ancestors of `cwd` (repoRoot → cwd parent). The harness injects the
 *      session-startup (cwd-root) AGENTS.md itself, so the file exactly at
 *      `cwd` is skipped — only strictly-ancestor docs above the session root
 *      are returned here.
 *   2. Descendants below `cwd` on the ancestor chain of each touched path:
 *      walking from the touched file's directory up to (but excluding) `cwd`,
 *      collecting `<dir>/AGENTS.md` at each depth. This covers the reported
 *      failure mode (2026-10-03): session at repo root touching
 *      `src/main/java/.../SecurityConfig.java` must pick up
 *      `src/main/java/AGENTS.md`, which is neither an ancestor of cwd nor
 *      knowable without the touched path. Home-global `~/AGENTS.md` is never
 *      collected (harness-owned).
 */
export function discoverAgents(cwd: string, touchedAbsDirs: string[] = []): AgentDoc[] {
  const resolvedCwd = path.resolve(cwd);
  const root = findRepoRoot(resolvedCwd);
  // Depths from root → cwd parent (cwd file itself is harness-owned: skip).
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
  const collect = (d: string): void => {
    const full = path.join(d, "AGENTS.md");
    if (seen.has(full) || !existsSync(full)) return;
    seen.add(full);
    const doc = readAgentFile(full, d);
    if (doc) out.push(doc);
  };
  for (const d of depths) {
    if (path.resolve(d) === resolvedCwd) continue; // harness-owned, skip
    collect(d);
  }
  // Descendant docs on each touched path's ancestor chain below cwd.
  // Nearest-scope doc is the most specific match; emit leaf-first so the
  // closest doc sorts last in the stacked order used at injection time.
  for (const absDir of touchedAbsDirs) {
    const chain: string[] = [];
    let d = path.resolve(absDir);
    for (;;) {
      if (!d.startsWith(resolvedCwd + path.sep) && d !== resolvedCwd) break;
      if (d === resolvedCwd) break;
      chain.push(d);
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
    for (const c of chain) collect(c);
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
