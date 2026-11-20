import { prisma } from "./prisma";

/**
 * Brings an archived case back to the active list. Archiving removed the case's
 * folders, so only the case and its saved statistics return; the files are not
 * restored. Cases are found by name, which is how History names them.
 */
export async function restoreCaseByName(
  name: string,
): Promise<{ id: string; name: string }> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Choose a case to restore.");
  const item = await prisma.managedCase.findUnique({
    where: { name: trimmed },
    select: { id: true, name: true, status: true },
  });
  if (!item) {
    throw new Error(
      "This case is no longer in the system, so it cannot be restored.",
    );
  }
  if (item.status !== "archived") {
    throw new Error("This case is already active.");
  }
  const result = await prisma.managedCase.updateMany({
    where: { id: item.id, status: "archived" },
    data: { status: "active", archived_at: null },
  });
  if (result.count === 0) throw new Error("This case is already active.");
  return { id: item.id, name: item.name };
}
