import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = dirname(fileURLToPath(import.meta.url));
const runtimeOutputFile = resolve(packageDir, "src/generated/browser-export-runtime.txt");
const sanitizerOutputFile = resolve(packageDir, "src/generated/html-sanitizer-runtime.txt");
const pageOutputFile = resolve(packageDir, "src/generated/browser-export-page.js");
const bundlerOutputFile = resolve(packageDir, "src/generated/gadget-bundler-harness.txt");
const pdfOutputFile = resolve(packageDir, "src/generated/pdf-runtime.txt");

const runtimeResult = await build({
  entryPoints: [resolve(packageDir, "browser/browser-export-runtime.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2025",
  minify: true,
  write: false,
});
const pageResult = await build({
  entryPoints: [resolve(packageDir, "browser/browser-export-page.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2025",
  write: false,
});
const sanitizerResult = await build({
  entryPoints: [resolve(packageDir, "browser/html-sanitizer-runtime.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2025",
  minify: true,
  write: false,
});

// `@gadget/pdf`, the first vetted library. ESM rather than the IIFE the three above use: real
// `export` boundaries have to survive so the per-Gadget bundle pass can resolve named imports
// against them (and tree-shake what it can). Minified, unlike the Gadget's own code -- this is
// vetted third-party source nobody debugs from a Gadget stack trace, and it is big enough that
// the Gadget's `jsCode` string, which gets URL-encoded into a data: URL, notices the difference.
const pdfResult = await build({
  entryPoints: [resolve(packageDir, "browser/gadget-pdf-runtime.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  write: false,
});
writeIfChanged(pdfOutputFile, pdfResult.outputFiles[0].contents);

// The Gadget client bundler, as loaded into a Dynamic Worker by gadget-bundle.ts. Unlike the
// three above this is Worker code, not browser code: `format: "esm"` because the loader takes an
// ES module, and no minification because its frames show up in bundler-side error messages.
//
// `esbuild-wasm`'s browser build (130 KB of JS) is inlined; its 14 MB `.wasm` is NOT -- that
// arrives as a separate Worker Loader module, so the bare specifier is left for the loader to
// resolve. `cloudflare:workers` is likewise a runtime module.
const bundlerResult = await build({
  entryPoints: [resolve(packageDir, "src/gadget-bundler-harness.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  external: ["cloudflare:workers", "./esbuild.wasm"],
  // The vetted-library sources are inlined into the harness as text (see SUPPORTED_LIBRARIES).
  loader: { ".txt": "text" },
  write: false,
});

writeIfChanged(runtimeOutputFile, runtimeResult.outputFiles[0].contents);
writeIfChanged(sanitizerOutputFile, sanitizerResult.outputFiles[0].contents);
writeIfChanged(pageOutputFile, pageResult.outputFiles[0].contents);
writeIfChanged(bundlerOutputFile, bundlerResult.outputFiles[0].contents);

function writeIfChanged(outputFile, bytes) {
  const contents = new TextDecoder().decode(bytes);
  if (!existsSync(outputFile) || readFileSync(outputFile, "utf8") !== contents) {
    mkdirSync(dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, contents);
  }
}
