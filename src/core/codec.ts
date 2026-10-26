/** Text files as tote reads and writes them: UTF-8 only, with the BOM and the line endings kept
 * as found (spec 「저장」). */

export type Eol = "\n" | "\r\n";

export interface DecodedText {
  text: string;
  eol: Eol;
  bom: boolean;
}

const BOM = [0xef, 0xbb, 0xbf];
/** The binary test the spec uses for backups too: a NUL byte in the first 8 KB. */
export const BINARY_PROBE_BYTES = 8192;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/** The text of `bytes`, or `null` when they are not text (binary, or not valid UTF-8). */
export function decodeText(bytes: Uint8Array): DecodedText | null {
  if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return null;
  const bom = BOM.every((byte, i) => bytes[i] === byte);
  let text: string;
  try {
    text = decoder.decode(bom ? bytes.subarray(BOM.length) : bytes);
  } catch {
    return null;
  }
  return { text, eol: lineEnding(text), bom };
}

/** CRLF only when it outnumbers bare LF: one stray CRLF in a shell script must not turn every
 * line into CRLF on the next save (`#!/bin/sh\r` breaks). */
function lineEnding(text: string): Eol {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > lf ? "\r\n" : "\n";
}

/** `text` must already use the file's line ending (`Text.sliceString(0, length, eol)`). */
export function encodeText(text: string, bom: boolean): Uint8Array {
  const body = encoder.encode(text);
  if (!bom) return body;
  const out = new Uint8Array(BOM.length + body.length);
  out.set(BOM);
  out.set(body, BOM.length);
  return out;
}

/** Length of the longest line. Soft wrap stays off above a limit: wrapping one huge line costs
 * seconds. */
export function longestLine(text: string): number {
  let longest = 0;
  let start = 0;
  for (;;) {
    const end = text.indexOf("\n", start);
    const stop = end === -1 ? text.length : end;
    longest = Math.max(longest, stop - start);
    if (end === -1) return longest;
    start = end + 1;
  }
}
