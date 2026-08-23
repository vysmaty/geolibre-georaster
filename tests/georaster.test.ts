import { describe, expect, it } from "vitest";
import { writeArrayBuffer } from "geotiff";
import type { StyleSpecification } from "maplibre-gl";
import { calculatePanelPosition } from "../src/lib/core/panel-position";
import {
  projectToSjtsk,
  projectedExtent,
  unprojectFromSjtsk,
} from "../src/lib/georaster/crs";
import {
  MAX_OUTPUT_PIXELS,
  createNorthUpWorldFile,
  createRasterGrid,
  createRotatedRasterGrid,
  createWorldFile,
  sanitizeFilename,
} from "../src/lib/georaster/grid";
import { sampleRgba } from "../src/lib/georaster/resampling";
import {
  arcGisSupportsDynamicExport,
  buildArcGisExportUrl,
  buildRasterBlocks,
  buildWmtsTileUrl,
  buildWmsGetMapUrl,
  parseArcGisSource,
  parseWmtsCapabilities,
  parseWmsSource,
  tryDirectRasterExport,
  wmsCapabilitiesSupportSjtsk,
} from "../src/lib/georaster/direct";
import {
  flattenTransparencyOnWhite,
  imageFileExtension,
  rasterFallbackReason,
  worldFileExtension,
} from "../src/lib/georaster/exporter";
import {
  detectRasterSourceKind,
  discoverRasterSources,
  type RasterSourceDescriptor,
} from "../src/lib/georaster/sources";

describe("EPSG:5514 conversion", () => {
  it("places Prague in the expected S-JTSK East/North quadrant", () => {
    const [easting, northing] = projectToSjtsk([14.4179, 50.1266]);
    expect(easting).toBeGreaterThan(-800_000);
    expect(easting).toBeLessThan(-600_000);
    expect(northing).toBeGreaterThan(-1_150_000);
    expect(northing).toBeLessThan(-950_000);
  });

  it("uses the EPSG:5239 coordinate-frame rotation with Proj4js signs", () => {
    const [easting, northing] = projectToSjtsk([14.4179, 50.1266]);
    expect(easting).toBeCloseTo(-742453.829779, 3);
    expect(northing).toBeCloseTo(-1038668.215222, 3);
  });

  it("round-trips geographic coordinates", () => {
    const source = [14.4179, 50.1266] as const;
    const result = unprojectFromSjtsk(projectToSjtsk(source));
    expect(result[0]).toBeCloseTo(source[0], 7);
    expect(result[1]).toBeCloseTo(source[1], 7);
  });

  it("densifies and projects the complete viewport boundary", () => {
    const extent = projectedExtent({
      west: 14.4,
      south: 50.0,
      east: 14.5,
      north: 50.1,
    });
    expect(extent.minX).toBeLessThan(extent.maxX);
    expect(extent.minY).toBeLessThan(extent.maxY);
    expect(extent.maxX).toBeLessThan(0);
    expect(extent.maxY).toBeLessThan(0);
  });
});

describe("raster grid and world file", () => {
  it("aligns the extent to complete pixels", () => {
    const grid = createRasterGrid(
      { minX: -10, minY: -20.1, maxX: 0.1, maxY: 0 },
      2,
    );
    expect(grid.width).toBe(6);
    expect(grid.height).toBe(11);
    expect(grid.maxX).toBe(2);
    expect(grid.minY).toBe(-22);
  });

  it("writes pixel-centre PGW values with a negative Y step", () => {
    const grid = createRasterGrid(
      { minX: -100, minY: -220, maxX: -80, maxY: -200 },
      2,
    );
    expect(createWorldFile(createNorthUpWorldFile(grid))).toBe(
      "2.0000000000\n" +
        "0.0000000000\n" +
        "0.0000000000\n" +
        "-2.0000000000\n" +
        "-99.0000000000\n" +
        "-201.0000000000\n",
    );
  });

  it("writes rotation coefficients for a CAD-oriented viewport export", () => {
    const grid = createRotatedRasterGrid(
      { west: 14.4, south: 50.0, east: 14.5, north: 50.1 },
      2,
    );
    const worldFile = createWorldFile(grid.worldFile)
      .trim()
      .split("\n")
      .map(Number);
    expect(worldFile[1]).not.toBeCloseTo(0, 8);
    expect(worldFile[2]).not.toBeCloseTo(0, 8);
    expect(grid.width * grid.height).toBe(grid.pixelCount);
  });

  it("rejects exports above the browser memory guard", () => {
    expect(() =>
      createRasterGrid(
        { minX: 0, minY: 0, maxX: MAX_OUTPUT_PIXELS + 1, maxY: 1 },
        1,
      ),
    ).toThrow(/limit/);
  });

  it("sanitizes output names", () => {
    expect(sanitizeFilename(" Prague: ortho?.png ")).toBe("Prague-_ortho");
    expect(sanitizeFilename("...")).toBe("geolibre_5514");
  });
});

describe("RGBA resampling", () => {
  const pixels = new Uint8ClampedArray([
    0, 0, 0, 255, 100, 0, 0, 255, 0, 100, 0, 255, 100, 100, 0, 255,
  ]);

  it("uses the closest pixel for nearest neighbour", () => {
    expect(sampleRgba(pixels, 2, 2, 0.8, 0.2, "nearest")).toEqual([
      100, 0, 0, 255,
    ]);
  });

  it("interpolates the four adjacent pixels for bilinear", () => {
    expect(sampleRgba(pixels, 2, 2, 0.5, 0.5, "bilinear")).toEqual([
      50, 50, 0, 255,
    ]);
  });

  it("returns bounded values for cubic interpolation", () => {
    const value = sampleRgba(pixels, 2, 2, 0.5, 0.5, "cubic");
    expect(value[0]).toBeGreaterThanOrEqual(0);
    expect(value[0]).toBeLessThanOrEqual(255);
    expect(value[3]).toBe(255);
  });
});

const rasterSource = (
  overrides: Partial<RasterSourceDescriptor>,
): RasterSourceDescriptor => ({
  id: "source",
  label: "Source",
  layerIds: ["layer"],
  kind: "raster",
  tiles: [],
  metadata: {},
  ...overrides,
});

describe("raster source discovery", () => {
  it("groups raster layers by source and uses GeoLibre metadata names", () => {
    const style = {
      version: 8,
      sources: {
        ortho: {
          type: "raster",
          tiles: [
            "https://example.test/wms?service=WMS&request=GetMap&layers=ortho&bbox={bbox-epsg-3857}",
          ],
        },
        vectors: {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        },
      },
      layers: [
        {
          id: "ortho-layer",
          type: "raster",
          source: "ortho",
          metadata: { name: "Ortofoto" },
        },
        { id: "ortho-overlay", type: "raster", source: "ortho" },
      ],
    } as StyleSpecification;
    const sources = discoverRasterSources(style);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      id: "ortho",
      label: "Ortofoto",
      kind: "wms",
      layerIds: ["ortho-layer", "ortho-overlay"],
    });
  });

  it("recognizes ArcGIS, COG, WMTS, MBTiles and XYZ URLs", () => {
    expect(
      detectRasterSourceKind({
        tiles: [
          "https://example.test/arcgis/rest/services/a/MapServer/tile/{z}/{y}/{x}",
        ],
        metadata: {},
      }),
    ).toBe("arcgis");
    expect(
      detectRasterSourceKind({
        url: "https://example.test/a.tif",
        tiles: [],
        metadata: {},
      }),
    ).toBe("cog");
    expect(
      detectRasterSourceKind({
        tiles: [
          "https://example.test/wmts?service=WMTS&TileMatrix={TileMatrix}",
        ],
        metadata: {},
      }),
    ).toBe("wmts");
    expect(
      detectRasterSourceKind({
        url: "mbtiles://local/a",
        tiles: [],
        metadata: {},
      }),
    ).toBe("mbtiles");
    expect(
      detectRasterSourceKind({
        tiles: ["https://example.test/{z}/{x}/{y}.png"],
        metadata: {},
      }),
    ).toBe("xyz");
  });
});

describe("direct service adapters", () => {
  const block = {
    x: 0,
    y: 0,
    width: 512,
    height: 256,
    minX: -750000,
    minY: -1050000,
    maxX: -749000,
    maxY: -1049500,
  };

  it("parses WMS parameters and creates an EPSG:5514 GetMap request", () => {
    const parsed = parseWmsSource(
      rasterSource({
        kind: "wms",
        tiles: [
          "https://example.test/wms?token=secret&SERVICE=WMS&VERSION=1.3.0&LAYERS=ortho&STYLES=&BBOX={bbox-epsg-3857}",
        ],
      }),
    );
    expect(parsed).toBeDefined();
    const url = new URL(buildWmsGetMapUrl(parsed!, block, "png"));
    expect(url.searchParams.get("CRS")).toBe("EPSG:5514");
    expect(url.searchParams.get("BBOX")).toBe(
      "-750000,-1050000,-749000,-1049500",
    );
    expect(url.searchParams.get("token")).toBe("secret");
    expect(url.searchParams.get("FORMAT")).toBe("image/png");
  });

  it("uses SRS for WMS 1.1.1 and CRS for WMS 1.3.0", () => {
    const version111 = parseWmsSource(
      rasterSource({
        kind: "wms",
        tiles: ["https://example.test/wms?VERSION=1.1.1&LAYERS=ortho"],
      }),
    );
    const version130 = parseWmsSource(
      rasterSource({
        kind: "wms",
        tiles: ["https://example.test/wms?VERSION=1.3.0&LAYERS=ortho"],
      }),
    );
    expect(
      new URL(buildWmsGetMapUrl(version111!, block, "png")).searchParams.get(
        "SRS",
      ),
    ).toBe("EPSG:5514");
    expect(
      new URL(buildWmsGetMapUrl(version130!, block, "png")).searchParams.get(
        "CRS",
      ),
    ).toBe("EPSG:5514");
  });

  it("splits large requests into contiguous blocks on one S-JTSK grid", () => {
    const grid = createRasterGrid(
      { minX: -750000, minY: -1051000, maxX: -749000, maxY: -1050000 },
      0.2,
    );
    const blocks = buildRasterBlocks(grid, 2048);
    expect(blocks).toHaveLength(9);
    expect(blocks[0]).toMatchObject({
      x: 0,
      y: 0,
      width: 2048,
      height: 2048,
      minX: -750000,
      maxY: -1050000,
    });
    expect(blocks.at(-1)).toMatchObject({
      x: 4096,
      y: 4096,
      width: 904,
      height: 904,
      maxX: -749000,
      minY: -1051000,
    });
  });

  it("recognizes EPSG:5514 in namespaced WMS capabilities", () => {
    expect(
      wmsCapabilitiesSupportSjtsk(
        "<WMS_Capabilities><Layer><CRS>EPSG:5514</CRS></Layer></WMS_Capabilities>",
      ),
    ).toBe(true);
    expect(
      wmsCapabilitiesSupportSjtsk("<Layer><CRS>EPSG:3857</CRS></Layer>"),
    ).toBe(false);
  });

  it("builds ArcGIS ImageServer exportImage requests in EPSG:5514", () => {
    const parsed = parseArcGisSource(
      rasterSource({
        kind: "arcgis",
        url: "https://example.test/arcgis/rest/services/ortho/ImageServer/tile/1/2/3",
      }),
    );
    expect(parsed).toMatchObject({ type: "ImageServer" });
    const url = new URL(buildArcGisExportUrl(parsed!, block, "jpeg"));
    expect(url.pathname).toMatch(/ImageServer\/exportImage$/);
    expect(url.searchParams.get("bboxSR")).toBe("5514");
    expect(url.searchParams.get("imageSR")).toBe("5514");
    expect(url.searchParams.get("format")).toBe("jpg");
  });

  it("rejects cached-only ArcGIS MapServer metadata", () => {
    const parsed = parseArcGisSource(
      rasterSource({
        kind: "arcgis",
        url: "https://example.test/arcgis/rest/services/base/MapServer/3",
      }),
    );
    expect(parsed).toMatchObject({ type: "MapServer", layerId: "3" });
    expect(
      arcGisSupportsDynamicExport(parsed!, { capabilities: "TilesOnly" }),
    ).toBe(false);
    expect(
      arcGisSupportsDynamicExport(parsed!, { capabilities: "Map,Query,Data" }),
    ).toBe(true);
    const url = new URL(buildArcGisExportUrl(parsed!, block, "png"));
    expect(url.pathname).toMatch(/MapServer\/export$/);
    expect(url.searchParams.get("layers")).toBe("show:3");
  });

  it("parses an EPSG:5514 WMTS matrix and builds a tile request", () => {
    const capabilities = parseWmtsCapabilities(`
      <Capabilities xmlns:ows="http://www.opengis.net/ows/1.1">
        <Contents><TileMatrixSet>
          <ows:Identifier>sjtsk</ows:Identifier>
          <ows:SupportedCRS>urn:ogc:def:crs:EPSG::5514</ows:SupportedCRS>
          <TileMatrix>
            <ows:Identifier>12</ows:Identifier>
            <ScaleDenominator>714.2857142857</ScaleDenominator>
            <TopLeftCorner>-950000 -900000</TopLeftCorner>
            <TileWidth>256</TileWidth><TileHeight>256</TileHeight>
            <MatrixWidth>64</MatrixWidth><MatrixHeight>64</MatrixHeight>
          </TileMatrix>
        </TileMatrixSet></Contents>
      </Capabilities>
    `);
    expect(capabilities?.tileMatrixSet).toBe("sjtsk");
    expect(capabilities?.matrices[0].resolution).toBeCloseTo(0.2, 8);
    const url = new URL(
      buildWmtsTileUrl(
        "https://example.test/wmts?layer=ortho&TileMatrixSet=sjtsk&TileMatrix={TileMatrix}&TileRow={TileRow}&TileCol={TileCol}",
        "sjtsk",
        "12",
        3,
        4,
      ),
    );
    expect(url.searchParams.get("TILEMATRIX")).toBe("12");
    expect(url.searchParams.get("TILEROW")).toBe("3");
    expect(url.searchParams.get("TILECOL")).toBe("4");
  });

  it("reads and crops a native EPSG:5514 GeoTIFF without reprojection", async () => {
    const geotiff = writeArrayBuffer(
      [
        [
          [10, 20],
          [30, 40],
        ],
        [
          [50, 60],
          [70, 80],
        ],
        [
          [90, 100],
          [110, 120],
        ],
      ],
      {
        width: 2,
        height: 2,
        ModelPixelScale: [1, 1, 0],
        ModelTiepoint: [0, 0, 0, -750000, -1050000, 0],
        ProjectedCSTypeGeoKey: 5514,
        GTModelTypeGeoKey: 1,
        GTRasterTypeGeoKey: 1,
      },
    );
    const grid = createRasterGrid(
      {
        minX: -750000,
        minY: -1050002,
        maxX: -749998,
        maxY: -1050000,
      },
      1,
    );
    const result = await tryDirectRasterExport({
      source: rasterSource({
        kind: "cog",
        url: "https://example.test/native.tif",
      }),
      grid,
      imageFormat: "png",
      resampling: "nearest",
      fetchArrayBuffer: async () => geotiff,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.method).toBe("Native raster");
    expect(result.result.width).toBe(2);
    expect(result.result.height).toBe(2);
    expect([...result.result.pixels.slice(0, 4)]).toEqual([10, 50, 90, 255]);
    expect(result.result.worldFile).toMatchObject({
      a: 1,
      e: -1,
      c: -749999.5,
      f: -1050000.5,
    });
  });

  it("reports a visible fallback reason for a standard Web Mercator XYZ source", async () => {
    const source = rasterSource({
      kind: "xyz",
      tiles: ["https://example.test/{z}/{x}/{y}.png"],
    });
    expect(rasterFallbackReason(source)).toMatch(/explicit EPSG:5514/);
    const result = await tryDirectRasterExport({
      source,
      grid: createRasterGrid({ minX: -10, minY: -10, maxX: 0, maxY: 0 }, 1),
      imageFormat: "png",
      resampling: "nearest",
    });
    expect(result).toEqual({
      ok: false,
      reason: "This raster source requires reprojection.",
    });
  });
});

describe("image formats", () => {
  it("uses conventional image and world-file extensions", () => {
    expect(imageFileExtension("png")).toBe("png");
    expect(worldFileExtension("png")).toBe("pgw");
    expect(imageFileExtension("jpeg")).toBe("jpg");
    expect(worldFileExtension("jpeg")).toBe("jgw");
  });

  it("flattens transparent pixels onto white for JPEG", () => {
    expect([
      ...flattenTransparencyOnWhite(new Uint8ClampedArray([0, 100, 200, 0])),
    ]).toEqual([255, 255, 255, 255]);
    expect([
      ...flattenTransparencyOnWhite(new Uint8ClampedArray([10, 20, 30, 255])),
    ]).toEqual([10, 20, 30, 255]);
  });
});

describe("panel positioning", () => {
  const map = {
    left: 0,
    top: 0,
    right: 1000,
    bottom: 700,
    width: 1000,
    height: 700,
  };
  const button = (left: number, top: number) => ({
    left,
    top,
    right: left + 30,
    bottom: top + 30,
    width: 30,
    height: 30,
  });

  it("anchors the panel inside each map corner", () => {
    expect(calculatePanelPosition(button(10, 10), map, 340, 500)).toMatchObject(
      {
        left: 12,
        top: 46,
      },
    );
    expect(
      calculatePanelPosition(button(960, 10), map, 340, 500),
    ).toMatchObject({
      right: 12,
      top: 46,
    });
    expect(
      calculatePanelPosition(button(10, 660), map, 340, 500),
    ).toMatchObject({
      left: 12,
      bottom: 46,
    });
    expect(
      calculatePanelPosition(button(960, 660), map, 340, 500),
    ).toMatchObject({
      right: 12,
      bottom: 46,
    });
  });

  it("clamps a wide panel to a narrow map", () => {
    const narrowMap = { ...map, right: 300, width: 300 };
    const position = calculatePanelPosition(
      button(260, 10),
      narrowMap,
      340,
      500,
    );
    expect(position.right).toBe(12);
  });
});
