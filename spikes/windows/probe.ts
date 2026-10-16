// Page under test for probe.spec.ts: a BroadcastChannel inbox, a localStorage JSON helper and a
// draggable list that records every HTML5 drag event. Nothing here is product code.
export {};

declare global {
  interface Window {
    probe: {
      inbox: unknown[];
      dragEvents: string[];
      post(message: unknown): void;
      appendStored(key: string, value: unknown): number;
    };
  }
}

const channel = new BroadcastChannel("probe");
const inbox: unknown[] = [];
channel.onmessage = (ev) => inbox.push(ev.data);

const dragEvents: string[] = [];
for (const type of ["dragstart", "dragenter", "dragover", "drop", "dragend"]) {
  document.addEventListener(type, (ev) => {
    // A drop target only exists once dragover is cancelled.
    if (type === "dragover" || type === "drop") ev.preventDefault();
    const e = ev as DragEvent;
    if (type === "dragstart") e.dataTransfer?.setData("text/plain", (e.target as HTMLElement).id);
    if (type !== "dragover") dragEvents.push(`${type}:${(e.target as HTMLElement).id}`);
  });
}

window.probe = {
  inbox,
  dragEvents,
  post: (message) => channel.postMessage(message),
  // Read, change and write back the same JSON; the lost-update check calls this from two pages in turn.
  appendStored(key, value) {
    const list = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown[];
    list.push(value);
    localStorage.setItem(key, JSON.stringify(list));
    return list.length;
  },
};
