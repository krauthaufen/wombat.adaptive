// Generic weak-keyed cache trie used to memoize derived adaptive
// objects by a path of reference-identity keys (typically:
// `[source, ...otherSources, fn]`).
//
// Each level is a `WeakMap<object, MemoTrie>`; the leaf holds a
// `WeakRef<object>` to the cached value. Lookup walks the path; insert
// nests as needed. Any null/dead level falls through to a miss.
//
// Callers are responsible for strongly retaining the path keys for the
// duration of the lookup; the trie itself only holds them weakly. The
// derived value must also be retained externally (the trie holds it via
// `WeakRef`), otherwise it can be collected between insert and the
// next lookup.

export class MemoTrie {
  private readonly next: WeakMap<object, MemoTrie> = new WeakMap();
  private leaf: WeakRef<object> | undefined = undefined;

  /**
   * Returns the cached value associated with `keys`, or `undefined` if
   * no live entry exists. The path's keys are strong-referenced by the
   * caller; they are held weakly here. A dead `WeakRef` at the leaf is
   * treated as a miss.
   */
  lookup(keys: ReadonlyArray<object>): object | undefined {
    let node: MemoTrie | undefined = this;
    for (let i = 0; i < keys.length; i++) {
      node = node.next.get(keys[i]!);
      if (node === undefined) return undefined;
    }
    return node.leaf?.deref();
  }

  /**
   * Inserts `value` at the path `keys`, creating intermediate nodes as
   * needed. The value is held weakly via `WeakRef`.
   */
  insert(keys: ReadonlyArray<object>, value: object): void {
    let node: MemoTrie = this;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      let n = node.next.get(k);
      if (n === undefined) {
        n = new MemoTrie();
        node.next.set(k, n);
      }
      node = n;
    }
    node.leaf = new WeakRef(value);
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
