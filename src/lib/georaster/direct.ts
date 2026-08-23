import { fromArrayBuffer } from "geotiff";
import type { RasterGrid, WorldFileTransform } from "./grid";
import { createNorthUpWorldFile, createRasterGrid } from "./grid";
import type { RasterSourceDescriptor } from "./sources";
import { isExplicitSjtskTileSource } from "./sources";
import type { ImageFormat, ResamplingMethod } from "./types";

export type FetchArrayBuffer = (url: string) => Promise<ArrayBuffer>;

export interface DirectExportContext {
  source: RasterSourceDescriptor;
  grid: RasterGrid;
  imageFormat: ImageFormat;
  resampling: ResamplingMethod;
  fetchArrayBuffer?: FetchArrayBuffer;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}

export interface DirectRasterResult {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  worldFile: WorldFileTransform;
  method: "Direct WMS" | "Direct ArcGIS" | "Native raster" | "Direct WMTS";
  warnings: string[];
}

export type DirectRasterAttempt =
  { ok: true; result: DirectRasterResult } | { ok: false; reason: string };

interface RasterBlock {
  x: number;
  y: number;
  width: number;
  height: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ParsedWmsSource {
  templateUrl: string;
  version: string;
  layers: string;
  styles: string;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new DOMException("Export cancelled.", "AbortError");
}

async function fetchBytes(
  url: string,
  fetchArrayBuffer?: FetchArrayBuffer,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  throwIfAborted(signal);
  if (fetchArrayBuffer) {
    const bytes = await fetchArrayBuffer(url);
    throwIfAborted(signal);
    return bytes;
  }
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return response.arrayBuffer();
}

function decodeText(buffer: ArrayBuffer): string {
  return new TextDecoder().decode(new Uint8Array(buffer));
}

function findParameter(url: URL, name: string): string | undefined {
  for (const [key, value] of url.searchParams) {
    if (key.toLowerCase() === name.toLowerCase()) return value;
  }
  return undefined;
}

function setParameter(url: URL, name: string, value: string): void {
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase() === name.toLowerCase()) url.searchParams.delete(key);
  }
  url.searchParams.set(name, value);
}

function deleteParameters(url: URL, names: string[]): void {
  const normalized = new Set(names.map((name) => name.toLowerCase()));
  for (const key of [...url.searchParams.keys()]) {
    if (normalized.has(key.toLowerCase())) url.searchParams.delete(key);
  }
}

export function parseWmsSource(
  source: RasterSourceDescriptor,
): ParsedWmsSource | undefined {
  const templateUrl = source.tiles[0] ?? source.url;
  if (!templateUrl) return undefined;
  let url: URL;
  try {
    url = new URL(templateUrl, window.location.href);
  } catch {
    return undefined;
  }
  const layers = findParameter(url, "layers");
  if (!layers) return undefined;
  return {
    templateUrl: url.toString(),
    version: findParameter(url, "version") ?? "1.1.1",
    layers,
    styles: findParameter(url, "styles") ?? "",
  };
}

export function wmsCapabilitiesSupportSjtsk(xml: string): boolean {
  return /<(?:\w+:)?(?:CRS|SRS)(?:\s[^>]*)?>\s*(?:urn:ogc:def:crs:EPSG(?::|::)|EPSG:)5514\s*</i.test(
    xml,
  );
}

export function buildWmsGetMapUrl(
  parsed: ParsedWmsSource,
  block: RasterBlock,
  format: ImageFormat,
): string {
  const url = new URL(parsed.templateUrl);
  deleteParameters(url, [
    "bbox",
    "width",
    "height",
    "crs",
    "srs",
    "request",
    "service",
    "format",
    "transparent",
  ]);
  setParameter(url, "SERVICE", "WMS");
  setParameter(url, "REQUEST", "GetMap");
  setParameter(url, "VERSION", parsed.version);
  setParameter(url, "LAYERS", parsed.layers);
  setParameter(url, "STYLES", parsed.styles);
  setParameter(
    url,
    parsed.version.startsWith("1.3") ? "CRS" : "SRS",
    "EPSG:5514",
  );
  setParameter(
    url,
    "BBOX",
    `${block.minX},${block.minY},${block.maxX},${block.maxY}`,
  );
  setParameter(url, "WIDTH", String(block.width));
  setParameter(url, "HEIGHT", String(block.height));
  setParameter(url, "FORMAT", format === "jpeg" ? "image/jpeg" : "image/png");
  setParameter(url, "TRANSPARENT", format === "png" ? "TRUE" : "FALSE");
  return url.toString();
}

export function buildRasterBlocks(
  grid: RasterGrid,
  blockSize: number,
): RasterBlock[] {
  const blocks: RasterBlock[] = [];
  for (let y = 0; y < grid.height; y += blockSize) {
    const height = Math.min(blockSize, grid.height - y);
    for (let x = 0; x < grid.width; x += blockSize) {
      const width = Math.min(blockSize, grid.width - x);
      blocks.push({
        x,
        y,
        width,
        height,
        minX: grid.minX + x * grid.resolution,
        maxX: grid.minX + (x + width) * grid.resolution,
        maxY: grid.maxY - y * grid.resolution,
        minY: grid.maxY - (y + height) * grid.resolution,
      });
    }
  }
  return blocks;
}

async function decodeBitmap(
  buffer: ArrayBuffer,
  mimeType: string,
): Promise<ImageBitmap> {
  const start = decodeText(
    buffer.slice(0, Math.min(buffer.byteLength, 512)),
  ).trim();
  if (start.startsWith("<") || start.startsWith("{")) {
    throw new Error(start.replace(/\s+/g, " ").slice(0, 240));
  }
  return createImageBitmap(new Blob([buffer], { type: mimeType }));
}

async function stitchServiceBlocks(
  grid: RasterGrid,
  blockSize: number,
  mimeType: string,
  buildUrl: (block: RasterBlock) => string,
  fetchArrayBuffer?: FetchArrayBuffer,
  signal?: AbortSignal,
  onProgress?: (percent: number) => void,
): Promise<Uint8ClampedArray> {
  const canvas = document.createElement("canvas");
  canvas.width = grid.width;
  canvas.height = grid.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("A direct export canvas could not be created.");
  const blocks = buildRasterBlocks(grid, blockSize);
  for (let index = 0; index < blocks.length; index += 1) {
    throwIfAborted(signal);
    const block = blocks[index];
    const bytes = await fetchBytes(buildUrl(block), fetchArrayBuffer, signal);
    const bitmap = await decodeBitmap(bytes, mimeType);
    context.drawImage(bitmap, block.x, block.y, block.width, block.height);
    bitmap.close();
    onProgress?.(Math.round(((index + 1) / blocks.length) * 100));
  }
  return context.getImageData(0, 0, grid.width, grid.height).data;
}

async function attemptWms(
  context: DirectExportContext,
): Promise<DirectRasterAttempt> {
  const parsed = parseWmsSource(context.source);
  if (!parsed)
    return { ok: false, reason: "WMS request parameters are unavailable." };
  try {
    const capabilitiesUrl = new URL(parsed.templateUrl);
    deleteParameters(capabilitiesUrl, [
      "bbox",
      "width",
      "height",
      "crs",
      "srs",
      "format",
      "transparent",
    ]);
    setParameter(capabilitiesUrl, "SERVICE", "WMS");
    setParameter(capabilitiesUrl, "REQUEST", "GetCapabilities");
    const capabilities = decodeText(
      await fetchBytes(
        capabilitiesUrl.toString(),
        context.fetchArrayBuffer,
        context.signal,
      ),
    );
    if (!wmsCapabilitiesSupportSjtsk(capabilities)) {
      return { ok: false, reason: "The WMS does not advertise EPSG:5514." };
    }
  } catch (error) {
    return {
      ok: false,
      reason: `WMS capabilities could not be verified: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    const mimeType =
      context.imageFormat === "jpeg" ? "image/jpeg" : "image/png";
    const pixels = await stitchServiceBlocks(
      context.grid,
      2048,
      mimeType,
      (block) => buildWmsGetMapUrl(parsed, block, context.imageFormat),
      context.fetchArrayBuffer,
      context.signal,
      context.onProgress,
    );
    return {
      ok: true,
      result: {
        pixels,
        width: context.grid.width,
        height: context.grid.height,
        worldFile: createNorthUpWorldFile(context.grid),
        method: "Direct WMS",
        warnings: [],
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: `Direct WMS export failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface WmtsMatrix {
  id: string;
  resolution: number;
  originX: number;
  originY: number;
  tileWidth: number;
  tileHeight: number;
  matrixWidth: number;
  matrixHeight: number;
}

export interface ParsedWmtsCapabilities {
  tileMatrixSet: string;
  matrices: WmtsMatrix[];
}

function directChildren(element: Element, localName: string): Element[] {
  return [...element.children].filter((child) => child.localName === localName);
}

function childText(element: Element, localName: string): string | undefined {
  return (
    directChildren(element, localName)[0]?.textContent?.trim() || undefined
  );
}

export function parseWmtsCapabilities(
  xml: string,
  requestedSet?: string,
): ParsedWmtsCapabilities | undefined {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const sets = [
    ...document.getElementsByTagNameNS("*", "TileMatrixSet"),
  ].filter((element) => directChildren(element, "SupportedCRS").length > 0);
  for (const set of sets) {
    const identifier = childText(set, "Identifier");
    const supportedCrs = childText(set, "SupportedCRS") ?? "";
    if (
      !identifier ||
      !/(?:EPSG(?::|::|\/0\/)|urn:ogc:def:crs:EPSG::)5514/i.test(
        supportedCrs,
      ) ||
      (requestedSet !== undefined && identifier !== requestedSet)
    ) {
      continue;
    }
    const matrices = directChildren(set, "TileMatrix")
      .map((matrix): WmtsMatrix | undefined => {
        const id = childText(matrix, "Identifier");
        const scale = Number(childText(matrix, "ScaleDenominator"));
        const origin = (childText(matrix, "TopLeftCorner") ?? "")
          .split(/\s+/)
          .map(Number);
        const tileWidth = Number(childText(matrix, "TileWidth"));
        const tileHeight = Number(childText(matrix, "TileHeight"));
        const matrixWidth = Number(childText(matrix, "MatrixWidth"));
        const matrixHeight = Number(childText(matrix, "MatrixHeight"));
        if (
          !id ||
          !Number.isFinite(scale) ||
          origin.length < 2 ||
          !origin.every(Number.isFinite) ||
          ![tileWidth, tileHeight, matrixWidth, matrixHeight].every(
            (value) => Number.isFinite(value) && value > 0,
          )
        ) {
          return undefined;
        }
        return {
          id,
          resolution: scale * 0.00028,
          originX: origin[0],
          originY: origin[1],
          tileWidth,
          tileHeight,
          matrixWidth,
          matrixHeight,
        };
      })
      .filter((matrix): matrix is WmtsMatrix => Boolean(matrix));
    if (matrices.length) return { tileMatrixSet: identifier, matrices };
  }
  return undefined;
}

function replaceTemplateToken(
  url: string,
  token: string,
  value: string,
): string {
  return url.replace(
    new RegExp(`\\{${token}\\}`, "gi"),
    encodeURIComponent(value),
  );
}

export function buildWmtsTileUrl(
  template: string,
  tileMatrixSet: string,
  matrix: string,
  row: number,
  column: number,
): string {
  let result = replaceTemplateToken(template, "TileMatrixSet", tileMatrixSet);
  result = replaceTemplateToken(result, "TileMatrix", matrix);
  result = replaceTemplateToken(result, "TileRow", String(row));
  result = replaceTemplateToken(result, "TileCol", String(column));
  result = replaceTemplateToken(result, "z", matrix);
  result = replaceTemplateToken(result, "y", String(row));
  result = replaceTemplateToken(result, "x", String(column));
  const url = new URL(result, window.location.href);
  setParameter(url, "SERVICE", "WMTS");
  setParameter(url, "REQUEST", "GetTile");
  setParameter(url, "TILEMATRIXSET", tileMatrixSet);
  setParameter(url, "TILEMATRIX", matrix);
  setParameter(url, "TILEROW", String(row));
  setParameter(url, "TILECOL", String(column));
  return url.toString();
}

async function attemptWmts(
  context: DirectExportContext,
): Promise<DirectRasterAttempt> {
  const template = context.source.tiles[0] ?? context.source.url;
  if (!template || !isExplicitSjtskTileSource(context.source)) {
    return {
      ok: false,
      reason: "The WMTS does not declare an EPSG:5514 tile matrix.",
    };
  }
  try {
    const templateUrl = new URL(template, window.location.href);
    const requestedSet = findParameter(templateUrl, "TileMatrixSet");
    const capabilitiesUrl = new URL(templateUrl);
    deleteParameters(capabilitiesUrl, [
      "tilematrix",
      "tilerow",
      "tilecol",
      "format",
      "request",
    ]);
    setParameter(capabilitiesUrl, "SERVICE", "WMTS");
    setParameter(capabilitiesUrl, "REQUEST", "GetCapabilities");
    const capabilities = parseWmtsCapabilities(
      decodeText(
        await fetchBytes(
          capabilitiesUrl.toString(),
          context.fetchArrayBuffer,
          context.signal,
        ),
      ),
      requestedSet,
    );
    if (!capabilities) {
      return {
        ok: false,
        reason: "EPSG:5514 WMTS matrix metadata is unavailable.",
      };
    }
    const matrix = capabilities.matrices.reduce((best, candidate) =>
      Math.abs(Math.log(candidate.resolution / context.grid.resolution)) <
      Math.abs(Math.log(best.resolution / context.grid.resolution))
        ? candidate
        : best,
    );
    const spanX = matrix.tileWidth * matrix.resolution;
    const spanY = matrix.tileHeight * matrix.resolution;
    const minColumn = Math.max(
      0,
      Math.floor((context.grid.minX - matrix.originX) / spanX),
    );
    const maxColumn = Math.min(
      matrix.matrixWidth - 1,
      Math.floor((context.grid.maxX - matrix.originX - Number.EPSILON) / spanX),
    );
    const minRow = Math.max(
      0,
      Math.floor((matrix.originY - context.grid.maxY) / spanY),
    );
    const maxRow = Math.min(
      matrix.matrixHeight - 1,
      Math.floor((matrix.originY - context.grid.minY - Number.EPSILON) / spanY),
    );
    if (minColumn > maxColumn || minRow > maxRow) {
      return {
        ok: false,
        reason: "The WMTS matrix does not cover the export extent.",
      };
    }
    const nativeGrid = createRasterGrid(
      {
        minX: context.grid.minX,
        minY: context.grid.minY,
        maxX: context.grid.maxX,
        maxY: context.grid.maxY,
      },
      matrix.resolution,
    );
    const canvas = document.createElement("canvas");
    canvas.width = nativeGrid.width;
    canvas.height = nativeGrid.height;
    const canvasContext = canvas.getContext("2d", {
      willReadFrequently: true,
    });
    if (!canvasContext)
      throw new Error("A WMTS export canvas could not be created.");
    const total = (maxColumn - minColumn + 1) * (maxRow - minRow + 1);
    let completed = 0;
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let column = minColumn; column <= maxColumn; column += 1) {
        throwIfAborted(context.signal);
        const bytes = await fetchBytes(
          buildWmtsTileUrl(
            template,
            capabilities.tileMatrixSet,
            matrix.id,
            row,
            column,
          ),
          context.fetchArrayBuffer,
          context.signal,
        );
        const bitmap = await decodeBitmap(bytes, "image/png");
        const tileMinX = matrix.originX + column * spanX;
        const tileMaxY = matrix.originY - row * spanY;
        canvasContext.drawImage(
          bitmap,
          (tileMinX - nativeGrid.minX) / nativeGrid.resolution,
          (nativeGrid.maxY - tileMaxY) / nativeGrid.resolution,
          spanX / nativeGrid.resolution,
          spanY / nativeGrid.resolution,
        );
        bitmap.close();
        completed += 1;
        context.onProgress?.(Math.round((completed / total) * 100));
      }
    }
    return {
      ok: true,
      result: {
        pixels: canvasContext.getImageData(
          0,
          0,
          nativeGrid.width,
          nativeGrid.height,
        ).data,
        width: nativeGrid.width,
        height: nativeGrid.height,
        worldFile: createNorthUpWorldFile(nativeGrid),
        method: "Direct WMTS",
        warnings:
          Math.abs(matrix.resolution - context.grid.resolution) > 1e-9
            ? [
                `WMTS native resolution ${matrix.resolution.toFixed(6)} m/px was preserved.`,
              ]
            : [],
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: `Direct WMTS export failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface ArcGisSource {
  root: string;
  type: "MapServer" | "ImageServer";
  layerId?: string;
}

export function arcGisSupportsDynamicExport(
  parsed: ArcGisSource,
  metadata: Record<string, unknown>,
): boolean {
  if (parsed.type === "ImageServer") return true;
  const capabilities = metadata.capabilities;
  if (typeof capabilities !== "string" || !capabilities.trim()) return true;
  return capabilities
    .split(",")
    .some((capability) => capability.trim().toLowerCase() === "map");
}

export function parseArcGisSource(
  source: RasterSourceDescriptor,
): ArcGisSource | undefined {
  const candidate = source.url ?? source.tiles[0];
  if (!candidate) return undefined;
  const match = candidate.match(
    /^(.*?\/(MapServer|ImageServer))(?:\/(\d+))?(?:\/.*)?(?:\?.*)?$/i,
  );
  if (!match) return undefined;
  const type =
    match[2].toLowerCase() === "imageserver" ? "ImageServer" : "MapServer";
  return { root: match[1], type, layerId: match[3] };
}

export function buildArcGisExportUrl(
  parsed: ArcGisSource,
  block: RasterBlock,
  format: ImageFormat,
): string {
  const operation = parsed.type === "ImageServer" ? "exportImage" : "export";
  const url = new URL(`${parsed.root}/${operation}`);
  url.searchParams.set("f", "image");
  url.searchParams.set(
    "bbox",
    `${block.minX},${block.minY},${block.maxX},${block.maxY}`,
  );
  url.searchParams.set("bboxSR", "5514");
  url.searchParams.set("imageSR", "5514");
  url.searchParams.set("size", `${block.width},${block.height}`);
  url.searchParams.set("format", format === "jpeg" ? "jpg" : "png32");
  url.searchParams.set("transparent", format === "png" ? "true" : "false");
  if (parsed.type === "MapServer" && parsed.layerId) {
    url.searchParams.set("layers", `show:${parsed.layerId}`);
  }
  return url.toString();
}

async function attemptArcGis(
  context: DirectExportContext,
): Promise<DirectRasterAttempt> {
  const parsed = parseArcGisSource(context.source);
  if (!parsed)
    return { ok: false, reason: "ArcGIS service metadata is unavailable." };
  let blockSize = 2048;
  try {
    const metadataUrl = new URL(parsed.root);
    metadataUrl.searchParams.set("f", "json");
    const metadata = JSON.parse(
      decodeText(
        await fetchBytes(
          metadataUrl.toString(),
          context.fetchArrayBuffer,
          context.signal,
        ),
      ),
    ) as Record<string, unknown>;
    if (metadata.error) {
      return {
        ok: false,
        reason: "The ArcGIS service rejected its metadata request.",
      };
    }
    if (!arcGisSupportsDynamicExport(parsed, metadata)) {
      return {
        ok: false,
        reason:
          "The ArcGIS MapServer is cached-only and has no dynamic map export capability.",
      };
    }
    const maxWidth = Number(metadata.maxImageWidth);
    const maxHeight = Number(metadata.maxImageHeight);
    if (Number.isFinite(maxWidth) && Number.isFinite(maxHeight)) {
      blockSize = Math.max(256, Math.min(4096, maxWidth, maxHeight));
    }
  } catch {
    // The export endpoint remains authoritative; use the conservative default.
  }

  try {
    const mimeType =
      context.imageFormat === "jpeg" ? "image/jpeg" : "image/png";
    const pixels = await stitchServiceBlocks(
      context.grid,
      blockSize,
      mimeType,
      (block) => buildArcGisExportUrl(parsed, block, context.imageFormat),
      context.fetchArrayBuffer,
      context.signal,
      context.onProgress,
    );
    return {
      ok: true,
      result: {
        pixels,
        width: context.grid.width,
        height: context.grid.height,
        worldFile: createNorthUpWorldFile(context.grid),
        method: "Direct ArcGIS",
        warnings: [],
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: `Direct ArcGIS export failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function candidateCogUrl(source: RasterSourceDescriptor): string | undefined {
  const candidate = source.url ?? source.tiles[0];
  if (!candidate || /[{}]/.test(candidate)) return undefined;
  if (/^(?:cog|geotiff):\/\//i.test(candidate)) {
    return candidate.replace(/^(?:cog|geotiff):\/\//i, "https://");
  }
  return candidate;
}

async function attemptCog(
  context: DirectExportContext,
): Promise<DirectRasterAttempt> {
  const url = candidateCogUrl(context.source);
  if (!url)
    return {
      ok: false,
      reason: "The original GeoTIFF/COG URL is unavailable.",
    };
  try {
    const bytes = await fetchBytes(
      url,
      context.fetchArrayBuffer,
      context.signal,
    );
    const tiff = await fromArrayBuffer(bytes, context.signal);
    const image = await tiff.getImage();
    const geoKeys = image.getGeoKeys();
    if (Number(geoKeys?.ProjectedCSTypeGeoKey) !== 5514) {
      return {
        ok: false,
        reason: "The source raster is not stored in EPSG:5514.",
      };
    }
    const [resolutionX, resolutionY] = image.getResolution();
    if (!(resolutionX > 0) || !(resolutionY < 0)) {
      return {
        ok: false,
        reason: "The raster is not a supported north-up grid.",
      };
    }
    const [rasterMinX, rasterMinY, rasterMaxX, rasterMaxY] =
      image.getBoundingBox();
    const minX = Math.max(context.grid.minX, rasterMinX);
    const minY = Math.max(context.grid.minY, rasterMinY);
    const maxX = Math.min(context.grid.maxX, rasterMaxX);
    const maxY = Math.min(context.grid.maxY, rasterMaxY);
    if (minX >= maxX || minY >= maxY) {
      return {
        ok: false,
        reason: "The raster does not intersect the current map extent.",
      };
    }

    const left = Math.max(0, Math.floor((minX - rasterMinX) / resolutionX));
    const right = Math.min(
      image.getWidth(),
      Math.ceil((maxX - rasterMinX) / resolutionX),
    );
    const top = Math.max(
      0,
      Math.floor((rasterMaxY - maxY) / Math.abs(resolutionY)),
    );
    const bottom = Math.min(
      image.getHeight(),
      Math.ceil((rasterMaxY - minY) / Math.abs(resolutionY)),
    );
    const destinationX = Math.max(
      0,
      Math.floor((minX - context.grid.minX) / context.grid.resolution),
    );
    const destinationY = Math.max(
      0,
      Math.floor((context.grid.maxY - maxY) / context.grid.resolution),
    );
    const destinationWidth = Math.min(
      context.grid.width - destinationX,
      Math.max(1, Math.ceil((maxX - minX) / context.grid.resolution)),
    );
    const destinationHeight = Math.min(
      context.grid.height - destinationY,
      Math.max(1, Math.ceil((maxY - minY) / context.grid.resolution)),
    );
    const rgb = await image.readRGB({
      window: [left, top, right, bottom],
      width: destinationWidth,
      height: destinationHeight,
      resampleMethod: context.resampling === "nearest" ? "nearest" : "bilinear",
      interleave: true,
      signal: context.signal,
    });
    const pixels = new Uint8ClampedArray(context.grid.pixelCount * 4);
    for (let row = 0; row < destinationHeight; row += 1) {
      for (let column = 0; column < destinationWidth; column += 1) {
        const sourceOffset = (row * destinationWidth + column) * 3;
        const targetOffset =
          ((destinationY + row) * context.grid.width + destinationX + column) *
          4;
        pixels[targetOffset] = rgb[sourceOffset] ?? 0;
        pixels[targetOffset + 1] = rgb[sourceOffset + 1] ?? 0;
        pixels[targetOffset + 2] = rgb[sourceOffset + 2] ?? 0;
        pixels[targetOffset + 3] = 255;
      }
      context.onProgress?.(Math.round(((row + 1) / destinationHeight) * 100));
    }
    const warnings =
      minX > context.grid.minX ||
      minY > context.grid.minY ||
      maxX < context.grid.maxX ||
      maxY < context.grid.maxY
        ? ["The selected raster covers only part of the export extent."]
        : [];
    return {
      ok: true,
      result: {
        pixels,
        width: context.grid.width,
        height: context.grid.height,
        worldFile: createNorthUpWorldFile(context.grid),
        method: "Native raster",
        warnings,
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: `Native raster export failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function tryDirectRasterExport(
  context: DirectExportContext,
): Promise<DirectRasterAttempt> {
  if (context.source.kind === "wms") return attemptWms(context);
  if (context.source.kind === "arcgis") return attemptArcGis(context);
  if (context.source.kind === "cog") return attemptCog(context);
  if (
    context.source.kind === "wmts" &&
    isExplicitSjtskTileSource(context.source)
  ) {
    return attemptWmts(context);
  }
  return { ok: false, reason: "This raster source requires reprojection." };
}
