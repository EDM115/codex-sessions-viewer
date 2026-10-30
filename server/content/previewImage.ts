/** Inspect bounded raster headers, unsupported/animated images keep the text-only preview */
export function previewImageDimensions(
  bytes: Buffer,
  mime: string,
): { width: number; height: number } | null {
  let width = 0;
  let height = 0;
  if (mime === "image/png" && bytes.length >= 24) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
    if (bytes.includes(Buffer.from("acTL"))) {
      return null;
    }
  } else if (mime === "image/gif" && bytes.length >= 13) {
    width = bytes.readUInt16LE(6);
    height = bytes.readUInt16LE(8);
    let offset = 13 + (bytes[10]! & 128 ? 3 * 2 ** ((bytes[10]! & 7) + 1) : 0);
    let frames = 0;
    while (offset < bytes.length) {
      const marker = bytes[offset++]!;
      if (marker === 0x3b) {
        break;
      }
      if (marker === 0x21) {
        offset += 1;
      } else if (marker === 0x2c) {
        if (++frames > 1 || offset + 9 > bytes.length) {
          return null;
        }
        const flags = bytes[offset + 8]!;
        offset += 9 + (flags & 128 ? 3 * 2 ** ((flags & 7) + 1) : 0) + 1;
      } else {
        return null;
      }
      while (offset < bytes.length) {
        const size = bytes[offset++]!;
        if (size === 0) {
          break;
        }
        offset += size;
      }
    }
  } else if (mime === "image/webp" && bytes.length >= 30) {
    const type = bytes.toString("ascii", 12, 16);
    if (type === "VP8X") {
      if (bytes[20]! & 2) {
        return null;
      }
      width = bytes.readUIntLE(24, 3) + 1;
      height = bytes.readUIntLE(27, 3) + 1;
    } else if (type === "VP8L" && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (type === "VP8 " && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    }
  } else if (mime === "image/jpeg") {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) {
        break;
      }
      while (bytes[offset] === 0xff) {
        offset += 1;
      }
      const marker = bytes[offset++]!;
      if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) {
        break;
      }
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) {
        break;
      }
      if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 7) {
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += size;
    }
  }
  return width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16_000_000
    ? { width, height }
    : null;
}
