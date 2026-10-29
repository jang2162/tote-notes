import { beforeEach, describe, expect, it, vi } from "vitest";

import { TauriBackend } from "./tauri";
import { BackendError } from "./types";

// Only invoke is under test; the window, webview and dialog modules reach the native side, so
// they are stubbed.
const { invoke, Channel } = vi.hoisted(() => ({
  invoke: vi.fn(),
  Channel: class {
    constructor(readonly onmessage: (message: unknown) => void) {}
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({}) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

// The command table of src-tauri/src/app/commands.rs. A renamed command or argument key fails
// only at runtime inside the app, so the names are pinned here.
describe("TauriBackend", () => {
  const backend = new TauriBackend();

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(new ArrayBuffer(0));
  });

  it("calls each command with the argument names commands.rs takes", async () => {
    const calls: [() => Promise<unknown>, string, Record<string, unknown> | undefined][] = [
      [() => backend.workspaceInfo(), "workspace_info", undefined],
      [() => backend.listMemos(), "list_memos", undefined],
      [() => backend.createMemo(), "create_memo", undefined],
      [() => backend.readMemo("m"), "read_memo", { id: "m" }],
      [() => backend.retitleMemo("m", "제목"), "retitle_memo", { id: "m", stem: "제목" }],
      [() => backend.renameMemo("m", "a.md"), "rename_memo", { id: "m", file: "a.md" }],
      [
        () => backend.setMemoLanguage("m", "python", "py"),
        "set_memo_language",
        { id: "m", language: "python", ext: "py" },
      ],
      [() => backend.deleteMemo("m"), "delete_memo", { id: "m" }],
      [() => backend.importFile("/a.sh"), "import_file", { path: "/a.sh" }],
      [() => backend.readWindowLayout(), "read_window_layout", undefined],
      [() => backend.writeWindowLayout("{}"), "write_window_layout", { json: "{}" }],
      [() => backend.takePendingOpens(), "take_pending_opens", undefined],
      [
        () => backend.claimTabs([{ kind: "memo", id: "m" }], true),
        "claim_tabs",
        { tabs: [{ kind: "memo", id: "m" }], reveal: true },
      ],
      [
        () => backend.releaseTab({ kind: "external", path: "/a.sh" }),
        "release_tab",
        { tab: { kind: "external", path: "/a.sh" } },
      ],
      [
        () => backend.tearOffTab("{}", { kind: "memo", id: "m" }),
        "tear_off_tab",
        { tab: "{}", tabRef: { kind: "memo", id: "m" }, at: null },
      ],
      [
        () => backend.tearOffTab("{}", { kind: "memo", id: "m" }, { x: -1500, y: 400 }),
        "tear_off_tab",
        { tab: "{}", tabRef: { kind: "memo", id: "m" }, at: { x: -1500, y: 400 } },
      ],
      [
        () => backend.showTabMenu([{ id: "x", text: "엑스" }]),
        "show_tab_menu",
        { items: [{ id: "x", text: "엑스" }] },
      ],
      [() => backend.openExternal("/a.sh"), "open_external", { path: "/a.sh" }],
      [() => backend.readExternal("/a.sh"), "read_external", { path: "/a.sh" }],
      [() => backend.readExternalDraft("/a.sh"), "read_external_draft", { path: "/a.sh" }],
      [() => backend.discardExternalDraft("/a.sh"), "discard_external_draft", { path: "/a.sh" }],
      [() => backend.listWorkspaces(), "list_workspaces", undefined],
      [
        () => backend.setWorkspaceOrder(["/w/업무", "/w/개인"], ["/w/개인"]),
        "set_workspace_order",
        { order: ["/w/업무", "/w/개인"], hidden: ["/w/개인"] },
      ],
      [() => backend.createWorkspace("업무"), "create_workspace", { name: "업무" }],
      [() => backend.openWorkspace("/w/업무"), "open_workspace", { path: "/w/업무" }],
      [() => backend.switchWorkspace("/w/업무"), "switch_workspace", { path: "/w/업무" }],
      [
        () => backend.relocateWorkspace("/gone/업무", "/new/업무"),
        "relocate_workspace",
        { from: "/gone/업무", to: "/new/업무" },
      ],
      [
        () => backend.flushDone(3, "저장하지 못한 메모 1개"),
        "flush_done",
        { id: 3, blocked: "저장하지 못한 메모 1개" },
      ],
      [() => backend.closeWindow(), "close_window", undefined],
      [() => backend.extensionRegistry(), "extension_registry", undefined],
      [
        () => backend.installExtension("/x.vsix", true),
        "install_extension",
        { path: "/x.vsix", replace: true },
      ],
      [() => backend.removeExtension("p.x"), "remove_extension", { id: "p.x" }],
      [
        () => backend.setExtensionEnabled("p.x", false),
        "set_extension_enabled",
        { id: "p.x", enabled: false },
      ],
      [() => backend.settings(), "get_settings", undefined],
      [() => backend.shortcutTable(), "shortcut_table", undefined],
      [() => backend.suspendShortcuts(true), "suspend_shortcuts", { on: true }],
      [() => backend.runMenuCommand("close-tab"), "run_menu_command", { id: "close-tab" }],
      [
        () => backend.issueFileToken({ kind: "memo", id: "m" }, "o"),
        "issue_file_token",
        { source: { kind: "memo", id: "m" }, owner: "o" },
      ],
      [() => backend.revokeFileTokens("o"), "revoke_file_tokens", { owner: "o" }],
      [
        () => backend.scanText({ kind: "memo", id: "m" }),
        "scan_text",
        { source: { kind: "memo", id: "m" } },
      ],
      [
        () =>
          backend.searchText(
            { kind: "external", path: "/x" },
            { query: "q", caseSensitive: false, regex: false },
            10,
            3,
          ),
        "search_text",
        {
          source: { kind: "external", path: "/x" },
          query: { query: "q", caseSensitive: false, regex: false },
          fromLine: 10,
          requestId: 3,
        },
      ],
      [
        () => backend.resolveRelative({ kind: "external", path: "/x/a.md" }, "p.png", "o"),
        "resolve_relative",
        { source: { kind: "external", path: "/x/a.md" }, relative: "p.png", owner: "o" },
      ],
      [
        () =>
          backend.patchSettings({
            workspaceRoot: null,
            themeDark: { extension: "tote.themes", label: "Light+" },
          }),
        "patch_settings",
        {
          patch: {
            workspaceRoot: null,
            themeDark: { extension: "tote.themes", label: "Light+" },
          },
        },
      ],
      [
        () => backend.readExtensionFile("p.x", "t.json"),
        "read_extension_file",
        { extensionId: "p.x", path: "t.json" },
      ],
    ];
    for (const [run, command, args] of calls) {
      invoke.mockClear();
      await run();
      expect(invoke).toHaveBeenCalledWith(command, args, undefined);
    }
  });

  it("hands the workspace search a channel that passes its events on", async () => {
    const events: unknown[] = [];
    const query = { query: "q", caseSensitive: true, regex: false };
    await backend.searchWorkspace(query, 4, (event) => events.push(event));
    const [command, args] = invoke.mock.lastCall!;
    expect(command).toBe("search_workspace");
    expect(args).toMatchObject({ query, requestId: 4 });
    const done = { kind: "done", filesSearched: 0, truncated: false, cancelled: false };
    args.onEvent.onmessage(done);
    expect(events).toEqual([done]);
    await backend.cancelWorkspaceSearch();
    expect(invoke).toHaveBeenLastCalledWith("cancel_workspace_search", undefined, undefined);
  });

  it("sends contents as raw bytes and names in percent-encoded headers", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await backend.writeMemo("id 1", bytes);
    expect(invoke).toHaveBeenLastCalledWith("write_memo", bytes, {
      headers: { "x-memo-id": "id%201" },
    });
    await backend.importMemo("회의.md", bytes);
    expect(invoke).toHaveBeenLastCalledWith("import_memo", bytes, {
      headers: { "x-file-name": "%ED%9A%8C%EC%9D%98.md" },
    });
    await backend.keepExternalDraft("/a b/c.sh", bytes);
    expect(invoke).toHaveBeenLastCalledWith("keep_external_draft", bytes, {
      headers: { "x-path": "%2Fa%20b%2Fc.sh" },
    });
    await backend.saveExternal("/a b/c.sh", bytes);
    expect(invoke).toHaveBeenLastCalledWith("save_external", bytes, {
      headers: { "x-path": "%2Fa%20b%2Fc.sh" },
    });
  });

  it("turns a rejection into a BackendError that keeps the code", async () => {
    invoke.mockRejectedValueOnce({ code: "unknown-memo", message: "no memo with id m" });
    const error = await backend.readMemo("m").catch((err: unknown) => err);
    expect(error).toBeInstanceOf(BackendError);
    expect(error).toMatchObject({ code: "unknown-memo", message: "no memo with id m" });
    invoke.mockRejectedValueOnce({ code: "from-a-newer-rust", message: "boom" });
    await expect(backend.listMemos()).rejects.toMatchObject({ code: "app", message: "boom" });
    invoke.mockRejectedValueOnce("the window is gone");
    await expect(backend.listMemos()).rejects.toMatchObject({ code: "app" });
  });

  // The codes commands.rs `install_update` and `restart_for_update` answer with: the dialog tells
  // 「받는 중」 and 「다른 창이 저장하는 중」 from a failure by them, and one folded into "app"
  // would read as a failure with 「다시 시도」.
  it("keeps the codes of the update commands", async () => {
    for (const code of ["no-update", "installing", "update-failed"]) {
      invoke.mockRejectedValueOnce({ code, message: "m" });
      await expect(backend.installUpdate(() => {})).rejects.toMatchObject({ code });
    }
    for (const code of ["not-installed", "busy"]) {
      invoke.mockRejectedValueOnce({ code, message: "m" });
      await expect(backend.restartForUpdate()).rejects.toMatchObject({ code });
    }
  });

  it("names bundled viewer pages by the tote-ext scheme", () => {
    expect(backend.viewerUrl("tote.markdown-preview", "viewer.html")).toBe(
      "tote-ext://localhost/tote.markdown-preview/viewer.html",
    );
  });
});
