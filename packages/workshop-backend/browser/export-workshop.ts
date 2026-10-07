/**
 * Defines `workshop` on the browser export page as the Workshop's gadget frame does, so a gadget's
 * UI code runs unchanged when it is exported. An export renders the gadget at its root, so the path
 * starts at "/", a navigation moves it only in memory, and there is no app page to link to.
 */
export function installExportWorkshop(target: object): void {
  let path = "/";
  Object.defineProperty(target, "workshop", {
    configurable: true,
    writable: true,
    value: Object.freeze({
      ready: Promise.resolve(),
      location: Object.freeze({ get path() { return path; } }),
      appUrl: null,
      async navigate(next: unknown) {
        if (typeof next !== "string" || !next.startsWith("/")) {
          throw new TypeError('workshop.navigate(): the path must start with "/".');
        }
        path = next;
      },
      async setTitle(_text: unknown) {},
    }),
  });
}
