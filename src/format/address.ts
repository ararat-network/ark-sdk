// Addresses for display: the whole address is the only identity; a shortened
// form keeps the prefix and both ends so two addresses are hard to confuse.

/** "ark1fec7dnxl3fre9zmc3kyvtt357de3ek9fnlu96j" to "ark1fec7d…lu96j". */
export function shortenAddress(address: string, { head = 5, tail = 5 }: { head?: number; tail?: number } = {}): string {
  const separator = address.lastIndexOf("1");
  // A count of characters: a negative one or a fraction is none, or whole.
  const first = Math.max(0, Math.floor(head));
  const last = Math.max(0, Math.floor(tail));
  if (separator < 0 || address.length <= separator + 1 + first + last + 1) return address;
  const prefix = address.slice(0, separator + 1);
  const data = address.slice(separator + 1);
  // slice(-0) is the whole string, so no tail is taken by its length.
  return `${prefix}${data.slice(0, first)}…${data.slice(data.length - last)}`;
}
