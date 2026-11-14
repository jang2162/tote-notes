import { describe, expect, it } from "vitest";

import type { MemoInfo, WorkspaceListItem } from "../backend/types";
import {
  COPY_PATH,
  DUPLICATE,
  memoRowMenu,
  pinsAll,
  movePick,
  moveTargets,
  REVEAL_IN_FINDER,
  tabFileItems,
  trashRowMenu,
  withRo,
} from "./context-menus";

const memo = (pinned = false): MemoInfo => ({
  id: "m",
  file: "a.md",
  autoTitle: false,
  modifiedMs: 0,
  size: 0,
  kind: "text",
  ...(pinned ? { pinned } : {}),
});

const workspace = (
  name: string,
  order: number | null,
  more: Partial<WorkspaceListItem> = {},
): WorkspaceListItem => ({
  name,
  path: `/w/${name}`,
  open: false,
  windows: 0,
  missing: false,
  order,
  hidden: false,
  orderable: true,
  ...more,
});

describe("moveTargets", () => {
  it("lists the switcher's workspaces in its order, leaving out this one, hidden and gone ones", () => {
    const list = [
      workspace("다", 2),
      workspace("가", 0),
      workspace("숨김", 1, { hidden: true }),
      workspace("지금", 3, { open: true, windows: 1 }),
      workspace("사라짐", null, { missing: true }),
      workspace("나", 4, { open: true, windows: 2 }),
    ];
    expect(moveTargets(list, "/w/지금").map((item) => item.name)).toEqual(["가", "다", "나"]);
  });
});

describe("memoRowMenu", () => {
  it("has the move submenu with each workspace, picked by its path", () => {
    const items = memoRowMenu([memo()], [workspace("가", 0), workspace("나".normalize("NFD"), 1)]);
    expect(items.map((item) => item.text)).toEqual([
      "이름 바꾸기…",
      "맨 위에 고정",
      "복제",
      "다른 워크스페이스로 옮기기",
      "",
      "Finder 에서 보기",
      "경로 복사",
      "",
      "휴지통으로 이동",
    ]);
    const move = items[3].items!;
    expect(move.map((item) => item.text)).toEqual(["가", "나"]);
    expect(move.map((item) => movePick(item.id))).toEqual(["/w/가", "/w/" + "나".normalize("NFD")]);
  });

  it("leaves the move out when there is nowhere to move to, and says 고정 해제 for a pinned memo", () => {
    const items = memoRowMenu([memo(true)], []);
    expect(items.some((item) => item.items)).toBe(false);
    expect(items[1].text).toBe("고정 해제");
  });

  it("leaves out what is for one memo alone when several are picked", () => {
    const items = memoRowMenu([memo(), memo(true)], [workspace("가", 0)]);
    expect(items.map((item) => item.text)).toEqual([
      "맨 위에 고정",
      "복제",
      "다른 워크스페이스로 옮기기",
      "",
      "휴지통으로 이동",
    ]);
    expect(memoRowMenu([memo(), memo()], []).map((item) => item.text)).toEqual([
      "맨 위에 고정",
      "복제",
      "",
      "휴지통으로 이동",
    ]);
  });

  it("says 고정 해제 for several only when every one of them is pinned", () => {
    expect(memoRowMenu([memo(true), memo(true)], [])[0].text).toBe("고정 해제");
    expect(pinsAll([memo(true), memo()])).toBe(true);
    expect(pinsAll([memo(true), memo(true)])).toBe(false);
  });

  it("tells a pick of the move submenu from the other items", () => {
    expect(movePick("move-to:/w/a:b")).toBe("/w/a:b");
    expect(movePick(DUPLICATE)).toBeNull();
    expect(movePick(null)).toBeNull();
  });
});

describe("tabFileItems", () => {
  it("copies only a memo, and shows every kind of tab's file", () => {
    expect(tabFileItems("memo").map((item) => item.id)).toEqual([
      "",
      DUPLICATE,
      REVEAL_IN_FINDER,
      COPY_PATH,
    ]);
    for (const kind of ["external", "trashed"] as const) {
      expect(tabFileItems(kind).map((item) => item.id)).toEqual(["", REVEAL_IN_FINDER, COPY_PATH]);
    }
  });
});

describe("trashRowMenu", () => {
  it("puts Finder between 복구 and 영구 삭제", () => {
    expect(trashRowMenu().map((item) => item.text)).toEqual([
      "복구",
      "Finder 에서 보기",
      "",
      "영구 삭제",
    ]);
  });
});

describe("trashRowMenu for several", () => {
  it("leaves Finder out", () => {
    expect(trashRowMenu(2).map((item) => item.text)).toEqual(["복구", "", "영구 삭제"]);
  });
});

describe("withRo", () => {
  it("picks 으로 or 로 by the last syllable", () => {
    expect(withRo("회사")).toBe("회사로");
    expect(withRo("서울")).toBe("서울로");
    expect(withRo("업무")).toBe("업무로");
    expect(withRo("메일함")).toBe("메일함으로");
    expect(withRo("메일함".normalize("NFD"))).toBe("메일함".normalize("NFD") + "으로");
    expect(withRo("Work")).toBe("Work(으)로");
    expect(withRo("")).toBe("(으)로");
  });
});
