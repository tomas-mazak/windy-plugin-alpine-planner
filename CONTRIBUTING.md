# Contributing to Alpine planner

Thanks for your interest! Bug reports, questions about the methods and pull requests are all welcome. For anything
larger than a small fix, please open an issue first so we can agree on the approach.

## Setup

You need Node.js 26 (see [`.nvmrc`](.nvmrc)) and npm.

```sh
npm ci
npm start   # then load https://localhost:9999/plugin.js in Windy's developer mode
```

The [README](README.md#for-developers) explains loading the plugin in Windy, the debug flag and the tests.

## Checks a pull request must pass

CI runs these on every pull request; please run them locally first:

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

Add or update unit tests (`src/**/*.test.ts`) for changes to the pure modules.

The **end-to-end tests** (`npm run test:e2e`) log in to Windy with dedicated test accounts, so they run only in the
maintainer's CI: after a merge to `main` and every night. You don't need accounts to contribute; if you have your own
Windy accounts, you can run them locally as the README describes. Never commit `.env` or anything under `e2e/.auth/`.

## The algorithm documents

Every manipulation of meteorological data (aggregation, interpolation, correction, thresholds) is documented in
[`docs/forecast-layer-algorithm.md`](docs/forecast-layer-algorithm.md) or
[`docs/freezing-mask-algorithm.md`](docs/freezing-mask-algorithm.md), so that meteorologists can review it.
**A pull request that changes the meteorological processing must update the matching document in the same pull
request**, and the code links to the section it implements (`// Algorithm: docs/… §n`). See
[`docs/README.md`](docs/README.md).

Changes to how the plugin hooks into Windy go through `src/features/forecastLayer/windyHooks.ts`, the only module that
patches Windy, and must keep every patch restorable; see [`docs/windy-integration.md`](docs/windy-integration.md).

## Code style

- Follow the existing [Prettier](.prettierrc) and [ESLint](.eslintrc.cjs) configuration (4 spaces, single quotes,
  trailing commas) and the style of the surrounding code. Format the code you touch; please don't reformat unrelated
  code.
- TypeScript in `.ts` and Svelte files; keep pure logic in framework-free modules so it can be unit-tested.
- Comments explain *why*; plain English.

## Licence

By contributing, you agree that your contributions are licensed under the [MIT licence](LICENSE).
