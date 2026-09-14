// `@gadget/pdf`: the first vetted library a Gadget's client.js can import.
//
// Bundled at Worker build time into src/generated/pdf-runtime.txt and handed to any Gadget that
// imports the specifier (see SUPPORTED_LIBRARIES in gadget-bundler-harness.ts). Nothing is fetched
// at runtime -- the whole library travels inside the Gadget's own bundle, because the iframe's CSP
// is `default-src 'none'` and there is no network from inside the sandbox at all.
//
// The worker module is bundled in and installed as `globalThis.pdfjsWorker`, which is pdf.js's
// documented hook for running on the main thread: PDFWorker#initialize() checks
// `globalThis.pdfjsWorker?.WorkerMessageHandler` first and takes its fake-worker path when it is
// present, so it never reaches `new Worker(...)`. That matters here beyond preference -- the CSP
// has no `worker-src`/`child-src`, so `default-src 'none'` blocks a real worker from a blob: or
// data: URL outright. Main thread is the only option in this sandbox.
import { getDocument as pdfjsGetDocument, VerbosityLevel } from "pdfjs-dist";
import * as pdfjsWorker from "pdfjs-dist/build/pdf.worker.mjs";

(globalThis as unknown as {pdfjsWorker: unknown}).pdfjsWorker = pdfjsWorker;

// Re-exported wholesale: `GlobalWorkerOptions`, `AnnotationMode`, and the rest of pdf.js's public
// surface, so a Gadget's import looks exactly like importing pdfjs-dist normally. Imported by
// package name, not by the deep `build/pdf.mjs` path, so it picks up pdfjs-dist's own type
// declarations (package.json `types`).
export * from "pdfjs-dist";

/**
 * pdf.js's `getDocument`, with warnings off by default.
 *
 * Two warnings are unavoidable in this sandbox and appear on every single load: "Setting up fake
 * worker" (the main-thread path above, working as intended) and "Failed to compile PostScript
 * function to wasm, falling back to JS" (the iframe CSP has no `'wasm-unsafe-eval'`, so pdf.js's
 * runtime `new WebAssembly.Module` is refused and it uses its JS implementation instead). Neither
 * is actionable, and both reach the agent through the Gadget console pipe -- where an unexplained
 * warning invites it to spend turns "fixing" a non-problem.
 *
 * `getDocument` reads `verbosity` off its parameter object and forwards it to the worker side too,
 * so this one default silences both. A Gadget that wants them back passes its own `verbosity`,
 * which wins: the caller's object is spread last. (pdf.js 6 accepts only an object here -- a bare
 * string or TypedArray is no longer normalized -- so there is no other shape to handle.)
 *
 * An explicit local export like this one takes precedence over the `export *` above, which is
 * what makes the override reach a Gadget importing `getDocument` from `@gadget/pdf`.
 */
export function getDocument(src: Parameters<typeof pdfjsGetDocument>[0]) {
  return pdfjsGetDocument({ verbosity: VerbosityLevel.ERRORS, ...src });
}
