import { strToU8, zipSync } from "fflate";
import type { Map as MapLibreMap } from "maplibre-gl";
import { captureVisibleMap } from "./capture";
import { EPSG_5514_WKT, projectedExtent } from "./crs";
import { tryDirectRasterExport, type FetchArrayBuffer } from "./direct";
import {
  createNorthUpWorldFile,
  createRasterGrid,
  createRotatedRasterGrid,
  createWorldFile,
  sanitizeFilename,
} from "./grid";
import {
  findRasterSource,
  isExplicitSjtskTileSource,
  predictedExportMethod,
  type RasterSourceDescriptor,
} from "./sources";
import type { ExportSettings, ImageFormat, OutputGeometry } from "./types";
import { warpRaster } from "./warp";

export type ExportPhase = "capture" | "reproject" | "package";

export interface ExportProgress {
  phase: ExportPhase;
  percent: number;
}

export interface ExportResult {
  filename: string;
  width: number;
  height: number;
  warnings: string[];
  method: string;
}

export interface ExportRuntimeOptions {
  fetchArrayBuffer?: FetchArrayBuffer;
}

export interface ExportPreview {
  width: number;
  height: number;
  pixelCount: number;
  method: string;
  directCandidate: boolean;
  warning?: string;
}

function mapBounds(map: MapLibreMap) {
  const bounds = map.getBounds();
  return {
    west: bounds.getWest(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    north: bounds.getNorth(),
  };
}

export function calculateExportGrid(map: MapLibreMap, resolution: number) {
  return createRasterGrid(projectedExtent(mapBounds(map)), resolution);
}

export function calculateRotatedExportGrid(
  map: MapLibreMap,
  resolution: number,
) {
  return createRotatedRasterGrid(mapBounds(map), resolution);
}

export function calculateOutputGrid(
  map: MapLibreMap,
  resolution: number,
  outputGeometry: OutputGeometry,
) {
  return outputGeometry === "rotated"
    ? calculateRotatedExportGrid(map, resolution)
    : calculateExportGrid(map, resolution);
}

function supportsDirectAttempt(source: RasterSourceDescriptor): boolean {
  return (
    source.kind === "wms" ||
    source.kind === "arcgis" ||
    source.kind === "cog" ||
    (source.kind === "wmts" && isExplicitSjtskTileSource(source))
  );
}

export function rasterFallbackReason(
  source: RasterSourceDescriptor,
): string | undefined {
  if (supportsDirectAttempt(source)) return undefined;
  if (source.kind === "wmts") {
    return "The WMTS source does not declare an EPSG:5514 tile matrix.";
  }
  if (source.kind === "xyz" || source.kind === "mbtiles") {
    return "The source does not expose an explicit EPSG:5514 tile grid.";
  }
  if (source.kind === "raster") {
    return "The original EPSG:5514 raster is not available to the plugin.";
  }
  return "This raster source does not support direct EPSG:5514 export.";
}

function selectedRasterSource(
  map: MapLibreMap,
  settings: ExportSettings,
): RasterSourceDescriptor | undefined {
  if (settings.sourceSelection.kind !== "raster") return undefined;
  return findRasterSource(map, settings.sourceSelection.sourceId);
}

export function calculateExportPreview(
  map: MapLibreMap,
  settings: ExportSettings,
): ExportPreview {
  const source = selectedRasterSource(map, settings);
  const missingSource =
    settings.sourceSelection.kind === "raster" && !source
      ? "The selected raster source is no longer available; Visible map will be used."
      : undefined;
  const fallbackReason = source ? rasterFallbackReason(source) : undefined;
  const directCandidate = Boolean(source && supportsDirectAttempt(source));
  const grid = calculateOutputGrid(
    map,
    settings.resolution,
    directCandidate ? "north-up" : settings.outputGeometry,
  );
  return {
    width: grid.width,
    height: grid.height,
    pixelCount: grid.pixelCount,
    method: source ? predictedExportMethod(source) : "Rendered map",
    directCandidate,
    warning: missingSource ?? fallbackReason,
  };
}

export function imageFileExtension(format: ImageFormat): "png" | "jpg" {
  return format === "jpeg" ? "jpg" : "png";
}

export function worldFileExtension(format: ImageFormat): "pgw" | "jgw" {
  return format === "jpeg" ? "jgw" : "pgw";
}

export function flattenTransparencyOnWhite(
  pixels: Uint8ClampedArray,
): Uint8ClampedArray {
  const flattened = new Uint8ClampedArray(pixels.length);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = (pixels[offset + 3] ?? 0) / 255;
    flattened[offset] = Math.round(
      (pixels[offset] ?? 0) * alpha + 255 * (1 - alpha),
    );
    flattened[offset + 1] = Math.round(
      (pixels[offset + 1] ?? 0) * alpha + 255 * (1 - alpha),
    );
    flattened[offset + 2] = Math.round(
      (pixels[offset + 2] ?? 0) * alpha + 255 * (1 - alpha),
    );
    flattened[offset + 3] = 255;
  }
  return flattened;
}

function imageDataToBlob(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  format: ImageFormat,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context)
    return Promise.reject(new Error("An image canvas could not be created."));
  const imagePixels =
    format === "jpeg"
      ? flattenTransparencyOnWhite(pixels)
      : new Uint8ClampedArray(pixels);
  context.putImageData(
    new ImageData(new Uint8ClampedArray(imagePixels), width, height),
    0,
    0,
  );
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The browser could not encode the PNG image."));
      },
      format === "jpeg" ? "image/jpeg" : "image/png",
      0.9,
    );
  });
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function exportVisibleMap(
  map: MapLibreMap,
  settings: ExportSettings,
  onProgress: (progress: ExportProgress) => void,
  signal?: AbortSignal,
  runtime: ExportRuntimeOptions = {},
): Promise<ExportResult> {
  const selectedSource = selectedRasterSource(map, settings);
  const selectionMissing =
    settings.sourceSelection.kind === "raster" && !selectedSource;
  const directCandidate = Boolean(
    selectedSource && supportsDirectAttempt(selectedSource),
  );
  const isRotated = !directCandidate && settings.outputGeometry === "rotated";
  const rotatedGrid = isRotated
    ? calculateRotatedExportGrid(map, settings.resolution)
    : undefined;
  const northUpGrid = isRotated
    ? undefined
    : calculateExportGrid(map, settings.resolution);
  const grid = rotatedGrid ?? northUpGrid;
  if (!grid) throw new Error("An output grid could not be created.");
  const filename = sanitizeFilename(settings.filename);
  const warnings: string[] = [];
  if (selectionMissing) {
    warnings.push(
      "The selected raster source was unavailable; Visible map was exported.",
    );
  }
  const knownFallbackReason = selectedSource
    ? rasterFallbackReason(selectedSource)
    : undefined;
  if (knownFallbackReason) {
    warnings.push(`${knownFallbackReason} The layer was reprojected instead.`);
  }
  onProgress({ phase: "capture", percent: 0 });
  let pixels: Uint8ClampedArray | undefined;
  let worldFile: ReturnType<typeof createNorthUpWorldFile> | undefined;
  let outputWidth = grid.width;
  let outputHeight = grid.height;
  let method = selectedSource ? "Reprojected" : "Rendered map";
  let directSucceeded = false;

  if (selectedSource && directCandidate && northUpGrid) {
    const attempt = await tryDirectRasterExport({
      source: selectedSource,
      grid: northUpGrid,
      imageFormat: settings.imageFormat,
      resampling: settings.resampling,
      fetchArrayBuffer: runtime.fetchArrayBuffer,
      signal,
      onProgress: (percent) => onProgress({ phase: "capture", percent }),
    });
    if (attempt.ok) {
      pixels = attempt.result.pixels;
      outputWidth = attempt.result.width;
      outputHeight = attempt.result.height;
      worldFile = attempt.result.worldFile;
      method = attempt.result.method;
      warnings.push(...attempt.result.warnings);
      directSucceeded = true;
      onProgress({ phase: "capture", percent: 100 });
      onProgress({ phase: "reproject", percent: 100 });
    } else {
      warnings.push(`${attempt.reason} The layer was reprojected instead.`);
    }
  }

  if (!directSucceeded) {
    const source = await captureVisibleMap(
      map,
      grid.width,
      grid.height,
      isRotated,
      selectedSource?.id,
    );
    warnings.push(...source.warnings);
    if (signal?.aborted)
      throw new DOMException("Export cancelled.", "AbortError");
    onProgress({ phase: "capture", percent: 100 });
    if (rotatedGrid) {
      pixels = source.pixels;
      worldFile = rotatedGrid.worldFile;
      onProgress({ phase: "reproject", percent: 100 });
    } else if (northUpGrid) {
      pixels = await warpRaster(
        { source, grid: northUpGrid, resampling: settings.resampling },
        (percent) => onProgress({ phase: "reproject", percent }),
        signal,
      );
      worldFile = createNorthUpWorldFile(northUpGrid);
    } else {
      throw new Error("An output grid could not be created.");
    }
  }
  if (!pixels || !worldFile) {
    throw new Error("The export did not produce a georeferenced image.");
  }
  onProgress({ phase: "package", percent: 10 });
  const image = await imageDataToBlob(
    pixels,
    outputWidth,
    outputHeight,
    settings.imageFormat,
  );
  const imageExtension = imageFileExtension(settings.imageFormat);
  const worldExtension = worldFileExtension(settings.imageFormat);
  const archive = zipSync(
    {
      [`${filename}.${imageExtension}`]: new Uint8Array(
        await image.arrayBuffer(),
      ),
      [`${filename}.${worldExtension}`]: strToU8(createWorldFile(worldFile)),
      [`${filename}.prj`]: strToU8(`${EPSG_5514_WKT}\n`),
    },
    { level: 6 },
  );
  if (signal?.aborted)
    throw new DOMException("Export cancelled.", "AbortError");
  onProgress({ phase: "package", percent: 100 });
  download(new Blob([archive], { type: "application/zip" }), `${filename}.zip`);
  return {
    filename: `${filename}.zip`,
    width: outputWidth,
    height: outputHeight,
    warnings: [...new Set(warnings)],
    method,
  };
}
