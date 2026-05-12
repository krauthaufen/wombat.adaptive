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

// Plugin emits cache keys that mix three kinds of entries:
//
//   1. Objects (op tag, source aval(s), object-typed closure deps).
//      These have reference identity — they go directly into the
//      MemoTrie's WeakMap path.
//   2. The body-hash string emitted by the plugin at compile time
//      (`"h:abc12345"`) — stable per call site.
//   3. Primitive closure-deps (numbers, booleans, etc.) — values
//      captured from the enclosing scope.
//
// MemoTrie needs object keys (per-level WeakMap). We collapse (2)
// + (3) into ONE interned object: a frozen `{ k: string }` whose
// string carries the body-hash plus a typed serialization of all
// primitive deps in their original order. Two calls with the same
// body and the same primitive-dep tuple share one interned object
// → one cache-trie key → one entry. Distinct values produce
// distinct strings → distinct entries.
//
// One interned object per unique (body × primitive-dep-tuple)
// combination. Bounded by the user's code; in practice tiny.
const COMBINED_INTERN = new Map<string, object>();
function internCombined(s: string): object {
  let v = COMBINED_INTERN.get(s);
  if (v === undefined) {
    v = Object.freeze({ k: s });
    COMBINED_INTERN.set(s, v);
  }
  return v;
}

// Length-prefixed type-tagged serialization so e.g. number 1 and
// string "1" can't alias, and concatenation of multiple deps stays
// unambiguous.
function tagPrimitive(k: unknown): string {
  switch (typeof k) {
    case "string":    return `s${(k as string).length}:${k as string}`;
    case "number":    return `n:${String(k)};`;
    case "boolean":   return k ? "t;" : "f;";
    case "bigint":    return `bi:${(k as bigint).toString()};`;
    case "undefined": return "u;";
    case "symbol":    return `sym:${(k as symbol).toString()};`;
    default:          return `?:${String(k)};`;  // unreachable in practice
  }
}

// Value-typed classes (V3f, M44f, V3i, ... in wombat.base) carry
// `getHashCode(): number` + `equals(other): boolean`. Two instances
// with the same data are structurally equal and should dedupe across
// distinct closures. We duck-type on BOTH methods — both together
// signal an "Aardvark-style value type" reliably (random objects
// rarely have both with that exact shape).
//
// We intern hashable values into stable object handles via a
// hash-bucket-with-equals scheme: distinct values get distinct
// handles regardless of `getHashCode()` collisions. equals() is the
// only correct primitive for value equality; hashCode is just a
// bucket selector. Interned handles are then used as ordinary
// MemoTrie object keys.
interface Hashable {
  getHashCode(): number;
  equals(other: unknown): boolean;
}
function isHashable(k: object): k is Hashable {
  const hc = (k as { getHashCode?: unknown }).getHashCode;
  const eq = (k as { equals?: unknown }).equals;
  return typeof hc === "function" && typeof eq === "function";
}

/** Duck-type for "this memo key is an aval". Avals expose
 *  `getValue(token)` (and `getValueUntyped`); that's enough to tell
 *  them apart from value-typed objects (`V3f`, …) which never do. */
function isAvalLike(k: object): boolean {
  return typeof (k as { getValue?: unknown }).getValue === "function";
}

// Hash-bucket intern table for value-typed objects. Map<hashCode,
// Array<{ value, key }>>. On a hash collision, we walk the bucket
// calling equals() to find a matching entry. If none matches, we
// allocate a fresh handle, push it, and return.
//
// The bucket retains live values strongly so the handle stays
// alive across all uses. Growth is bounded by the user's set of
// distinct value-typed deps (in practice small — a few hundred
// distinct V3 positions, mat4 transforms, etc.). If memory pressure
// becomes a real concern, swap the strong refs for WeakRef + a
// FinalizationRegistry that prunes dead bucket entries.
const HASHABLE_BUCKETS = new Map<number, Array<{ value: Hashable; key: object }>>();
function internHashable(v: Hashable): object {
  const hc = v.getHashCode() | 0;          // normalize to int32
  let bucket = HASHABLE_BUCKETS.get(hc);
  if (bucket === undefined) {
    bucket = [];
    HASHABLE_BUCKETS.set(hc, bucket);
  } else {
    for (let i = 0; i < bucket.length; i++) {
      if (bucket[i]!.value.equals(v)) return bucket[i]!.key;
    }
  }
  const key = Object.freeze({});             // opaque handle
  bucket.push({ value: v, key });
  return key;
}

// Plain-object / plain-array closure deps with primitive leaves.
// Two structurally-equal `{r:1, g:0, b:0}` literals captured at
// distinct call sites get distinct references in JS, so without
// interning each becomes a separate cache-trie key. We dedupe
// "simple" containers (own enumerable keys only, prototype is
// Object.prototype or Array.prototype, depth-bounded, no circular
// refs, no functions/symbols/typed-arrays) by serializing to a
// deterministic string and interning via a module-level Map.
//
// Anything outside this profile (class instances without
// getHashCode/equals, Maps, Sets, typed arrays, exotic objects)
// falls through to reference identity — the safe default.
const SIMPLE_INTERN = new Map<string, object>();
const MAX_SIMPLE_DEPTH = 4;

function isPlainContainer(o: object): boolean {
  if (Array.isArray(o)) return true;
  const p = Object.getPrototypeOf(o);
  return p === Object.prototype || p === null;
}

function trySerializeSimple(v: unknown, depth: number): string | null {
  if (depth > MAX_SIMPLE_DEPTH) return null;
  if (v === null) return "z;";
  switch (typeof v) {
    case "string":  return `s${(v as string).length}:${v as string}`;
    case "number":  return `n:${String(v)};`;
    case "boolean": return v ? "t;" : "f;";
    case "bigint":  return `bi:${(v as bigint).toString()};`;
    case "undefined": return "u;";
    case "symbol":  return null;     // non-comparable
    case "function": return null;
  }
  if (typeof v !== "object") return null;
  const obj = v as object;
  if (!isPlainContainer(obj)) return null;
  if (Array.isArray(obj)) {
    let out = `[${obj.length}|`;
    for (let i = 0; i < obj.length; i++) {
      const part = trySerializeSimple(obj[i], depth + 1);
      if (part === null) return null;
      out += part;
    }
    return out + "]";
  }
  // Plain object: sort keys for deterministic output.
  const keys = Object.keys(obj).sort();
  let out = `{${keys.length}|`;
  for (const k of keys) {
    const part = trySerializeSimple((obj as Record<string, unknown>)[k], depth + 1);
    if (part === null) return null;
    out += `k${k.length}:${k}=${part}`;
  }
  return out + "}";
}

function internSimple(o: object): object | null {
  const ser = trySerializeSimple(o, 0);
  if (ser === null) return null;
  let handle = SIMPLE_INTERN.get(ser);
  if (handle === undefined) {
    handle = Object.freeze({});
    SIMPLE_INTERN.set(ser, handle);
  }
  return handle;
}

/**
 * Plugin-facing `__memo` wrapper. Accepts a key path that may mix
 * objects and primitives. Object entries go straight into the
 * MemoTrie path. Primitive entries — including the body-hash string
 * — are concatenated into one type-tagged interned-object key
 * appended at the end of the path. Same primitive-tuple → same
 * interned object → same cache entry.
 */
export function __memo<T extends object>(
  keys: ReadonlyArray<unknown>,
  compute: () => T,
): T {
  // NOTE — we used to fast-path "all sources constant" by skipping the
  // trie. That was wrong: even constant-source combinators benefit
  // from identity-sharing downstream (e.g. `derivePipelineState` keys
  // bucket caches on the topology aval's identity; without sharing,
  // every leaf with the same `state.mode` / `state.fillMode` gets its
  // own bucket). Always go through the trie — constants intern by
  // value (see internSimple/Hashable paths below), reactive avals key
  // by reference.
  const objKeys: object[] = [];
  let primParts = "";
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k !== null && (typeof k === "object" || typeof k === "function")) {
      // Avals key by REFERENCE — this cache dedups combinator
      // call-sites that share the *same* source aval variable
      // (`av.map(fn)` written twice with the same `av`), which is
      // identity. We deliberately do NOT value-intern constant avals
      // here: a `ConstantVal` is technically `isHashable` (it carries
      // value-based equals/getHashCode for the explicit pool caches),
      // and routing it through `internHashable` walks a hash bucket
      // calling `equals()` — at scale (one `AVal.constant(Trafo3d…)`
      // per scene leaf, all colliding into one bucket because the
      // matrix-hash distribution is poor) that's O(N²) per frame.
      // Content-equality dedup of constants belongs in the bounded
      // `HashTable`-keyed resource pools, not in this unbounded memo.
      if (isAvalLike(k)) {
        objKeys.push(k as object);
      } else if (isHashable(k as object)) {
        // Aardvark value-types passed *directly* (not wrapped in an
        // aval): V3f / M44f / ... — hash-bucket + equals interning so
        // distinct-instance / equal-data collapses. Bounded in
        // practice (a handful of distinct colours / sizes / etc.).
        objKeys.push(internHashable(k as Hashable));
      } else if (typeof k === "object") {
        // "Simple" plain objects / arrays with primitive leaves —
        // serialise + intern via a module-level Map.
        const handle = internSimple(k as object);
        objKeys.push(handle ?? (k as object));
      } else {
        // Functions / exotic objects → reference identity.
        objKeys.push(k as object);
      }
    } else {
      primParts += tagPrimitive(k);
    }
  }
  if (primParts.length > 0) {
    objKeys.push(internCombined(primParts));
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
export const TAG_ASET_MAPA = Object.freeze({ tag: "aset.mapA" });
export const TAG_ASET_FILTERA = Object.freeze({ tag: "aset.filterA" });
export const TAG_ASET_CHOOSEA = Object.freeze({ tag: "aset.chooseA" });

export const TAG_ALIST_MAP = Object.freeze({ tag: "alist.map" });
export const TAG_ALIST_BIND = Object.freeze({ tag: "alist.bind" });
export const TAG_ALIST_FILTER = Object.freeze({ tag: "alist.filter" });
export const TAG_ALIST_COLLECT = Object.freeze({ tag: "alist.collect" });
export const TAG_ALIST_CHOOSE = Object.freeze({ tag: "alist.choose" });
export const TAG_ALIST_MAPI = Object.freeze({ tag: "alist.mapi" });
export const TAG_ALIST_FILTERI = Object.freeze({ tag: "alist.filteri" });
export const TAG_ALIST_CHOOSEI = Object.freeze({ tag: "alist.choosei" });
export const TAG_ALIST_COLLECTI = Object.freeze({ tag: "alist.collecti" });
export const TAG_ALIST_MAPA = Object.freeze({ tag: "alist.mapA" });
export const TAG_ALIST_FILTERA = Object.freeze({ tag: "alist.filterA" });
export const TAG_ALIST_CHOOSEA = Object.freeze({ tag: "alist.chooseA" });
export const TAG_ALIST_MAPAI = Object.freeze({ tag: "alist.mapAi" });
export const TAG_ALIST_FILTERAI = Object.freeze({ tag: "alist.filterAi" });
export const TAG_ALIST_CHOOSEAI = Object.freeze({ tag: "alist.chooseAi" });

export const TAG_AMAP_MAP = Object.freeze({ tag: "amap.map" });
export const TAG_AMAP_BIND = Object.freeze({ tag: "amap.bind" });
export const TAG_AMAP_FILTER = Object.freeze({ tag: "amap.filter" });
export const TAG_AMAP_CHOOSE = Object.freeze({ tag: "amap.choose" });
export const TAG_AMAP_MAPA = Object.freeze({ tag: "amap.mapA" });
export const TAG_AMAP_FILTERA = Object.freeze({ tag: "amap.filterA" });
export const TAG_AMAP_CHOOSEA = Object.freeze({ tag: "amap.chooseA" });
