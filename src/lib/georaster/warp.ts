import InlineWarpWorker from "./warp.worker?worker&inline";
import type { WarpRequest, WarpResponse } from "./types";

export function warpRaster(
  request: WarpRequest,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<Uint8ClampedArray> {
  return new Promise((resolve, reject) => {
    const worker = new InlineWarpWorker();
    const abort = () => {
      worker.terminate();
      reject(new DOMException("Export cancelled.", "AbortError"));
    };

    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      reject(new Error(event.message || "Raster worker failed."));
    };
    worker.onmessage = (event: MessageEvent<WarpResponse>) => {
      if (event.data.type === "progress") {
        onProgress(event.data.percent);
        return;
      }
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (event.data.type === "complete") resolve(event.data.pixels);
      else reject(new Error(event.data.message));
    };

    worker.postMessage(request, [request.source.pixels.buffer]);
  });
}
