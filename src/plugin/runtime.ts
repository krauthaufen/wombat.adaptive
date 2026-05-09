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

// Intern primitive keys. The plugin emits cache keys that include the
// body-hash (a string), and may also include captured-local references
// extracted from the rewritten callback's closure. Captured locals are
// arbitrary user values — quite often primitives (`scale: number`,
// flags, etc.). MemoTrie's per-level WeakMap requires object keys, so
// every primitive must be boxed to a stable object.
//
// We intern by typed key (`type:value`) so e.g. number 1 and string
// "1" don't collide. Each unique primitive becomes a frozen wrapper
// held strongly by this module. Growth is bounded by the set of
// distinct values the user code actually passes; practical user code
// has a small such set.
const PRIMITIVE_INTERN = new Map<string, object>();
function internPrimitive(typeTag: string, key: string): object {
  const k = `${typeTag}:${key}`;
  let v = PRIMITIVE_INTERN.get(k);
  if (v === undefined) {
    v = Object.freeze({ t: typeTag, v: key });
    PRIMITIVE_INTERN.set(k, v);
  }
  return v;
}

// Sentinels for non-string primitives that don't round-trip safely
// through `String(x)`.
const NULL_KEY = Object.freeze({ t: "null" });
const UNDEF_KEY = Object.freeze({ t: "undefined" });
const TRUE_KEY = Object.freeze({ t: "bool", v: true });
const FALSE_KEY = Object.freeze({ t: "bool", v: false });

function toKeyObject(k: unknown): object {
  switch (typeof k) {
    case "object":
      return k === null ? NULL_KEY : (k as object);
    case "function":
      return k as object;
    case "undefined":
      return UNDEF_KEY;
    case "boolean":
      return k ? TRUE_KEY : FALSE_KEY;
    case "string":
      return internPrimitive("s", k);
    case "number":
      // NaN/Infinity/+0/-0 all stringify uniquely enough via String().
      return internPrimitive("n", String(k));
    case "bigint":
      return internPrimitive("bi", k.toString());
    case "symbol":
      // Symbols already have identity; box them once for WeakMap use.
      return internPrimitive("sym", (k as symbol).toString());
    default:
      // Should be unreachable.
      return internPrimitive("?", String(k));
  }
}

/**
 * Plugin-facing `__memo` wrapper. Accepts a key path that may mix
 * objects and primitives; every primitive is interned to a stable
 * boxed object so the underlying MemoTrie can use it as a WeakMap key.
 */
export function __memo<T extends object>(
  keys: ReadonlyArray<unknown>,
  compute: () => T,
): T {
  const objKeys: object[] = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    objKeys[i] = toKeyObject(keys[i]);
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
