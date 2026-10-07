import { describe, expect, it } from "vitest";
import BROWSER_EXPORT_RUNTIME from "../src/generated/browser-export-runtime.txt";
import { installExportWorkshop } from "../browser/export-workshop";

type Workshop = {
  ready: Promise<void>;
  location: { readonly path: string };
  appUrl: string | null;
  navigate(path: unknown): Promise<void>;
  setTitle(text: unknown): Promise<void>;
};

describe("workshop on the browser export page", () => {
  it("is installed by the export page's runtime", () => {
    expect(BROWSER_EXPORT_RUNTIME).toContain('"workshop"');
  });

  it("starts at the gadget's root, with no app page to link to", async () => {
    const page: { workshop?: Workshop } = {};
    installExportWorkshop(page);
    const workshop = page.workshop!;

    await workshop.ready;
    expect(workshop.location.path).toBe("/");
    expect(workshop.appUrl).toBeNull();
    await workshop.setTitle("Draft");
    await workshop.navigate("/a/b");
    expect(workshop.location.path).toBe("/a/b");
    await expect(workshop.navigate("elsewhere")).rejects.toThrow(TypeError);
    expect(workshop.location.path).toBe("/a/b");
  });
});
