// The base of every error the SDK throws on purpose. A caller that catches
// one `instanceof ArkSdkError` is holding a refusal the SDK made, a chain's
// or a node's answer it reported, or a request it could not build; anything
// else is a bug or the runtime's own failure. Each class keeps its `name` as
// a literal, since a minifier renames the class.

export class ArkSdkError extends Error {
  override readonly name: string = "ArkSdkError";
}

/** The message of whatever was thrown: an Error's own, or the value as text. Internal: not exported from the core entry. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
