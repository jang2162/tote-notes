type Child = Node | string | null | undefined | false;
type Props<K extends keyof HTMLElementTagNameMap> = Partial<
  Omit<HTMLElementTagNameMap[K], "className" | "dataset" | "style" | "innerHTML" | "outerHTML">
> & { class?: string; data?: Record<string, string> };

/** `document.createElement` with properties and children in one call. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props<K> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const { class: className, data, ...rest } = props;
  const element = Object.assign(document.createElement(tag), rest);
  if (className) element.className = className;
  if (data) Object.assign(element.dataset, data);
  for (const child of children) if (child) element.append(child);
  return element;
}

/** Makes `wanted` the children of `parent`, in that order, touching only what is out of place.
 * An element made anew under a press — or taken out and put back — gets no `click` when the press
 * is let go: the browser sends it only when the element pressed is still where it was. */
export function placeChildren(parent: HTMLElement, wanted: readonly HTMLElement[]): void {
  let at = parent.firstChild;
  for (const el of wanted) {
    if (el === at) at = at.nextSibling;
    else parent.insertBefore(el, at);
  }
  while (at) {
    const next = at.nextSibling;
    at.remove();
    at = next;
  }
}
