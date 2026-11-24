// Bundles the library for a browser: a node: import or a missing browser API
// in src/ fails here rather than in an app's build. Prints each bundle's size
// so growth is visible in CI logs. The core entry must stay clear of the full
// type registry: one import of it would put every generated file in the
// bundle of a consumer who passed a registry of their own, so that is checked
// here, on the whole entry and on a client built over one service. So is what
// the per-service clients are for: a flow handed the clients of the services
// it reads must not bundle the others.
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
      import { Query, file_cosmos_bank_v1beta1_query } from "./src/gen/cosmos/bank/v1beta1/query_pb.ts";
      // The file, for its messages: a registry of the service alone would hold no type an Any resolves to.
      const registry = createRegistry(file_cosmos_bank_v1beta1_query);
      console.log(new GatewayClient("https://node.example", { registry }), Query, decodeTx);
    `,
  },
});
console.log(`core entry, a gateway client over one service: ${size(narrow)} before minification, ${generated(narrow)} generated files`);

// The query client holds a client for every service the app reads, and bundles them all whatever the registry.
const whole = await bundle({
  stdin: {
    resolveDir: process.cwd(),
    loader: "ts",
    contents: `
      import { createRegistry } from "@bufbuild/protobuf";
      import { QueryClient, decodeTx } from "./src/core.ts";
      import { file_cosmos_bank_v1beta1_tx } from "./src/gen/cosmos/bank/v1beta1/tx_pb.ts";
      const registry = createRegistry(file_cosmos_bank_v1beta1_tx);
      console.log(new QueryClient("https://node.example", { registry }), decodeTx);
    `,
  },
});
console.log(`core entry, the query client: ${size(whole)} before minification, ${generated(whole)} generated files`);

// A send through the clients of the services it reads, each over one gateway: the other services stay out.
const send = await bundle({
  stdin: {
    resolveDir: process.cwd(),
    loader: "ts",
    contents: `
      import { createRegistry } from "@bufbuild/protobuf";
      import { GatewayClient, authClient, nodeClient, sendTx, treasuryClient, txClient } from "./src/core.ts";
      import { file_cosmos_bank_v1beta1_tx } from "./src/gen/cosmos/bank/v1beta1/tx_pb.ts";
      const gateway = new GatewayClient("https://node.example", { registry: createRegistry(file_cosmos_bank_v1beta1_tx) });
      const client = { gateway, tx: txClient(gateway), auth: authClient(gateway), treasury: treasuryClient(gateway), node: nodeClient(gateway) };
      console.log(client, sendTx);
    `,
  },
});
console.log(`core entry, a send through four services' clients: ${size(send)} before minification, ${generated(send)} generated files`);

// The per-service clients are what keeps a service a caller does not name out of its bundle: one that reached the
// send would mean the clients no longer tree-shake apart, or a flow asks for the whole query client again.
const unread = ["disbursement", "market", "oracle", "staking", "distribution", "gov"].map((service) => new RegExp(`^src/gen/.*/${service}/.*/query_pb\\.ts$`));
const strays = inputs(send).filter((path) => unread.some((service) => service.test(path)));
if (strays.length > 0) {
  console.error(`a send through four services' clients bundles ${strays.join(", ")}: a service it does not read`);
  process.exit(1);
}

const full = ["src/codec/registry.ts", "src/codec/files.ts", "src/defaults.ts"];
for (const [name, result] of [
  ["the core entry", core],
  ["a core gateway client over one service", narrow],
  ["the core query client", whole],
  ["a core send through four services' clients", send],
]) {
  const leaked = inputs(result).filter((path) => full.includes(path));
  if (leaked.length > 0) {
    console.error(`${name} bundles ${leaked.join(", ")}: something under src/core.ts imports the full registry`);
    process.exit(1);
  }
}
