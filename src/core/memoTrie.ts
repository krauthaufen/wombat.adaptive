// Generic weak-keyed cache trie used to memoize derived adaptive
// objects by a path of reference-identity keys (typically:
// `[source, ...otherSources, fn]`).
//
// Each interior level is a `WeakMap<object, MemoTrie | WeakRef>`; the
// LAST key of a path maps directly to the value's `WeakRef` — no
// terminal node, no terminal WeakMap (at scene scale the terminal
// nodes were half the trie's heap). When a shorter path terminates at
// a key that a longer path passes through, the entry upgrades to a
// node carrying both a `leaf` and children.
//
// Callers are responsible for strongly retaining the path keys for the
// duration of the lookup; the trie itself only holds them weakly. The
// derived value must also be retained externally (the trie holds it via
// `WeakRef`), otherwise it can be collected between insert and the
// next lookup.

export class MemoTrie {
  private readonly next: WeakMap<object, MemoTrie | WeakRef<object>> = new WeakMap();
  private leaf: WeakRef<object> | undefined = undefined;

  /**
   * Returns the cached value associated with `keys`, or `undefined` if
   * no live entry exists. The path's keys are strong-referenced by the
   * caller; they are held weakly here. A dead `WeakRef` at the leaf is
   * treated as a miss.
   */
  lookup(keys: ReadonlyArray<object>): object | undefined {
    if (keys.length === 0) return this.leaf?.deref();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let node: MemoTrie = this;
    const last = keys.length - 1;
    for (let i = 0; i < keys.length; i++) {
      const e = node.next.get(keys[i]!);
      if (e === undefined) return undefined;
      if (e instanceof WeakRef) {
        // inlined terminal — a hit only if this is the path's last key
        return i === last ? e.deref() : undefined;
      }
      if (i === last) return e.leaf?.deref();
      node = e;
    }
    return undefined;
  }

  /**
   * Inserts `value` at the path `keys`, creating intermediate nodes as
   * needed. The value is held weakly via `WeakRef`. An empty path
   * stores at the root's own leaf.
   */
  insert(keys: ReadonlyArray<object>, value: object): void {
    if (keys.length === 0) {
      this.leaf = new WeakRef(value);
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let node: MemoTrie = this;
    const last = keys.length - 1;
    for (let i = 0; i < last; i++) {
      const k = keys[i]!;
      const e = node.next.get(k);
      if (e === undefined) {
        const n = new MemoTrie();
        node.next.set(k, n);
        node = n;
      } else if (e instanceof WeakRef) {
        // upgrade an inlined terminal into an interior node keeping
        // its value as the node's own leaf
        const n = new MemoTrie();
        n.leaf = e;
        node.next.set(k, n);
        node = n;
      } else {
        node = e;
      }
    }
    const k = keys[last]!;
    const e = node.next.get(k);
    if (e === undefined || e instanceof WeakRef) {
      node.next.set(k, new WeakRef(value));
    } else {
      e.leaf = new WeakRef(value);
    }
  }
}

/**
 * Lookup-or-compute-and-insert helper. Returns the existing entry if
 * one is live; otherwise calls `compute`, inserts, and returns the
 * fresh value.
 */
export function memoize<T extends object>(
  trie: MemoTrie,
  keys: ReadonlyArray<object>,
  compute: () => T,
): T {
  const hit = trie.lookup(keys);
  if (hit !== undefined) return hit as T;
  const fresh = compute();
  trie.insert(keys, fresh);
  return fresh;
}
