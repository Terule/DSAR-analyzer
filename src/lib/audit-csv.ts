/**
 * The one CSV of the audit trail. The file written next to the deliverables
 * (`Discarded/audit-trail.csv`) and the export of the decisions panel use this
 * same format, so a person reads the same columns in both.
 *
 * `item` is what a person recognises: the email subject, or the path / name of a
 * file or attachment. Items recorded before subjects were kept have no label and
 * show the start of their identifier instead.
 */
export const AUDIT_CSV_HEADER =
  "time,decision,item,kind,origin,parent,rule,reason,decided_by";

export interface AuditCsvItem {
  id: string;
  label: string | null;
  kind: string;
  origin: string;
  parent_id: string | null;
  state: string;
  decision_rule: string | null;
  reason: string | null;
  decided_by: string | null;
  updated_at: Date;
}

/** Longest subject or name kept in a label. */
export const AUDIT_LABEL_MAX = 300;

/** A subject as one readable line, never empty. */
export function cleanAuditLabel(value: string | null | undefined): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.slice(0, AUDIT_LABEL_MAX);
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function auditCsvLine(item: AuditCsvItem): string {
  return [
    item.updated_at.toISOString(),
    item.state,
    item.label || item.id.slice(0, 16),
    item.kind,
    item.origin,
    item.parent_id ? item.parent_id.slice(0, 16) : "",
    item.decision_rule ?? "",
    item.reason ?? "",
    item.decided_by ?? "",
  ]
    .map((cell) => csvCell(String(cell)))
    .join(",");
}

export function auditCsv(items: AuditCsvItem[]): string {
  return `${[AUDIT_CSV_HEADER, ...items.map(auditCsvLine)].join("\n")}\n`;
}
