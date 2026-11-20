import assert from "node:assert/strict";
import test from "node:test";
import {
  AUDIT_CSV_HEADER,
  AUDIT_LABEL_MAX,
  auditCsv,
  cleanAuditLabel,
} from "../../../src/lib/audit-csv";

const base = {
  id: "abcdef0123456789abcdef",
  label: null,
  kind: "email",
  origin: "pst",
  parent_id: null,
  state: "discarded",
  decision_rule: "ai_email",
  reason: "Not about the subject",
  decided_by: "haiku-4.5",
  updated_at: new Date("2026-11-20T09:00:00.000Z"),
};

test("one header for the file and the panel export", () => {
  assert.equal(
    AUDIT_CSV_HEADER,
    "time,decision,item,kind,origin,parent,rule,reason,decided_by",
  );
  assert.equal(auditCsv([]), `${AUDIT_CSV_HEADER}\n`);
});

test("an email shows its subject, quoted when needed", () => {
  const csv = auditCsv([{ ...base, label: 'Re: Q3, "final" budget' }]);
  assert.equal(
    csv.split("\n")[1],
    '2026-11-20T09:00:00.000Z,discarded,"Re: Q3, ""final"" budget",email,pst,,ai_email,Not about the subject,haiku-4.5',
  );
});

test("an item without a label shows the start of its identifier", () => {
  const line = auditCsv([base]).split("\n")[1];
  assert.ok(line.includes(",abcdef0123456789,"));
});

test("a child shows the start of its parent", () => {
  const line = auditCsv([
    { ...base, parent_id: "1234567890abcdef1234", label: "logo.png" },
  ]).split("\n")[1];
  assert.ok(line.includes(",logo.png,email,pst,1234567890abcdef,"));
});

test("a subject is one readable line of bounded length", () => {
  assert.equal(cleanAuditLabel("  Re:\n  hello\t world  "), "Re: hello world");
  assert.equal(cleanAuditLabel(undefined), "");
  assert.equal(cleanAuditLabel("x".repeat(1000)).length, AUDIT_LABEL_MAX);
});
