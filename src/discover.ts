import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Rule } from "./rule";
import { parseRule } from "./rule";

const cache = new Map<string, { mtimeMs: number; rule: Rule }>();

export function clearRuleCache(): void {
  cache.clear();
}

export function findRepoRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  const home = homedir();
  for (;;) {
    if (dir === home) return dir;
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

function collectRules(rulesDir: string, base: string): Rule[] {
  const out: Rule[] = [];
  if (!existsSync(rulesDir)) return out;
  const entries = readdirSync(rulesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(rulesDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectRules(full, base));
    } else if (/\.(md|mdc)$/i.test(entry.name)) {
      const rel = path.relative(base, full).split(path.sep).join("/");
      try {
        const st = statSync(full);
        const cached = cache.get(full);
        let rule: Rule;
        if (cached && cached.mtimeMs === st.mtimeMs) {
          rule = cached.rule;
        } else {
          rule = parseRule(full, rel, readFileSync(full, "utf8"), st.mtimeMs);
          cache.set(full, { mtimeMs: st.mtimeMs, rule });
        }
        out.push(rule);
      } catch {
        // unreadable file: skip
      }
    }
  }
  return out;
}

export async function discoverRules(cwd: string): Promise<Rule[]> {
  const root = findRepoRoot(cwd);
  const rules: Rule[] = [];

  // Walk from cwd (inclusive) down to repo root, collecting each depth's rules.
  let dir = path.resolve(cwd);
  const walk: string[] = [];
  for (;;) {
    walk.push(dir);
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // walk is cwd → root; reverse so ancestors come first, nearer last.
  for (const d of walk.reverse()) {
    rules.push(...collectRules(path.join(d, ".claude", "rules"), path.join(d, ".claude", "rules")));
  }

  // User scope last.
  const userRules = path.join(homedir(), ".claude", "rules");
  rules.push(...collectRules(userRules, userRules));

  // Dedup by absolute path, keep first occurrence. Duplicate filenames across
  // scopes: a later (more-local / user) entry wins, so remove earlier same-name.
  const seen = new Set<string>();
  const deduped: Rule[] = [];
  for (const rule of rules) {
    if (seen.has(rule.file)) continue;
    seen.add(rule.file);
    // Drop any earlier rule with the same name (more-local wins).
    const idx = deduped.findIndex((r) => r.name === rule.name);
    if (idx !== -1) deduped.splice(idx, 1);
    deduped.push(rule);
  }
  return deduped;
}