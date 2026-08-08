export interface Rule {
  file: string;        // absolute path
  relPath: string;     // path shown in the injected heading (relative to rules root)
  name: string;        // filename without extension
  paths: string[];     // positive glob patterns
  negated: string[];   // `!`-prefixed exclusion glob patterns (prefix stripped)
  description?: string;
  body: string;        // frontmatter stripped
  alwaysApply: boolean;
  mtimeMs: number;
}

export function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;
  return content.slice(end + 4).replace(/^\n/, "");
}

/**
 * Minimal YAML-frontmatter parser for the subset claude-rules needs:
 * `paths` (string or list), `description` (string). Values are parsed from
 * simple `key: value` lines and `- item` list lines. On any malformed input
 * it returns empty metadata (never throws).
 */
export function parseFrontmatter(content: string): {
  paths: string[];
  negated: string[];
  description?: string;
} {
  const out = { paths: [] as string[], negated: [] as string[], description: undefined as string | undefined };

  if (!content.startsWith("---")) return out;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return out;
  const block = content.slice(3, end);

  let current: "paths" | null = null;
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const listItem = line.match(/^-\s*(.+)$/);
    if (listItem && current) {
      out[current].push(cleanScalar(listItem[1]));
      continue;
    }

    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const value = kv[2].trim();
    current = key === "paths" ? "paths" : null;

    if (key === "paths") {
      if (!value) continue;
      // Inline array `[a, b]` or single string.
      const inline = value.match(/^\[(.*)\]$/);
      if (inline) {
        for (const item of inline[1].split(",")) {
          const s = cleanScalar(item);
          if (s) out.paths.push(s);
        }
      } else if (value && !value.startsWith("[")) {
        out.paths.push(cleanScalar(value));
      }
    } else if (key === "description" && value) {
      out.description = cleanScalar(value);
    }
  }

  // Split negations out of `paths`.
  const negated: string[] = [];
  const paths: string[] = [];
  for (const p of out.paths) {
    if (p.startsWith("!")) negated.push(p.slice(1));
    else paths.push(p);
  }
  out.paths = paths;
  out.negated = negated;
  return out;
}

function cleanScalar(s: string): string {
  return s.replace(/^['"]/, "").replace(/['"]$/, "").trim();
}

export function parseRule(
  file: string,
  relPath: string,
  content: string,
  mtimeMs: number
): Rule {
  const fm = parseFrontmatter(content);
  const body = stripFrontmatter(content);
  const name = file.split("/").pop()!.replace(/\.(md|mdc)$/i, "");
  const alwaysApply = fm.paths.length === 0;
  return {
    file,
    relPath,
    name,
    paths: fm.paths,
    negated: fm.negated,
    description: fm.description,
    body,
    alwaysApply,
    mtimeMs,
  };
}