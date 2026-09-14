// The Gadget client bundler, as it runs inside a Dynamic Worker.
//
// NOT imported by this Worker. `build-browser-runtime.mjs` bundles this file (with esbuild-wasm's
// browser build inlined) into `src/generated/gadget-bundler-harness.txt`, which `gadget-bundle.ts`
// hands to the `LOADER` binding as a Dynamic Worker's main module. It lives under `src/` rather
// than `browser/` because it is Worker code -- it needs `cloudflare:workers` and worker types, not
// the DOM lib `browser/` is configured for.
//
// It runs with no bindings, no env (`disallow_importable_env`) and `globalOutbound: null`, because
// the source it parses is AI-generated and untrusted. Keep it that way: this file should never
// need a capability of any kind.
import { WorkerEntrypoint } from "cloudflare:workers";
import * as esbuild from "esbuild-wasm/esm/browser.js";
import PDF_RUNTIME_SOURCE from "./generated/pdf-runtime.txt";

// Inside the loaded worker this specifier is a compiled `WebAssembly.Module`, supplied by the
// Worker Loader from the bytes `gadget-bundle.ts` passes as `modules["esbuild.wasm"]`. The
// ambient `*.wasm` declaration describes the *other* end of that trip (the Data-module import in
// this Worker, which is an ArrayBuffer), hence the cast. Marked external by the build script, so
// the bundled harness keeps the bare import for the loader to resolve, and it typechecks here
// against that same ambient declaration.
import wasmModuleImport from "./esbuild.wasm";
const wasmModule = wasmModuleImport as unknown as WebAssembly.Module;

/** The entry point every Gadget's client bundle is rooted at. */
const ENTRY = "client.js";

/**
 * Not importable from client code: it runs in a different runtime with different globals, and
 * bundling it into the client would produce something that fails confusingly in the browser
 * instead of clearly here. (The server side needs no such rule -- `loadGadgetWorker` already
 * passes every `.js` file to the Gadget's worker as a module, so `server.js` can import siblings
 * today.)
 */
const SERVER_ENTRY = "server.js";

/** Extensions we know how to hand esbuild, and the loader each one gets. */
const LOADERS: Record<string, "js" | "json"> = {
  ".js": "js",
  ".mjs": "js",
  ".json": "json",
};

/**
 * The libraries a Gadget's client code may import, by the specifier it imports them as.
 *
 * Deliberately an allowlist of pre-bundled sources, not a package manager: nothing is fetched, at
 * build time or at runtime, and a Gadget can only reach code that was vetted and compiled into
 * this Worker. Specifiers are shaped like ordinary scoped packages rather than a custom URI
 * scheme, because that is the form the model has seen millions of times and a bespoke scheme none.
 *
 * Getters, not eager values, so a Gadget importing none of them costs nothing per build.
 */
const SUPPORTED_LIBRARIES: Record<string, () => string> = {
  "@gadget/pdf": () => PDF_RUNTIME_SOURCE,
};

/** Namespace for a resolved vetted library, kept separate from the Gadget's own files. */
const LIBRARY_NAMESPACE = "gadget-lib";

/** For the "not available" message: what the Gadget could have imported instead. */
function availableLibraries(): string {
  return Object.keys(SUPPORTED_LIBRARIES).map(name => `\`${name}\``).join(", ");
}

/** Tried in order when an import specifier does not name a file directly. */
const RESOLVE_SUFFIXES = ["", ".js", ".mjs", "/index.js"];

export interface BundleSuccess {
  ok: true;
  /** The bundled ESM source. */
  code: string;
  /** Every file that ended up in the bundle, entry included. */
  inputs: string[];
}

export interface BundleFailure {
  ok: false;
  /** One agent-readable line per problem, each naming a file where esbuild gave us one. */
  errors: string[];
}

export type BundleResult = BundleSuccess | BundleFailure;

// esbuild-wasm initializes once per isolate, never per call. A stable `LOADER.get()` key keeps
// that isolate (and this compiled wasm) alive across bundles.
let initialized: Promise<void> | undefined;

function initialize(): Promise<void> {
  // `worker: false`: there is no Worker constructor here, and no `fetch` for the default init
  // path to pull a `.wasm` over either -- the module above is already compiled.
  initialized ??= esbuild.initialize({ wasmModule, worker: false });
  return initialized;
}

/** `a/b/c.js` -> `a/b`; a bare `c.js` -> `""`. */
function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * Resolves `specifier` (relative, e.g. `./util.js` or `../lib/render`) against the directory of
 * the file that imported it, collapsing `.` and `..` the way a real filesystem would. Returns
 * undefined if the result escapes the Gadget's own tree -- the file map is the only filesystem
 * there is, and a `..` walking off the top of it must not resolve to anything.
 */
function resolvePath(specifier: string, importer: string): string | undefined {
  const segments: string[] = [];
  for (const segment of `${dirname(importer)}/${specifier}`.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      segments.push(segment);
      continue;
    }
    // Escaping the root is a resolution failure, not a path with leading `..`.
    if (segments.length === 0) return undefined;
    segments.pop();
  }
  return segments.join("/");
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(dot) : "";
}

/**
 * The Gadget's own files as a virtual filesystem. There is no disk here: `onResolve` and `onLoad`
 * answer entirely out of `files`, so esbuild can never read anything the Gadget's author did not
 * write.
 */
function virtualFsPlugin(files: Record<string, string>): esbuild.Plugin {
  return {
    name: "gadget-vfs",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") {
          return { path: ENTRY, namespace: "gadget-vfs" };
        }

        // Anything not starting with `.` is a package specifier: either one of the vetted
        // libraries, or nothing at all. Naming what IS available matters -- the agent reads this
        // message and retries, and "not available" alone tells it nothing about what to use.
        if (!args.path.startsWith(".")) {
          if (args.path in SUPPORTED_LIBRARIES) {
            return { path: args.path, namespace: LIBRARY_NAMESPACE };
          }
          return {
            errors: [{
              text: `\`${args.path}\` is not available in Gadget client code. Available ` +
                  `libraries: ${availableLibraries()}. Anything else must be a relative import ` +
                  `of this Gadget's own files (e.g. "./util.js").`,
            }],
          };
        }

        const base = resolvePath(args.path, args.importer);
        if (base === undefined) {
          return {
            errors: [{
              text: `"${args.path}" (imported by ${args.importer}) points outside this Gadget's ` +
                  `files.`,
            }],
          };
        }

        if (base === SERVER_ENTRY) {
          return {
            errors: [{
              text: `${SERVER_ENTRY} cannot be imported by client code: it runs on the server, ` +
                  `in a different runtime with different globals. Call it over the \`gadget\` RPC ` +
                  `stub instead, or move the shared code into a third file both can import.`,
            }],
          };
        }

        const found = RESOLVE_SUFFIXES
            .map((suffix) => `${base}${suffix}`)
            .find((candidate) => candidate in files);
        if (found === undefined) {
          return {
            errors: [{
              text: `No such file in this Gadget: "${args.path}" (imported by ${args.importer}). ` +
                  `Tried ${RESOLVE_SUFFIXES.map((s) => `${base}${s}`).join(", ")}.`,
            }],
          };
        }

        const extension = extensionOf(found);
        if (!(extension in LOADERS)) {
          return {
            errors: [{
              text: `${found} cannot be imported by Gadget client code: only ` +
                  `${Object.keys(LOADERS).join(", ")} files are supported.`,
            }],
          };
        }

        return { path: found, namespace: "gadget-vfs" };
      });

      build.onLoad({ filter: /.*/, namespace: "gadget-vfs" }, (args) => {
        return { contents: files[args.path], loader: LOADERS[extensionOf(args.path)] ?? "js" };
      });

      // A vetted library's pre-bundled source. It is already ESM, so esbuild parses it like any
      // other module in the graph and keeps only what the Gadget's imports reach.
      build.onLoad({ filter: /.*/, namespace: LIBRARY_NAMESPACE }, (args) => {
        return { contents: SUPPORTED_LIBRARIES[args.path]!(), loader: "js" };
      });
    },
  };
}

/** esbuild's messages, flattened to one agent-readable line each. */
function formatMessages(messages: readonly esbuild.Message[]): string[] {
  return messages.map((message) => {
    const at = message.location;
    // A vfs path with no location is still worth naming; a location without a file is not.
    const where = at?.file ? `${at.file}:${at.line}:${at.column}: ` : "";
    return `${where}${message.text}`;
  });
}

export default class GadgetBundler extends WorkerEntrypoint {
  /**
   * Bundles a Gadget's client entry point from its own files. `files` is a plain object rather
   * than a Map to keep this boundary's contract dumb: keys are the Gadget's file paths exactly as
   * stored (flat, `/`-separated), values their contents.
   *
   * Never throws for input the Gadget's author got wrong -- those come back as `{ok: false}` with
   * per-file messages, because the caller reports them to the agent rather than treating them as
   * an internal failure.
   */
  async bundle(files: Record<string, string>): Promise<BundleResult> {
    if (!(ENTRY in files)) {
      return { ok: false, errors: [`This Gadget has no ${ENTRY}.`] };
    }

    await initialize();

    let result: esbuild.BuildResult<{ write: false; metafile: true }>;
    try {
      result = await esbuild.build({
        entryPoints: [ENTRY],
        bundle: true,
        // ESM with no wrapper, deliberately. An IIFE (even an async one) would hide the Gadget's
        // top-level `await` inside a function, so the dynamic `import()` that browser-mode export
        // awaits would resolve before the Gadget finished rendering -- silently capturing
        // half-loaded content. See browser-export-runtime.ts's waitForClientModule().
        format: "esm",
        platform: "neutral",
        target: "es2022",
        // No minification and no source maps: the agent reads its own stack traces to self-repair,
        // and browsers do not apply source maps to `Error.prototype.stack` (which is what
        // GadgetUI.tsx forwards). Unminified output with esbuild's per-file path banners is what
        // actually keeps a bundled frame locatable.
        minify: false,
        sourcemap: false,
        write: false,
        // Drives the caller's single-file passthrough: a graph of exactly one file means the
        // Gadget imported nothing, so its original source can be served untouched.
        metafile: true,
        plugins: [virtualFsPlugin(files)],
      });
    } catch (error) {
      const messages = (error as esbuild.BuildFailure).errors;
      return {
        ok: false,
        errors: messages?.length
            ? formatMessages(messages)
            : [`Bundling ${ENTRY} failed: ${(error as Error).message}`],
      };
    }

    if (result.errors.length > 0) {
      return { ok: false, errors: formatMessages(result.errors) };
    }

    const output = result.outputFiles[0];
    if (output === undefined) {
      return { ok: false, errors: [`Bundling ${ENTRY} produced no output.`] };
    }

    return { ok: true, code: output.text, inputs: Object.keys(result.metafile.inputs) };
  }
}
