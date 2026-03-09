import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(rootDir, "manifest.json");
const outputDir = resolve(rootDir, "dist");
const destination = resolve(outputDir, "manifest.json");

await mkdir(outputDir, { recursive: true });
await cp(source, destination);
