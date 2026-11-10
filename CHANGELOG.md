# Changelog

All notable changes to Alpine planner are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-11-10

The first public release.

### Added

- **Temperature tool:** Windy's temperature layer as the minimum or maximum over a time window chosen with Windy's
  range selector, from the model's lossless forecast steps; free accounts use the steps up to the end of the free
  forecast.
- **Lapse rate correction** of the temperature to the real terrain height (about 90 m elevation data), from the
  model's own vertical profile, following the free air below the model terrain; for Instant and for Min / Max.
- **Terrain mask, Elevation:** dims terrain outside an altitude range (500 m to 8 000 m+).
- **Terrain mask, Isotherm:** dims terrain below the forecast freezing level plus an offset, at the timeline time
  or over a time window (Min, Max, Both), with an optional lapse rate correction below the model terrain.
- **Picker labels:** Max / Min, the time of the extreme and the height the value is for.
- **Remembered state:** the range and offset always; the tools' modes, corrections and the isotherm window for
  60 minutes after the last use.
- In-app help, desktop and mobile layouts.

[Unreleased]: https://github.com/tomas-mazak/windy-plugin-alpine-planner/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/tomas-mazak/windy-plugin-alpine-planner/releases/tag/v1.0.0
