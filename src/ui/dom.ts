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
