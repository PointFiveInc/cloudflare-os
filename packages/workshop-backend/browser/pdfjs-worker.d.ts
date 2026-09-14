// pdfjs-dist ships type declarations only for its root entry (`types/src/pdf.d.ts` via
// package.json's `types`), not for the deep `build/pdf.worker.mjs` path. The worker module is
// imported purely for its side effect of being installed as `globalThis.pdfjsWorker` (see
// gadget-pdf-runtime.ts) -- nothing reads its exports, so an untyped module declaration is
// exactly as much type information as this needs.
declare module "pdfjs-dist/build/pdf.worker.mjs";
