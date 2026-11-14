import type { LanguageInfo } from "../backend/types";
import type { Registry } from "../extensions/registry";
import type { CodeBlock, CodeColors, CodeSpan } from "./protocol";

/** How much of a preview's code is coloured at most (spec 2026-11-14 md-preview 「코드 블록 색」):
 * past these the blocks stay plain rather than hold the highlight worker for long. */
export const MAX_CODE_BLOCKS = 200;
export const MAX_CODE_CHARS = 500_000;

/** What `colorCode` needs of the window's `HighlightClient`. */
export interface CodeHighlighter {
  readonly colorMap: string[];
  nextDocId(): number;
  open(doc: number, lang: LanguageInfo, text: () => string): Promise<boolean>;
  tokens(doc: number, from: number, to: number): Promise<Uint32Array[] | null>;
  close(doc: number): void;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** The language a code fence's info word names: by id, then alias, then file extension (`ts`,
 * `py`), case ignored. Only one with a grammar: the others stay plain. */
export function fenceLanguage(registry: Registry, word: string): LanguageInfo | undefined {
  const name = word.trim().toLowerCase();
  if (!name) return undefined;
  const languages = registry.data.languages.filter((lang) => lang.grammar);
  return (
    languages.find((lang) => lang.id.toLowerCase() === name) ??
    languages.find((lang) => lang.aliases.some((alias) => alias.toLowerCase() === name)) ??
    languages.find((lang) => lang.extensions.includes(name))
  );
}

/** The worker's tokens of each line (`[start, colourId, fontStyle]` triples) as pieces of text
 * with their colour: the viewer builds them as text nodes, never as markup. A colour that is not
 * a hex one is left out. A line with no tokens (one too long for the worker) stays one plain piece. */
export function spansOf(
  lines: readonly string[],
  tokens: readonly (Uint32Array | undefined)[],
  colorMap: readonly string[],
): CodeSpan[][] {
  return lines.map((line, i) => {
    const triples = tokens[i];
    if (!line) return [];
    if (!triples || triples.length < 3) return [{ text: line, fontStyle: 0 }];
    const spans: CodeSpan[] = [];
    for (let t = 0; t < triples.length; t += 3) {
      const start = triples[t];
      const end = t + 3 < triples.length ? triples[t + 3] : line.length;
      if (end <= start) continue;
      const color = colorMap[triples[t + 1]];
      const span: CodeSpan = { text: line.slice(start, end), fontStyle: triples[t + 2] };
      if (color && HEX_COLOR.test(color)) span.color = color;
      spans.push(span);
    }
    return spans;
  });
}

/** Colours the preview's code blocks with the editor's grammars and theme, one document in the
 * highlight worker per block, each closed when its tokens are in. Blocks in a language with no
 * grammar, or past the limits, are left out of the answer: they stay plain. Once `stale` says the
 * preview has drawn another text, no further block is sent: the worker would colour blocks no one
 * will see while the editors' requests wait behind them. */
export async function colorCode(
  client: CodeHighlighter,
  registry: Registry,
  blocks: readonly CodeBlock[],
  stale: () => boolean = () => false,
): Promise<CodeColors[]> {
  const out: CodeColors[] = [];
  let chars = 0;
  for (const block of blocks.slice(0, MAX_CODE_BLOCKS)) {
    if (stale()) break;
    if (chars + block.code.length > MAX_CODE_CHARS) continue;
    const lang = fenceLanguage(registry, block.lang);
    if (!lang) continue;
    chars += block.code.length;
    const doc = client.nextDocId();
    try {
      if (!(await client.open(doc, lang, () => block.code))) continue;
      const lines = block.code.split("\n");
      const tokens = await client.tokens(doc, 0, lines.length);
      if (tokens) out.push({ index: block.index, lines: spansOf(lines, tokens, client.colorMap) });
    } finally {
      client.close(doc);
    }
  }
  return out;
}
