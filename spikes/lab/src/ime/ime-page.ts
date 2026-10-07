import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";

import { recordResult } from "../lab-api";

interface Scenario {
  id: string;
  title: string;
  instruction: string;
  doc: string;
  selection: EditorSelection;
  expected: string;
}

const SCENARIOS: Scenario[] = [
  {
    id: "plain",
    title: "빈 문서 입력",
    instruction: "「안녕하세요 한글 입력 테스트」를 입력한다",
    doc: "",
    selection: EditorSelection.single(0),
    expected: "안녕하세요 한글 입력 테스트",
  },
  {
    id: "middle",
    title: "문장 중간 삽입",
    instruction: "커서 자리에 「가운데 」(끝 공백 포함)를 입력한다",
    doc: "앞 뒤",
    selection: EditorSelection.single(2),
    expected: "앞 가운데 뒤",
  },
  {
    id: "multicursor",
    title: "멀티커서 3개",
    instruction: "세 줄 끝에 커서가 있는 상태에서 「한글」을 입력한다",
    doc: "하나\n둘\n셋",
    selection: EditorSelection.create([
      EditorSelection.cursor(2),
      EditorSelection.cursor(4),
      EditorSelection.cursor(6),
    ]),
    expected: "하나한글\n둘한글\n셋한글",
  },
  {
    id: "arrow-commit",
    title: "조합 중 화살표",
    instruction: "「한」만 입력하고(조합 중) → 키를 누른 뒤 「글」을 입력한다",
    doc: "",
    selection: EditorSelection.single(0),
    expected: "한글",
  },
  {
    id: "brackets",
    title: "괄호 자동 닫기",
    instruction: "「(」를 입력하고 이어서 「한글」을 입력한다",
    doc: "",
    selection: EditorSelection.single(0),
    expected: "(한글)",
  },
  {
    id: "enter",
    title: "조합 직후 Enter",
    instruction:
      "「한글」을 입력하고 바로 Enter, 이어서 「끝」을 입력한 뒤 Enter 없이 「확인」을 누른다",
    doc: "",
    selection: EditorSelection.single(0),
    expected: "한글\n끝",
  },
  {
    id: "replace-selections",
    title: "다중 선택 덮어쓰기",
    instruction: "두 「foo」가 선택된 상태에서 「가」를 입력한다",
    doc: "foo bar foo",
    selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(8, 11)]),
    expected: "가 bar 가",
  },
];

export function mountImePage(root: HTMLElement): void {
  root.innerHTML = `
    <p><a href="#">← 메뉴</a></p>
    <h1>한글 IME 검사</h1>
    <p>각 항목의 「시작」 → 지시대로 입력 → 「확인」. 모두 끝나면 「결과 저장」. 시작을 누른 뒤 편집기를 클릭하지 말고 바로 입력한다(클릭하면 준비된 커서·선택이 사라져 거짓 실패가 나온다). 마지막 글자는 Enter 로 확정하지 말고 바로 「확인」을 누른다(「확인」이 조합을 확정한다).</p>
    <div id="ime-list"></div>
    <div id="ime-editor" style="border:1px solid #888;height:200px;margin:8px 0"></div>
    <button id="ime-save">결과 저장</button>
    <div id="ime-save-status"></div>
    <pre id="ime-out"></pre>`;
  const view = new EditorView({
    parent: root.querySelector<HTMLElement>("#ime-editor")!,
    extensions: [basicSetup],
  });
  const results: Record<string, { pass: boolean; actual: string; expected: string }> = {};
  const list = root.querySelector<HTMLElement>("#ime-list")!;

  for (const s of SCENARIOS) {
    const row = document.createElement("div");
    row.innerHTML = `<b>${s.title}</b>: ${s.instruction} <button data-act="start">시작</button> <button data-act="check">확인</button> <span data-role="status"></span>`;
    row.querySelector('[data-act="start"]')!.addEventListener("click", () => {
      view.setState(
        EditorState.create({ doc: s.doc, selection: s.selection, extensions: [basicSetup] }),
      );
      view.focus();
    });
    row.querySelector('[data-act="check"]')!.addEventListener("click", () => {
      const actual = view.state.doc.toString();
      results[s.id] = { pass: actual === s.expected, actual, expected: s.expected };
      row.querySelector('[data-role="status"]')!.textContent = results[s.id].pass
        ? "통과"
        : `실패: ${JSON.stringify(actual)}`;
    });
    list.append(row);
  }

  root.querySelector("#ime-save")!.addEventListener("click", async () => {
    const status = root.querySelector("#ime-save-status")!;
    try {
      await recordResult("ime", { userAgent: navigator.userAgent, results });
      status.textContent = `저장됨 (${Object.keys(results).length}개 항목)`;
    } catch (err) {
      status.textContent = `저장 실패: ${String(err)}`;
    }
    root.querySelector("#ime-out")!.textContent = JSON.stringify(results, null, 2);
  });
}
