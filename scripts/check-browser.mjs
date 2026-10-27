// Bundles the library for a browser: a node: import or a missing browser API
// in src/ fails here rather than in an app's build. Prints the bundle size so
// growth is visible in CI logs.
import { build } from "esbuild";

const result = await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  write: false,
  metafile: true,
  logLevel: "warning",
});
const bytes = result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0);
console.log(`browser bundle: ${(bytes / 1024).toFixed(0)} KiB before minification`);
