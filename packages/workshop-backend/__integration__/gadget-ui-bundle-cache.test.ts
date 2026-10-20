// Integration rather than unit for the same reason as gadget-bundle.test.ts: only this config has
// the `LOADER` binding the bundler runs in.
import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

describe("getGadgetUiBundle's cache", () => {
  it("keeps a built bundle, but no copy of a client.js served verbatim", async () => {
    const stub = exports.OverseerDurableObject.getByName("gadget-ui-bundle-cache-test");
    await runInDurableObject(stub, async (instance) => {
      const impl = (instance as unknown as { impl: any }).impl;
      const gadgetOf = async (bindingName: string, files: Record<string, string>) => {
        const commitId = await impl.gitStore.writeFilesAsCommit(new Map(Object.entries(files)), {
          parents: [],
          author: { name: "Test", email: "test@example.com" },
          message: bindingName,
          timestamp: new Date(0),
        });
        return impl.createGadget("Gadget", bindingName, undefined, undefined, commitId);
      };
      const single = await gadgetOf("SINGLE", {
        "client.js": `document.body.textContent = await gadget.hi();\n`,
        "server.js": `export class Gadget {}`,
      });
      const bundled = await gadgetOf("BUNDLED", {
        "client.js": `import {greet} from "./helper.js";\ndocument.body.textContent = greet("x");`,
        "helper.js": `export function greet(name) { return "hello " + name; }`,
        "server.js": `export class Gadget {}`,
      });

      const info = vi.spyOn(impl.logger, "info");
      for (const gadget of [single, bundled, single, bundled]) {
        await impl.getGadgetUiBundle(gadget.id);
      }
      expect(info.mock.calls.map(([, fields]: any) => fields?.event)).toEqual([
        "gadget.ui.bundle.passthrough",
        "gadget.ui.bundle.built",
        "gadget.ui.bundle.passthrough",
        "gadget.ui.bundle.cached",
      ]);
    });
  });
});
