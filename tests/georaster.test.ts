import { describe, expect, it } from "vitest";
import {
  projectToSjtsk,
  projectedExtent,
  unprojectFromSjtsk,
} from "../src/lib/georaster/crs";
import {
  MAX_OUTPUT_PIXELS,
  createRasterGrid,
  createWorldFile,
  sanitizeFilename,
} from "../src/lib/georaster/grid";
import { sampleRgba } from "../src/lib/georaster/resampling";

describe("EPSG:5514 conversion", () => {
  it("places Prague in the expected S-JTSK East/North quadrant", () => {
    const [easting, northing] = projectToSjtsk([14.4179, 50.1266]);
    expect(easting).toBeGreaterThan(-800_000);
    expect(easting).toBeLessThan(-600_000);
    expect(northing).toBeGreaterThan(-1_150_000);
    expect(northing).toBeLessThan(-950_000);
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
    expect(createWorldFile(grid)).toBe(
      "2.0000000000\n" +
        "0.0000000000\n" +
        "0.0000000000\n" +
        "-2.0000000000\n" +
        "-99.0000000000\n" +
        "-201.0000000000\n",
    );
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
