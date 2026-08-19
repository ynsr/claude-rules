import os from "node:os";
import path from "node:path";
import { matchGlob } from "./glob.ts";
import type { Rule } from "./rule.ts";

export function normalizePath(p: string, repoRoot: string): string {
  let s = p;
  if (s === "~") s = os.homedir();
  else if (s.startsWith("~/")) s = path.join(os.homedir(), s.slice(2));

  const abs = path.isAbsolute(s) ? s : path.resolve(repoRoot, s);
  const rel = path.relative(repoRoot, abs);
  // If the path is outside repoRoot, keep a normalized absolute form.
  let out = rel.startsWith("..") ? abs : rel;
  out = out.split(path.sep).join("/").replace(/\\/g, "/");
  out = out.replace(/^\.\//, "");
  return out.replace(/\/+$/, "");
}

export function matchRule(rule: Rule, touchedPaths: string[]): boolean {
  if (rule.alwaysApply) return true;
  if (rule.paths.length === 0) return false;

  return touchedPaths.some((tp) => {
    const positiveHit = rule.paths.some((pattern) => matchGlob(pattern, tp));
    if (!positiveHit) return false;
    // Per-path negation: a touched path contributing to a match must not
    // itself be hidden by a negated glob. Other (negated) touched paths do
    // not disqualify the rule — matching Claude Code's per-path semantics.
    return !rule.negated.some((pattern) => matchGlob(pattern, tp));
  });
}