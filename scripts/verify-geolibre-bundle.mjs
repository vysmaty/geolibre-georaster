import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(rootDir, "geolibre-plugin", "dist");
const entryPath = join(distDir, "index.js");
const entry = await readFile(entryPath, "utf8");
const files = await readdir(distDir);
const extraJavaScript = files.filter(
  (file) => file.endsWith(".js") && file !== "index.js",
);

if (extraJavaScript.length > 0) {
  throw new Error(
    "GeoLibre external plugins must be a single JavaScript module because " +
      "their entry is imported from a blob URL. Disable JavaScript code splitting.",
  );
}

if (
  !entry.includes("Promise.resolve().then(() => (init_raw(), raw_exports))")
) {
  throw new Error(
    "GeoTIFF decoder imports were not inlined into the GeoLibre entry module.",
  );
}

console.log("Verified self-contained GeoLibre JavaScript bundle.");
