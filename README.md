# GeoLibre GeoRaster Export

GeoLibre external plugin that exports the visible map to a georeferenced raster
in **S-JTSK / Krovak East North (EPSG:5514)**.

The downloaded ZIP contains:

- `<name>.png` — flattened RGBA map image
- `<name>.pgw` — pixel-to-coordinate world file
- `<name>.prj` — EPSG:5514 coordinate reference system

## Install

1. Download the latest `geolibre-georaster-*.zip` from the private GitHub release or
   build it locally.
2. In GeoLibre, open **Settings → Manage Plugins**.
3. Install the ZIP and enable **GeoLibre GeoRaster Export**.
4. Open the exporter from the map button or the **GeoRaster** toolbar menu.

## Use

1. Set map bearing and pitch to `0°` and use the Mercator map projection.
2. Choose the target pixel size. `0.20 m/px` is the default for orthophotos.
3. Choose an output geometry:
   - **Rotated image (CAD)** preserves the rectangular map image and writes the
     rotation into the PGW. It is the default and is appropriate for small CAD
     inserts; it is an affine approximation.
   - **North-up S-JTSK grid (precise)** performs a complete raster reprojection.
     It is spatially more accurate over larger areas, but can contain empty corner
     pixels because the reprojected map does not fill its rectangular S-JTSK extent.
4. Choose a resampling method for the precise north-up mode:
   - **Bilinear** for orthophotos and continuous imagery
   - **Nearest neighbour** for categorical maps and hard pixel boundaries
   - **Cubic** for smoother imagery
5. Review the calculated dimensions and select **Export ZIP**.
6. Load the PNG in QGIS together with its PGW and PRJ files.

The plugin limits an export to 50 million output pixels. Increase the pixel
size when the current map extent exceeds that limit.

## Accuracy and limitations

- Output pixels form a regular Easting/Northing grid in EPSG:5514.
- The PGW references pixel centres and uses a negative northing pixel step.
- EPSG:5514 coordinates are normally negative in both axes over Czechia.
- The visible map is flattened before reprojection. Labels and symbols are
  therefore resampled together with imagery.
- Runtime custom or Deck.gl layers that cannot be represented by the cloned
  MapLibre style may be omitted.
- Tile servers must permit browser/CORS access. Authenticated sources whose
  request transformation cannot be reproduced may fail in the export renderer.
- The bundled CRS conversion uses EPSG transformation 5239, whose stated
  accuracy is 1 metre. It is intended for map imagery, not cadastral surveying.

## Development

Requirements: Node.js 20+ and pnpm 11.

```powershell
pnpm install
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run package:geolibre
```

The installable bundle is created at:

```text
geolibre-plugin/geolibre-georaster-<version>.zip
```

The ZIP has a root `plugin.json` and self-contained `dist/index.js` and
`dist/style.css`, matching the current GeoLibre external plugin contract.

## Česká poznámka

Plugin vyexportuje aktuální mapový výřez jako `PNG + PGW + PRJ` v
S-JTSK / EPSG:5514. Výchozí režim „Rotated image (CAD)“ vloží do PGW také
rotaci; přesný severový režim provede skutečnou reprojekci.
Před exportem musí být mapa bez náklonu a natočení.

This repository is private and currently unlicensed.
