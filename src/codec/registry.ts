// The type registry: every message the chain can carry in an Any or emit as a
// typed event, from the generated files. A consumer with a smaller surface can
// build its own with createRegistry and pass it where one is accepted.
import { createRegistry, type DescMessage, type Registry } from "@bufbuild/protobuf";

import { generatedFiles } from "./files.js";

export const registry: Registry = createRegistry(...generatedFiles);

/** What every reader of packed messages accepts: the types an Any resolves against. */
export interface RegistryOption {
  /** Every generated type by default; a client's helpers default to the client's own. */
  registry?: Registry;
}

/** The schema registered under a type URL or full type name. */
export function schemaFor(typeUrlOrName: string, reg: Registry = registry): DescMessage | undefined {
  return reg.getMessage(typeUrlOrName.slice(typeUrlOrName.lastIndexOf("/") + 1));
}
