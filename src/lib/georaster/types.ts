import type { GeographicBounds } from "./crs";
import type { RasterGrid } from "./grid";

export type ResamplingMethod = "nearest" | "bilinear" | "cubic";

export interface ExportSettings {
  targetCrs: "EPSG:5514";
  resolution: number;
  resampling: ResamplingMethod;
  filename: string;
}

export interface CapturedMap {
  bounds: GeographicBounds;
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  warnings: string[];
}

export interface WarpRequest {
  source: CapturedMap;
  grid: RasterGrid;
  resampling: ResamplingMethod;
}

export interface WarpProgress {
  type: "progress";
  percent: number;
}

export interface WarpComplete {
  type: "complete";
  pixels: Uint8ClampedArray;
}

export interface WarpFailure {
  type: "error";
  message: string;
}

export type WarpResponse = WarpProgress | WarpComplete | WarpFailure;
