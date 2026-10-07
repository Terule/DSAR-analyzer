import { spawn } from "node:child_process";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

export type MentionScan = {
  status: "mentioned" | "not-mentioned" | "unsupported";
  reason?: string;
};

const DEFAULT_THRESHOLD_MB = 20;
const SCAN_TIMEOUT_MS = 120_000;

/** Spreadsheets this big are screened by streaming their text before converting. */
export function prescreenThresholdMb(): number {
  const configured = Number(process.env.XLSX_PRESCREEN_MB);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_THRESHOLD_MB;
}

export function shouldPrescreenSpreadsheet(
  extension: string,
  sizeBytes: number,
  thresholdMb: number,
): boolean {
  return (
    (extension === ".xlsx" || extension === ".xlsm") &&
    sizeBytes >= thresholdMb * 1024 * 1024
  );
}

/**
 * The words of each search criterion. The conversion keeps a spreadsheet only if
 * one cell contains a whole criterion (a name, an alias or an email), so a
 * workbook can only match if every word of some criterion occurs in it.
 */
export function criteriaTokenSets(criteria: string[]): string[][] {
  const sets: string[][] = [];
  for (const criterion of criteria) {
    const tokens = criterion
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token.length > 0);
    if (tokens.length > 0) sets.push([...new Set(tokens)]);
  }
  return sets;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(amp|lt|gt|quot|apos);|&#(\d+);|&#x([0-9a-f]+);/gi,
    (_match, named, decimal, hex) => {
      if (named) return ENTITIES[named.toLowerCase()] ?? "";
      const code = decimal ? Number(decimal) : Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    },
  );
}

/**
 * Reads the workbook's text in pieces and reports whether some criterion has
 * all of its words somewhere in it. Only the last few characters are carried
 * from one piece to the next, so memory stays flat however big the file is.
 * Tags are removed (names can be split across formatting runs) and entities
 * decoded.
 */
export async function scanTextChunks(
  chunks: AsyncIterable<Buffer | string>,
  tokenSets: string[][],
): Promise<boolean> {
  if (tokenSets.length === 0) return false;
  const wanted = new Set(tokenSets.flat());
  const longest = Math.max(...[...wanted].map((token) => token.length));
  const found = new Set<string>();
  const decoder = new StringDecoder("utf8");
  let rawCarry = "";
  let plainTail = "";

  const satisfied = () =>
    tokenSets.some((tokens) => tokens.every((token) => found.has(token)));

  const consume = (raw: string, final: boolean): boolean => {
    let text = rawCarry + raw;
    rawCarry = "";
    if (!final) {
      // Hold back a half-read tag or entity until its end arrives.
      const lastOpen = text.lastIndexOf("<");
      if (lastOpen > text.lastIndexOf(">")) {
        rawCarry = text.slice(lastOpen);
        text = text.slice(0, lastOpen);
      }
      const lastAmp = text.lastIndexOf("&");
      if (
        lastAmp >= 0 &&
        text.length - lastAmp <= 12 &&
        !text.includes(";", lastAmp)
      ) {
        rawCarry = text.slice(lastAmp) + rawCarry;
        text = text.slice(0, lastAmp);
      }
    }
    const plain = decodeEntities(
      text.replace(/<\/si>/g, "\n").replace(/<[^>]*>/g, ""),
    ).toLowerCase();
    const window = plainTail + plain;
    for (const token of wanted) {
      if (!found.has(token) && window.includes(token)) found.add(token);
    }
    plainTail = window.slice(-(longest - 1 > 0 ? longest - 1 : 0));
    return satisfied();
  };

  for await (const chunk of chunks) {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    if (consume(text, false)) return true;
  }
  return consume(decoder.end(), true);
}

/**
 * Streams a workbook's shared strings (where all its text cells live) through
 * `unzip` and says whether the subject can appear in it, without ever loading
 * the workbook. A 740MB workbook takes seconds and a few MB of memory, where
 * parsing it needs more than 6GB and gets the worker killed.
 *
 * "unsupported" means we cannot tell (old .xls, a workbook with inline strings
 * only, a damaged file, no criteria, a timeout): the caller falls back to the
 * normal conversion, so nothing is ever dropped on a guess.
 */
export async function scanXlsxForMentions(
  filePath: string,
  criteria: string[],
  options: { timeoutMs?: number } = {},
): Promise<MentionScan> {
  const tokenSets = criteriaTokenSets(criteria);
  if (tokenSets.length === 0) {
    return { status: "unsupported", reason: "no search criteria" };
  }
  if (!fs.existsSync(filePath)) {
    return { status: "unsupported", reason: "file not found" };
  }

  return await new Promise<MentionScan>((resolve) => {
    const child = spawn("unzip", ["-p", filePath, "xl/sharedStrings.xml"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let settled = false;
    const finish = (result: MentionScan) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ status: "unsupported", reason: "scan timed out" }),
      options.timeoutMs ?? SCAN_TIMEOUT_MS,
    );
    child.once("error", (error) =>
      finish({
        status: "unsupported",
        reason: `unzip failed: ${error.message}`,
      }),
    );

    scanTextChunks(child.stdout, tokenSets).then(
      (mentioned) => {
        if (mentioned) return finish({ status: "mentioned" });
        // Not found. That only means "absent" if unzip actually read the strings.
        child.once("exit", (code) => {
          if (code === 0 || code === 1) finish({ status: "not-mentioned" });
          else finish({ status: "unsupported", reason: `unzip exit ${code}` });
        });
        if (child.exitCode !== null) {
          const code = child.exitCode;
          if (code === 0 || code === 1) finish({ status: "not-mentioned" });
          else finish({ status: "unsupported", reason: `unzip exit ${code}` });
        }
      },
      (error) =>
        finish({
          status: "unsupported",
          reason: `scan failed: ${String(error)}`,
        }),
    );
  });
}
