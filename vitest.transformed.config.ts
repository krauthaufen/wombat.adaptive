// Vitest config for behavioural tests of the adaptive-memo plugin.
//
// Tests under `tests/plugin/transformed/**/*.test.ts` are compiled with
// the plugin actually applied to test sources. Aliases route the public
// `@aardworx/wombat.adaptive/...` import paths back to `src/...` so the
// test sources, the plugin's emitted runtime import, and the rest of the
// adaptive runtime all live in a single module instance (avoiding the
// dual-instance problem that would otherwise split TAG_* identity and
// the MemoTrie's state between dist and src).
//
// The plugin's own AST-shape tests live at `tests/plugin/transform.test.ts`
// and are explicitly excluded — running them through the plugin would
// transform their inline source-strings on the way in (harmless), but
// more importantly we don't want the plugin's TYPE-CHECKER behaviour to
// blow up on synthetic snippets. Excluding keeps that suite isolated.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { adaptiveMemoPlugin } from "./src/plugin/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => resolve(__dirname, "src", p);

export default defineConfig({
  plugins: [
    adaptiveMemoPlugin({
      // Match only the transformed-test directory. This keeps every
      // other file (including this config, the plugin source itself,
      // and the rest of the project) untouched.
      match: (id) => /[\\/]tests[\\/]plugin[\\/]transformed[\\/].*\.tsx?$/.test(id),
      internalModule: "@aardworx/wombat.adaptive/plugin/runtime",
    }),
  ],
  resolve: {
    alias: [
      // Self-package import paths → src/. Order matters: longer prefixes
      // first so `/plugin/runtime` doesn't get swallowed by `/plugin`.
      { find: "@aardworx/wombat.adaptive/plugin/runtime", replacement: src("plugin/runtime.ts") },
      { find: "@aardworx/wombat.adaptive/plugin", replacement: src("plugin/index.ts") },
      { find: "@aardworx/wombat.adaptive/internal", replacement: src("internal/memo.ts") },
      { find: "@aardworx/wombat.adaptive/aval", replacement: src("aval.ts") },
      { find: "@aardworx/wombat.adaptive/aset", replacement: src("aset.ts") },
      { find: "@aardworx/wombat.adaptive/alist", replacement: src("alist.ts") },
      { find: "@aardworx/wombat.adaptive/amap", replacement: src("amap.ts") },
      { find: "@aardworx/wombat.adaptive/datastructures", replacement: src("datastructures.ts") },
      { find: "@aardworx/wombat.adaptive/extensions", replacement: src("extensions.ts") },
      { find: "@aardworx/wombat.adaptive/traceable", replacement: src("traceable.ts") },
      { find: "@aardworx/wombat.adaptive/reference", replacement: src("reference.ts") },
      { find: "@aardworx/wombat.adaptive", replacement: src("index.ts") },
    ],
  },
  test: {
    include: ["tests/plugin/transformed/**/*.test.ts"],
    globals: false,
  },
});
