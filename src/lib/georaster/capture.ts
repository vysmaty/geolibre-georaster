import {
  Map as MapLibreMap,
  type Map as MapLibreMapType,
  type StyleSpecification,
} from "maplibre-gl";
import type { GeographicBounds } from "./crs";
import type { CapturedMap } from "./types";

const MAX_CAPTURE_DIMENSION = 8192;
const CAPTURE_TIMEOUT_MS = 30_000;

function readBounds(map: MapLibreMapType): GeographicBounds {
  const bounds = map.getBounds();
  return {
    west: bounds.getWest(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    north: bounds.getNorth(),
  };
}

function cloneStyle(
  map: MapLibreMapType,
  warnings: string[],
  sourceId?: string,
): StyleSpecification {
  const style = structuredClone(map.getStyle());
  const layers = style.layers ?? [];
  const omittedCustomLayers = layers.some(
    (layer) => (layer as { type: string }).type === "custom",
  );
  const supportedLayers = layers.filter((layer) => {
    if ((layer as { type: string }).type === "custom") return false;
    if (!sourceId) return true;
    return (layer as { source?: string }).source === sourceId;
  });
  if (omittedCustomLayers && !sourceId) {
    warnings.push("Custom or Deck.gl layers were omitted from the export.");
  }
  if (supportedLayers.length !== layers.length) style.layers = supportedLayers;
  if (sourceId) {
    const source = style.sources[sourceId];
    if (!source) throw new Error(`Raster source '${sourceId}' is unavailable.`);
    style.sources = { [sourceId]: source };
  }
  return style;
}

function captureSize(
  map: MapLibreMapType,
  outputWidth: number,
  outputHeight: number,
  exactDimensions: boolean,
): [number, number] {
  if (exactDimensions) {
    if (
      outputWidth > MAX_CAPTURE_DIMENSION ||
      outputHeight > MAX_CAPTURE_DIMENSION
    ) {
      throw new Error(
        `Rotated export is limited to ${MAX_CAPTURE_DIMENSION.toLocaleString("en-US")} px per side. Increase the pixel size.`,
      );
    }
    return [outputWidth, outputHeight];
  }
  const canvas = map.getCanvas();
  const baseWidth = Math.max(1, canvas.clientWidth || canvas.width);
  const baseHeight = Math.max(1, canvas.clientHeight || canvas.height);
  const desiredScale = Math.max(
    1,
    outputWidth / baseWidth,
    outputHeight / baseHeight,
  );
  const cappedScale = Math.min(
    desiredScale,
    MAX_CAPTURE_DIMENSION / baseWidth,
    MAX_CAPTURE_DIMENSION / baseHeight,
  );
  return [
    Math.max(1, Math.round(baseWidth * cappedScale)),
    Math.max(1, Math.round(baseHeight * cappedScale)),
  ];
}

function waitForIdle(map: MapLibreMapType): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      map.off("idle", handleIdle);
      reject(new Error("Map rendering timed out after 30 seconds."));
    }, CAPTURE_TIMEOUT_MS);
    const handleIdle = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    map.once("idle", handleIdle);
  });
}

export async function captureVisibleMap(
  map: MapLibreMapType,
  outputWidth: number,
  outputHeight: number,
  exactDimensions = false,
  sourceId?: string,
): Promise<CapturedMap> {
  if (Math.abs(map.getBearing()) > 0.001 || Math.abs(map.getPitch()) > 0.001) {
    throw new Error("Set map bearing and pitch to 0° before exporting.");
  }
  if (map.getProjection().type !== "mercator") {
    throw new Error("Switch the map projection to Mercator before exporting.");
  }

  const bounds = readBounds(map);
  if (bounds.east <= bounds.west || bounds.north <= bounds.south) {
    throw new Error("The current map bounds cannot be exported.");
  }

  const warnings: string[] = [];
  const style = cloneStyle(map, warnings, sourceId);
  const [width, height] = captureSize(
    map,
    outputWidth,
    outputHeight,
    exactDimensions,
  );
  const container = document.createElement("div");
  container.style.cssText =
    `position:fixed;left:-100000px;top:0;width:${width}px;height:${height}px;` +
    "pointer-events:none;opacity:0;";
  document.body.appendChild(container);

  let clone: MapLibreMapType | undefined;
  try {
    clone = new MapLibreMap({
      container,
      style,
      bounds: [
        [bounds.west, bounds.south],
        [bounds.east, bounds.north],
      ],
      fitBoundsOptions: { padding: 0, animate: false },
      bearing: 0,
      pitch: 0,
      pixelRatio: 1,
      interactive: false,
      attributionControl: false,
      canvasContextAttributes: { preserveDrawingBuffer: true },
      fadeDuration: 0,
    });

    clone.on("styleimagemissing", (event) => {
      const image = map.getImage(event.id);
      if (image && !clone?.hasImage(event.id)) {
        clone?.addImage(event.id, image.data, {
          pixelRatio: image.pixelRatio,
          sdf: image.sdf,
          stretchX: image.stretchX,
          stretchY: image.stretchY,
          content: image.content,
        });
      } else warnings.push(`Style image '${event.id}' was not available.`);
    });
    await waitForIdle(clone);

    const sourceCanvas = clone.getCanvas();
    const canvas = document.createElement("canvas");
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("A 2D canvas could not be created.");
    context.drawImage(sourceCanvas, 0, 0);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    return {
      bounds,
      width: canvas.width,
      height: canvas.height,
      pixels: image.data,
      warnings: [...new Set(warnings)],
    };
  } finally {
    clone?.remove();
    container.remove();
  }
}
