import { BackendError, type TextQuery, type TextSearch } from "../../../src/backend/types";
import { LargeTextViewer } from "../../../src/viewer/large-text";

// A file of `?lines=` lines (6,000,000 by default) that exists only as an answer to Range
// requests: line i is "L" and i in nine digits, so every line is 11 bytes with its newline and
// a page is generated on demand. `?trailing=1` ends the file with a newline, as `seq` does.
// `?maxRange=<n>` answers at most n bytes at a time, as `tote-file` cuts a long range.
const params = new URLSearchParams(location.search);
const contentLines = Number(params.get("lines") ?? 6_000_000);
const trailing = params.has("trailing");
const maxRange = Number(params.get("maxRange") ?? Infinity);
const WIDTH = 11;
const URL_ = "fake:big";
const lineText = (i: number) => `L${String(i).padStart(9, "0")}`;
const size = contentLines * WIDTH - (trailing ? 0 : 1);
const lineCount = contentLines + (trailing ? 1 : 0);
const checkpoints: number[] = [];
for (let k = 0; k * 1000 < lineCount; k++) checkpoints.push(k * 1000 * WIDTH);

const fetchLog: [number, number][] = [];
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  if (input !== URL_) return realFetch(input, init);
  const range = new Headers(init?.headers).get("Range") ?? "";
  const [a, b] = range.replace("bytes=", "").split("-").map(Number);
  fetchLog.push([a, b]);
  if (a >= size || a > b) return new Response(null, { status: 416 });
  const end = Math.min(b, size - 1, a + maxRange - 1);
  const first = Math.floor(a / WIDTH);
  const last = Math.floor(end / WIDTH);
  let text = "";
  for (let i = first; i <= last; i++) text += `${lineText(i)}\n`;
  return new Response(text.slice(a - first * WIDTH, end - first * WIDTH + 1), {
    status: 206,
    headers: { "Content-Range": `bytes ${a}-${end}/${size}` },
  });
};

// Searches wait for the test to answer them, so their order can be chosen.
const searchCalls: {
  query: TextQuery;
  fromLine: number;
  resolve: (result: TextSearch) => void;
  reject: (error: unknown) => void;
}[] = [];

const viewer = new LargeTextViewer({
  url: URL_,
  scan: { size, lineCount, checkpoints, longestLine: WIDTH - 1 },
  fileName: "big.log",
  search: (query, fromLine) =>
    new Promise((resolve, reject) => searchCalls.push({ query, fromLine, resolve, reject })),
});
document.getElementById("host")!.append(viewer.el);
Object.assign(window, { largeTextViewer: viewer, searchCalls, fetchLog, BackendError, lineText });
