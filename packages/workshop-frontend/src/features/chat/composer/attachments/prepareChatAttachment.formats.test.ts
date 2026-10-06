// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CHAT_ATTACHMENT_BYTES,
  prepareChatAttachment,
} from "./prepareChatAttachment";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const MB = 1024 * 1024;

const pngPhoto = () =>
  new File([new Uint8Array(3 * MB)], "photo.png", { type: "image/png" });

const stubPhotoDecode = () =>
  vi.stubGlobal("createImageBitmap", async () => ({ width: 4032, height: 3024, close: () => {} }));

// A browser asked for a type it has no encoder for returns PNG instead, as real ones do.
const stubCanvasEncoders = (encodedBytes: Record<string, number>) => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    { drawImage: () => {} } as never,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback, type = "image/png") => {
      const encodedType = type in encodedBytes ? type : "image/png";
      callback({ type: encodedType, size: encodedBytes[encodedType] } as Blob);
    },
  );
};

describe("prepareChatAttachment image formats", () => {
  it("re-encodes a PNG photo that stays over the limit as WebP", async () => {
    stubPhotoDecode();
    stubCanvasEncoders({ "image/png": 3.5 * MB, "image/webp": 34 * 1024, "image/jpeg": 123 * 1024 });

    const { blob, mimeType } = await prepareChatAttachment(pngPhoto());

    expect(mimeType).toBe("image/webp");
    expect(blob.type).toBe("image/webp");
    expect(blob.size).toBeLessThanOrEqual(MAX_CHAT_ATTACHMENT_BYTES);
  });

  it("re-encodes it as JPEG where the browser has no WebP encoder", async () => {
    stubPhotoDecode();
    stubCanvasEncoders({ "image/png": 3.5 * MB, "image/jpeg": 123 * 1024 });

    const { blob, mimeType } = await prepareChatAttachment(pngPhoto());

    expect(mimeType).toBe("image/jpeg");
    expect(blob.type).toBe("image/jpeg");
    expect(blob.size).toBeLessThanOrEqual(MAX_CHAT_ATTACHMENT_BYTES);
  });

  it("refuses an SVG with a message that says what to do", async () => {
    vi.stubGlobal("createImageBitmap", async () => {
      throw new DOMException("The source image could not be decoded.", "InvalidStateError");
    });
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], "diagram.svg", {
      type: "image/svg+xml",
    });

    await expect(prepareChatAttachment(svg)).rejects.toThrow(
      "SVG images aren't supported. Convert it to PNG or JPEG first.",
    );
  });
});
