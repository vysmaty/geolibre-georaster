import type { IControl, Map as MapLibreMap } from "maplibre-gl";
import {
  calculateExportPreview,
  exportVisibleMap,
} from "../georaster/exporter";
import { discoverRasterSources } from "../georaster/sources";
import type {
  ExportSettings,
  ImageFormat,
  OutputGeometry,
  ResamplingMethod,
} from "../georaster/types";
import { calculatePanelPosition } from "./panel-position";
import type {
  PluginControlEvent,
  PluginControlEventHandler,
  PluginControlOptions,
  PluginState,
} from "./types";

const DEFAULT_SETTINGS: ExportSettings = {
  targetCrs: "EPSG:5514",
  resolution: 0.2,
  resampling: "bilinear",
  outputGeometry: "rotated",
  imageFormat: "png",
  sourceSelection: { kind: "visible-map" },
  filename: "geolibre_5514",
};

const DEFAULT_OPTIONS: Required<
  Omit<PluginControlOptions, "fetchArrayBuffer">
> = {
  collapsed: true,
  position: "top-right",
  title: "GeoRaster",
  panelWidth: 340,
};

type EventHandlers = Map<PluginControlEvent, Set<PluginControlEventHandler>>;

function formField(labelText: string, input: HTMLElement): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "georaster-field";
  const caption = document.createElement("span");
  caption.textContent = labelText;
  label.append(caption, input);
  return label;
}

export class PluginControl implements IControl {
  private map?: MapLibreMap;
  private container?: HTMLElement;
  private panel?: HTMLElement;
  private status?: HTMLElement;
  private preview?: HTMLElement;
  private exportButton?: HTMLButtonElement;
  private cancelButton?: HTMLButtonElement;
  private abortController?: AbortController;
  private readonly options: Required<
    Omit<PluginControlOptions, "fetchArrayBuffer">
  >;
  private readonly fetchArrayBuffer?: (url: string) => Promise<ArrayBuffer>;
  private state: PluginState;
  private readonly handlers: EventHandlers = new Map();
  private mapMoveHandler?: () => void;
  private mapStyleHandler?: () => void;
  private mapResizeHandler?: () => void;

  constructor(options?: Partial<PluginControlOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.fetchArrayBuffer = options?.fetchArrayBuffer;
    this.state = {
      collapsed: this.options.collapsed,
      panelWidth: this.options.panelWidth,
      settings: { ...DEFAULT_SETTINGS },
    };
  }

  onAdd(map: MapLibreMap): HTMLElement {
    this.map = map;
    this.container = this.createButton();
    this.panel = this.createPanel();
    map.getContainer().appendChild(this.panel);
    this.refreshSourceOptions();
    this.mapMoveHandler = () => this.updatePreview();
    this.mapStyleHandler = () => this.refreshSourceOptions();
    this.mapResizeHandler = () => this.positionPanel();
    map.on("moveend", this.mapMoveHandler);
    map.on("styledata", this.mapStyleHandler);
    map.on("resize", this.mapResizeHandler);
    if (!this.state.collapsed) this.expand();
    this.updatePreview();
    return this.container;
  }

  onRemove(): void {
    this.abortController?.abort();
    if (this.map && this.mapMoveHandler)
      this.map.off("moveend", this.mapMoveHandler);
    if (this.map && this.mapStyleHandler)
      this.map.off("styledata", this.mapStyleHandler);
    if (this.map && this.mapResizeHandler)
      this.map.off("resize", this.mapResizeHandler);
    this.panel?.remove();
    this.container?.remove();
    this.map = undefined;
    this.panel = undefined;
    this.container = undefined;
    this.handlers.clear();
  }

  getState(): PluginState {
    return { ...this.state, settings: { ...this.state.settings } };
  }

  setState(next: Partial<PluginState>): void {
    this.state = {
      ...this.state,
      ...next,
      settings: { ...this.state.settings, ...next.settings },
    };
    this.renderSettings();
    if (this.state.collapsed) this.collapse();
    else this.expand();
    this.emit("statechange");
  }

  toggle(): void {
    if (this.state.collapsed) this.expand();
    else this.collapse();
  }

  expand(): void {
    this.state.collapsed = false;
    this.panel?.classList.add("expanded");
    this.positionPanel();
    this.emit("expand");
    this.emit("statechange");
  }

  collapse(): void {
    this.state.collapsed = true;
    this.panel?.classList.remove("expanded");
    this.emit("collapse");
    this.emit("statechange");
  }

  on(event: PluginControlEvent, handler: PluginControlEventHandler): void {
    const set =
      this.handlers.get(event) ?? new Set<PluginControlEventHandler>();
    set.add(handler);
    this.handlers.set(event, set);
  }

  off(event: PluginControlEvent, handler: PluginControlEventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  private emit(type: PluginControlEvent): void {
    const event = { type, state: this.getState() };
    this.handlers.get(type)?.forEach((handler) => handler(event));
  }

  private createButton(): HTMLElement {
    const container = document.createElement("div");
    container.className =
      "maplibregl-ctrl maplibregl-ctrl-group georaster-control";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "georaster-toggle";
    button.title = this.options.title;
    button.setAttribute("aria-label", this.options.title);
    button.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v12H4zM8 20h8M12 16v4"/><path d="m7 13 3-3 2 2 3-4 2 3"/></svg>';
    button.addEventListener("click", () => this.toggle());
    container.appendChild(button);
    return container;
  }

  private createPanel(): HTMLElement {
    const panel = document.createElement("section");
    panel.className = "georaster-panel";
    panel.style.width = `${this.state.panelWidth}px`;

    const header = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = this.options.title;
    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    close.addEventListener("click", () => this.collapse());
    header.append(title, close);

    const form = document.createElement("form");
    form.className = "georaster-form";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.startExport();
    });

    const crs = document.createElement("input");
    crs.value = "EPSG:5514 — S-JTSK / Krovak East North";
    crs.disabled = true;

    const source = document.createElement("select");
    source.dataset.field = "sourceSelection";
    source.addEventListener("change", () => {
      this.state.settings.sourceSelection =
        source.value === "visible-map"
          ? { kind: "visible-map" }
          : { kind: "raster", sourceId: source.value };
      this.emit("statechange");
      this.updatePreview();
    });

    const resolution = document.createElement("input");
    resolution.type = "number";
    resolution.min = "0.01";
    resolution.step = "0.01";
    resolution.setAttribute("list", "georaster-resolutions");
    resolution.dataset.field = "resolution";
    resolution.addEventListener("input", () => {
      this.state.settings.resolution = Number(resolution.value);
      this.emit("statechange");
      this.updatePreview();
    });
    const datalist = document.createElement("datalist");
    datalist.id = "georaster-resolutions";
    for (const value of [0.1, 0.2, 0.5, 1]) {
      const option = document.createElement("option");
      option.value = String(value);
      datalist.appendChild(option);
    }

    const resampling = document.createElement("select");
    resampling.dataset.field = "resampling";
    for (const [value, text] of [
      ["nearest", "Nearest neighbour"],
      ["bilinear", "Bilinear"],
      ["cubic", "Cubic"],
    ] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      resampling.appendChild(option);
    }
    resampling.addEventListener("change", () => {
      this.state.settings.resampling = resampling.value as ResamplingMethod;
      this.emit("statechange");
    });

    const outputGeometry = document.createElement("select");
    outputGeometry.dataset.field = "outputGeometry";
    for (const [value, text] of [
      ["rotated", "Rotated image (less precise)"],
      ["north-up", "Blank corners (grid aligned)"],
    ] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      outputGeometry.appendChild(option);
    }
    outputGeometry.addEventListener("change", () => {
      this.state.settings.outputGeometry =
        outputGeometry.value as OutputGeometry;
      this.emit("statechange");
      this.updatePreview();
    });

    const imageFormat = document.createElement("select");
    imageFormat.dataset.field = "imageFormat";
    for (const [value, text] of [
      ["png", "PNG (lossless, transparency)"],
      ["jpeg", "JPEG (90% quality, white background)"],
    ] as const) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      imageFormat.appendChild(option);
    }
    imageFormat.addEventListener("change", () => {
      this.state.settings.imageFormat = imageFormat.value as ImageFormat;
      this.emit("statechange");
    });

    const filename = document.createElement("input");
    filename.type = "text";
    filename.dataset.field = "filename";
    filename.addEventListener("input", () => {
      this.state.settings.filename = filename.value;
      this.emit("statechange");
    });

    this.preview = document.createElement("div");
    this.preview.className = "georaster-preview";
    this.status = document.createElement("div");
    this.status.className = "georaster-status";
    this.status.setAttribute("role", "status");

    const actions = document.createElement("div");
    actions.className = "georaster-actions";
    this.exportButton = document.createElement("button");
    this.exportButton.type = "submit";
    this.exportButton.className = "primary";
    this.exportButton.textContent = "Export ZIP";
    this.cancelButton = document.createElement("button");
    this.cancelButton.type = "button";
    this.cancelButton.textContent = "Cancel";
    this.cancelButton.hidden = true;
    this.cancelButton.addEventListener("click", () =>
      this.abortController?.abort(),
    );
    actions.append(this.exportButton, this.cancelButton);

    form.append(
      formField("Source", source),
      formField("Target CRS", crs),
      formField("Pixel size (metres)", resolution),
      datalist,
      formField("Resampling", resampling),
      formField("Output geometry", outputGeometry),
      formField("Image format", imageFormat),
      formField("File name", filename),
      this.preview,
      this.status,
      actions,
    );
    panel.append(header, form);
    this.refreshSourceOptions();
    this.renderSettings();
    return panel;
  }

  private renderSettings(): void {
    if (!this.panel) return;
    const resolution = this.panel.querySelector<HTMLInputElement>(
      "[data-field=resolution]",
    );
    const resampling = this.panel.querySelector<HTMLSelectElement>(
      "[data-field=resampling]",
    );
    const filename = this.panel.querySelector<HTMLInputElement>(
      "[data-field=filename]",
    );
    const outputGeometry = this.panel.querySelector<HTMLSelectElement>(
      "[data-field=outputGeometry]",
    );
    const imageFormat = this.panel.querySelector<HTMLSelectElement>(
      "[data-field=imageFormat]",
    );
    const sourceSelection = this.panel.querySelector<HTMLSelectElement>(
      "[data-field=sourceSelection]",
    );
    if (resolution) resolution.value = String(this.state.settings.resolution);
    if (resampling) resampling.value = this.state.settings.resampling;
    if (filename) filename.value = this.state.settings.filename;
    if (outputGeometry)
      outputGeometry.value = this.state.settings.outputGeometry;
    if (imageFormat) imageFormat.value = this.state.settings.imageFormat;
    if (sourceSelection) {
      sourceSelection.value =
        this.state.settings.sourceSelection.kind === "raster"
          ? this.state.settings.sourceSelection.sourceId
          : "visible-map";
    }
    this.updatePreview();
  }

  private refreshSourceOptions(): void {
    if (!this.panel || !this.map) return;
    const select = this.panel.querySelector<HTMLSelectElement>(
      "[data-field=sourceSelection]",
    );
    if (!select) return;
    const selected =
      this.state.settings.sourceSelection.kind === "raster"
        ? this.state.settings.sourceSelection.sourceId
        : "visible-map";
    select.replaceChildren();
    const visibleMap = document.createElement("option");
    visibleMap.value = "visible-map";
    visibleMap.textContent = "Visible map";
    select.appendChild(visibleMap);
    for (const raster of discoverRasterSources(this.map)) {
      const option = document.createElement("option");
      option.value = raster.id;
      option.textContent = `${raster.label} (${raster.kind.toUpperCase()})`;
      select.appendChild(option);
    }
    select.value = selected;
    if (!select.value) select.value = "visible-map";
    this.updatePreview();
  }

  private updatePreview(): void {
    if (!this.preview || !this.map) return;
    try {
      const preview = calculateExportPreview(this.map, this.state.settings);
      this.preview.textContent =
        `${preview.width.toLocaleString()} × ${preview.height.toLocaleString()} px · ` +
        `${preview.pixelCount.toLocaleString()} pixels · ${preview.method}`;
      if (preview.warning) this.preview.textContent += ` · ${preview.warning}`;
      this.preview.classList.remove("error");
      const geometry = this.panel?.querySelector<HTMLSelectElement>(
        "[data-field=outputGeometry]",
      );
      const resampling = this.panel?.querySelector<HTMLSelectElement>(
        "[data-field=resampling]",
      );
      if (geometry) geometry.disabled = preview.directCandidate;
      if (resampling) resampling.disabled = preview.directCandidate;
      if (this.exportButton) this.exportButton.disabled = false;
    } catch (error) {
      this.preview.textContent =
        error instanceof Error ? error.message : "Invalid export settings.";
      this.preview.classList.add("error");
      if (this.exportButton) this.exportButton.disabled = true;
    }
  }

  private async startExport(): Promise<void> {
    if (!this.map || !this.exportButton || !this.cancelButton || !this.status) {
      return;
    }
    this.abortController = new AbortController();
    this.exportButton.disabled = true;
    this.cancelButton.hidden = false;
    try {
      const result = await exportVisibleMap(
        this.map,
        this.state.settings,
        ({ phase, percent }) => {
          if (this.status) this.status.textContent = `${phase}: ${percent}%`;
        },
        this.abortController.signal,
        { fetchArrayBuffer: this.fetchArrayBuffer },
      );
      this.status.textContent =
        `Downloaded ${result.filename} (${result.width.toLocaleString()} × ` +
        `${result.height.toLocaleString()} px, ${result.method}).`;
      if (result.warnings.length) {
        this.status.textContent += ` Warning: ${result.warnings.join(" ")}`;
      }
    } catch (error) {
      this.status.textContent =
        error instanceof DOMException && error.name === "AbortError"
          ? "Export cancelled."
          : error instanceof Error
            ? error.message
            : "Export failed.";
    } finally {
      this.abortController = undefined;
      this.cancelButton.hidden = true;
      this.updatePreview();
    }
  }

  private positionPanel(): void {
    if (!this.panel || !this.container || !this.map) return;
    const button = this.container.getBoundingClientRect();
    const map = this.map.getContainer().getBoundingClientRect();
    const panel = this.panel.getBoundingClientRect();
    const position = calculatePanelPosition(
      button,
      map,
      panel.width || this.state.panelWidth,
      panel.height || Math.min(620, map.height - 24),
    );
    this.panel.style.left =
      position.left === undefined ? "" : `${position.left}px`;
    this.panel.style.right =
      position.right === undefined ? "" : `${position.right}px`;
    this.panel.style.top =
      position.top === undefined ? "" : `${position.top}px`;
    this.panel.style.bottom =
      position.bottom === undefined ? "" : `${position.bottom}px`;
  }
}
