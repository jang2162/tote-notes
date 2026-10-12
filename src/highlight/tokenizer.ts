import {
  EncodedTokenMetadata,
  INITIAL,
  type IGrammar,
  type StateStack,
} from "@shikijs/vscode-textmate";

/** A line longer than this is not tokenized (spec 「크기별 단계」 — VS Code's default). */
export const MAX_TOKENIZED_LINE_LENGTH = 20_000;

/** `[start, foreground, fontStyle]` per token, decoded from the binary metadata. */
export function encodeLine(binary: Uint32Array): Uint32Array {
  const count = binary.length / 2;
  const out = new Uint32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const meta = binary[i * 2 + 1];
    out[i * 3] = binary[i * 2];
    out[i * 3 + 1] = EncodedTokenMetadata.getForeground(meta);
    out[i * 3 + 2] = EncodedTokenMetadata.getFontStyle(meta);
  }
  return out;
}

/** Tokenizes one document line by line, keeping the grammar state at the start of every line
 * it has seen (spec 「성능」). An edit drops the states from its first line on, so what comes
 * before it is never redone. No wall-clock limit inside a line: a line cut short would leave a
 * wrong state in the cache and colour every line after it wrongly. */
export class LineTokenizer {
  private lines: string[];
  /** states[i] is the state at the start of line i; states[0] is INITIAL. */
  private states: StateStack[] = [INITIAL];

  constructor(
    private readonly grammar: IGrammar,
    text: string,
  ) {
    this.lines = text.split("\n");
  }

  get lineCount(): number {
    return this.lines.length;
  }

  /** How many lines from the top have a known end state. */
  get cachedLines(): number {
    return this.states.length - 1;
  }

  edit(fromLine: number, toLine: number, insert: string[]): void {
    this.lines = this.lines.slice(0, fromLine).concat(insert, this.lines.slice(toLine));
    this.states.length = Math.min(this.states.length, fromLine + 1);
  }

  /** Forgets every state (the theme changed: old states carry old colour ids). */
  reset(): void {
    this.states.length = 1;
  }

  /** Tokens of lines [from, to). Lines before `from` that have no state yet are tokenized on
   * the way (their tokens are dropped, their states kept). */
  tokens(from: number, to: number): Uint32Array[] {
    const end = Math.min(to, this.lines.length);
    for (let i = this.cachedLines; i < from && i < end; i++) this.tokenizeLine(i);
    const out: Uint32Array[] = [];
    for (let i = from; i < end; i++) out.push(this.tokenizeLine(i));
    return out;
  }

  /** Tokens of lines [from, to), or null when the state at the start of `from` is not known
   * yet: answers from the cache without catching up to `from`. */
  tokensIfCached(from: number, to: number): Uint32Array[] | null {
    return from <= this.cachedLines ? this.tokens(from, to) : null;
  }

  /** Tokens of lines [from, to) from the grammar's initial state, the cache left alone: a guess
   * for lines the cache has not reached, as VS Code colours a far viewport before its states
   * catch up. Wrong inside anything opened above `from` (a block comment, a template string)
   * until the exact tokens replace it. */
  guessTokens(from: number, to: number): Uint32Array[] {
    const out: Uint32Array[] = [];
    let state = INITIAL;
    for (let i = from; i < Math.min(to, this.lines.length); i++) {
      const result = this.tokenize(i, state);
      state = result.state;
      out.push(result.tokens);
    }
    return out;
  }

  /** Tokenizes ahead for about `budgetMs`, whole lines only, up to line `until`. True once every
   * line before `until` is cached. */
  advance(budgetMs: number, until = this.lines.length): boolean {
    const end = Math.min(until, this.lines.length);
    const stop = performance.now() + budgetMs;
    while (this.cachedLines < end) {
      this.tokenizeLine(this.cachedLines);
      if (performance.now() >= stop) break;
    }
    return this.cachedLines >= end;
  }

  private tokenizeLine(i: number): Uint32Array {
    const { tokens, state } = this.tokenize(i, this.states[i]);
    this.states[i + 1] = state;
    return tokens;
  }

  private tokenize(i: number, state: StateStack): { tokens: Uint32Array; state: StateStack } {
    const text = this.lines[i];
    if (text.length > MAX_TOKENIZED_LINE_LENGTH) return { tokens: new Uint32Array(), state };
    const result = this.grammar.tokenizeLine2(text, state, 0);
    return { tokens: encodeLine(result.tokens), state: result.ruleStack };
  }
}
