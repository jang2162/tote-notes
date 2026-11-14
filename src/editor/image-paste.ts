import { isolateHistory } from "@codemirror/commands";
import {
  Facet,
  StateEffect,
  StateField,
  type ChangeDesc,
  type EditorState,
  type Extension,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { BackendError, type ImportedImage, type MemoInfo } from "../backend/types";
import {
  IMAGE_TOO_LARGE,
  imageLink,
  isImageName,
  MAX_IMAGE_BYTES,
  pastedImageName,
  PASTED_IMAGE_TYPES,
} from "../core/images";
import { basename, splitName } from "../core/names";

/** What a memo's editor asks of the app to take an image in (spec
 * docs/superpowers/specs/2026-11-14-tote-notes-image-paste-design.md). */
export interface ImageHost {
  /** Whether the tab takes images now: a Markdown memo whose text the editor shows. */
  accepts(): boolean;
  /** The memo's file name, which a pasted image is named after. */
  memoFile(): string;
  saveImage(fileName: string, bytes: Uint8Array): Promise<MemoInfo>;
  importImage(path: string): Promise<ImportedImage>;
  /** Applies what `make` returns to the tab's text where it is now — the pane's editor when it
   * shows the tab, the tab's own state when not. Nothing when the tab is closed. */
  apply(make: (state: EditorState) => TransactionSpec | null): void;
  /** A new file is in the workspace: the memo list shows it. */
  added(memo: MemoInfo): void;
  notice(message: string): void;
  report(error: unknown): void;
}

/** Whether a tab of `fileName` with the registry's `languageId` is Markdown — the rule
 * `languageFor` in src/editor/setup.ts gives the editor its Markdown support by. */
export function isMarkdown(fileName: string, languageId: string | undefined): boolean {
  if (languageId !== undefined) return languageId === "markdown";
  return /^(md|markdown)$/i.test(splitName(fileName).ext);
}

const imageHost = Facet.define<ImageHost, ImageHost | null>({
  combine: (hosts) => hosts[0] ?? null,
});

/** Where the links of an image on its way will go: the selection it replaces, moved along with
 * the edits made while it is saved. */
interface Spot {
  id: number;
  from: number;
  to: number;
}

// Both ends stay in front of text typed at them meanwhile: the image came first.
const mapSpot = (spot: Spot, changes: ChangeDesc): Spot => {
  const from = changes.mapPos(spot.from, -1);
  return { id: spot.id, from, to: Math.max(from, changes.mapPos(spot.to, -1)) };
};

const addSpot = StateEffect.define<Spot>({ map: mapSpot });
const dropSpot = StateEffect.define<number>();

const spots = StateField.define<readonly Spot[]>({
  create: () => [],
  update(value, tr) {
    let next = tr.docChanged ? value.map((spot) => mapSpot(spot, tr.changes)) : value;
    for (const effect of tr.effects) {
      if (effect.is(addSpot)) next = [...next, effect.value];
      else if (effect.is(dropSpot)) next = next.filter((spot) => spot.id !== effect.value);
    }
    return next;
  },
});

let nextSpot = 0;

/** Marks the main selection of `view` as the place of an image on its way. */
function holdSpot(view: EditorView, at?: number): number {
  const id = nextSpot++;
  const { from, to } = view.state.selection.main;
  view.dispatch({
    effects: addSpot.of(at === undefined ? { id, from, to } : { id, from: at, to: at }),
  });
  return id;
}

/** Puts the links of `files` at spot `id` — or at the cursor when the tab's state was replaced
 * since (another app's change read in) — one per line, as one undo step, the cursor after them.
 * No files: the spot is let go. */
function placeLinks(host: ImageHost, id: number, files: readonly string[], userEvent: string) {
  host.apply((state) => {
    const spot = state.field(spots, false)?.find((each) => each.id === id);
    const effects = spot ? [dropSpot.of(id)] : [];
    if (files.length === 0) return effects.length ? { effects } : null;
    const { from, to } = spot ?? state.selection.main;
    const insert = files.map(imageLink).join("\n");
    return {
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
      effects,
      userEvent,
      scrollIntoView: true,
      annotations: isolateHistory.of("full"),
    };
  });
}

/** The image a paste of `data` brings, or null: the clipboard has text — which a paste takes
 * first, `text/uri-list` when there is no `text/plain` as CodeMirror's own paste does — or no
 * image of a type a paste takes. */
export function clipboardImage(data: DataTransfer | null): File | null {
  if (!data) return null;
  if (data.getData("text/plain") || data.getData("text/uri-list")) return null;
  for (const item of Array.from(data.items)) {
    if (item.kind === "file" && item.type in PASTED_IMAGE_TYPES) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return Array.from(data.files).find((file) => file.type in PASTED_IMAGE_TYPES) ?? null;
}

/** The backend's refusal of an image over the limit, which the person is told in the image's own
 * words rather than as the editor's size limit `describeError` gives `too-large`. */
const tooLarge = (error: unknown) => error instanceof BackendError && error.code === "too-large";

async function pasteImage(view: EditorView, host: ImageHost, image: File): Promise<void> {
  if (image.size > MAX_IMAGE_BYTES) return host.notice(IMAGE_TOO_LARGE);
  const name = pastedImageName(host.memoFile(), image.type);
  const id = holdSpot(view);
  let file: string | null = null;
  try {
    const memo = await host.saveImage(name, new Uint8Array(await image.arrayBuffer()));
    host.added(memo);
    file = memo.file;
  } catch (error) {
    if (tooLarge(error)) host.notice(IMAGE_TOO_LARGE);
    else host.report(error);
  }
  placeLinks(host, id, file === null ? [] : [file], "input.paste");
}

/** The image files of a drop on a Markdown memo's editor go in as links at the place they were
 * let go (spec 「끌어 놓기」); returns the paths left for the app's own drop — every one when the
 * drop is not on such an editor. `at` is in the page's CSS pixels. */
export function takeDroppedImages(
  paths: readonly string[],
  at: { x: number; y: number },
): string[] {
  const images = paths.filter((path) => isImageName(basename(path)));
  if (images.length === 0) return [...paths];
  const editor = document.elementFromPoint(at.x, at.y)?.closest(".cm-editor");
  const view = editor instanceof HTMLElement ? EditorView.findFromDOM(editor) : null;
  const host = view?.state.facet(imageHost);
  if (!view || !host?.accepts()) return [...paths];
  const id = holdSpot(view, view.posAtCoords(at) ?? view.state.selection.main.head);
  void importImages(host, id, images);
  return paths.filter((path) => !images.includes(path));
}

async function importImages(host: ImageHost, id: number, paths: readonly string[]): Promise<void> {
  const files: string[] = [];
  for (const path of paths) {
    try {
      const imported = await host.importImage(path);
      if (imported.memo) host.added(imported.memo);
      files.push(imported.file);
    } catch (error) {
      if (tooLarge(error)) host.notice(`${IMAGE_TOO_LARGE}: ${basename(path)}`);
      else host.report(error);
    }
  }
  placeLinks(host, id, files, "input.drop");
}

/** A memo's editor takes pasted images; `takeDroppedImages` finds it under a drop through this. */
export function imageInput(host: ImageHost): Extension {
  return [
    imageHost.of(host),
    spots,
    EditorView.domEventHandlers({
      paste(event, view) {
        if (!host.accepts()) return false;
        const image = clipboardImage(event.clipboardData);
        if (!image) return false;
        event.preventDefault();
        void pasteImage(view, host, image);
        return true;
      },
    }),
  ];
}
