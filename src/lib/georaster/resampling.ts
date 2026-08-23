import type { ResamplingMethod } from "./types";

const CHANNELS = 4;

function pixelOffset(width: number, x: number, y: number): number {
  return (y * width + x) * CHANNELS;
}

function readChannel(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  channel: number,
): number {
  const clampedX = Math.max(0, Math.min(width - 1, x));
  const clampedY = Math.max(0, Math.min(height - 1, y));
  return pixels[pixelOffset(width, clampedX, clampedY) + channel] ?? 0;
}

function cubicWeight(value: number): number {
  const absolute = Math.abs(value);
  if (absolute <= 1) return 1.5 * absolute ** 3 - 2.5 * absolute ** 2 + 1;
  if (absolute < 2)
    return -0.5 * absolute ** 3 + 2.5 * absolute ** 2 - 4 * absolute + 2;
  return 0;
}

export function sampleRgba(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  method: ResamplingMethod,
): [number, number, number, number] {
  if (method === "nearest") {
    const ix = Math.max(0, Math.min(width - 1, Math.round(x)));
    const iy = Math.max(0, Math.min(height - 1, Math.round(y)));
    const offset = pixelOffset(width, ix, iy);
    return [
      pixels[offset] ?? 0,
      pixels[offset + 1] ?? 0,
      pixels[offset + 2] ?? 0,
      pixels[offset + 3] ?? 0,
    ];
  }

  if (method === "bilinear") {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    return [0, 1, 2, 3].map((channel) => {
      const top =
        readChannel(pixels, width, height, x0, y0, channel) * (1 - fx) +
        readChannel(pixels, width, height, x0 + 1, y0, channel) * fx;
      const bottom =
        readChannel(pixels, width, height, x0, y0 + 1, channel) * (1 - fx) +
        readChannel(pixels, width, height, x0 + 1, y0 + 1, channel) * fx;
      return Math.round(top * (1 - fy) + bottom * fy);
    }) as [number, number, number, number];
  }

  const baseX = Math.floor(x);
  const baseY = Math.floor(y);
  const result: [number, number, number, number] = [0, 0, 0, 0];
  for (let channel = 0; channel < CHANNELS; channel += 1) {
    let value = 0;
    let weightSum = 0;
    for (let offsetY = -1; offsetY <= 2; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 2; offsetX += 1) {
        const weight =
          cubicWeight(x - (baseX + offsetX)) *
          cubicWeight(y - (baseY + offsetY));
        value +=
          readChannel(
            pixels,
            width,
            height,
            baseX + offsetX,
            baseY + offsetY,
            channel,
          ) * weight;
        weightSum += weight;
      }
    }
    result[channel] = Math.round(value / (weightSum || 1));
  }
  return result;
}
