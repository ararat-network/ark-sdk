// The type registry: every message the chain can carry in an Any or emit as a
// typed event, from the generated files. A consumer with a smaller surface can
// build its own with createRegistry and pass it where one is accepted.
import { createRegistry, type Registry } from "@bufbuild/protobuf";

import { generatedFiles } from "./files.js";

export const registry: Registry = createRegistry(...generatedFiles);

/** What every reader of packed messages accepts: the types an Any resolves against. */
export interface RegistryOption {
  /** Every generated type by default; a client's helpers default to the client's own. */
  registry?: Registry;
}
