// The main entry: everything the core entry exports, with the registry
// defaulted to every generated type wherever the core takes one as an
// argument. src/defaults.ts is that layer, and src/core.ts holds the list of
// every public name. Generated types are importable under ./gen/*.

export * from "./defaults.js";
