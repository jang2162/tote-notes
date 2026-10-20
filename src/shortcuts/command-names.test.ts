import { describe, expect, it } from "vitest";

import { editorKeymap } from "../editor/setup";
import { commandName } from "./command-names";

describe("commandName", () => {
  // The guarantee that stands where `keepNames` stood: a command added to the keymap that the table
  // in command-names.ts lacks would read 편집기 명령 in the settings.
  it("names every command the editor keymap binds", () => {
    const unnamed: string[] = [];
    for (const binding of editorKeymap)
      for (const run of [binding.run, binding.shift])
        if (run && commandName(run) === undefined)
          unnamed.push(`${binding.mac ?? binding.key} (${run.name})`);
    expect(unnamed).toEqual([]);
  });
});
