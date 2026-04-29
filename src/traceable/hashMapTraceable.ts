// Traceable / Monoid instances for HashMap<K, V> + HashMapDelta<K, V>.

import { HashMap } from "../datastructures/hashCollections.js";
import { HashMapDelta } from "../datastructures/hashMapDelta.js";
import { HashMapDeltaExt } from "../datastructures/deltas.js";
import type { Monoid, Traceable } from "./traceable.js";

/** Monoid for `HashMapDelta<K, V>` (combine = unionWith right-biased). */
export function hashMapDeltaMonoid<K, V>(): Monoid<HashMapDelta<K, V>> {
  return {
    misEmpty: (d) => d.isEmpty,
    mempty: HashMapDelta.empty<K, V>(),
    mappend: (l, r) => l.combine(r),
  };
}

/** Traceable instance for `HashMap<K, V>` driven by `HashMapDelta<K, V>`. */
export function hashMapTrace<K, V>(): Traceable<
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
