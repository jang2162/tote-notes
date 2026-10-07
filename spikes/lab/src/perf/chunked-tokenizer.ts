import type { GrammarState, HighlighterCore, ThemedToken } from "shiki/core";

export const DEFAULT_CHUNK_LINES = 200;
export const MAX_TOKENIZED_LINE_LENGTH = 20_000;

export interface LineToken {
  content: string;
  /** Offset from the start of the line, not of the chunk Shiki tokenized. */
  offset: number;
  color?: string;
}

export interface ChunkedTokenizerOptions {
  lang: string;
  theme: string;
  chunkLines?: number;
  /** Lines longer than this are left as one uncolored token; 0 tokenizes every line. */
  maxLineLength?: number;
  /** Per-line tokenizing time limit in ms; 0 lifts it, and leaving it out keeps Shiki's default. */
  timeLimit?: number;
}

/**
 * Tokenizes in fixed line chunks and caches the grammar state at each chunk start, so a request
 * deep in the file re-tokenizes only from the last valid chunk, and constructs opened in one chunk
 * (block comments, template strings) keep their color in the next.
 */
export class ChunkedTokenizer {
  private lines: string[];
  // states[k] is the grammar state at the start of chunk k; undefined is the initial state.
  private states: (GrammarState | undefined)[] = [undefined];
  private readonly chunkLines: number;
  private readonly maxLineLength: number;

  constructor(
    private readonly hl: HighlighterCore,
    text: string,
    private readonly opts: ChunkedTokenizerOptions,
  ) {
    this.lines = text.split("\n");
    this.chunkLines = opts.chunkLines ?? DEFAULT_CHUNK_LINES;
    this.maxLineLength = opts.maxLineLength ?? MAX_TOKENIZED_LINE_LENGTH;
  }

  get lineCount(): number {
    return this.lines.length;
  }

  /** Number of chunks whose start state is cached; exposed so tests can catch over-invalidation. */
  get cachedChunkCount(): number {
    return this.states.length;
  }

  /** Replaces lines [fromLine, toLine) with `insert` and drops every cached state the edit can affect. */
  edit(fromLine: number, toLine: number, insert: string[]): void {
    this.lines = this.lines.slice(0, fromLine).concat(insert, this.lines.slice(toLine));
    this.states.length = Math.min(this.states.length, Math.floor(fromLine / this.chunkLines) + 1);
  }

  /** Tokens for lines [from, to). */
  tokens(from: number, to: number): LineToken[][] {
    const chunk = Math.floor(from / this.chunkLines);
    this.ensureStates(chunk);
    const start = chunk * this.chunkLines;
    const raw = this.tokenize(this.lines.slice(start, to).join("\n"), this.states[chunk]);
    return raw.slice(from - start).map(toLineTokens);
  }

  private ensureStates(chunk: number): void {
    while (this.states.length <= chunk) {
      const k = this.states.length - 1;
      const text = this.lines.slice(k * this.chunkLines, (k + 1) * this.chunkLines).join("\n");
      this.states.push(this.hl.getLastGrammarState(this.tokenize(text, this.states[k])));
    }
  }

  private tokenize(text: string, grammarState: GrammarState | undefined): ThemedToken[][] {
    return this.hl.codeToTokensBase(text, {
      lang: this.opts.lang,
      theme: this.opts.theme,
      grammarState,
      // Shiki skips lines whose length is >= this, while maxLineLength is the longest line still
      // tokenized; 0 means no limit in both.
      tokenizeMaxLineLength: this.maxLineLength > 0 ? this.maxLineLength + 1 : 0,
      tokenizeTimeLimit: this.opts.timeLimit,
    });
  }
}

function toLineTokens(line: ThemedToken[]): LineToken[] {
  let offset = 0;
  return line.map((t) => {
    // Shiki marks a skipped line with an empty color string.
    const token = { content: t.content, offset, color: t.color || undefined };
    offset += t.content.length;
    return token;
  });
}
