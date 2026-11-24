// Bundles the library for a browser: a node: import or a missing browser API
// in src/ fails here rather than in an app's build. Prints each bundle's size
// so growth is visible in CI logs. The core entry must stay clear of the full
// type registry: one import of it would put every generated file in the
// bundle of a consumer who passed a registry of their own, so that is checked
// here, on the whole entry and on a client built over one service.
import { build } from "esbuild";

const bundle = (options) =>
  build({ bundle: true, platform: "browser", format: "esm", target: "es2022", write: false, metafile: true, logLevel: "warning", ...options });
const size = (result) => `${(result.outputFiles.reduce((n, f) => n + f.contents.byteLength, 0) / 1024).toFixed(0)} KiB`;
const inputs = (result) =>
  Object.entries(Object.values(result.metafile.outputs)[0].inputs)
    .filter(([, v]) => v.bytesInOutput > 0)
    .map(([path]) => path);
const generated = (result) => inputs(result).filter((path) => path.startsWith("src/gen/")).length;

const main = await bundle({ entryPoints: ["src/index.ts"] });
console.log(`browser bundle: ${size(main)} before minification, ${generated(main)} generated files`);

const core = await bundle({ entryPoints: ["src/core.ts"] });
console.log(`core entry: ${size(core)} before minification, ${generated(core)} generated files`);

// What the core entry is for: a client that names the one service it calls.
const narrow = await bundle({
  stdin: {
    resolveDir: process.cwd(),
    loader: "ts",
    contents: `
      import { createRegistry } from "@bufbuild/protobuf";
      import { GatewayClient, decodeTx } from "./src/core.ts";
      import { Query } from "./src/gen/cosmos/bank/v1beta1/query_pb.ts";
      const registry = createRegistry(Query);
      console.log(new GatewayClient("https://node.example", { registry }), decodeTx);
    `,
  },
});
console.log(`core entry, a gateway client over one service: ${size(narrow)} before minification, ${generated(narrow)} generated files`);

const full = ["src/codec/registry.ts", "src/codec/files.ts", "src/defaults.ts"];
for (const [name, result] of [
  ["the core entry", core],
  ["a core gateway client over one service", narrow],
]) {
  const leaked = inputs(result).filter((path) => full.includes(path));
  if (leaked.length > 0) {
    console.error(`${name} bundles ${leaked.join(", ")}: something under src/core.ts imports the full registry`);
    process.exit(1);
  }
}
