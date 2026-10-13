export type BrowserTargetKind = "page" | "iframe" | "worker";

export type BrowserTarget = {
  id: string;
  kind: BrowserTargetKind;
  parentId?: string;
  url: string;
  title: string;
  pageGeneration: number;
  attachedAt: number;
  updatedAt: number;
};

export type TargetEvent =
  | { type: "attached"; target: Omit<BrowserTarget, "pageGeneration" | "attachedAt" | "updatedAt">; at?: number }
  | { type: "detached"; id: string; at?: number }
  | { type: "info-changed"; id: string; url?: string; title?: string; at?: number }
  | { type: "navigated"; id: string; url: string; title?: string; at?: number }
  | { type: "focused"; id: string; at?: number };

/** Rebuilds focus from live target events instead of replaying stale tab/frame handles. */
export class TargetRegistry {
  private readonly targets = new Map<string, BrowserTarget>();
  private focusedId: string | undefined;

  apply(event: TargetEvent): void {
    const at = event.at ?? Date.now();
    if (event.type === "attached") {
      const previous = this.targets.get(event.target.id);
      this.targets.set(event.target.id, {
        ...event.target,
        pageGeneration: previous?.pageGeneration ?? 0,
        attachedAt: previous?.attachedAt ?? at,
        updatedAt: at,
      });
      if (!this.focusedId && event.target.kind === "page") this.focusedId = event.target.id;
      return;
    }

    if (event.type === "detached") {
      this.targets.delete(event.id);
      if (this.focusedId === event.id) this.focusedId = undefined;
      return;
    }

    const target = this.targets.get(event.id);
    if (!target) return;
    if (event.type === "focused") {
      this.focusedId = event.id;
      target.updatedAt = at;
    } else if (event.type === "navigated") {
      target.url = event.url;
      target.title = event.title ?? target.title;
      target.pageGeneration += 1;
      target.updatedAt = at;
    } else {
      target.url = event.url ?? target.url;
      target.title = event.title ?? target.title;
      target.updatedAt = at;
    }
  }

  resolveFocus(preferredId?: string): BrowserTarget | undefined {
    const preferred = preferredId ? this.targets.get(preferredId) : undefined;
    if (preferred) return { ...preferred };
    const focused = this.focusedId ? this.targets.get(this.focusedId) : undefined;
    if (focused) return { ...focused };
    const firstPage = [...this.targets.values()].find((target) => target.kind === "page");
    return firstPage ? { ...firstPage } : undefined;
  }

  get(id: string): BrowserTarget | undefined {
    const target = this.targets.get(id);
    return target ? { ...target } : undefined;
  }

  snapshot(): BrowserTarget[] {
    return [...this.targets.values()].map((target) => ({ ...target }));
  }
}
