import "./lib/styles/plugin-control.css";

export { PluginControl } from "./lib/core/PluginControl";
export type {
  PluginControlOptions,
  PluginState,
  PluginControlEvent,
  PluginControlEventHandler,
} from "./lib/core/types";
export {
  EPSG_5514_PROJ4,
  EPSG_5514_WKT,
  TARGET_CRS,
  projectToSjtsk,
  unprojectFromSjtsk,
  projectedExtent,
} from "./lib/georaster/crs";
export {
  MAX_OUTPUT_PIXELS,
  createRasterGrid,
  createWorldFile,
  sanitizeFilename,
} from "./lib/georaster/grid";
export { sampleRgba } from "./lib/georaster/resampling";
export {
  discoverRasterSources,
  detectRasterSourceKind,
  predictedExportMethod,
} from "./lib/georaster/sources";
export type {
  RasterSourceDescriptor,
  RasterSourceKind,
} from "./lib/georaster/sources";
export type {
  ExportSettings,
  ImageFormat,
  OutputGeometry,
  ResamplingMethod,
  SourceSelection,
} from "./lib/georaster/types";
export type {
  GeoLibreAppAPI,
  GeoLibrePlugin,
  GeoLibreControl,
  GeoLibreMapControlPosition,
  GeoLibreToolbarMenu,
  GeoLibreToolbarMenuItem,
} from "./lib/geolibre/host-api";
