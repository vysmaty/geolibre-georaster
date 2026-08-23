import { PluginControl } from "./lib/core/PluginControl";
import packageMetadata from "../package.json";
import type { PluginState } from "./lib/core/types";
import type {
  GeoLibreAppAPI,
  GeoLibreMapControlPosition,
  GeoLibrePlugin,
} from "./lib/geolibre/host-api";
import type {
  ImageFormat,
  OutputGeometry,
  ResamplingMethod,
  SourceSelection,
} from "./lib/georaster/types";
import "./lib/styles/plugin-control.css";

type AppAPI = GeoLibreAppAPI<PluginControl>;

let control: PluginControl | null = null;
let position: GeoLibreMapControlPosition = "top-right";
let pendingState: Partial<PluginState> | null = null;
let disposeToolbarMenu: (() => void) | null = null;

function createControl(app: AppAPI): PluginControl {
  const next = new PluginControl({
    collapsed: pendingState?.collapsed ?? true,
    panelWidth: pendingState?.panelWidth ?? 340,
    title: "GeoRaster",
    fetchArrayBuffer: app.fetchArrayBuffer,
  });
  if (pendingState) next.setState(pendingState);
  return next;
}

function isOutputGeometry(value: unknown): value is OutputGeometry {
  return value === "rotated" || value === "north-up";
}

function isImageFormat(value: unknown): value is ImageFormat {
  return value === "png" || value === "jpeg";
}

function isSourceSelection(value: unknown): value is SourceSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const selection = value as Record<string, unknown>;
  return (
    selection.kind === "visible-map" ||
    (selection.kind === "raster" && typeof selection.sourceId === "string")
  );
}

function isResampling(value: unknown): value is ResamplingMethod {
  return value === "nearest" || value === "bilinear" || value === "cubic";
}

function isPluginState(value: unknown): value is Partial<PluginState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if ("collapsed" in candidate && typeof candidate.collapsed !== "boolean")
    return false;
  if ("panelWidth" in candidate && typeof candidate.panelWidth !== "number")
    return false;
  if ("settings" in candidate) {
    const settings = candidate.settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings))
      return false;
    const item = settings as Record<string, unknown>;
    if ("targetCrs" in item && item.targetCrs !== "EPSG:5514") return false;
    if ("resolution" in item && typeof item.resolution !== "number")
      return false;
    if ("filename" in item && typeof item.filename !== "string") return false;
    if ("resampling" in item && !isResampling(item.resampling)) return false;
    if ("outputGeometry" in item && !isOutputGeometry(item.outputGeometry))
      return false;
    if ("imageFormat" in item && !isImageFormat(item.imageFormat)) return false;
    if ("sourceSelection" in item && !isSourceSelection(item.sourceSelection))
      return false;
  }
  return true;
}

function registerToolbar(app: AppAPI): (() => void) | null {
  if (!app.registerToolbarMenu) return null;
  return app.registerToolbarMenu({
    id: "geolibre-georaster-menu",
    label: "GeoRaster",
    items: [
      {
        id: "open-export",
        label: "Export georeferenced image…",
        onSelect: () => control?.expand(),
      },
    ],
  });
}

export const plugin: GeoLibrePlugin<PluginControl> = {
  id: "geolibre-georaster",
  name: "GeoRaster",
  version: packageMetadata.version,
  activate(app) {
    control = control ?? createControl(app);
    if (!app.addMapControl(control, position)) {
      control = null;
      return false;
    }
    disposeToolbarMenu = registerToolbar(app);
  },
  deactivate(app) {
    disposeToolbarMenu?.();
    disposeToolbarMenu = null;
    if (!control) return;
    pendingState = control.getState();
    app.removeMapControl(control);
    control = null;
  },
  getMapControlPosition() {
    return position;
  },
  setMapControlPosition(app, nextPosition) {
    position = nextPosition;
    if (!control) return;
    app.removeMapControl(control);
    if (!app.addMapControl(control, position)) {
      pendingState = control.getState();
      control = null;
      return false;
    }
  },
  getProjectState() {
    return control?.getState() ?? pendingState ?? undefined;
  },
  applyProjectState(_app, state) {
    if (!isPluginState(state)) return false;
    pendingState = state;
    control?.setState(state);
  },
};

export default plugin;
