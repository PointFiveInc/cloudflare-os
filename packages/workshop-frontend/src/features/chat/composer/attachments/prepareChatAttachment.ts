import { formatAttachmentSize } from "../../attachmentFormatting";

export const MAX_CHAT_ATTACHMENT_BYTES = 1024 * 1024;
export const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_CHAT_ATTACHMENT_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024;
const CHAT_ATTACHMENT_IMAGE_MAX_EDGE = 1568;

const canvasToBlob = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Failed to encode image.")),
      type,
      quality,
    );
  });

export const prepareChatAttachment = async (
  file: File,
): Promise<{ blob: Blob; mimeType: string }> => {
  if (!file.type.startsWith("image/")) {
    if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachments must be ${formatAttachmentSize(MAX_CHAT_ATTACHMENT_BYTES)} or smaller.`,
      );
    }
    return { blob: file, mimeType: file.type || "application/octet-stream" };
  }
  if (file.size > MAX_CHAT_ATTACHMENT_SOURCE_IMAGE_BYTES) {
    throw new Error(
      `Images must be ${formatAttachmentSize(MAX_CHAT_ATTACHMENT_SOURCE_IMAGE_BYTES)} or smaller before resizing.`,
    );
  }
  // createImageBitmap() cannot decode a vector source, so name the problem here rather than let
  // the decode below fail with the browser's opaque "the source image could not be decoded".
  if (file.type === "image/svg+xml") {
    throw new Error("SVG images aren't supported. Convert it to PNG or JPEG first.");
  }

  const bitmap = await createImageBitmap(file);
  try {
    const supportedOriginalType = file.type === "image/jpeg" || file.type === "image/png" ||
      file.type === "image/webp";
    if (supportedOriginalType && file.size <= MAX_CHAT_ATTACHMENT_BYTES &&
        Math.max(bitmap.width, bitmap.height) <= CHAT_ATTACHMENT_IMAGE_MAX_EDGE) {
      return { blob: file, mimeType: file.type };
    }

    const scale = Math.min(1, CHAT_ATTACHMENT_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Failed to get 2D canvas context.");
    context.drawImage(bitmap, 0, 0, width, height);

    // Retaining PNG/WebP avoids losing transparency and keeps the MIME type consistent with the
    // original filename extension.
    const outputMimeType = supportedOriginalType ? file.type : "image/jpeg";
    const quality = outputMimeType === "image/png" ? undefined : 0.85;
    // PNG is lossless, so a photograph stays above the cap however far it is scaled. Fall back
    // through the other accepted encodings rather than reject it; WebP precedes JPEG to keep a
    // PNG's alpha, and a browser lacking an encoder returns PNG, so the type is re-checked.
    for (const next of [{type: outputMimeType, q: quality}, {type: "image/webp", q: 0.85},
                        {type: "image/jpeg", q: 0.85}, {type: "image/webp", q: 0.6}]) {
      const blob = await canvasToBlob(canvas, next.type, next.q);
      if (blob.type === next.type && blob.size <= MAX_CHAT_ATTACHMENT_BYTES) {
        return { blob, mimeType: next.type };
      }
    }
    throw new Error(
      `Attachments must be ${formatAttachmentSize(MAX_CHAT_ATTACHMENT_BYTES)} or smaller.`,
    );
  } finally {
    bitmap.close();
  }
};
