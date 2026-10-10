/** VS Code's theme and language-configuration files are JSONC. Same rules as
 * src-tauri/src/extensions/jsonc.rs: comments go, a comma before `}`/`]` goes, strings stay. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  const lineEnd = (from: number) => {
    const end = text.indexOf("\n", from);
    return end === -1 ? text.length : end;
  };
  const blockEnd = (from: number) => {
    const end = text.indexOf("*/", from + 2);
    return end === -1 ? text.length : end + 2;
  };
  const nextSignificant = (from: number) => {
    let j = from;
    for (;;) {
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text.startsWith("//", j)) j = lineEnd(j);
      else if (text.startsWith("/*", j)) j = blockEnd(j);
      else return j;
    }
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") j += 2;
        else if (text[j] === '"') {
          j++;
          break;
        } else j++;
      }
      out += text.slice(i, j);
      i = j;
    } else if (text.startsWith("//", i)) {
      i = lineEnd(i);
    } else if (text.startsWith("/*", i)) {
      i = blockEnd(i);
    } else if (ch === ",") {
      const next = text[nextSignificant(i + 1)];
      if (next !== "}" && next !== "]") out += ",";
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

export function parseJsonc<T = unknown>(text: string): T {
  // Plain JSON (every bundled grammar) skips the comment-stripping loop.
  try {
    return JSON.parse(text) as T;
  } catch {
    return JSON.parse(stripJsonc(text)) as T;
  }
}
