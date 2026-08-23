/// <reference lib="webworker" />

import { unprojectFromSjtsk } from "./crs";
import { sampleRgba } from "./resampling";
import type { WarpRequest, WarpResponse } from "./types";

const worker = self as unknown as DedicatedWorkerGlobalScope;

function latitudeToMercator(latitude: number): number {
  const limited = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const radians = (limited * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + radians / 2));
}

worker.onmessage = (event: MessageEvent<WarpRequest>) => {
  try {
    const { source, grid, resampling } = event.data;
    const output = new Uint8ClampedArray(grid.pixelCount * 4);
    const mercatorNorth = latitudeToMercator(source.bounds.north);
    const mercatorSouth = latitudeToMercator(source.bounds.south);
    const mercatorSpan = mercatorNorth - mercatorSouth;
    const longitudeSpan = source.bounds.east - source.bounds.west;

    for (let row = 0; row < grid.height; row += 1) {
      const northing = grid.maxY - (row + 0.5) * grid.resolution;
      for (let column = 0; column < grid.width; column += 1) {
        const easting = grid.minX + (column + 0.5) * grid.resolution;
        const [longitude, latitude] = unprojectFromSjtsk([easting, northing]);
        if (
          longitude < source.bounds.west ||
          longitude > source.bounds.east ||
          latitude < source.bounds.south ||
          latitude > source.bounds.north
        ) {
          continue;
        }

        const sourceX =
          ((longitude - source.bounds.west) / longitudeSpan) *
          (source.width - 1);
        const sourceY =
          ((mercatorNorth - latitudeToMercator(latitude)) / mercatorSpan) *
          (source.height - 1);
        const rgba = sampleRgba(
          source.pixels,
          source.width,
          source.height,
          sourceX,
          sourceY,
          resampling,
        );
        output.set(rgba, (row * grid.width + column) * 4);
      }

      if (row % 32 === 0 || row === grid.height - 1) {
        const response: WarpResponse = {
          type: "progress",
          percent: Math.round(((row + 1) / grid.height) * 100),
        };
        worker.postMessage(response);
      }
    }

    const response: WarpResponse = { type: "complete", pixels: output };
    worker.postMessage(response, [output.buffer]);
  } catch (error) {
    const response: WarpResponse = {
      type: "error",
      message:
        error instanceof Error ? error.message : "Raster reprojection failed.",
    };
    worker.postMessage(response);
  }
};
