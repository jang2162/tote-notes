export const TS_SAMPLE = `/**
 * Block comment that spans lines so chunk boundaries land inside it.
 */
export interface Memo<T extends string = string> {
  id: T;
  title: string;
  tags: readonly string[];
}

const template = \`multi-line
template \${1 + 2} string\`;

export class Store<T extends string> {
  private readonly items = new Map<T, Memo<T>>();

  add(memo: Memo<T>): void {
    if (this.items.has(memo.id)) throw new Error(\`duplicate \${memo.id}\`);
    this.items.set(memo.id, memo);
  }

  find(predicate: (m: Memo<T>) => boolean): Memo<T> | undefined {
    for (const m of this.items.values()) if (predicate(m)) return m;
    return undefined;
  }
}

// line comment with 한글 text
export const sizes = [1, 2, 3].map((n) => n * 1024 ** 2);
`;

/** Sizes are in UTF-16 code units, which match bytes for everything here except the Hangul comment. */
export function makeCodeFixture(targetChars: number): string {
  const parts: string[] = [];
  let length = 0;
  while (length < targetChars) {
    parts.push(TS_SAMPLE);
    length += TS_SAMPLE.length;
  }
  return parts.join("");
}

export function makeSingleLineJson(targetChars: number): string {
  const items: string[] = [];
  let length = 2;
  for (let i = 0; length < targetChars; i++) {
    const item = JSON.stringify({
      id: i,
      title: `memo ${i}`,
      tags: ["a", "b"],
      body: "lorem ipsum dolor sit amet",
    });
    items.push(item);
    length += item.length + 1;
  }
  return `[${items.join(",")}]`;
}

export function makeLogFixture(lineCount: number): string {
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    const level = i % 10 === 0 ? "ERROR" : i % 3 === 0 ? "WARN" : "INFO";
    const second = String(i % 60).padStart(2, "0");
    lines.push(
      `2026-01-01T00:00:${second}.000Z ${level} worker-${i % 8} processed request id=${i} in ${i % 97}ms`,
    );
  }
  return lines.join("\n");
}
