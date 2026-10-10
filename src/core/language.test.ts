import { Text } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";

import fake from "../backend/fake-registry.json";
import type { ExtensionRegistry } from "../backend/types";
import { detectLanguage, firstLineOf } from "./language";

const languages = (fake as ExtensionRegistry).languages;

describe("detectLanguage", () => {
  it("recognises a shebang through a language's firstLine pattern", () => {
    expect(detectLanguage("#!/bin/bash\necho hi", languages)?.id).toBe("shellscript");
    expect(detectLanguage("#!/usr/bin/env python3\nprint(1)", languages)?.id).toBe("python");
    expect(detectLanguage('<?xml version="1.0"?>\n<a/>', languages)?.id).toBe("xml");
  });

  it("recognises whole-document JSON starting with { or [", () => {
    expect(detectLanguage('{"a": [1, 2]}', languages)?.id).toBe("json");
    expect(detectLanguage("  [1, 2, 3]\n", languages)?.id).toBe("json");
    expect(detectLanguage("{ not json", languages)).toBeNull();
    expect(detectLanguage("1", languages)).toBeNull();
  });

  it("guesses nothing else", () => {
    expect(detectLanguage("# 회의 준비\n- 안건", languages)).toBeNull();
    expect(detectLanguage("", languages)).toBeNull();
    expect(detectLanguage("echo hi", languages)).toBeNull();
  });

  it("skips a firstLine pattern that is not a valid expression", () => {
    const broken = [{ ...languages[0], id: "broken", firstLine: "[" }];
    expect(detectLanguage("[1]", broken)).toBeNull();
  });

  it("firstLineOf stops at the first line break of either kind", () => {
    expect(firstLineOf("a\r\nb")).toBe("a");
    expect(firstLineOf("a")).toBe("a");
  });

  it("reads only the first line of a document that cannot be JSON", () => {
    const doc = Text.of(["# 회의 준비", "- 안건"]);
    const whole = vi.spyOn(doc, "toString");
    const slice = vi.spyOn(doc, "sliceString");
    expect(detectLanguage(doc, languages)).toBeNull();
    expect(whole).not.toHaveBeenCalled();
    expect(slice).not.toHaveBeenCalled();
    expect(detectLanguage(Text.of(["#!/bin/sh", "echo"]), languages)?.id).toBe("shellscript");
    expect(detectLanguage(Text.of(["", '  {"a": 1}']), languages)?.id).toBe("json");
  });
});
