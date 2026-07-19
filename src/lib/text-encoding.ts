/**
 * Repairs the common case where UTF-8 bytes were decoded as Windows-1252
 * (for example, `â€œ` instead of `“`). It is deliberately conservative: text
 * is changed only when a valid UTF-8 round-trip reduces mojibake markers.
 */
const CP1252_BYTES: Record<string, number> = {
  "€": 0x80,
  "‚": 0x82,
  ƒ: 0x83,
  "„": 0x84,
  "…": 0x85,
  "†": 0x86,
  "‡": 0x87,
  ˆ: 0x88,
  "‰": 0x89,
  Š: 0x8a,
  "‹": 0x8b,
  Œ: 0x8c,
  Ž: 0x8e,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "•": 0x95,
  "–": 0x96,
  "—": 0x97,
  "˜": 0x98,
  "™": 0x99,
  š: 0x9a,
  "›": 0x9b,
  œ: 0x9c,
  ž: 0x9e,
  Ÿ: 0x9f,
};

function artifactScore(value: string): number {
  return (value.match(/(?:â.|Ã.|Â.|�)/g) || []).length;
}

function cp1252Bytes(value: string): Uint8Array | null {
  const bytes: number[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) return null;
    if (codePoint <= 0xff) bytes.push(codePoint);
    else if (CP1252_BYTES[character] !== undefined)
      bytes.push(CP1252_BYTES[character]);
    else return null;
  }
  return Uint8Array.from(bytes);
}

export function repairMojibake(value: string): string {
  if (artifactScore(value) === 0) return value;
  const bytes = cp1252Bytes(value);
  if (!bytes) return value;

  try {
    const repaired = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return artifactScore(repaired) < artifactScore(value) ? repaired : value;
  } catch {
    // Do not guess when the source cannot be recovered losslessly.
    return value;
  }
}
