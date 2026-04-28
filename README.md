# adaptive-ts

TypeScript port of [FSharp.Data.Adaptive](https://github.com/fsprojects/FSharp.Data.Adaptive).
Foundation for an Aardvark-style adaptive system in the browser.

Status: phase 1 (AVal core foundation). See `plan.md` and `phase1.md`.

## Build & test

```bash
npm install
npm run build       # tsc -p tsconfig.json
npm test            # vitest run
npm run typecheck   # tsc --noEmit
```
