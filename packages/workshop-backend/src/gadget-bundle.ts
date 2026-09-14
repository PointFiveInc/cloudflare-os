// Bundles a Gadget's client entry point from the Gadget's own files, so client code can be split
// across files and imported normally instead of having to live entirely in one client.js.
//
// The bundling itself happens in a Dynamic Worker (see GADGET_BUNDLER_WORKER): the source is
// AI-generated and untrusted, and running the parser in its own isolate is what lets it carry a
// CPU cap, no bindings and no network. This module is only the caller.
import type { WorkerEntrypoint } from "cloudflare:workers";
import GADGET_BUNDLER_HARNESS from "./generated/gadget-bundler-harness.txt";
import type { BundleResult } from "./gadget-bundler-harness.ts";

/**
 * Bumped whenever the harness or this worker definition changes. It is part of the `LOADER.get()`
 * key (and, once caching lands, of the bundle cache key), so a deploy can never serve a Dynamic
 * Worker cached from the previous version of the bundler.
 */
export const BUNDLER_VERSION = 1;

// Extends WorkerEntrypoint so getEntrypoint() accepts it: the stub is branded, not structural.
interface GadgetBundlerEntrypoint extends WorkerEntrypoint {
  bundle(files: Record<string, string>): Promise<BundleResult>;
}

/**
 * The bundler as a Dynamic Worker, alongside CODE_MODE_HARNESS and RESTORE_FORGER_WORKER in
 * overseer.ts -- the same `LOADER` binding, the same "run untrusted code in its own isolate"
 * pattern.
 *
 * The wasm is imported dynamically, on the first bundle, rather than at module scope. Two
 * reasons, one of them load-bearing: the unit test config (vitest.config.ts) builds its miniflare
 * options inline and so never sees wrangler.jsonc's `Data` rule, and a *static* import here puts
 * that unresolvable wasm in the module graph of everything that reaches overseer.ts -- which
 * failed eight unrelated suites with "ESM integration proposal for Wasm is not supported". The
 * second reason is that nothing pays for reading 14 MB until a Gadget actually needs a bundle.
 */
async function gadgetBundlerWorker(): Promise<WorkerLoaderWorkerCode> {
  // Bytes, not a compiled module: `WorkerLoaderModule.wasm` takes an ArrayBuffer, and a
  // WebAssembly.Module cannot cross this boundary. The loader compiles it inside the bundler's
  // own isolate, which is also what keeps a 14 MB wasm compile out of this Worker's startup.
  const { default: wasm } = await import("esbuild-wasm/esbuild.wasm");
  return {
    compatibilityDate: "2026-02-01",
    // The bundler holds no bindings; lock it down like the code-mode and forger workers.
    compatibilityFlags: ["disallow_importable_env"],
    mainModule: "bundler.js",
    modules: {
      "bundler.js": GADGET_BUNDLER_HARNESS,
      "esbuild.wasm": { wasm },
    },
    // Same "no network" guarantee the code-mode and forger workers get, for the same reason.
    globalOutbound: null,
    // A hard ceiling on parsing pathological AI-generated source, charged to the bundler's own
    // isolate rather than to the overseer's request. Generous enough that a real Gadget never
    // reaches it; low enough that a runaway build fails instead of eating the budget.
    limits: { cpuMs: 30_000 },
  };
}

/** Thrown for a Gadget whose client source cannot be bundled. Message is agent-readable. */
export class GadgetBundleError extends Error {
  constructor(readonly errors: string[]) {
    super(`Failed to build the Gadget UI:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    this.name = "GadgetBundleError";
  }
}

/**
 * Whether `source` could possibly contain a module import: any `import` or `export` token at all.
 * Deliberately crude, and safe in the direction that matters -- every real static or dynamic
 * import contains one of those two words, so a false negative (skipping a build that was needed)
 * is not reachable, while a false positive (a mention in a comment or a string) costs one cheap
 * build whose single-input result is discarded in favour of the original source anyway.
 */
function mightImport(source: string): boolean {
  return /\b(?:import|export)\b/.test(source);
}

/**
 * The bundled `client.js` for `files`, or the original source verbatim when the Gadget imports
 * nothing.
 *
 * That passthrough is not just an optimization: a single-file Gadget is the overwhelmingly common
 * case, and returning its source untouched means bundling cannot change what runs, or where its
 * stack traces point, for any of them.
 *
 * `loader` is the `LOADER` binding; the isolate is keyed so it (and its initialized wasm) is
 * reused across calls.
 */
export async function bundleGadgetClient(
    loader: WorkerLoader, keyPrefix: string, files: ReadonlyMap<string, string>): Promise<string> {
  const client = files.get("client.js");
  if (client === undefined) {
    throw new GadgetBundleError(["This Gadget has no client.js."]);
  }

  // A client.js with no import syntax in it has nothing to bundle, so skip the round trip
  // entirely rather than pay for a build whose output would be this same string. That keeps the
  // single-file Gadget -- still the overwhelmingly common one -- exactly as fast, and exactly as
  // debuggable, as it was before any of this existed. Everything with an import in it goes to the
  // bundler, including the mistakes: that is where `client.js` importing `server.js`, a missing
  // file, or an npm package get their real error messages.
  if (!mightImport(client)) return client;

  // The loader only calls this back when it has no live isolate for the key, so the wasm is
  // read once per isolate rather than once per bundle.
  const stub = loader.get(`${keyPrefix}.gadget-bundler.${BUNDLER_VERSION}`,
      gadgetBundlerWorker);
  const result = await stub.getEntrypoint<GadgetBundlerEntrypoint>()
      .bundle(Object.fromEntries(files));

  if (!result.ok) throw new GadgetBundleError(result.errors);
  // Exactly one input means the entry imported nothing at all.
  return result.inputs.length === 1 ? client : result.code;
}
