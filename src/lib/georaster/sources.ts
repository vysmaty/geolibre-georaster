import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";

export type RasterSourceKind =
  "wms" | "arcgis" | "cog" | "wmts" | "xyz" | "mbtiles" | "raster";

export interface RasterSourceDescriptor {
  id: string;
  label: string;
  layerIds: string[];
  kind: RasterSourceKind;
  tiles: string[];
  url?: string;
  metadata: Record<string, unknown>;
}

type LooseSource = {
  type?: string;
  tiles?: string[];
  url?: string;
  metadata?: Record<string, unknown>;
};

type LooseLayer = {
  id: string;
  type: string;
  source?: string;
  metadata?: Record<string, unknown>;
};

function metadataLabel(metadata: Record<string, unknown>): string | undefined {
  for (const key of ["name", "title", "geolibre:name", "geolibreName"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function queryParameter(url: string, name: string): string | undefined {
  try {
    const parsed = new URL(url, "https://georaster.invalid/");
    for (const [key, value] of parsed.searchParams) {
      if (key.toLowerCase() === name.toLowerCase()) return value;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function titleCaseIdentifier(value: string): string | undefined {
  const clean = value
    .replace(/^layer-/i, "")
    .replace(/-raster$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!clean || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(clean)) {
    return undefined;
  }
  return clean
    .split(/\s+/)
    .map((word) => {
      if (word.toLowerCase() === "arcgis") return "ArcGIS";
      if (/^[A-Z0-9]+$/.test(word)) return word;
      return `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`;
    })
    .join(" ");
}

function wmsLayerLabel(candidate: string): string | undefined {
  const layers = queryParameter(candidate, "layers");
  if (!layers) return undefined;
  const names = layers
    .split(",")
    .map((name) => {
      const parts = name.split(":");
      return parts[parts.length - 1]?.trim();
    })
    .filter((name): name is string => Boolean(name));
  return names.length ? names.join(", ") : undefined;
}

function arcGisServiceLabel(candidate: string): string | undefined {
  const match = candidate.match(
    /\/services\/(.+?)\/(?:MapServer|ImageServer)(?:\/|$)/i,
  );
  const segments = match?.[1]?.split("/") ?? [];
  const segment = segments[segments.length - 1];
  if (!segment) return undefined;
  try {
    return titleCaseIdentifier(decodeURIComponent(segment));
  } catch {
    return titleCaseIdentifier(segment);
  }
}

export function deriveRasterSourceLabel(
  id: string,
  layers: LooseLayer[],
  source: LooseSource,
): string {
  const sourceMetadata = source.metadata ?? {};
  const layerMetadata = layers[0]?.metadata ?? {};
  const candidate = source.tiles?.[0] ?? source.url ?? "";
  const detected = detectRasterSourceKind({
    tiles: source.tiles ?? [],
    url: source.url,
    metadata: { ...sourceMetadata, ...layerMetadata },
  });
  return (
    metadataLabel(layerMetadata) ??
    metadataLabel(sourceMetadata) ??
    (detected === "wms" ? wmsLayerLabel(candidate) : undefined) ??
    (detected === "arcgis" ? arcGisServiceLabel(candidate) : undefined) ??
    titleCaseIdentifier(layers[0]?.id ?? "") ??
    titleCaseIdentifier(id) ??
    layers[0]?.id ??
    id
  );
}

export function detectRasterSourceKind(
  source: Pick<RasterSourceDescriptor, "tiles" | "url" | "metadata">,
): RasterSourceKind {
  const candidate = source.tiles[0] ?? source.url ?? "";
  const declared = String(
    source.metadata.type ?? source.metadata.sourceType ?? "",
  ).toLowerCase();
  if (
    declared === "wms" ||
    queryParameter(candidate, "service")?.toLowerCase() === "wms" ||
    queryParameter(candidate, "request")?.toLowerCase() === "getmap"
  ) {
    return "wms";
  }
  if (/\/(?:MapServer|ImageServer)(?:\/|$)/i.test(candidate)) return "arcgis";
  if (
    declared === "cog" ||
    /^(?:cog|geotiff):\/\//i.test(candidate) ||
    /\.tiff?(?:[?#]|$)/i.test(candidate)
  ) {
    return "cog";
  }
  if (
    declared === "wmts" ||
    queryParameter(candidate, "service")?.toLowerCase() === "wmts" ||
    /\{TileMatrix\}|TileMatrixSet/i.test(candidate)
  ) {
    return "wmts";
  }
  if (declared === "mbtiles" || /^mbtiles:/i.test(candidate)) return "mbtiles";
  if (/\{z\}.*\{x\}.*\{y\}/i.test(candidate)) return "xyz";
  return "raster";
}

export function isExplicitSjtskTileSource(
  source: RasterSourceDescriptor,
): boolean {
  const candidate = `${source.url ?? ""} ${source.tiles.join(" ")} ${JSON.stringify(source.metadata)}`;
  return /(?:EPSG(?::|%3A|\/0\/)|urn:ogc:def:crs:EPSG::)5514/i.test(candidate);
}

export function discoverRasterSources(
  mapOrStyle: MapLibreMap | StyleSpecification,
): RasterSourceDescriptor[] {
  const style = "getStyle" in mapOrStyle ? mapOrStyle.getStyle() : mapOrStyle;
  const styleSources = style.sources as Record<string, LooseSource>;
  const rasterLayers = (style.layers ?? []).filter(
    (layer): layer is typeof layer & LooseLayer =>
      (layer as LooseLayer).type === "raster" &&
      typeof (layer as LooseLayer).source === "string",
  );
  const grouped = new Map<string, LooseLayer[]>();
  for (const layer of rasterLayers) {
    const sourceId = layer.source as string;
    const layers = grouped.get(sourceId) ?? [];
    layers.push(layer);
    grouped.set(sourceId, layers);
  }

  const descriptors: RasterSourceDescriptor[] = [];
  for (const [id, layers] of grouped.entries()) {
    const source = styleSources[id];
    if (!source || source.type !== "raster") continue;
    const sourceMetadata = source.metadata ?? {};
    const layerMetadata = layers[0]?.metadata ?? {};
    const metadata = { ...sourceMetadata, ...layerMetadata };
    const partial = {
      tiles: Array.isArray(source.tiles) ? [...source.tiles] : [],
      url: typeof source.url === "string" ? source.url : undefined,
      metadata,
    };
    descriptors.push({
      id,
      label: deriveRasterSourceLabel(id, layers, source),
      layerIds: layers.map((layer) => layer.id),
      kind: detectRasterSourceKind(partial),
      ...partial,
    });
  }
  return descriptors.sort((first, second) =>
    first.label.localeCompare(second.label),
  );
}

export function findRasterSource(
  map: MapLibreMap,
  sourceId: string,
): RasterSourceDescriptor | undefined {
  return discoverRasterSources(map).find((source) => source.id === sourceId);
}

export function predictedExportMethod(source: RasterSourceDescriptor): string {
  if (source.kind === "wms") return "Direct WMS";
  if (source.kind === "arcgis") return "Direct ArcGIS";
  if (source.kind === "cog") return "Native raster";
  if (source.kind === "wmts" && isExplicitSjtskTileSource(source)) {
    return "Direct WMTS";
  }
  return "Reprojected";
}
