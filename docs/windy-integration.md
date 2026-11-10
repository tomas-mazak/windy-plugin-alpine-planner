# How Alpine planner integrates with Windy

*Audience: contributors. Read this before changing anything that touches Windy's map, picker, timeline or layers.*

Alpine planner is an external Windy plugin. Most of what it does uses the plugin API: the `@windy/*` modules (the
build rewrites their imports to Windy's runtime objects), the `store` and `broadcast` events, and MapLibre custom
layers in Windy's ordered layer buckets. The **forecast layer** goes further: to replace Windy's temperature layer it
patches a few of Windy's client internals at runtime. This document describes what the plugin relies on, why, and how
every change to Windy is undone.

Everything here describes **observed behaviour** of the live Windy client, verified in the browser and by the
end-to-end tests. None of it is a documented contract.

## 1. The plugin box

`src/pluginConfig.ts` sets `desktopUI: 'embedded'` and `mobileUI: 'small'`.

| | Desktop (`embedded`) | Mobile (`small`) |
|---|---|---|
| Windy's box | 320 px wide, at most **200 px** tall (`max-height`), padding `0.5em 1em`, 40 px on the right for Windy's close button | full width, at most **200 px** tall, padding 5 px, close button above the box |
| Our root | fills the content height exactly (`calc(200px - 1em)`), so the box never changes size | its natural height |

- **The 200 px limit is Windy's.** The panel shows one tool at a time (TEMP or MASK) so every state fits; the
  end-to-end tests check the 320 × 200 desktop box in every state they visit.
- **Plain markup.** The root is a plain `<section>`. Windy's `plugin__content` wrapper is absolutely positioned
  (`inset: 0`) for the full-height right-hand pane; inside the auto-height embedded slot it contributes no height and
  the content is clipped to a thin strip.
- **Overlays outside the box.** The help modal and the mobile "Isotherm settings" popover are mounted on
  `document.body`, so they aren't clipped by the box. Both are removed when the plugin closes.
- **Mobile layout** is chosen by Windy at page load from the user agent (`isMobileOrTablet`), not from the viewport
  size: device emulation needs a mobile user agent and a reload.
- **Keyboard:** Windy's own keyboard handler takes the arrow keys (it moves the timeline by an hour) before they reach
  a range input. Our sliders therefore respond to the mouse and touch; `NumberField` stops the keys it uses itself.

## 2. Map layers

Both features draw with **MapLibre custom layers** (`CustomLayerInterface`) added through `@windy/map`:
`map.addMapLibreOrderedLayerToBucket(layer, bucket)`, `map.moveMapLibreOrderedLayerToBucket(id, bucket)` and
`map.removeMapLibreOrderedLayer(id)`. Removal is synchronous: the layer's `onRemove` frees its GL resources before
the call returns.

### Buckets

Windy draws its layers in ordered buckets (`layerOrder`). The values the plugin relies on:

| Bucket | Value | Content |
|---|---|---|
| `MAIN` | 200 | Windy's weather layer (and our forecast layer) |
| `PARTICLES` | 250 | wind particles |
| `LANDMASK_SEAMASK` | 300 | land / sea mask |
| *(ours)* | **350** | the terrain mask, below MapLibre zoom 10.5 |
| `BASE_MAP` / `TOPO_MAP` | 400 / 401 | the base map: an alpha-blended grey map, then from MapLibre zoom 10.5 an opaque topographic map |
| *(ours)* | **440** | the terrain mask, from MapLibre zoom 10.5 |
| `PARTICLES_HIGH_ZOOM` | 450 | wind particles at high zoom |

- **Terrain mask** (`src/features/elevationMask/layer.ts`, `bucketForZoom`): at 350 it dims the weather colours and
  particles, while borders, lakes and labels stay crisp above it. From MapLibre zoom `grayMapZoomEnd − 0.5` (10.5,
  `@windy/baseMap`) Windy's opaque topographic map would cover bucket 350, so the mask moves to 440, above the
  topographic map, which is what Windy does with its own wind particles.
- **Forecast layer** (`src/features/forecastLayer/controller.ts`): in `MAIN`, the same bucket as Windy's layer, so
  it blends with the base map exactly the same way, and the topographic map covers it from zoom 10.5 as it covers
  Windy's. The terrain mask stays above it.
- The packaged `@windycom/plugin-devtools` types for `layerOrder` lack `TOPO_MAP` and `ALPHA_CLEAR`, which exist at
  runtime; `src/features/elevationMask/constants.ts` uses plain numbers.

### Geometry and tiles

- **WebGL2 only.** Windy's map renders with WebGL2, so the shaders are GLSL ES 3.00.
- **Projection:** `args.modelViewProjectionMatrix` expects geometry in **Mercator pixel space**, world size
  `512 · 2^z` at MapLibre zoom `z` (not MapLibre's `[0, 1]` `MercatorCoordinate`). Each tile is one quad.
- **Zoom:** Windy's (Leaflet-style) `map.getZoom()` is MapLibre zoom + 1. Render tiles are 256 px at
  `z = floor(MapLibre zoom + 1)` for the mask and `round(MapLibre zoom + 1)` for the forecast layer, as Windy's own
  temperature layer picks them.
- **Tile cache:** the terrain mask uses the global `L.TileCache` with its classic API:
  `new L.TileCache(loadTile, beforeTileDeleted)`, `cache.update({ min: { x, y }, max: { x, y } }, z)` and
  `cache.getOrderedTilePyramid(bounds, z, maxLower, maxHigher)` for the loaded ancestors and descendants of the view.
  The transform-based `update(transform, options)` signature doesn't work from a plugin. Tile x ranges are unwrapped
  across ±180°, so the mask covers both sides of the antimeridian.
- **Stencil:** overlapping ancestor and descendant tiles are resolved with the stencil test (the most detailed tile
  wins). After drawing, the layer resets the stencil (`painter.clearStencil()`), so MapLibre redraws its own stencil
  masks; the forecast layer also sets the framebuffer alpha to 1, as Windy's layer does.
- **3D globe:** neither layer draws while `isGlobeActive()`. The forecast layer deactivates completely in the globe
  (§5), so Windy's own layer is shown there.

## 3. Tiles and data

All data comes from Windy's tile server `ims.windy.com`, in Windy's `/im/v3.0` tile format: a 257 × 265 px image,
an 8-row header with the per-tile value range, then 257 × 257 corner-registered nodes. `src/lib/windyTile.ts` decodes
it exactly as Windy does (`@windy/TileLayerUtils` can be imported statically too, but the plugin keeps its own
framework-free decoder so the pure modules can be unit-tested).

- **Images are decoded without colour management:** `createImageBitmap(blob, { colorSpaceConversion: 'none',
  premultiplyAlpha: 'none' })`, so the bytes are the stored values.
- **PNG, not JPEG,** for every forecast field: the PNG and JPEG tiles have the same layout and header, but JPEG adds
  compression noise that would bias minima and maxima and break the `deg0`-equals-terrain test (see the algorithm
  docs). Nodata is alpha 0 in PNG (blue ≥ 192 in JPEG).
- **Authentication:** forecast tile URLs go through `addTileAuthParams` from `@windy/authParams` (available at
  runtime; `declarations/index.d.ts` declares it, since the devtools ship no types for it). Without it, zooms above
  the free `maxTileZoom` are refused.
- **Data zoom:** the forecast layer uses the same data tiles as Windy (`getDataZoom` with Windy's render params), and
  the picker's data zoom follows Windy's picker rule: `round(clamp(MapLibre zoom, 2, 10)) + 1`.
- **Model terrain:** `gh-surface` from the model's analysis. The plugin requests the first tile with a far-future
  reference time (`2099010100`); the server redirects it to the model's active analysis run, and the plugin reads that
  run from the final URL and uses it for every other terrain tile (`src/features/elevationMask/deg0.ts`).
- **Elevation:** a static global layer under `analysis/elevation/<reftime>` (zooms 0–10; above 10 the plugin
  over-zooms), `src/features/elevationMask/constants.ts`.
- **Caching:** tiles are sent with `cache-control: max-age=86400` and no `Vary`, so repeated requests are served from
  the browser's HTTP cache. The plugin also keeps decoded step tiles in its own byte-budgeted LRU
  (`src/lib/stepTiles.ts`).

## 4. Runtime patches of Windy's client (the forecast layer)

`src/features/forecastLayer/windyHooks.ts` is **the only module that patches Windy**. It has four patches, each a
setter that is idempotent, remembers Windy's original on first use and puts it back on `null` / `false`.

| Patch | What it changes | Why | Restore |
|---|---|---|---|
| `setInterpolatorOverride(factory)` | `renderers.tileLayer.interpolator`, a plain property shared by Windy's tile layer renderers | Windy's desktop and mobile pickers read values through it; ours returns the folded or corrected value | the original object, unless Windy has replaced ours in the meantime (then Windy's stays) |
| `setPickerDecorator(fn)` | wraps `overlays.temp.createPickerHTML`, which both pickers use to format the value | adds "Max" / "Min" before the value and a second line with the time of the extreme and the height | the original method, if ours is still installed |
| `setRangeControl(on)` | sets `renderers.tileLayer.userControl` to `'accumulations'` | Windy's range selector replaces the timeline, so the user picks the window with Windy's own control | the original control: `'progress-bar'` on desktop, `'mobile-calendar'` on mobile |
| `setWindyLayerHidden(hidden)` | `visibility: 'none'` on Windy's temperature MapLibre layer | our layer replaces it | `'visible'` |

### The interpolator

- Windy's interpolator factory hands out two functions, `latLon(latLon, abort?, params?)` and
  `xy(x, y, abort?, params?)` (Mercator pixels of 256 px tiles at MapLibre zoom + 1). For temperature it resolves to
  `[K, 0, 0]`, or `null` where there's no data or no tile loaded.
- `createInterpolator(sample)` builds a factory with that interface. **Calls that pass another layer's render
  params** (the picker's wind companion row on some overlays) go to Windy's interpolator.
- **Who reads it:** the desktop picker re-reads the interpolator on `redrawFinished` and on
  `picker.emit('dataChanged')`; the mobile picker re-reads it only on `redrawFinished` (and map `moveend`), and
  `dataChanged` only re-renders it. The `cities` POI mode reads it too, unlabelled. **City labels are not affected**:
  their temperatures come from Windy's point-forecast API.
- **The decorator** recognises our value arrays by identity (a `WeakMap` in `controller.ts`), so it leaves any value
  Windy computed itself alone.

### The range control

- On every params broadcast Windy compares `renderers.tileLayer.userControl` with the control it has open, and
  closes and opens controls itself. So the plugin only sets the property and triggers a broadcast (below); it never
  opens or closes the controls by hand, which would leave Windy's record of the open control stale.
- `watchRangeWindow` reads the window as `[timestamp, timestamp + acRange h]`. On desktop `acRange` is fractional
  while dragging and `timestamp` can lie between forecast steps; on mobile the duration buttons give 12, 24, 48, 96 or
  192 h. The plugin takes the steps inside the window itself (`src/lib/steps.ts`).
- **Free users:** Windy's range selector marks the premium days but lets a free user select them, and doesn't cap
  `acRange`. The plugin drops the steps after the free horizon itself and says so in the panel.

### Hiding Windy's layer

- All of Windy's tile layer renderers share one MapLibre layer, named after whichever renderer created it first:
  `'tileLayer'` normally, `'accumulations'` if the session started on an accumulation overlay, and so on. The hooks
  look it up among the known names.
- **A one-off `setLayoutProperty` doesn't hold:** Windy makes its layer visible again on every params change
  (timeline, model, new run) and then emits `tileLayerParamsChanged` synchronously. The hooks hide it again in that
  event, before the next frame.
- The hidden layer **keeps loading tiles**, so Windy's own interpolator keeps working and `redrawFinished` keeps
  firing; the cost is that Windy's tile textures stay in GPU memory next to ours.

### Making Windy notice

- `notifyPickerDataChanged()` emits `picker.emit('dataChanged')`: the desktop picker re-reads and re-renders, the
  mobile picker re-renders.
- The mobile picker's re-read and the control swap happen only on a **params broadcast**. Installing or restoring the
  interpolator or the range control therefore re-sets an unsaved store value:

  ```ts
  store.set('levelsRange', store.get('levelsRange'), { forceChange: true });
  ```

  Windy then broadcasts its current params once, debounced together with any real change. `levelsRange` is used
  because it isn't saved or synced and only the levels-range UI listens to it. Alternatives that don't work as well:
  `redrawLayers` reloads every tile layer and doesn't swap the control; `metricChanged` has many listeners and misses
  the mobile picker; emitting `paramsChanged` directly could run concurrently with Windy's own debounced broadcast.

### Drawing like Windy

Our temperature layer (`src/features/forecastLayer/layer.ts`, `shaders.ts`, `colorLut.ts`) reproduces Windy's two
passes, so it looks identical to Windy's layer (verified by alternating the two at zoom 4–13, with a customised
palette, on desktop and phone):

1. **Colour:** each render tile is coloured once into a 256² RGBA8 texture at texel centres: a Catmull-Rom bicubic over
   the 4 × 4 nodes, clamped to the 2 × 2 neighbours, Windy's colour scale, and grey where the bilinear nodata weight
   exceeds 0.33.
2. **Draw:** the coloured textures are drawn with LINEAR filtering, opaque; then the framebuffer alpha is set to 1.

The colour scale is Windy's own table (`colors.temp.getColor()`, 2048 steps, Kelvin), so a customised palette applies
automatically; it's rebuilt on `redrawLayers`, which Windy emits when the palette changes.

## 5. Restoring Windy

`restoreAll()` undoes every patch and is safe to call at any time. The controller activates the forecast layer only
while all of these hold: the plugin is open, the overlay is Temperature at the surface, the map isn't the 3D globe,
and the mode is Min or Max (or Instant with the lapse rate correction). On activation it adds our layer, hides
Windy's, swaps in the range control (Min / Max only) and installs the interpolator and the decorator. **Every way
out** removes our layer and calls `restoreAll()`:

| Exit path | Trigger |
|---|---|
| back to Instant (without the correction) | the panel |
| another overlay or another level | `store` `overlay` / `level` |
| the 3D globe | `store` `mapLibrary` |
| closing the plugin | `ForecastLayerPanel`'s `onDestroy` → `stopForecastLayer()` |
| a page reload | nothing to restore: the patches live only in memory |

The terrain mask doesn't patch Windy; it removes its layer when its mode is set to Off and when the plugin closes.
All store, broadcast and DOM listeners are removed on close.

**Checks:**

- `setHooksDebug(true)` in `windyHooks.ts` logs every install and restore, and after each `redrawFinished` checks
  that each installed patch is still in place, logging `[alpine-planner] windyHooks: Windy undid our …` as an error
  if not. It isn't wired to the debug flag; call it from the code while working on the hooks.
- The test API's `hooks()` (README, *Test API*) reports which patches are in place, and whether the interpolator and
  the user control are Windy's originals.

## 6. These patches can break

The four patches in §4 rely on **Windy's client internals, not on the plugin API**: property names, the order of
events, and how Windy reacts to them. Any Windy release can change them, and the plugin would then fail silently
(the picker showing Windy's value instead of ours, two timeline controls, Windy's layer showing through ours, or a
patch not being undone).

That's why the **nightly end-to-end run** exists: it runs the suite against production windy.com every day. The
forecast-layer specs check each patch and each exit path of §5 (`hooks()` back to Windy's originals, the native
timeline visible); the other specs rely on a few of Windy's DOM ids (`#plugin-progress-bar`, `#plugin-mobile-calendar`,
`#plugin-accumulations`, `#plugin-developer-mode`, `#plugin-login`, `.picker`) and `W` exports. A nightly failure
after a Windy release is the signal to look here first.

When a patch breaks, keep the rule: **one module patches Windy, and every patch is restorable.** Prefer a fix that
fails safe (Windy's own behaviour) over one that keeps the feature working at the risk of leaving Windy modified.
