# Documentation

| Document | For | Covers |
|---|---|---|
| [`forecast-layer-algorithm.md`](forecast-layer-algorithm.md) | meteorologists, developers | The temperature tool: minimum / maximum of 2 m temperature over a time window, spatial interpolation, the picker, and the lapse rate correction to the real terrain height. |
| [`freezing-mask-algorithm.md`](freezing-mask-algorithm.md) | meteorologists, developers | The terrain mask in Isotherm mode: the effective freezing level from `deg0`, the model terrain, T2m and the pressure-level profile; Instant and Min / Max / Both over a time window. |
| [`windy-integration.md`](windy-integration.md) | contributors | How the plugin hooks into Windy: the plugin box, the map layers and their buckets, the tiles, the runtime patches of Windy's client, and how every change is undone. |

## The algorithm documents

Every manipulation of meteorological data in Alpine planner (aggregation, interpolation, correction, thresholds) is
documented in the two algorithm documents, so that meteorologists can validate it.

**Rule for every change to the meteorological processing:**

- **A new or changed manipulation updates its document in the same change** (pull request).
- **The code that implements it links to the section**, e.g. `// Algorithm: docs/forecast-layer-algorithm.md §3`.
- **The document names the code** that implements each section.

Items marked **"To validate"** are open questions for meteorologists. Feedback on them is welcome as a GitHub issue.

## Not covered here

- **The terrain elevation data:** a static global elevation layer at about 90 m resolution (3 arc-seconds), served as
  tiles from Windy's tile server at zooms 0–10 (zoom 10 at full resolution, lower zooms averaged from it). The plugin
  reads it as it is.
- **Windy's own processing** of the model data into tiles (resampling from the model grid, quantisation to 8 bits per
  tile) is Windy's; the algorithm documents state only what the plugin sees in the tiles.
