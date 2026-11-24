// The type registry: every message the chain can carry in an Any or emit as a
// typed event, from the generated files. Only src/defaults.ts imports it: the
// modules take their registry as an argument, so a consumer of the core entry
// who builds a narrower one with createRegistry does not bundle this one.
import { createRegistry, type Registry } from "@bufbuild/protobuf";

import { generatedFiles } from "./files.js";

export const registry: Registry = createRegistry(...generatedFiles);
