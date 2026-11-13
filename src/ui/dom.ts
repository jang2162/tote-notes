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
 * is let go: the browser sends it only when the element pressed is still where it was. So the
 * children no longer wanted go first: left in until the end, each would stand where the walk is
 * and every wanted child after it would be taken out and put back before it. A child that comes
 * forward is the only one moved for it; one that falls back has the children it passes moved in
 * its stead. */
export function placeChildren(parent: HTMLElement, wanted: readonly HTMLElement[]): void {
  const kept = new Set<Node>(wanted);
  for (const child of [...parent.childNodes]) if (!kept.has(child)) child.remove();
  let at = parent.firstChild;
  for (const el of wanted) {
    if (el === at) at = at.nextSibling;
    else parent.insertBefore(el, at);
  }
}
