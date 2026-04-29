// Traceable / Monoid instances for IndexList<T> + IndexListDelta<T>.

import { IndexList } from "../datastructures/indexList.js";
import {
  IndexListDelta,
  IndexListDeltaExt,
} from "../datastructures/indexListDelta.js";
import type { Monoid, Traceable } from "./traceable.js";

/** Monoid for `IndexListDelta<T>` (combine = MapExt union right-biased). */
export function indexListDeltaMonoid<T>(): Monoid<IndexListDelta<T>> {
  return {
    misEmpty: (d) => d.isEmpty,
    mempty: IndexListDelta.empty<T>(),
    mappend: (l, r) => l.combine(r),
  };
}

/** Traceable instance for `IndexList<T>` driven by `IndexListDelta<T>`. */
export function indexListTrace<T>(): Traceable<
  IndexList<T>,
  IndexListDelta<T>
> {
  return {
    tmonoid: indexListDeltaMonoid<T>(),
    tempty: IndexList.empty<T>(),
    tapplyDelta: (state, delta) => {
      const r = IndexListDeltaExt.applyDelta(state, delta);
      return [r.state, r.delta];
    },
    tcomputeDelta: (a, b) => IndexListDeltaExt.computeDelta(a, b),
    tsize: (d) => d.count,
    tprune: undefined,
  };
}
