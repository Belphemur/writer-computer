// Keyed registry whose entries belong to an owner, removable as a group. Shared by the Obsidian
// host (owner = plugin id) and the built-in feature host (owner = `builtin:<id>`): one teardown
// model (docs/consolidation.md). Moved out of `obsidian-host/api/core.ts` when the second user came.

/** Keyed registry whose entries belong to an owner (plugin id), removable as a group. */
export class OwnedRegistry<T extends { owner: string }> {
  private items = new Map<string, T>();
  private listeners = new Set<() => void>();

  constructor(private dispose?: (item: T) => void) {}

  add(key: string, item: T): () => void {
    this.remove(key);
    this.items.set(key, item);
    this.emit();
    return () => {
      if (this.items.get(key) === item) this.remove(key);
    };
  }

  remove(key: string): boolean {
    const item = this.items.get(key);
    if (!item) return false;
    this.items.delete(key);
    this.dispose?.(item);
    this.emit();
    return true;
  }

  removeOwner(owner: string): number {
    let n = 0;
    for (const [key, item] of Array.from(this.items)) {
      if (item.owner !== owner) continue;
      this.items.delete(key);
      this.dispose?.(item);
      n++;
    }
    if (n > 0) this.emit();
    return n;
  }

  get(key: string): T | undefined {
    return this.items.get(key);
  }
  has(key: string): boolean {
    return this.items.has(key);
  }
  list(): T[] {
    return [...this.items.values()];
  }
  get size(): number {
    return this.items.size;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of Array.from(this.listeners)) l();
  }
}
