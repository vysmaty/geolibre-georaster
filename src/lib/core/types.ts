import type { Map } from "maplibre-gl";
import type { ExportSettings } from "../georaster/types";

export interface PluginControlOptions {
  collapsed?: boolean;
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  title?: string;
  panelWidth?: number;
  fetchArrayBuffer?: (url: string) => Promise<ArrayBuffer>;
}

export interface PluginState {
  collapsed: boolean;
  panelWidth: number;
  settings: ExportSettings;
  data?: Record<string, unknown>;
}

export interface PluginControlReactProps extends PluginControlOptions {
  map: Map;
  onStateChange?: (state: PluginState) => void;
}

export type PluginControlEvent = "collapse" | "expand" | "statechange";
export type PluginControlEventHandler = (event: {
  type: PluginControlEvent;
  state: PluginState;
}) => void;
