/**
 * A size-bounded map whose entries expire. Writing a key moves it to the back; when the map is full the
 * least recently written entry goes first, so a flood of junk keys can only push out older junk, never be
 * used to wipe the whole map at once. (All entries share one TTL, so insertion order is also expiry order.)
 */
export class BoundedTtlMap<V> {
  private m = new Map<string, { v: V; exp: number }>()
  constructor(private max: number, private ttlMs: number, private now: () => number = Date.now) {}

  get(key: string): V | undefined {
    const e = this.m.get(key)
    if (!e) return undefined
    if (e.exp <= this.now()) { this.m.delete(key); return undefined }
    return e.v
  }

  set(key: string, v: V) {
    this.m.delete(key)
    this.m.set(key, { v, exp: this.now() + this.ttlMs })
    const t = this.now()
    for (const [k, e] of this.m) { if (e.exp > t) break; this.m.delete(k) }
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string)
  }

  delete(key: string) { this.m.delete(key) }
  get size() { return this.m.size }
}
