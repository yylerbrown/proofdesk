// What kind of picture some bytes are, read from the bytes themselves. A file's name and the
// type a browser claims for it are both chosen by whoever sends it, so neither is trusted.
// Each format below starts with a fixed signature that its specification sets out.

export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export type PictureType = (typeof PICTURE_TYPES)[number];

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const GIF_87 = Buffer.from("GIF87a", "latin1");
const GIF_89 = Buffer.from("GIF89a", "latin1");
const RIFF = Buffer.from("RIFF", "latin1");
const WEBP = Buffer.from("WEBP", "latin1");

/** True when the bytes hold this signature, starting at this position. */
function hasAt(bytes: Buffer, signature: Buffer, at = 0): boolean {
  return bytes.subarray(at, at + signature.length).equals(signature);
}

/** The picture type these bytes are, or null when they are not one of the four allowed. */
export function pictureTypeOf(bytes: Buffer): PictureType | null {
  // PNG: eight fixed bytes.
  if (hasAt(bytes, PNG)) return "image/png";
  // JPEG: a start-of-image marker followed by the start of the next marker.
  if (hasAt(bytes, JPEG)) return "image/jpeg";
  // GIF: "GIF87a" or "GIF89a".
  if (hasAt(bytes, GIF_87) || hasAt(bytes, GIF_89)) return "image/gif";
  // WebP: a RIFF container whose form type, after the four-byte length, is "WEBP".
  if (hasAt(bytes, RIFF) && hasAt(bytes, WEBP, 8)) return "image/webp";
  return null;
}
