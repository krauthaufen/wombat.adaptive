// INTERNAL — not part of the public API.
//
// Memoization layer over the adaptive combinators. The runtime
// substrate for a future build-time source-rewrite plugin (see
// docs/heap-future-work.md §5d in wombat.rendering) that lowers user
// `.map(f)` / `.bind(f)` / etc. calls into the `memo*` helpers below
// when the callback is recognized as pure + reference-stable.
//
// End users should NOT import from this module. The public API on
// `aval` / `aset` / `alist` / `amap` stays exactly as-is; the plugin
// rewrites call sites to route through here without surfacing the
// concept to user code.
//
// Cache shape: a single shared `MemoTrie` partitioned by op-tag at
// the first level, then by source adaptive(s), then by the user
// function reference. Every level is a `WeakMap<object, ...>` and the
// derived value is held via `WeakRef`, so entries collapse naturally
// when any key or the derived value becomes unreachable.

import { MemoTrie } from "../core/memoTrie.js";

import {
  type aval,
  map as avalMap,
  bind as avalBind,
} from "../adaptiveValue/adaptiveValue.js";

import {
  type aset,
  map as asetMap,
  bind as asetBind,
  filter as asetFilter,
  collect as asetCollect,
  choose as asetChoose,
} from "../adaptiveHashSet/adaptiveHashSet.js";

import {
  type alist,
  map as alistMap,
  filter as alistFilter,
  choose as alistChoose,
  collect as alistCollect,
  bind as alistBind,
} from "../adaptiveIndexList/adaptiveIndexList.js";

import {
  type amap,
  map as amapMap,
  filter as amapFilter,
  choose as amapChoose,
  bind as amapBind,
} from "../adaptiveHashMap/adaptiveHashMap.js";

// ---------------------------------------------------------------------------
// Op-tag interning. The first level of the trie is partitioned by a
// stable string identifying the rewritten operation. The plugin emits
// the matching tag based on which combinator it is lowering. We box
// each tag once and reuse the boxed object so the trie's `WeakMap` key
// stays stable.
// ---------------------------------------------------------------------------

const TAGS = {
  avalMap: { tag: "aval.map" },
  avalBind: { tag: "aval.bind" },
  avalZipN: { tag: "aval.zipN" },
  asetMap: { tag: "aset.map" },
  asetBind: { tag: "aset.bind" },
  asetFilter: { tag: "aset.filter" },
  asetCollect: { tag: "aset.collect" },
  asetChoose: { tag: "aset.choose" },
  alistMap: { tag: "alist.map" },
  alistFilter: { tag: "alist.filter" },
  alistChoose: { tag: "alist.choose" },
  alistCollect: { tag: "alist.collect" },
  alistBind: { tag: "alist.bind" },
  amapMap: { tag: "amap.map" },
  amapFilter: { tag: "amap.filter" },
  amapChoose: { tag: "amap.choose" },
  amapBind: { tag: "amap.bind" },
} as const;

// Single shared trie instance.
const trie = new MemoTrie();

/**
 * Compute-or-lookup with weak caching. Cache key is `keys` — a path
 * of reference-identity object refs. `compute` is invoked only on
 * miss; the resulting value is held in the trie via `WeakRef`.
 *
 * INTERNAL — intended for the build-time source-rewrite plugin (see
 * docs/heap-future-work.md §5d in wombat.rendering). End users should
 * not call this directly; use plain `.map(f)` / `.bind(f)` / etc. and
 * trust the plugin to lower it.
 */
export function __memo<T extends object>(
  keys: ReadonlyArray<object>,
  compute: () => T,
): T {
  const hit = trie.lookup(keys);
  if (hit !== undefined) return hit as T;
  const fresh = compute();
  trie.insert(keys, fresh);
  return fresh;
}

// ---------------------------------------------------------------------------
// aval combinators
// ---------------------------------------------------------------------------

export function memoAvalMap<T, R>(av: aval<T>, f: (t: T) => R): aval<R> {
  return __memo([TAGS.avalMap, av, f], () => avalMap(av, f) as aval<R> & object);
}

export function memoAvalBind<T, R>(
  av: aval<T>,
  f: (t: T) => aval<R>,
): aval<R> {
  return __memo(
    [TAGS.avalBind, av, f],
    () => avalBind(av, f) as aval<R> & object,
  );
}

/**
 * N-ary zip + map. Cache key is `[tag, ...avs, fn]`; the trie handles
 * arbitrary arity automatically.
 */
export function memoAvalZipN<R>(
  avs: ReadonlyArray<aval<unknown>>,
  fn: (vs: ReadonlyArray<unknown>) => R,
): aval<R> {
  const keys: object[] = [TAGS.avalZipN];
  for (const a of avs) keys.push(a as unknown as object);
  keys.push(fn);
  return __memo(keys, () => {
    // Build via bind cascade so each source contributes to dirty
    // tracking; the result is itself an aval<R>.
    const inner = (i: number, acc: ReadonlyArray<unknown>): aval<R> => {
      if (i === avs.length) {
        // Wrap fn in a constant-aval-style map of the last source so the
        // result type is aval<R>. Since acc is fully resolved we route
        // through the final source's map.
        // Should not get here: handled by branch below.
        throw new Error("unreachable");
      }
      if (i === avs.length - 1) {
        return avalMap(avs[i]!, (v) => fn([...acc, v]));
      }
      return avalBind(avs[i]!, (v) => inner(i + 1, [...acc, v]));
    };
    if (avs.length === 0) {
      // No sources — wrap fn() into a degenerate map. Use any source-
      // less path: build via avalMap on a sentinel? We don't have one
      // handy and the plugin won't emit zipN with arity 0. Throw.
      throw new Error("memoAvalZipN: at least one source required");
    }
    return inner(0, []) as aval<R> & object;
  });
}

// ---------------------------------------------------------------------------
// aset combinators
// ---------------------------------------------------------------------------

export function memoAsetMap<T, R>(set: aset<T>, f: (t: T) => R): aset<R> {
  return __memo(
    [TAGS.asetMap, set, f],
    () => asetMap(f, set) as aset<R> & object,
  );
}

export function memoAsetBind<T, R>(
  av: aval<T>,
  f: (t: T) => aset<R>,
): aset<R> {
  return __memo(
    [TAGS.asetBind, av, f],
    () => asetBind(f, av) as aset<R> & object,
  );
}

export function memoAsetFilter<T>(
  set: aset<T>,
  predicate: (t: T) => boolean,
): aset<T> {
  return __memo(
    [TAGS.asetFilter, set, predicate],
    () => asetFilter(predicate, set) as aset<T> & object,
  );
}

export function memoAsetChoose<T, R>(
  set: aset<T>,
  f: (t: T) => R | undefined,
): aset<R> {
  return __memo(
    [TAGS.asetChoose, set, f],
    () => asetChoose(f, set) as aset<R> & object,
  );
}

export function memoAsetCollect<T, R>(
  set: aset<T>,
  f: (t: T) => aset<R>,
): aset<R> {
  return __memo(
    [TAGS.asetCollect, set, f],
    () => asetCollect(f, set) as aset<R> & object,
  );
}

// ---------------------------------------------------------------------------
// alist combinators
// ---------------------------------------------------------------------------

export function memoAlistMap<T, R>(list: alist<T>, f: (t: T) => R): alist<R> {
  return __memo(
    [TAGS.alistMap, list, f],
    () => alistMap(f, list) as alist<R> & object,
  );
}

export function memoAlistFilter<T>(
  list: alist<T>,
  predicate: (t: T) => boolean,
): alist<T> {
  return __memo(
    [TAGS.alistFilter, list, predicate],
    () => alistFilter(predicate, list) as alist<T> & object,
  );
}

export function memoAlistChoose<T, R>(
  list: alist<T>,
  f: (t: T) => R | undefined,
): alist<R> {
  return __memo(
    [TAGS.alistChoose, list, f],
    () => alistChoose(f, list) as alist<R> & object,
  );
}

export function memoAlistCollect<T, R>(
  list: alist<T>,
  f: (t: T) => alist<R>,
): alist<R> {
  return __memo(
    [TAGS.alistCollect, list, f],
    () => alistCollect(f, list) as alist<R> & object,
  );
}

export function memoAlistBind<T, R>(
  av: aval<T>,
  f: (t: T) => alist<R>,
): alist<R> {
  return __memo(
    [TAGS.alistBind, av, f],
    () => alistBind(f, av) as alist<R> & object,
  );
}

// ---------------------------------------------------------------------------
// amap combinators
// ---------------------------------------------------------------------------

export function memoAmapMap<K, V1, V2>(
  m: amap<K, V1>,
  f: (k: K, v: V1) => V2,
): amap<K, V2> {
  return __memo(
    [TAGS.amapMap, m, f],
    () => amapMap(f, m) as amap<K, V2> & object,
  );
}

export function memoAmapFilter<K, V>(
  m: amap<K, V>,
  predicate: (k: K, v: V) => boolean,
): amap<K, V> {
  return __memo(
    [TAGS.amapFilter, m, predicate],
    () => amapFilter(predicate, m) as amap<K, V> & object,
  );
}

export function memoAmapChoose<K, V1, V2>(
  m: amap<K, V1>,
  f: (k: K, v: V1) => V2 | undefined,
): amap<K, V2> {
  return __memo(
    [TAGS.amapChoose, m, f],
    () => amapChoose(f, m) as amap<K, V2> & object,
  );
}

export function memoAmapBind<T, K, V>(
  av: aval<T>,
  f: (t: T) => amap<K, V>,
): amap<K, V> {
  return __memo(
    [TAGS.amapBind, av, f],
    () => amapBind(f, av) as amap<K, V> & object,
  );
}
