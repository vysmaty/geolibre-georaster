import type { ProjectedExtent } from "./crs";

export const MAX_OUTPUT_PIXELS = 50_000_000;

export interface RasterGrid extends ProjectedExtent {
  resolution: number;
  width: number;
  height: number;
  pixelCount: number;
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
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_OUTPUT_PIXELS) {
    throw new Error(
      `The export would contain ${pixelCount.toLocaleString("en-US")} pixels; ` +
        `the limit is ${MAX_OUTPUT_PIXELS.toLocaleString("en-US")}. Increase the pixel size.`,
    );
  }

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

export function createWorldFile(grid: RasterGrid): string {
  const values = [
    grid.resolution,
    0,
    0,
    -grid.resolution,
    grid.minX + grid.resolution / 2,
    grid.maxY - grid.resolution / 2,
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
