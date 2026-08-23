import {
  projectToSjtsk,
  type GeographicBounds,
  type ProjectedExtent,
} from "./crs";

export const MAX_OUTPUT_PIXELS = 50_000_000;

export interface RasterGrid extends ProjectedExtent {
  resolution: number;
  width: number;
  height: number;
  pixelCount: number;
}

export interface WorldFileTransform {
  a: number;
  d: number;
  b: number;
  e: number;
  c: number;
  f: number;
}

export interface RotatedRasterGrid {
  resolution: number;
  width: number;
  height: number;
  pixelCount: number;
  worldFile: WorldFileTransform;
}

function validatePixelCount(width: number, height: number): number {
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_OUTPUT_PIXELS) {
    throw new Error(
      `The export would contain ${pixelCount.toLocaleString("en-US")} pixels; ` +
        `the limit is ${MAX_OUTPUT_PIXELS.toLocaleString("en-US")}. Increase the pixel size.`,
    );
  }
  return pixelCount;
}

export function createRasterGrid(
  extent: ProjectedExtent,
  resolution: number,
): RasterGrid {
  if (!Number.isFinite(resolution) || resolution <= 0) {
    throw new Error("Resolution must be a positive number.");
  }

  const width = Math.max(
    1,
    Math.ceil((extent.maxX - extent.minX) / resolution),
  );
  const height = Math.max(
    1,
    Math.ceil((extent.maxY - extent.minY) / resolution),
  );
  const pixelCount = validatePixelCount(width, height);

  return {
    ...extent,
    maxX: extent.minX + width * resolution,
    minY: extent.maxY - height * resolution,
    resolution,
    width,
    height,
    pixelCount,
  };
}

export function createNorthUpWorldFile(grid: RasterGrid): WorldFileTransform {
  return {
    a: grid.resolution,
    d: 0,
    b: 0,
    e: -grid.resolution,
    c: grid.minX + grid.resolution / 2,
    f: grid.maxY - grid.resolution / 2,
  };
}

function distance(
  first: readonly [number, number],
  second: readonly [number, number],
): number {
  return Math.hypot(second[0] - first[0], second[1] - first[1]);
}

export function createRotatedRasterGrid(
  bounds: GeographicBounds,
  resolution: number,
): RotatedRasterGrid {
  if (!Number.isFinite(resolution) || resolution <= 0) {
    throw new Error("Resolution must be a positive number.");
  }
  const topLeft = projectToSjtsk([bounds.west, bounds.north]);
  const topRight = projectToSjtsk([bounds.east, bounds.north]);
  const bottomLeft = projectToSjtsk([bounds.west, bounds.south]);
  const width = Math.max(
    1,
    Math.ceil(distance(topLeft, topRight) / resolution),
  );
  const height = Math.max(
    1,
    Math.ceil(distance(topLeft, bottomLeft) / resolution),
  );
  const a = (topRight[0] - topLeft[0]) / width;
  const d = (topRight[1] - topLeft[1]) / width;
  const b = (bottomLeft[0] - topLeft[0]) / height;
  const e = (bottomLeft[1] - topLeft[1]) / height;
  return {
    resolution,
    width,
    height,
    pixelCount: validatePixelCount(width, height),
    worldFile: {
      a,
      d,
      b,
      e,
      c: topLeft[0] + (a + b) / 2,
      f: topLeft[1] + (d + e) / 2,
    },
  };
}

export function createWorldFile(transform: WorldFileTransform): string {
  const values = [
    transform.a,
    transform.d,
    transform.b,
    transform.e,
    transform.c,
    transform.f,
  ];
  return `${values.map((value) => value.toFixed(10)).join("\n")}\n`;
}

export function sanitizeFilename(value: string): string {
  const printable = [...value]
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("");
  const sanitized = printable
    .trim()
    .replace(/\.[^.]+$/, "")
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[-_.]+|[-_.]+$/g, "");
  return sanitized || "geolibre_5514";
}
