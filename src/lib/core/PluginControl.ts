import type { IControl, Map as MapLibreMap } from "maplibre-gl";
import { calculateOutputGrid, exportVisibleMap } from "../georaster/exporter";
import type {
  ExportSettings,
  OutputGeometry,
  ResamplingMethod,
} from "../georaster/types";
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
  filename: "geolibre_5514",
};

const DEFAULT_OPTIONS: Required<PluginControlOptions> = {
  collapsed: true,
  position: "top-right",
  title: "GeoRaster Export",
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
  private readonly options: Required<PluginControlOptions>;
  private state: PluginState;
  private readonly handlers: EventHandlers = new Map();
  private mapMoveHandler?: () => void;

  constructor(options?: Partial<PluginControlOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
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
    this.mapMoveHandler = () => this.updatePreview();
    map.on("moveend", this.mapMoveHandler);
    if (!this.state.collapsed) this.expand();
    this.updatePreview();
    return this.container;
  }

  onRemove(): void {
    this.abortController?.abort();
    if (this.map && this.mapMoveHandler)
      this.map.off("moveend", this.mapMoveHandler);
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
      ["rotated", "Rotated image (CAD)"],
      ["north-up", "North-up S-JTSK grid (precise)"],
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
      formField("Target CRS", crs),
      formField("Pixel size (metres)", resolution),
      datalist,
      formField("Resampling", resampling),
      formField("Output geometry", outputGeometry),
      formField("File name", filename),
      this.preview,
      this.status,
      actions,
    );
    panel.append(header, form);
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
    if (resolution) resolution.value = String(this.state.settings.resolution);
    if (resampling) resampling.value = this.state.settings.resampling;
    if (filename) filename.value = this.state.settings.filename;
    if (outputGeometry)
      outputGeometry.value = this.state.settings.outputGeometry;
    this.updatePreview();
  }

  private updatePreview(): void {
    if (!this.preview || !this.map) return;
    try {
      const grid = calculateOutputGrid(
        this.map,
        this.state.settings.resolution,
        this.state.settings.outputGeometry,
      );
      this.preview.textContent =
        `${grid.width.toLocaleString()} × ${grid.height.toLocaleString()} px · ` +
        `${grid.pixelCount.toLocaleString()} pixels`;
      this.preview.classList.remove("error");
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
      );
      this.status.textContent =
        `Downloaded ${result.filename} (${result.width.toLocaleString()} × ` +
        `${result.height.toLocaleString()} px).`;
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
    this.panel.style.top = `${button.bottom - map.top + 6}px`;
    this.panel.style.right = `${map.right - button.right}px`;
  }
}
