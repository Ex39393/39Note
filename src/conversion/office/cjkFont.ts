const CMAP_TAG = 0x636d6170;
const CJK_RADICALS_START = 0x2e80;
const KANGXI_RADICALS_END = 0x2fd5;

/**
 * Noto Sans SC intentionally maps Unicode radical symbols and their unified
 * ideographs to the same glyph. Reamkit 1.29 builds `/ToUnicode` by scanning
 * code points and otherwise chooses the earlier radical code point (for
 * example `文` becomes `⽂`). The PDF font subset does not carry `cmap`, so a
 * conversion-scoped clone can hide those compatibility aliases from Reamkit's
 * mapper without changing glyph outlines or the bundled source font.
 */
export function preferUnifiedCjkUnicodeMappings(font: Uint8Array): Uint8Array {
  const bytes = font.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tableCount = readU16(view, 4);
  let cmapOffset = -1;
  let cmapLength = 0;
  for (let index = 0; index < tableCount; index += 1) {
    const recordOffset = 12 + index * 16;
    assertRange(view, recordOffset, 16);
    if (view.getUint32(recordOffset) !== CMAP_TAG) continue;
    cmapOffset = view.getUint32(recordOffset + 8);
    cmapLength = view.getUint32(recordOffset + 12);
    break;
  }
  if (cmapOffset < 0) throw new Error('The bundled CJK font has no cmap table.');
  assertRange(view, cmapOffset, cmapLength);

  const subtableCount = readU16(view, cmapOffset + 2);
  const visited = new Set<number>();
  let hiddenAliases = 0;
  for (let index = 0; index < subtableCount; index += 1) {
    const recordOffset = cmapOffset + 4 + index * 8;
    assertRange(view, recordOffset, 8);
    const subtableOffset = cmapOffset + view.getUint32(recordOffset + 4);
    if (visited.has(subtableOffset)) continue;
    visited.add(subtableOffset);
    if (readU16(view, subtableOffset) !== 12) continue;
    const length = readU32(view, subtableOffset + 4);
    assertRange(view, subtableOffset, length);
    const groupCount = readU32(view, subtableOffset + 12);
    assertRange(view, subtableOffset + 16, groupCount * 12);
    for (let group = 0; group < groupCount; group += 1) {
      const groupOffset = subtableOffset + 16 + group * 12;
      const start = view.getUint32(groupOffset);
      const end = view.getUint32(groupOffset + 4);
      if (start < CJK_RADICALS_START || end > KANGXI_RADICALS_END) continue;
      // An empty range (start > end) remains ordered and makes the parser
      // report no glyph for the compatibility alias.
      view.setUint32(groupOffset, end + 1);
      hiddenAliases += end - start + 1;
    }
  }
  if (hiddenAliases === 0) {
    throw new Error('The bundled CJK font compatibility map was not recognized.');
  }
  return bytes;
}

function readU16(view: DataView, offset: number): number {
  assertRange(view, offset, 2);
  return view.getUint16(offset);
}

function readU32(view: DataView, offset: number): number {
  assertRange(view, offset, 4);
  return view.getUint32(offset);
}

function assertRange(view: DataView, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > view.byteLength
  ) {
    throw new Error('The bundled CJK font is malformed.');
  }
}
