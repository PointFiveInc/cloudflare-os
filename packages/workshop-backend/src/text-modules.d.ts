declare module "*.txt" {
  const content: string;
  export default content;
}

// Bytes, not a compiled module -- see the `rules` entry in cloudflare.config.ts, which maps
// `**/esbuild.wasm` to a Data module. The Gadget bundler needs the raw bytes to hand to the Worker Loader.
declare module "*.wasm" {
  const bytes: ArrayBuffer;
  export default bytes;
}
