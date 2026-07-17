// Traceable / Monoid instances for HashMap<K, V> + HashMapDelta<K, V>.

import { HashMap } from "../datastructures/hashCollections.js";
import { HashMapDelta } from "../datastructures/hashMapDelta.js";
import { HashMapDeltaExt } from "../datastructures/deltas.js";
import type { Monoid, Traceable } from "./traceable.js";

function hashMapDeltaMonoidImpl<K, V>(): Monoid<HashMapDelta<K, V>> {
  return {
    misEmpty: (d) => d.isEmpty,
    mempty: HashMapDelta.empty<K, V>(),
    mappend: (l, r) => l.combine(r),
  };
}

function hashMapTraceImpl<K, V>(): Traceable<
  HashMap<K, V>,
  HashMapDelta<K, V>
> {
  return {
    tmonoid: hashMapDeltaMonoid<K, V>(),
    tempty: HashMap.empty<K, V>(),
    tapplyDelta: (state, delta) => {
      const { state: ns, delta: ed } = HashMapDeltaExt.applyDelta(state, delta);
      return [ns, ed];
    },
    tcomputeDelta: (a, b) => HashMapDeltaExt.computeDelta(a, b),
    tsize: (d) => d.count,
    tprune: undefined,
  };
}

// Stateless records — ONE shared instance each (generics are erased at
// runtime; fresh closure records per reader/history were a measured
// heap item at scene scale).
const _hashMapDeltaMonoid = hashMapDeltaMonoidImpl<unknown, unknown>();
const _hashMapTrace = hashMapTraceImpl<unknown, unknown>();

/** Monoid for `HashMapDelta<K, V>` (combine = unionWith right-biased). */
export function hashMapDeltaMonoid<K, V>(): Monoid<HashMapDelta<K, V>> {
  return _hashMapDeltaMonoid as unknown as Monoid<HashMapDelta<K, V>>;
}

/** Traceable instance for `HashMap<K, V>` driven by `HashMapDelta<K, V>`. */
export function hashMapTrace<K, V>(): Traceable<HashMap<K, V>, HashMapDelta<K, V>> {
  return _hashMapTrace as unknown as Traceable<HashMap<K, V>, HashMapDelta<K, V>>;
}
