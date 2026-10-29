import sharp from "sharp";
import type { GuidePdfWebpDecoder } from "../frontend/domain/guide-pdf";

const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_IMAGE_DIMENSION = 100_000;

/** Decode the first WebP frame into a bounded sRGB RGBA buffer for the portable PDF renderer. */
export const decodeGuideWebp: GuidePdfWebpDecoder = async (bytes) => {
  if (
    bytes.byteLength < 12 ||
    bytes[0] !== 0x52 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x46 ||
    bytes[8] !== 0x57 ||
    bytes[9] !== 0x45 ||
    bytes[10] !== 0x42 ||
    bytes[11] !== 0x50
  ) {
    throw new Error("The WebP guide image header is invalid.");
  }

  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const options = { animated: false, failOn: "warning" as const, limitInputPixels: MAX_IMAGE_PIXELS };
  let width: number;
  let height: number;
  try {
    const metadata = await sharp(input, options).metadata();
    width = metadata.width ?? 0;
    height = metadata.height ?? 0;
  } catch (error) {
    throw new Error("The WebP guide image could not be decoded.", { cause: error });
  }

  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    throw new Error("The WebP guide image dimensions are invalid or exceed safe limits.");
  }

  try {
    const { data, info } = await sharp(input, options)
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const expectedBytes = width * height * 4;
    if (
      info.width !== width ||
      info.height !== height ||
      info.channels !== 4 ||
      data.byteLength !== expectedBytes ||
      data.byteLength > MAX_IMAGE_PIXELS * 4
    ) {
      throw new Error("The WebP decoder returned an unexpected image buffer.");
    }
    return { width, height, pixels: data };
  } catch (error) {
    throw new Error("The WebP guide image could not be decoded.", { cause: error });
  }
};
