// Runtime helper module for the build-time plugin.
//
// The plugin emits `__memo([TAG_*, "h:hash", ...sources, fn, ...deps],
// () => /* original */)` calls. The fallback closure preserves the user's
// original call exactly, so the only thing the plugin needs from us is:
//   * `__memo` itself (re-exported from the canonical internal module);
//   * a stable, weakly-keyable token per (kind × method) pair, exposed
//     under predictable names (`TAG_AVAL_MAP`, `TAG_ASET_BIND`, ...).
//
// The tags must be reference-stable across imports. Each is a fresh
// frozen object literal — its identity is the cache-trie key.

import { __memo as __memoInternal } from "../internal/memo.js";

// Intern string keys (the plugin emits a body-hash string literal as
// part of the key path; MemoTrie's per-level WeakMap requires object
// keys). Each unique hash becomes a stable boxed object held strongly
// by this module. Since the hash space is bounded by user code size,
// the intern map's growth is bounded.
const HASH_INTERN = new Map<string, object>();
function internHash(s: string): object {
  let v = HASH_INTERN.get(s);
  if (v === undefined) {
    v = Object.freeze({ h: s });
    HASH_INTERN.set(s, v);
  }
  return v;
}

/**
 * Plugin-facing `__memo` wrapper. Accepts a key path that may mix
 * objects and strings; strings are interned to stable boxed objects so
 * the underlying MemoTrie can use them as WeakMap keys.
 */
export function __memo<T extends object>(
  keys: ReadonlyArray<object | string>,
  compute: () => T,
): T {
  const objKeys: object[] = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    objKeys[i] = typeof k === "string" ? internHash(k) : k;
  }
  return __memoInternal(objKeys, compute);
}

export const TAG_AVAL_MAP = Object.freeze({ tag: "aval.map" });
export const TAG_AVAL_BIND = Object.freeze({ tag: "aval.bind" });
export const TAG_AVAL_ZIPN = Object.freeze({ tag: "aval.zipN" });

export const TAG_ASET_MAP = Object.freeze({ tag: "aset.map" });
export const TAG_ASET_BIND = Object.freeze({ tag: "aset.bind" });
export const TAG_ASET_FILTER = Object.freeze({ tag: "aset.filter" });
export const TAG_ASET_COLLECT = Object.freeze({ tag: "aset.collect" });
export const TAG_ASET_CHOOSE = Object.freeze({ tag: "aset.choose" });

export const TAG_ALIST_MAP = Object.freeze({ tag: "alist.map" });
export const TAG_ALIST_BIND = Object.freeze({ tag: "alist.bind" });
export const TAG_ALIST_FILTER = Object.freeze({ tag: "alist.filter" });
export const TAG_ALIST_COLLECT = Object.freeze({ tag: "alist.collect" });
export const TAG_ALIST_CHOOSE = Object.freeze({ tag: "alist.choose" });

export const TAG_AMAP_MAP = Object.freeze({ tag: "amap.map" });
export const TAG_AMAP_BIND = Object.freeze({ tag: "amap.bind" });
export const TAG_AMAP_FILTER = Object.freeze({ tag: "amap.filter" });
export const TAG_AMAP_CHOOSE = Object.freeze({ tag: "amap.choose" });
