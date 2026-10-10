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

  /** Tokenizes ahead for about `budgetMs`, whole lines only. True once every line is cached. */
  advance(budgetMs: number): boolean {
    const until = performance.now() + budgetMs;
    while (this.cachedLines < this.lines.length) {
      this.tokenizeLine(this.cachedLines);
      if (performance.now() >= until) break;
    }
    return this.cachedLines >= this.lines.length;
  }

  private tokenizeLine(i: number): Uint32Array {
    const text = this.lines[i];
    const state = this.states[i];
    if (text.length > MAX_TOKENIZED_LINE_LENGTH) {
      this.states[i + 1] = state;
      return new Uint32Array();
    }
    const result = this.grammar.tokenizeLine2(text, state, 0);
    this.states[i + 1] = result.ruleStack;
    return encodeLine(result.tokens);
  }
}
