import os from "node:os";
import path from "node:path";
import { matchGlob } from "./glob";
import type { Rule } from "./rule";

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

  const positiveHit = touchedPaths.some((tp) =>
    rule.paths.some((pattern) => matchGlob(pattern, tp))
  );
  if (!positiveHit) return false;

  const negatedHit = touchedPaths.some((tp) =>
    rule.negated.some((pattern) => matchGlob(pattern, tp))
  );
  return !negatedHit;
}