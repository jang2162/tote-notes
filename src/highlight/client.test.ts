import { describe, expect, it } from "vitest";

import type { ExtensionRegistry, LanguageInfo } from "../backend/types";
import { Registry } from "../extensions/registry";
import { HighlightClient } from "./client";
import type { WorkerRequest } from "./protocol";

const lang = {
  id: "a",
  extension: "e",
  grammar: { scopeName: "source.a", path: "a.json" },
} as unknown as LanguageInfo;

const registry = new Registry({
  extensions: [],
  languages: [lang],
  grammars: [],
  themes: [],
  viewers: [],
  problems: [],
} as ExtensionRegistry);

function setup() {
  const sent: WorkerRequest[] = [];
  const worker = {
    postMessage: (request: WorkerRequest) => sent.push(request),
    addEventListener: () => {},
  } as unknown as Worker;
  let reads = 0;
  const read = async () => {
    reads++;
    return new TextEncoder().encode('{"scopeName":"source.a","patterns":[]}');
  };
  const client = new HighlightClient(worker, () => registry, read);
  const grammarMessages = () => sent.filter((r) => r.type === "grammars").length;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { client, grammarMessages, reads: () => reads, settle };
}

describe("HighlightClient grammar cache", () => {
  it("sends a language's grammars once, and again after they are forgotten", async () => {
    const { client, grammarMessages, reads, settle } = setup();
    void client.open(1, lang, () => "x");
    await settle();
    void client.open(2, lang, () => "x");
    await settle();
    expect(grammarMessages()).toBe(1);
    expect(reads()).toBe(1);
    // An extension was reinstalled or replaced: its files may differ now.
    client.forgetGrammars();
    void client.open(3, lang, () => "x");
    await settle();
    expect(grammarMessages()).toBe(2);
    expect(reads()).toBe(2);
  });
});
