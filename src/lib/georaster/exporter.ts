import { strToU8, zipSync } from "fflate";
import type { Map as MapLibreMap } from "maplibre-gl";
import { captureVisibleMap } from "./capture";
import { EPSG_5514_WKT, projectedExtent } from "./crs";
import { createRasterGrid, createWorldFile, sanitizeFilename } from "./grid";
import type { ExportSettings } from "./types";
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

function imageDataToPng(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context)
    return Promise.reject(new Error("A PNG canvas could not be created."));
  context.putImageData(
    new ImageData(new Uint8ClampedArray(pixels), width, height),
    0,
    0,
  );
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The browser could not encode the PNG image."));
    }, "image/png");
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
): Promise<ExportResult> {
  const grid = calculateExportGrid(map, settings.resolution);
  const filename = sanitizeFilename(settings.filename);
  onProgress({ phase: "capture", percent: 0 });
  const source = await captureVisibleMap(map, grid.width, grid.height);
  if (signal?.aborted)
    throw new DOMException("Export cancelled.", "AbortError");
  onProgress({ phase: "capture", percent: 100 });

  const pixels = await warpRaster(
    { source, grid, resampling: settings.resampling },
    (percent) => onProgress({ phase: "reproject", percent }),
    signal,
  );
  onProgress({ phase: "package", percent: 10 });
  const png = await imageDataToPng(pixels, grid.width, grid.height);
  const archive = zipSync(
    {
      [`${filename}.png`]: new Uint8Array(await png.arrayBuffer()),
      [`${filename}.pgw`]: strToU8(createWorldFile(grid)),
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
    width: grid.width,
    height: grid.height,
    warnings: source.warnings,
  };
}
