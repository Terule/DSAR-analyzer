import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface ArchiveLimits {
  maxDepth: number;
  maxEntries: number;
  maxBytes: number;
  timeoutMs: number;
}

export function archiveLimits(): ArchiveLimits {
  const number = (name: string, fallback: number) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    maxDepth: number("FILES_ZIP_MAX_DEPTH", 3),
    maxEntries: number("FILES_ZIP_MAX_ENTRIES", 50_000),
    maxBytes: number("FILES_ZIP_MAX_GB", 50) * 1024 ** 3,
    timeoutMs: number("FILES_ZIP_TIMEOUT_MS", 10 * 60_000),
  };
}

export type ZipInspection =
  | { kind: "ok"; entries: number; bytes: number }
  | { kind: "encrypted" }
  | { kind: "corrupt" }
  | { kind: "overLimit" };

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const MAX_CENTRAL_DIRECTORY_BYTES = 256 * 1024 * 1024;

function readAt(fd: number, position: number, length: number): Buffer | null {
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, position);
  return read === length ? buffer : null;
}

/**
 * Reads only the zip's central directory (no decompression) to learn whether
 * any entry is encrypted, how many entries there are and their declared total
 * size. Truncated or malformed archives are reported as corrupt.
 */
export function inspectZip(
  zipPath: string,
  limits: ArchiveLimits,
): ZipInspection {
  let fd: number | undefined;
  try {
    fd = fs.openSync(zipPath, "r");
    const size = fs.fstatSync(fd).size;
    if (size < 22) return { kind: "corrupt" };

    const tailLength = Math.min(size, 65_557);
    const tail = readAt(fd, size - tailLength, tailLength);
    if (!tail) return { kind: "corrupt" };
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return { kind: "corrupt" };

    let entries = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);

    if (
      entries === 0xffff ||
      cdSize === 0xffffffff ||
      cdOffset === 0xffffffff
    ) {
      const eocdPosition = size - tailLength + eocd;
      const locator = readAt(fd, eocdPosition - 20, 20);
      if (!locator || locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIG) {
        return { kind: "corrupt" };
      }
      const recordOffset = Number(locator.readBigUInt64LE(8));
      const record = readAt(fd, recordOffset, 56);
      if (!record || record.readUInt32LE(0) !== ZIP64_EOCD_SIG) {
        return { kind: "corrupt" };
      }
      entries = Number(record.readBigUInt64LE(32));
      cdSize = Number(record.readBigUInt64LE(40));
      cdOffset = Number(record.readBigUInt64LE(48));
    }

    if (entries > limits.maxEntries || cdSize > MAX_CENTRAL_DIRECTORY_BYTES) {
      return { kind: "overLimit" };
    }
    if (cdOffset + cdSize > size) return { kind: "corrupt" };
    const directory = readAt(fd, cdOffset, cdSize);
    if (!directory) return { kind: "corrupt" };

    let position = 0;
    let bytes = 0;
    for (let index = 0; index < entries; index++) {
      if (
        position + 46 > directory.length ||
        directory.readUInt32LE(position) !== CENTRAL_SIG
      ) {
        return { kind: "corrupt" };
      }
      if (directory.readUInt16LE(position + 8) & 1) {
        return { kind: "encrypted" };
      }
      let uncompressed = directory.readUInt32LE(position + 24);
      const nameLength = directory.readUInt16LE(position + 28);
      const extraLength = directory.readUInt16LE(position + 30);
      const commentLength = directory.readUInt16LE(position + 32);
      const next = position + 46 + nameLength + extraLength + commentLength;
      if (next > directory.length) return { kind: "corrupt" };

      if (uncompressed === 0xffffffff) {
        // Real size lives in the zip64 extra field (header id 0x0001).
        let extra = position + 46 + nameLength;
        const extraEnd = extra + extraLength;
        while (extra + 4 <= extraEnd) {
          const id = directory.readUInt16LE(extra);
          const length = directory.readUInt16LE(extra + 2);
          if (id === 0x0001 && length >= 8) {
            uncompressed = Number(directory.readBigUInt64LE(extra + 4));
            break;
          }
          extra += 4 + length;
        }
      }
      bytes += uncompressed;
      if (bytes > limits.maxBytes) return { kind: "overLimit" };
      position = next;
    }
    return { kind: "ok", entries, bytes };
  } catch {
    return { kind: "corrupt" };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

type ExtractOutcome = "ok" | "corrupt" | "timeout";

function runUnzip(
  zipPath: string,
  targetDir: string,
  timeoutMs: number,
): Promise<ExtractOutcome> {
  return new Promise((resolve, reject) => {
    // stdin is closed so a missed encrypted entry can never block on a
    // password prompt.
    const child = spawn("unzip", ["-oq", zipPath, "-d", targetDir], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve("timeout");
      // 0 = ok, 1 = warnings (for example a skipped unsafe path).
      if (code === 0 || code === 1) return resolve("ok");
      // Memory (4-8) and disk-full (50) failures are environmental, not a
      // property of the archive; surface them so the job is retried.
      if ((code !== null && code >= 4 && code <= 8) || code === 50) {
        return reject(new Error(`unzip failed for ${zipPath} (exit ${code}).`));
      }
      resolve("corrupt");
    });
  });
}

function findZips(directory: string, found: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) findZips(full, found);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".zip")) {
      found.push(full);
    }
  }
  return found;
}

/** Archives may contain symlinks; never let one escape into the pipeline. */
function removeSymlinks(directory: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fs.rmSync(full, { force: true });
    else if (entry.isDirectory()) removeSymlinks(full);
  }
}

function extractionDir(zipPath: string): string {
  const base = zipPath.replace(/\.zip$/i, "");
  let candidate = `${base}_unzipped`;
  for (let n = 2; fs.existsSync(candidate); n++) {
    candidate = `${base}_unzipped-${n}`;
  }
  return candidate;
}

export interface ArchiveExpansion {
  /** Archives that were extracted (and removed). */
  expanded: number;
  /** Password-protected; left untouched in place and excluded from delivery. */
  confidential: string[];
  /** Unreadable archives; already deleted from staging. */
  corrupted: string[];
  /**
   * Original archives that must be delivered as-is (over the safety limits;
   * in client mode also password-protected and corrupt ones). The caller
   * copies them to Unconverted/ and removes the source.
   */
  keep: string[];
}

/**
 * Expands every .zip below `inputDir` in place so the extracted files join the
 * normal Files manifest and go through filtering, dedup and rendering.
 */
export async function expandArchives(
  inputDir: string,
  options: { clientMode?: boolean; limits?: ArchiveLimits } = {},
): Promise<ArchiveExpansion> {
  const limits = options.limits ?? archiveLimits();
  const result: ArchiveExpansion = {
    expanded: 0,
    confidential: [],
    corrupted: [],
    keep: [],
  };
  const settled = new Set<string>();
  const keepOriginal = (zipPath: string) => {
    settled.add(zipPath);
    result.keep.push(zipPath);
  };

  for (let depth = 1; ; depth++) {
    const zips = findZips(inputDir)
      .filter((zipPath) => !settled.has(zipPath))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (zips.length === 0) break;

    for (const zipPath of zips) {
      // Archives nested deeper than the limit are delivered untouched.
      if (depth > limits.maxDepth) {
        keepOriginal(zipPath);
        continue;
      }
      const inspection = inspectZip(zipPath, limits);
      if (inspection.kind === "overLimit") {
        keepOriginal(zipPath);
      } else if (inspection.kind === "encrypted") {
        if (options.clientMode) keepOriginal(zipPath);
        else {
          settled.add(zipPath);
          result.confidential.push(zipPath);
        }
      } else if (inspection.kind === "corrupt") {
        if (options.clientMode) keepOriginal(zipPath);
        else {
          fs.rmSync(zipPath, { force: true });
          result.corrupted.push(zipPath);
        }
      } else {
        const target = extractionDir(zipPath);
        fs.mkdirSync(target, { recursive: true });
        const outcome = await runUnzip(zipPath, target, limits.timeoutMs);
        if (outcome === "ok") {
          removeSymlinks(target);
          fs.rmSync(zipPath, { force: true });
          result.expanded++;
        } else {
          fs.rmSync(target, { recursive: true, force: true });
          if (outcome === "timeout" || options.clientMode) {
            keepOriginal(zipPath);
          } else {
            fs.rmSync(zipPath, { force: true });
            result.corrupted.push(zipPath);
          }
        }
      }
    }
  }
  return result;
}
