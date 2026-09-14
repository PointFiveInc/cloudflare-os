// Covers the Gadget client bundler end to end: the real harness, bundled by
// build-browser-runtime.mjs, loaded through the real `LOADER` binding, with esbuild-wasm compiling
// and running inside the Dynamic Worker.
//
// Integration rather than unit: the unit config (vitest.config.ts) builds its miniflare options
// inline and has no `worker_loaders`, so `env.LOADER` only exists here, where the pool reads the
// real wrangler.jsonc.
import { env } from "cloudflare:test";
import { GadgetBundleError, bundleGadgetClient } from "../src/gadget-bundle";
import { describe, expect, it } from "vitest";

function bundle(files: Record<string, string>): Promise<string> {
  return bundleGadgetClient(env.LOADER, "gadget-bundle-test", new Map(Object.entries(files)));
}

/** The message of the GadgetBundleError `bundle` rejects with. Fails if it resolves instead. */
async function bundleError(files: Record<string, string>): Promise<string> {
  try {
    await bundle(files);
  } catch (error) {
    expect(error).toBeInstanceOf(GadgetBundleError);
    return (error as GadgetBundleError).message;
  }
  throw new Error("expected bundling to fail");
}

describe("bundleGadgetClient", () => {
  it("bundles a Gadget's own sibling files", async () => {
    let code = await bundle({
      "client.js": `import {greet} from "./helper.js";\ndocument.body.textContent = greet("world");`,
      "helper.js": `export function greet(name) { return "hello " + name; }`,
    });
    // The dependency's body is inlined, and the import of it is gone.
    expect(code).toContain(`"hello " + name`);
    expect(code).not.toContain(`from "./helper.js"`);
    // esbuild's per-file banners are what keep a bundled frame locatable without source maps.
    expect(code).toContain("helper.js");
  });

  it("returns a client.js with no imports verbatim", async () => {
    // Not merely equivalent: byte-identical, so bundling cannot change what runs or where its
    // stack traces point for the overwhelmingly common single-file Gadget. This one never reaches
    // the bundler at all (see mightImport).
    let source = `// a comment esbuild would drop\ndocument.body.textContent = await gadget.hi();\n`;
    expect(await bundle({"client.js": source})).toBe(source);
  });

  it("returns source verbatim when a build finds no imports after all", async () => {
    // The crude `mightImport` scan sends this to the bundler because of the word in the string,
    // and the single-input metafile check is what still hands back the original bytes.
    let source = `document.body.textContent = "the import/export buttons are over there";\n`;
    expect(await bundle({"client.js": source, "unused.js": `export let x = 1;`})).toBe(source);
  });

  it("still diagnoses a bad import in a Gadget with no other files", async () => {
    // The bypass must not swallow diagnostics: an import is an import even when the tree holds
    // nothing that could satisfy it.
    expect(await bundleError({"client.js": `import {x} from "./missing.js";`}))
        .toContain("No such file in this Gadget");
  });

  it("preserves genuine top-level await from a dependency", async () => {
    // Load-bearing for browser-mode export: browser-export-runtime.ts awaits `import(clientUrl)`,
    // which only waits for the Gadget if its top-level await is really top-level. Any IIFE
    // wrapper (even async) would resolve that import early and capture half-loaded content.
    let code = await bundle({
      "client.js": `import {data} from "./slow.js";\ndocument.body.textContent = data;`,
      "slow.js": `export let data = await Promise.resolve("ready");`,
    });
    expect(code).toMatch(/^\s*(\/\/.*\n)*\s*var .*= await /m);
    expect(code).not.toMatch(/^\(function|^\(\(\)|^\(async/);
  });

  it("resolves subdirectories, extensionless imports and directory indexes", async () => {
    let code = await bundle({
      "client.js": `import {a} from "./lib/a.js";\nimport {b} from "./lib/b";\n` +
          `import {c} from "./lib/c";\ndocument.body.textContent = a + b + c;`,
      "lib/a.js": `export let a = "a";`,
      "lib/b.js": `export let b = "b";`,
      "lib/c/index.js": `export let c = "c";`,
    });
    expect(code).toContain(`"a"`);
    expect(code).toContain(`"b"`);
    expect(code).toContain(`"c"`);
  });

  it("resolves a dependency's own relative import against that dependency's directory", async () => {
    let code = await bundle({
      "client.js": `import {label} from "./lib/render.js";\ndocument.body.textContent = label;`,
      "lib/render.js": `import {format} from "./format.js";\nexport let label = format("x");`,
      "lib/format.js": `export function format(v) { return "[" + v + "]"; }`,
    });
    expect(code).toContain(`"[" + v + "]"`);
  });

  it("supports importing JSON", async () => {
    let code = await bundle({
      "client.js": `import config from "./config.json";\ndocument.body.textContent = config.title;`,
      "config.json": `{"title": "Tracker"}`,
    });
    expect(code).toContain("Tracker");
  });

  it("rejects an import that escapes the Gadget's files", async () => {
    let message = await bundleError({
      "client.js": `import {x} from "../../secrets.js";\nconsole.log(x);`,
    });
    expect(message).toContain("points outside this Gadget's files");
  });

  it("rejects client.js importing server.js, and says what to do instead", async () => {
    let message = await bundleError({
      "client.js": `import {Gadget} from "./server.js";\nconsole.log(Gadget);`,
      "server.js": `export class Gadget {}`,
    });
    expect(message).toContain("server.js cannot be imported by client code");
    expect(message).toContain("gadget` RPC stub");
  });

  it("names the package, and what IS available, in a bare-specifier failure", async () => {
    let message = await bundleError({
      "client.js": `import _ from "lodash";\nconsole.log(_);`,
    });
    expect(message).toContain("`lodash` is not available in Gadget client code");
    // The agent retries off this message, so it has to say what to use instead.
    expect(message).toContain("@gadget/pdf");
  });

  it("resolves the @gadget/pdf vetted library", async () => {
    let code = await bundle({
      "client.js": `import {getDocument} from "@gadget/pdf";\n` +
          `let pdf = await getDocument({data: await gadget.getPdfBytes()}).promise;\n` +
          `document.body.textContent = "pages: " + pdf.numPages;`,
    });
    // The library is inlined, not left as an import for the browser to resolve (it could not:
    // the iframe CSP is `default-src 'none'`).
    expect(code).not.toContain(`from "@gadget/pdf"`);
    expect(code).not.toMatch(/^\s*import\s/m);
    // pdf.js's own worker message handler is in there, which is what makes the main-thread
    // fake-worker path work with no `new Worker`.
    expect(code).toContain("WorkerMessageHandler");
    // Big enough to be the real library, not a stub.
    expect(code.length).toBeGreaterThan(500_000);
    // The exported getDocument is our quiet-by-default wrapper, not pdf.js's own. This is the
    // ESM subtlety the wrapper relies on -- an explicit local export takes precedence over the
    // `export *` beside it -- so a reordering that broke it would otherwise go unnoticed.
    expect(code).toMatch(/verbosity:\s*\w+\.ERRORS/);
  });

  it("does not put a library into a Gadget that does not import it", async () => {
    let code = await bundle({
      "client.js": `import {greet} from "./helper.js";\ndocument.body.textContent = greet("x");`,
      "helper.js": `export function greet(n) { return "hi " + n; }`,
    });
    expect(code).not.toContain("WorkerMessageHandler");
    expect(code.length).toBeLessThan(5_000);
  });

  it("names the file a missing import pointed at, and what it tried", async () => {
    let message = await bundleError({
      "client.js": `import {x} from "./nope.js";\nconsole.log(x);`,
    });
    expect(message).toContain("No such file in this Gadget");
    expect(message).toContain("nope.js");
    expect(message).toContain("imported by client.js");
  });

  it("rejects file types the client cannot load", async () => {
    let message = await bundleError({
      "client.js": `import "./styles.css";`,
      "styles.css": `body { color: red }`,
    });
    expect(message).toContain("styles.css cannot be imported");
  });

  it("reports a syntax error against the dependency that has it", async () => {
    let message = await bundleError({
      "client.js": `import {x} from "./broken.js";\nconsole.log(x);`,
      "broken.js": `export let x = (((;`,
    });
    expect(message).toContain("broken.js");
  });

  it("fails cleanly for a Gadget with no client.js", async () => {
    expect(await bundleError({"server.js": `export class Gadget {}`}))
        .toContain("has no client.js");
  });
});
