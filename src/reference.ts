// Sub-path barrel: `@aardworx/adaptive/reference`.
//
// The slow-but-obviously-correct executable spec used by the
// property tests. Useful when writing tests of your own that
// exercise an adaptive expression against a reference baseline.

export * as RefAVal from "./reference/adaptiveValue.js";
export * as RefASet from "./reference/adaptiveHashSet.js";
export * as RefAMap from "./reference/adaptiveHashMap.js";
export * as RefAList from "./reference/adaptiveIndexList.js";
