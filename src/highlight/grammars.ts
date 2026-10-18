import type { LanguageInfo } from "../backend/types";
import { pageLeaving } from "../core/leaving";
import type { Registry } from "../extensions/registry";
import type { GrammarSource } from "./protocol";

/** Scope names a grammar includes from other grammars (`source.js`, `text.html.basic#tag`),
 * in order of first appearance. `#local` and `$self`/`$base` are not includes of other files.
 * The worker runs it on every grammar it is sent. */
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

/** Sends the grammar of `lang`, then every grammar it includes that some extension provides,
 * read through `read`, and returns the scopes sent. Each file goes as text: `send` hands a batch
 * to the worker, which parses it and answers with the includes it does not hold yet. The
 * registry's own grammar must be read; an included one that cannot be read or that nobody
 * provides is left out, and the text inside it simply stays uncoloured (spec 「오류 처리」 — a
 * grammar that cannot be loaded means plain text, never a blocked file). */
export async function collectGrammars(
  registry: Registry,
  lang: LanguageInfo,
  read: (extensionId: string, path: string) => Promise<Uint8Array>,
  send: (batch: GrammarSource[]) => Promise<string[]>,
): Promise<string[]> {
  if (!lang.grammar) return [];
  const load = async (extensionId: string, path: string) =>
    new TextDecoder().decode(await read(extensionId, path));
  const loadIncluded = async (scope: string): Promise<GrammarSource | null> => {
    const ref = registry.grammarForScope(scope);
    if (!ref) return null;
    try {
      return { scopeName: scope, text: await load(ref.extension, ref.path) };
    } catch (error) {
      if (!pageLeaving()) console.warn(`grammar ${scope} could not be read`, error);
      return null;
    }
  };
  const scopeName = lang.grammar.scopeName;
  const sent: string[] = [];
  const tried = new Set([scopeName]);
  let batch: GrammarSource[] = [{ scopeName, text: await load(lang.extension, lang.grammar.path) }];
  while (batch.length) {
    sent.push(...batch.map((source) => source.scopeName));
    const missing = (await send(batch)).filter((scope) => !tried.has(scope));
    for (const scope of missing) tried.add(scope);
    const loaded = await Promise.all(missing.map(loadIncluded));
    batch = loaded.filter((source): source is GrammarSource => source !== null);
  }
  return sent;
}
