// Addresses for display: the whole address is the only identity; a shortened
// form keeps the prefix and both ends so two addresses are hard to confuse.

/** "ark1fec7dnxl3fre9zmc3kyvtt357de3ek9fnlu96j" to "ark1fec7d…lu96j". */
export function shortenAddress(address: string, { head = 5, tail = 5 }: { head?: number; tail?: number } = {}): string {
  const separator = address.lastIndexOf("1");
  if (separator < 0 || address.length <= separator + 1 + head + tail + 1) return address;
  const prefix = address.slice(0, separator + 1);
  const data = address.slice(separator + 1);
  return `${prefix}${data.slice(0, head)}…${data.slice(-tail)}`;
}
