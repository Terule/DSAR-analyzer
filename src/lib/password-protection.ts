import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Password-protection detection by file *signature*, not extension, reading only
 * the few bytes it needs (never the whole file). A file that needs a password to
 * open is treated as confidential and is never delivered, in any case type.
 *
 * Covered: OOXML/legacy Office (OLE compound files), ZIP (and so docx/xlsx/pptx
 * with encrypted entries), RAR 4/5 and 7z. PDFs are decided by the parser (see
 * `isPasswordProtectionError`), because a PDF can carry an owner password and
 * still open without one.
 */

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_EMPTY_MAGIC = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const RAR4_MAGIC = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
const RAR5_MAGIC = Buffer.from([
  0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00,
]);
const SEVENZ_MAGIC = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);

export function isPasswordProtectionError(error: unknown): boolean {
  const message = String(
    error instanceof Error ? error.message : error,
  ).toLowerCase();
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  return (
    name.includes("password") ||
    /(password|passphrase|encrypted|encryption|decrypt|protected)/.test(message)
  );
}

function readAt(fd: number, position: number, length: number): Buffer | null {
  if (length <= 0 || position < 0) return null;
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, position);
  return read === 0 ? null : buffer.subarray(0, read);
}

// ---------------------------------------------------------------------------
// OLE compound files (Office 97-2003 and the wrapper of every encrypted
// OOXML file). Only the directory and a stream's first bytes are read.
// ---------------------------------------------------------------------------

interface OleEntry {
  name: string;
  type: number;
  startSector: number;
  size: number;
}

const ENDOFCHAIN = 0xfffffffe;
const MAX_CHAIN = 1 << 20;

interface OleDirectory {
  entries: OleEntry[];
  /** First `length` bytes of a regular stream, or null (mini streams). */
  read: (entry: OleEntry, length: number) => Buffer | null;
}

function readOleDirectory(fd: number, header: Buffer): OleDirectory | null {
  const sectorShift = header.readUInt16LE(30);
  if (sectorShift !== 9 && sectorShift !== 12) return null;
  const sectorSize = 1 << sectorShift;
  const sectorOffset = (sector: number) => (sector + 1) * sectorSize;

  // FAT: the first 109 sector ids sit in the header, the rest in a DIFAT chain.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const id = header.readUInt32LE(76 + i * 4);
    if (id < 0xfffffffa) fatSectors.push(id);
  }
  let difat = header.readUInt32LE(68);
  for (let hops = 0; difat < 0xfffffffa && hops < 4096; hops++) {
    const sector = readAt(fd, sectorOffset(difat), sectorSize);
    if (!sector || sector.length < sectorSize) break;
    for (let i = 0; i < sectorSize / 4 - 1; i++) {
      const id = sector.readUInt32LE(i * 4);
      if (id < 0xfffffffa) fatSectors.push(id);
    }
    difat = sector.readUInt32LE(sectorSize - 4);
  }

  const fatCache = new Map<number, Buffer>();
  const nextSector = (sector: number): number => {
    const perFat = sectorSize / 4;
    const fatIndex = Math.floor(sector / perFat);
    const fatSector = fatSectors[fatIndex];
    if (fatSector === undefined) return ENDOFCHAIN;
    let table = fatCache.get(fatSector);
    if (!table) {
      const read = readAt(fd, sectorOffset(fatSector), sectorSize);
      if (!read || read.length < sectorSize) return ENDOFCHAIN;
      table = read;
      fatCache.set(fatSector, table);
    }
    return table.readUInt32LE((sector % perFat) * 4);
  };

  const entries: OleEntry[] = [];
  let sector = header.readUInt32LE(48);
  for (let hops = 0; sector < 0xfffffffa && hops < MAX_CHAIN; hops++) {
    const data = readAt(fd, sectorOffset(sector), sectorSize);
    if (!data || data.length < sectorSize) break;
    for (let at = 0; at + 128 <= data.length; at += 128) {
      const nameLength = data.readUInt16LE(at + 64);
      const type = data.readUInt8(at + 66);
      if (type === 0 || nameLength < 2 || nameLength > 64) continue;
      entries.push({
        name: data.toString("utf16le", at, at + nameLength - 2),
        type,
        startSector: data.readUInt32LE(at + 116),
        size: Number(data.readBigUInt64LE(at + 120)),
      });
    }
    sector = nextSector(sector);
    // A directory this long means a damaged file; stop reading.
    if (entries.length > 100_000) break;
  }

  return {
    entries,
    // Streams under 4096 bytes live in the mini stream; real Word/Excel
    // bodies never do, so those are reported as unreadable.
    read: (entry, length) =>
      entry.size < 4096
        ? null
        : readAt(fd, sectorOffset(entry.startSector), length),
  };
}

function oleLooksEncrypted(fd: number, header: Buffer): boolean {
  const directory = readOleDirectory(fd, header);
  if (!directory) return false;
  const { entries, read } = directory;
  const byName = (name: string) =>
    entries.find((entry) => entry.type === 2 && entry.name === name);

  // Every encrypted OOXML file (docx/xlsx/pptx) is wrapped in a compound file
  // holding these two streams.
  if (byName("EncryptedPackage") || byName("EncryptionInfo")) return true;

  // Word 97-2003: FIB flags word at 0x0A, bit 0x0100 = fEncrypted.
  const word = byName("WordDocument");
  if (word) {
    const fib = read(word, 12);
    if (fib && fib.length >= 12 && fib.readUInt16LE(0x0a) & 0x0100) return true;
  }

  // Excel 97-2003: the BOF record is followed directly by FILEPASS (0x002F).
  const book = byName("Workbook") ?? byName("Book");
  if (book) {
    const head = read(book, 32);
    if (head && head.length >= 8 && head.readUInt16LE(0) === 0x0809) {
      const bofLength = head.readUInt16LE(2);
      const next = 4 + bofLength;
      if (head.length >= next + 2 && head.readUInt16LE(next) === 0x002f) {
        return true;
      }
    }
  }

  // PowerPoint 97-2003: an encrypted deck's "Current User" stream carries the
  // header token 0xF3D1C4DF instead of 0xE391C05F.
  const current = byName("Current User");
  if (current) {
    const head = read(current, 8);
    if (head && head.length >= 8 && head.readUInt32LE(4) === 0xf3d1c4df) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// ZIP (also docx/xlsx/pptx): bit 0 of any entry's general-purpose flags.
// ---------------------------------------------------------------------------

function zipHasEncryptedEntry(fd: number, size: number): boolean {
  const tailLength = Math.min(size, 65_557);
  const tail = readAt(fd, size - tailLength, tailLength);
  if (!tail || tail.length < 22) return false;
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return false;
  let entries = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locator = readAt(fd, size - tailLength + eocd - 20, 20);
    if (!locator || locator.readUInt32LE(0) !== 0x07064b50) return false;
    const record = readAt(fd, Number(locator.readBigUInt64LE(8)), 56);
    if (!record || record.readUInt32LE(0) !== 0x06064b50) return false;
    entries = Number(record.readBigUInt64LE(32));
    cdSize = Number(record.readBigUInt64LE(40));
    cdOffset = Number(record.readBigUInt64LE(48));
  }
  if (cdSize > 256 * 1024 * 1024 || cdOffset + cdSize > size) return false;
  const directory = readAt(fd, cdOffset, cdSize);
  if (!directory) return false;
  let position = 0;
  for (let i = 0; i < entries; i++) {
    if (
      position + 46 > directory.length ||
      directory.readUInt32LE(position) !== 0x02014b50
    ) {
      return false;
    }
    if (directory.readUInt16LE(position + 8) & 1) return true;
    position +=
      46 +
      directory.readUInt16LE(position + 28) +
      directory.readUInt16LE(position + 30) +
      directory.readUInt16LE(position + 32);
  }
  return false;
}

// ---------------------------------------------------------------------------
// RAR 4 / RAR 5
// ---------------------------------------------------------------------------

const MAX_ARCHIVE_BLOCKS = 5_000;

function rar4Encrypted(fd: number, size: number): boolean {
  let position = RAR4_MAGIC.length;
  for (
    let blocks = 0;
    blocks < MAX_ARCHIVE_BLOCKS && position < size;
    blocks++
  ) {
    const head = readAt(fd, position, 11);
    if (!head || head.length < 7) return false;
    const type = head.readUInt8(2);
    const flags = head.readUInt16LE(3);
    const headSize = head.readUInt16LE(5);
    if (headSize < 7) return false;
    // Main header (0x73): 0x0080 = the headers themselves are encrypted.
    if (type === 0x73 && flags & 0x0080) return true;
    // File header (0x74): 0x0004 = this file is password protected.
    if (type === 0x74 && flags & 0x0004) return true;
    let add = 0;
    if (flags & 0x8000 || type === 0x74) {
      if (head.length < 11) return false;
      add = head.readUInt32LE(7);
    }
    position += headSize + add;
  }
  return false;
}

function readVint(
  buffer: Buffer,
  at: number,
): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  for (let i = at; i < buffer.length && shift < 49; i++) {
    const byte = buffer[i];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: i + 1 };
    shift += 7;
  }
  return null;
}

function rar5Encrypted(fd: number, size: number): boolean {
  let position = RAR5_MAGIC.length;
  for (
    let blocks = 0;
    blocks < MAX_ARCHIVE_BLOCKS && position < size;
    blocks++
  ) {
    const prefix = readAt(fd, position, 4 + 10);
    if (!prefix || prefix.length < 6) return false;
    const headerSize = readVint(prefix, 4);
    if (!headerSize || headerSize.value <= 0 || headerSize.value > 1 << 20) {
      return false;
    }
    const headerStart = position + headerSize.next;
    const header = readAt(fd, headerStart, headerSize.value);
    if (!header || header.length < headerSize.value) return false;
    const type = readVint(header, 0);
    if (!type) return false;
    const flags = readVint(header, type.next);
    if (!flags) return false;
    // Type 4: archive encryption header; everything after it is encrypted.
    if (type.value === 4) return true;
    let cursor = flags.next;
    let extraSize = 0;
    let dataSize = 0;
    if (flags.value & 0x1) {
      const extra = readVint(header, cursor);
      if (!extra) return false;
      extraSize = extra.value;
      cursor = extra.next;
    }
    if (flags.value & 0x2) {
      const data = readVint(header, cursor);
      if (!data) return false;
      dataSize = data.value;
      cursor = data.next;
    }
    // File (2) and service (3) headers keep their encryption record in the
    // extra area at the end of the header: record type 0x01.
    if ((type.value === 2 || type.value === 3) && extraSize > 0) {
      let at = header.length - extraSize;
      while (at > 0 && at < header.length) {
        const recordSize = readVint(header, at);
        if (!recordSize || recordSize.value === 0) break;
        const recordType = readVint(header, recordSize.next);
        if (!recordType) break;
        if (recordType.value === 0x01) return true;
        at = recordSize.next + recordSize.value;
      }
    }
    position = headerStart + headerSize.value + dataSize;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 7z: the AES coder id (06 F1 07 01) appears in the header's coder list. If
// the header itself is LZMA-compressed we cannot see the coders of the files,
// only whether the *header* is encrypted ("encrypt file names").
// ---------------------------------------------------------------------------

const SEVENZ_AES = Buffer.from([0x06, 0xf1, 0x07, 0x01]);

function sevenZipEncrypted(fd: number, size: number): boolean {
  const start = readAt(fd, 0, 32);
  if (!start || start.length < 32) return false;
  const nextOffset = Number(start.readBigUInt64LE(12));
  const nextSize = Number(start.readBigUInt64LE(20));
  if (nextSize <= 0 || nextSize > 64 * 1024 * 1024) return false;
  if (32 + nextOffset + nextSize > size) return false;
  const next = readAt(fd, 32 + nextOffset, nextSize);
  return next?.includes(SEVENZ_AES) ?? false;
}

// ---------------------------------------------------------------------------

/**
 * True when the file at `filePath` needs a password to be opened. Never throws:
 * an unreadable or unrecognised file is reported as not protected so the normal
 * conversion decides what to do with it.
 */
export function isPasswordProtectedFile(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    const magic = readAt(fd, 0, 512);
    if (!magic || magic.length < 8) return false;

    if (magic.subarray(0, 8).equals(OLE_MAGIC)) {
      if (magic.length < 512) return false;
      return oleLooksEncrypted(fd, magic);
    }
    if (
      magic.subarray(0, 4).equals(ZIP_MAGIC) ||
      magic.subarray(0, 4).equals(ZIP_EMPTY_MAGIC)
    ) {
      return zipHasEncryptedEntry(fd, size);
    }
    if (magic.subarray(0, 8).equals(RAR5_MAGIC)) return rar5Encrypted(fd, size);
    if (magic.subarray(0, 7).equals(RAR4_MAGIC)) return rar4Encrypted(fd, size);
    if (magic.subarray(0, 6).equals(SEVENZ_MAGIC)) {
      return sevenZipEncrypted(fd, size);
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Same check for content that only exists in memory (an email attachment). */
export function isPasswordProtectedBuffer(content: Uint8Array): boolean {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aida-pwd-"));
  const file = path.join(directory, "attachment");
  try {
    fs.writeFileSync(file, content);
    return isPasswordProtectedFile(file);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
