// Port of FSharp.Data.Adaptive Datastructures/MultiSetMap.fs

import { HashMap, HashSet } from "./hashCollections.js";

/** A simple multi-map: key → set of values. */
export type MultiSetMap<K, V> = HashMap<K, HashSet<V>>;

export const MultiSetMap = {
  empty: <K, V>(): MultiSetMap<K, V> => HashMap.empty<K, HashSet<V>>(),

  add: <K, V>(
    key: K,
    value: V,
    m: MultiSetMap<K, V>,
  ): MultiSetMap<K, V> => {
    return m.alter(key, (old) => {
      if (old !== undefined) return old.add(value);
      return HashSet.single(value);
    });
  },

  remove: <K, V>(
    key: K,
    value: V,
    m: MultiSetMap<K, V>,
  ): { wasLast: boolean; result: MultiSetMap<K, V> } => {
    let wasLast = false;
    const result = m.alter(key, (old) => {
      if (old === undefined) return undefined;
      const s = old.remove(value);
      if (s.isEmpty) {
        wasLast = true;
        return undefined;
      }
      return s;
    });
    return { wasLast, result };
  },

  find: <K, V>(key: K, m: MultiSetMap<K, V>): HashSet<V> => {
    const s = m.tryFind(key);
    return s ?? HashSet.empty<V>();
  },
};
