import { h } from "./dom";

export interface TabView {
  id: string;
  title: string;
  hint: string;
  dirty: boolean;
  external: boolean;
  active: boolean;
}

export class TabBar {
  readonly el = h("div", { class: "tabbar", role: "tablist" });

  constructor(private readonly actions: { select(id: string): void; close(id: string): void }) {}

  render(tabs: TabView[]): void {
    this.el.replaceChildren(...tabs.map((tab) => this.tab(tab)));
    this.el.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private tab(tab: TabView): HTMLElement {
    const close = h("button", {
      class: "tab-close",
      title: "탭 닫기",
      textContent: "×",
      tabIndex: -1,
    });
    close.addEventListener("click", () => this.actions.close(tab.id));
    const classes = [
      "tab",
      tab.active && "active",
      tab.dirty && "dirty",
      tab.external && "external",
    ]
      .filter(Boolean)
      .join(" ");
    const el = h(
      "div",
      { class: classes, role: "tab", title: tab.hint, data: { id: tab.id } },
      h("span", { class: "tab-title", textContent: tab.title }),
      close,
    );
    el.addEventListener("mousedown", (event) => {
      if (event.button === 0 && !(event.target as Element).closest(".tab-close"))
        this.actions.select(tab.id);
    });
    el.addEventListener("auxclick", (event) => {
      if (event.button === 1) this.actions.close(tab.id);
    });
    return el;
  }
}
