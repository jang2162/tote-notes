import { Marked, marked } from "marked";
import { describe, expect, it } from "vitest";

import { taskLines, toggleTask } from "./tasks";

/** How many checkboxes `marked` draws for `text`: what the viewer numbers. */
function drawn(text: string): number {
  return marked.parse(text, { async: false, gfm: true }).match(/<input /g)?.length ?? 0;
}

function apply(text: string, index: number): string | null {
  const change = toggleTask(text, index);
  return change ? text.slice(0, change.from) + change.insert + text.slice(change.to) : null;
}

describe("taskLines", () => {
  it("gives the line of each task in the order marked draws its checkbox", () => {
    const text = ["# 할 일", "", "- [ ] 하나", "- [x] 둘", "- 그냥", "- [X] 셋"].join("\n");
    expect(taskLines(text)).toEqual([2, 3, 5]);
    expect(drawn(text)).toBe(3);
  });

  it("does not count a task-looking line in a fenced or an indented code block", () => {
    const text = [
      "- [ ] 앞",
      "",
      "```md",
      "- [ ] 코드 안",
      "```",
      "",
      "    - [ ] 들여 쓴 코드",
      "",
      "- [x] 뒤",
    ].join("\n");
    expect(taskLines(text)).toEqual([0, 8]);
  });

  it("counts tasks in a quote, with or without a lazy line", () => {
    const text = ["> - [ ] 인용", "> 이어짐", "> - [x] 둘", "", "- [ ] 밖"].join("\n");
    expect(taskLines(text)).toEqual([0, 2, 4]);
    expect(drawn(text)).toBe(3);
  });

  it("counts nested lists depth first, a parent before its children", () => {
    const text = [
      "- [ ] 부모",
      "  - [x] 자식",
      "    - [ ] 손자",
      "  - [ ] 자식 둘",
      "- [ ] 다음",
    ].join("\n");
    expect(taskLines(text)).toEqual([0, 1, 2, 3, 4]);
    expect(drawn(text)).toBe(5);
  });

  it("counts a loose list, its items apart by blank lines and with more paragraphs", () => {
    const text = ["- [ ] 하나", "", "  더 쓴 문단", "", "- [x] 둘", "", "1. [ ] 번호"].join("\n");
    expect(taskLines(text)).toEqual([0, 4, 6]);
    expect(drawn(text)).toBe(3);
  });

  it("counts ordered lists and other bullets", () => {
    const text = ["1. [ ] 가", "2) [x] 나", "", "* [ ] 다", "", "+ [ ] 라"].join("\n");
    expect(taskLines(text)).toEqual([0, 1, 3, 5]);
  });

  it("reads CRLF and CR line ends as the editor does", () => {
    expect(taskLines("# 제목\r\n\r\n- [ ] 가\r\n- [x] 나")).toEqual([2, 3]);
    expect(taskLines("# 제목\r\r- [ ] 가\r- [x] 나")).toEqual([2, 3]);
  });

  it("does not count checkboxes written as HTML, nor a bracket that is not a task", () => {
    const text = [
      '<input type="checkbox" checked>',
      "",
      "<div>",
      "- [ ] HTML 블록 안",
      "</div>",
      "",
      "- [ ]",
      "- [] 아님",
      "- [ ] 진짜",
    ].join("\n");
    expect(taskLines(text)).toEqual([8]);
    // The HTML one is drawn by the browser, not by marked's renderer: the viewer drops it.
    expect(drawn(text)).toBe(2);
  });

  it("comes after definitions, headings, tables and a front paragraph", () => {
    const text = [
      "[a]: https://example.com",
      "제목",
      "===",
      "",
      "| a | b |",
      "| - | - |",
      "| [ ] | x |",
      "",
      "문단",
      "- [ ] 문단에 붙은 목록",
    ].join("\n");
    expect(taskLines(text)).toEqual([9]);
  });
});

describe("toggleTask", () => {
  it("finds every box marked draws in a mixed document, each on a line that holds it", () => {
    const text = [
      "# 계획",
      "",
      "> 인용",
      "> - [ ] 인용 할 일",
      ">   - [x] 그 아래",
      "",
      "1. [ ] 첫째",
      "",
      "   ```",
      "   - [ ] 항목 안 코드",
      "   ```",
      "",
      "   - [x] 항목 안 목록",
      "2. [x] 둘째",
      "",
      "| 표 | - [ ] |",
      "| -- | ----- |",
      "",
      "- [ ] 끝 *강조*",
      "  이어지는 줄",
      "- [x] **굵게**",
    ].join("\n");
    const n = drawn(text);
    expect(n).toBe(7);
    expect(taskLines(text)).toHaveLength(n);
    for (let i = 0; i < n; i++) expect(toggleTask(text, i), `task ${i}`).not.toBeNull();
  });

  it("flips the n-th task's box and nothing else", () => {
    const text = ["- [ ] 하나", "- [x] 둘", "  - [X] 셋"].join("\n");
    expect(apply(text, 0)).toBe(["- [x] 하나", "- [x] 둘", "  - [X] 셋"].join("\n"));
    expect(apply(text, 1)).toBe(["- [ ] 하나", "- [ ] 둘", "  - [X] 셋"].join("\n"));
    expect(apply(text, 2)).toBe(["- [ ] 하나", "- [x] 둘", "  - [ ] 셋"].join("\n"));
  });

  it("changes one character, in a quote too", () => {
    const text = "> 1. [ ] 인용 안";
    expect(toggleTask(text, 0)).toEqual({ from: 6, to: 7, insert: "x" });
  });

  it("keeps CRLF line ends", () => {
    expect(apply("# 제목\r\n\r\n- [ ] 가\r\n- [ ] 나\r\n", 1)).toBe(
      "# 제목\r\n\r\n- [ ] 가\r\n- [x] 나\r\n",
    );
  });

  it("finds nothing past the last task or before the first", () => {
    expect(toggleTask("- [ ] 하나", 1)).toBeNull();
    expect(toggleTask("- [ ] 하나", -1)).toBeNull();
    expect(toggleTask("그냥 글", 0)).toBeNull();
  });

  it("leaves a task inside a code block alone, whatever index points past it", () => {
    const text = ["```", "- [ ] 코드", "```", "- [ ] 진짜"].join("\n");
    expect(apply(text, 0)).toBe(["```", "- [ ] 코드", "```", "- [x] 진짜"].join("\n"));
    expect(toggleTask(text, 1)).toBeNull();
  });

  it("turns a text the preview was not drawn from away: the n-th task may be another one now", () => {
    const shown = ["- [ ] 하나", "- [ ] 둘"].join("\n");
    const now = ["- [ ] 새 줄", "- [ ] 하나", "- [ ] 둘"].join("\n");
    expect(toggleTask(now, 1, shown)).toBeNull();
    expect(toggleTask(shown, 1, shown)).toEqual({ from: 12, to: 13, insert: "x" });
  });
});

/** The boxes the preview draws for `text`, in order, `X` checked and `O` not: marked's own
 * renderer, as the viewer calls it — apart from the token walk `toggleTask` counts with. */
const renderer = new Marked({
  renderer: {
    checkbox: ({ checked }) => (checked ? "\uE000X" : "\uE000O"),
  },
});
function boxes(text: string): string {
  const html = renderer.parse(text, { async: false, gfm: true });
  return [...html.matchAll(/\uE000([XO])/g)].map((m) => m[1]).join("");
}

/** The text after pressing box `index`; null when the press was turned away. */
function pressed(text: string, index: number): string | null {
  const change = toggleTask(text, index);
  return change ? text.slice(0, change.from) + change.insert + text.slice(change.to) : null;
}

/** The boxes of `before` with box `index` flipped: what pressing it must draw, and nothing else. */
function flipped(before: string, index: number): string {
  const states = [...before];
  states[index] = states[index] === "X" ? "O" : "X";
  return states.join("");
}

describe("a press changes the box pressed or nothing", () => {
  // Marked's tokens do not always add up to the text: a quote split by a line without `>` gains a
  // line end in its raw, a definition in a quote loses one. Counting lines by them goes wrong there.
  it("in a quote whose items go on in lines without `>`", () => {
    const text = [
      "> - [ ] 우유",
      "저녁 전에",
      "> - [ ] 빵",
      "아침용",
      "- [ ] 청소",
      "- [ ] 빨래",
      "- [ ] 설거지",
    ].join("\n");
    const before = boxes(text);
    for (let i = 0; i < before.length; i++) {
      const after = pressed(text, i);
      if (after !== null) expect(boxes(after), `box ${i}`).toBe(flipped(before, i));
    }
    expect(boxes(pressed(text, 2) ?? text)).toBe(flipped(before, 2));
  });

  it("after a definition in a quote", () => {
    const text = "> [q]: /q\nlazy\n> - [x] a\n> - [ ] b";
    expect(boxes(text)).toBe("XO");
    expect(pressed(text, 1)).toBe("> [q]: /q\nlazy\n> - [x] a\n> - [x] b");
    expect(pressed(text, 0)).toBe("> [q]: /q\nlazy\n> - [ ] a\n> - [ ] b");
  });

  it("never on a paragraph line that only looks like a box", () => {
    const text = [
      "> - [ ] quoted",
      "  continuation",
      "> - [ ] quoted",
      "  continuation",
      "- [ ] a",
      "-   [ ] wide",
      "[ ] bare",
    ].join("\n");
    const before = boxes(text);
    for (let i = 0; i < before.length; i++) {
      const after = pressed(text, i);
      if (after !== null) expect(boxes(after), `box ${i}`).toBe(flipped(before, i));
      expect(after ?? "", `box ${i}`).not.toContain("[x] bare");
    }
  });
});

/** A small generator with a fixed seed: the same documents every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const PIECES = [
  "- [ ] a",
  "- [x] b",
  "* [X] c",
  "+ [ ] d",
  "1. [ ] e",
  "2) [x] f",
  "  - [ ] nested",
  "    - [x] deeper",
  "      - [ ] deepest",
  "    - [ ] deep or code",
  "-   [ ] wide",
  "- [ ]",
  "- [] not",
  "- [ ]no space",
  "[ ] bare",
  "text with [ ] inside",
  "> - [ ] quoted",
  "> - [x] quoted done",
  "> > - [ ] twice quoted",
  "> text",
  ">",
  "> [q]: /q",
  "[r]: /r",
  "lazy line",
  "  continuation",
  "",
  "",
  "```",
  "```md",
  "~~~",
  "- [ ] in fence?",
  "    indented code",
  "# heading",
  "heading",
  "===",
  "---",
  "| a | b |",
  "| - | - |",
  "| [ ] | [x] |",
  "<div>",
  "</div>",
  '<input type="checkbox" checked>',
  "<!-- - [ ] comment -->",
  "- item",
  "  - [ ] under item",
  "1. one",
  "   - [x] under one",
  "> - item",
  ">   - [ ] under quoted item",
  "- > - [ ] quote in item",
  "- - [ ] list in item",
  "\t- [ ] tab",
  "- [ ] *em* **strong** `code`",
  "- [x] [link](a.md)",
];

describe("pressing every box of many generated documents", () => {
  it("changes the box pressed and no other, or changes nothing", () => {
    const next = random(20261114);
    let presses = 0;
    let refused = 0;
    for (let doc = 0; doc < 3000; doc++) {
      const lines = Array.from(
        { length: 2 + Math.floor(next() * 12) },
        () => PIECES[Math.floor(next() * PIECES.length)],
      );
      const text = lines.join(next() < 0.1 ? "\r\n" : "\n");
      const before = boxes(text);
      for (let i = 0; i < before.length; i++) {
        presses++;
        const after = pressed(text, i);
        if (after === null) {
          refused++;
          continue;
        }
        expect(boxes(after), JSON.stringify({ text, i })).toBe(flipped(before, i));
        expect(after.length).toBe(text.length);
      }
    }
    expect(presses).toBeGreaterThan(1000);
    // Turning a press away is the safe failure, not the usual answer.
    expect(refused).toBeLessThan(presses / 100);
    if (process.env.TASKS_FUZZ_REPORT) console.log({ presses, refused });
    // Synchronous: a time-out here measures the machine, not the presses (docs/guides/development.md
    // 「부하에서만 실패하는 테스트는 …」).
  }, 60_000);
});
