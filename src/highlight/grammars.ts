import type { IRawGrammar } from "@shikijs/vscode-textmate";

import type { LanguageInfo } from "../backend/types";
import { parseJsonc } from "../core/jsonc";
import type { Registry } from "../extensions/registry";
import type { GrammarSource } from "./protocol";

/** Scope names a grammar includes from other grammars (`source.js`, `text.html.basic#tag`),
 * in order of first appearance. `#local` and `$self`/`$base` are not includes of other files. */
export function collectIncludes(grammar: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (
        key === "include" &&
        typeof value === "string" &&
        !value.startsWith("#") &&
        !value.startsWith("$")
      ) {
        const scope = value.split("#")[0];
        if (scope && !found.includes(scope)) found.push(scope);
      } else {
        walk(value);
      }
    }
  };
  walk(grammar);
  return found;
}

/** The grammar of `lang` and every grammar it includes that some extension provides, read
 * through `read`. The registry's own grammar must load; an included one that cannot be read or
 * that nobody provides is left out, and the text inside it simply stays uncoloured (spec
 * 「오류 처리」 — a grammar that cannot be loaded means plain text, never a blocked file). */
export async function collectGrammars(
  registry: Registry,
  lang: LanguageInfo,
  read: (extensionId: string, path: string) => Promise<Uint8Array>,
): Promise<GrammarSource[]> {
  if (!lang.grammar) return [];
  const sources: GrammarSource[] = [];
  const seen = new Set<string>();
  const load = async (extensionId: string, path: string) =>
    parseJsonc<IRawGrammar>(new TextDecoder().decode(await read(extensionId, path)));
  const main = await load(lang.extension, lang.grammar.path);
  sources.push({ scopeName: lang.grammar.scopeName, grammar: main });
  seen.add(lang.grammar.scopeName);
  const queue = collectIncludes(main);
  while (queue.length) {
    const scope = queue.shift()!;
    if (seen.has(scope)) continue;
    seen.add(scope);
    const ref = registry.grammarForScope(scope);
    if (!ref) continue;
    try {
      const grammar = await load(ref.extension, ref.path);
      sources.push({ scopeName: scope, grammar });
      queue.push(...collectIncludes(grammar));
    } catch (error) {
      console.warn(`grammar ${scope} could not be read`, error);
    }
  }
  return sources;
}
