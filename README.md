# GeoRaster

> **Project scope:** GeoRaster is intentionally focused on EPSG:5514. Support
> for other coordinate reference systems is welcome, but it must be designed
> and implemented by contributors; the maintainer does not currently plan to
> add it.

GeoLibre external plugin that exports the visible map or an individual raster
layer to a georeferenced image in **S-JTSK / Krovak East North (EPSG:5514)**.

The downloaded ZIP contains:

- `<name>.png` or `<name>.jpg` — exported map or raster image
- `<name>.pgw` or `<name>.jgw` — pixel-to-coordinate world file
- `<name>.prj` — EPSG:5514 coordinate reference system

## Install

1. Download the latest `geolibre-georaster-*.zip` from the GitHub release or
   build it locally.
2. In GeoLibre, open **Settings → Manage Plugins**.
3. Install the ZIP and enable **GeoRaster**.
4. Open the exporter from the map button or the **GeoRaster** toolbar menu.

## Use

1. Set map bearing and pitch to `0°` and use the Mercator map projection.
2. Choose **Visible map** or one raster source from the Source list.
3. Choose the target pixel size. `0.20 m/px` is the default for orthophotos.
4. Choose an output geometry when the source needs client-side reprojection:
   - **Rotated image (less precise)** preserves the rectangular map image and
     writes rotation into the world file. It is an affine approximation.
   - **Blank corners (grid aligned)** is the default and produces a regular
     S-JTSK grid. The reprojected visible map can leave transparent corner pixels.
5. Choose a resampling method:
   - **Bilinear** for orthophotos and continuous imagery
   - **Nearest neighbour** for categorical maps and hard pixel boundaries
   - **Cubic** for smoother imagery
6. Choose PNG (lossless, transparency) or JPEG (90% quality, white background).
7. Review the dimensions and detected export method, then select **Export ZIP**.
8. Load the image together with its world file and PRJ in CAD or GIS software.

## Raster source export

- **WMS** requests EPSG:5514 directly when the service advertises it.
- **ArcGIS MapServer/ImageServer** uses the server export endpoint with
  `bboxSR=5514` and `imageSR=5514`.
- **GeoTIFF/COG** is read natively when the original resource is accessible,
  north-up and already stored in EPSG:5514.
- **WMTS** is assembled directly when an EPSG:5514 TileMatrixSet is explicit.
- **XYZ, MBTiles and other raster sources** are isolated and reprojected when
  GeoLibre does not expose a complete, unambiguous S-JTSK tile grid.

When a direct request is unavailable or fails, GeoRaster automatically exports
the isolated layer through the reprojection pipeline and includes the reason as
a warning. Direct service requests are split into aligned blocks for servers
with image-size limits.

The plugin limits an export to 50 million output pixels. Increase the pixel
size when the current map extent exceeds that limit.

## Accuracy and limitations

- Direct and grid-aligned output pixels form a regular Easting/Northing grid in
  EPSG:5514.
- The PGW references pixel centres and uses a negative northing pixel step.
- EPSG:5514 coordinates are normally negative in both axes over Czechia.
- A visible map or fallback layer is flattened before reprojection. Labels and symbols are
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

The ZIP has a root `plugin.json` and a complete `dist` directory containing the
entry point, stylesheet and GeoTIFF decoder chunks required at runtime.

## Česká poznámka

Plugin vyexportuje aktuální mapový výřez nebo jednu rastrovou vrstvu jako
`PNG/JPEG + world file + PRJ` v S-JTSK / EPSG:5514. WMS, ArcGIS, nativní
GeoTIFF/COG a vhodné WMTS se exportují přímo, pokud zdroj 5514 podporuje.
Výchozí režim „Blank corners (grid aligned)“ provede skutečnou reprojekci;
„Rotated image (less precise)“ vloží do world file také rotaci.
Před exportem musí být mapa bez náklonu a natočení.

Released under the [MIT License](LICENSE).
