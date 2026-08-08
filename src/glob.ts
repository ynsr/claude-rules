/**
 * Minimal dependency-free glob → RegExp translation.
 * Supports `**` (crosses segments), `*` (within a segment), `?` (one char),
 * `{a,b}` alternation, and `[abc]`/`[a-z]` character classes.
 * Patterns match against forward-slash relative paths.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  const n = pattern.length;

  while (i < n) {
    const c = pattern[i];

    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**` — match zero or more segments (including none).
        out += "(?:.*/)?";
        i += 2;
        // Skip an immediately-following single slash.
        if (pattern[i] === "/") i++;
      } else {
        out += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      out += "[^/]";
      i++;
    } else if (c === "{") {
      // Find matching closing brace; split on commas (no nesting support).
      const close = pattern.indexOf("}", i);
      if (close === -1) {
        out += "\\{";
        i++;
      } else {
        const inner = pattern.slice(i + 1, close);
        // globToRegExp anchors each part (`^…$`); strip those outer anchors so
        // the alternation can match mid-pattern. Literal `^`/`$` inside a part
        // are already escaped (`\^`/`\$`) by the translation below.
        const parts = inner
          .split(",")
          .map((p) => globToRegExp(p).source.replace(/^\^|\$$/g, ""));
        out += `(?:${parts.join("|")})`;
        i = close + 1;
      }
    } else if (c === "[") {
      const close = pattern.indexOf("]", i);
      if (close === -1) {
        out += "\\[";
        i++;
      } else {
        out += pattern.slice(i, close + 1); // keep the class verbatim
        i = close + 1;
      }
    } else {
      out += c.replace(/[.+^$()|\\]/g, "\\$&");
      i++;
    }
  }

  return new RegExp(`^${out}$`);
}

export function matchGlob(pattern: string, relativePath: string): boolean {
  // Normalize backslashes; strip a leading `./`.
  const p = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return globToRegExp(pattern).test(p);
}