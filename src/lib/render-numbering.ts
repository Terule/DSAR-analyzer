import fs from "node:fs";
import path from "node:path";
import { prisma } from "./prisma";
import { highestNumber } from "./request-waves";

function entries(directory: string): string[] {
  return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
}

/**
 * Bases for this wave's `Email N` / `Warning N` numbering. Stored on the
 * request at the wave's first Render so a retry numbers identically. Wave 1
 * always starts at 0 (a retried wave-1 render may already hold its own partial
 * PDFs and must keep numbering from 1); wave 2+ continue after the highest
 * number already delivered.
 */
export async function resolveRenderBases(
  requestId: string | null,
  emailsDir: string,
): Promise<{ email: number; warning: number }> {
  if (!requestId) return { email: 0, warning: 0 };
  const request = await prisma.caseRequest.findUnique({
    where: { id: requestId },
    select: { wave: true, render_base: true, warning_base: true },
  });
  if (!request) return { email: 0, warning: 0 };

  const email =
    request.render_base ??
    (request.wave > 1 ? highestNumber(entries(emailsDir), "Email") : 0);
  const warning =
    request.warning_base ??
    (request.wave > 1
      ? highestNumber(entries(path.join(emailsDir, "Warning")), "Warning")
      : 0);

  if (request.render_base === null || request.warning_base === null) {
    await prisma.caseRequest.updateMany({
      where: {
        id: requestId,
        render_base: request.render_base,
        warning_base: request.warning_base,
      },
      data: { render_base: email, warning_base: warning },
    });
  }
  return { email, warning };
}
