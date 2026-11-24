// Reading a network from the published registry: the three files of one
// directory, fetched at a git ref and handed to Network, which checks them.
// The name and the ref become part of a URL, so each is held to the form a
// registry directory's name or a git ref has before anything is fetched.
import { errorMessage } from "../errors.js";
import { Network } from "./network.js";
import { RegistryError } from "./parse.js";

export const REGISTRY_REPOSITORY = "ararat-network/ark-registry";
/** The ref the registry is read at unless one is given: the branch its endpoints are kept on. */
export const DEFAULT_REGISTRY_REF = "main";

/** Where the published registry's files are read from, at a git ref: a branch, a tag, or a commit, which pins it. */
export function registrySource(ref = DEFAULT_REGISTRY_REF): string {
  checkRef(ref);
  return `https://raw.githubusercontent.com/${REGISTRY_REPOSITORY}/${ref}`;
}

/** One part of a git ref between slashes: letters, digits, dots, hyphens, and underscores, not led by a dot. */
const REF_PART = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * Refuses a ref that is not a branch, tag, or commit name. The ref becomes
 * part of the registry's URL, and one holding "..", an empty part, or a
 * character a URL reads as structure would name another repository's files.
 */
function checkRef(ref: string): void {
  const named = ref.split("/").every((part) => REF_PART.test(part) && !part.includes("..") && !part.endsWith("."));
  if (!named) throw new RegistryError(`registry ref ${JSON.stringify(ref)} is not a branch, tag, or commit name`);
}

export interface LoadOptions {
  /** Base URL holding `<name>/chain.json` and the two other files; the published registry at `ref` by default. */
  source?: string;
  /** The registry's git ref when `source` is not given: `main` by default; a commit pins what is read. */
  ref?: string;
  fetch?: typeof fetch;
}

/** A registry directory's name, as the chain registry names chains: lowercase letters and digits, single hyphens or underscores between them. */
const NETWORK_NAME = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/**
 * Fetches the three files for a network, checks them, and builds it. The name
 * is a registry directory's and nothing else: it and the ref become part of
 * the URL, and a caller may have taken either from a link or a setting. The
 * network the files describe must be the one asked for.
 */
export async function loadNetwork(name: string, options: LoadOptions = {}): Promise<Network> {
  if (!NETWORK_NAME.test(name)) {
    throw new RegistryError(
      `network name ${JSON.stringify(name)} is not a registry directory's: lowercase letters and digits, hyphens or underscores between them`,
    );
  }
  const source = options.source ?? registrySource(options.ref);
  const fetchFn = options.fetch ?? globalThis.fetch;
  const read = async (file: string): Promise<unknown> => {
    const url = `${source}/${name}/${file}`;
    const response = await fetchOk(fetchFn, url);
    try {
      return await response.json();
    } catch (err) {
      throw new RegistryError(`${url}: not JSON: ${errorMessage(err)}`, { cause: err });
    }
  };
  const [chain, assets, ark] = await Promise.all([read("chain.json"), read("assetlist.json"), read("ark.json")]);
  const network = Network.fromRegistry({ chain, assets, ark });
  // A directory is named for the chain it describes. Files for another chain, well formed, would hand a caller
  // who asked for the testnet another network's chain ID and endpoints.
  if (network.name !== name) throw new RegistryError(`${source}/${name} describes the network ${network.name}, not ${name}`);
  return network;
}

/**
 * A registry file or the genesis it names, fetched: a request that fails or is answered with an error status is a
 * RegistryError, the failure kept as its cause. Called unbound: a browser's fetch refuses any receiver but its
 * window. Internal: not exported from the core entry.
 */
export async function fetchOk(fetchFn: typeof fetch, url: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetchFn(url);
  } catch (err) {
    throw new RegistryError(`${url}: ${errorMessage(err)}`, { cause: err });
  }
  if (!response.ok) throw new RegistryError(`${url}: ${response.status} ${response.statusText}`);
  return response;
}
