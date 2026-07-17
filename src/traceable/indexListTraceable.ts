// Traceable / Monoid instances for IndexList<T> + IndexListDelta<T>.

import { IndexList } from "../datastructures/indexList.js";
import {
  IndexListDelta,
  IndexListDeltaExt,
} from "../datastructures/indexListDelta.js";
import type { Monoid, Traceable } from "./traceable.js";

function indexListDeltaMonoidImpl<T>(): Monoid<IndexListDelta<T>> {
  return {
    misEmpty: (d) => d.isEmpty,
    mempty: IndexListDelta.empty<T>(),
    mappend: (l, r) => l.combine(r),
  };
}

function indexListTraceImpl<T>(): Traceable<
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

// Stateless records — ONE shared instance each (see hashMapTraceable).
const _indexListDeltaMonoid = indexListDeltaMonoidImpl<unknown>();
const _indexListTrace = indexListTraceImpl<unknown>();

/** Monoid for `IndexListDelta<T>` (combine = MapExt union right-biased). */
export function indexListDeltaMonoid<T>(): Monoid<IndexListDelta<T>> {
  return _indexListDeltaMonoid as unknown as Monoid<IndexListDelta<T>>;
}

/** Traceable instance for `IndexList<T>` driven by `IndexListDelta<T>`. */
export function indexListTrace<T>(): Traceable<IndexList<T>, IndexListDelta<T>> {
  return _indexListTrace as unknown as Traceable<IndexList<T>, IndexListDelta<T>>;
}
