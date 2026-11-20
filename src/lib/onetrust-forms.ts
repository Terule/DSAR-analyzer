export interface OneTrustFormInput {
  name?: string;
  templateId?: string;
  apiToken?: string;
  dateRaisedFieldKey?: string;
  systemLabel?: string;
  language?: string;
  subjectType?: string;
  requiredFields?: string[];
}

/** Case details a OneTrust request can need, in the order the editor shows them. */
export const ONETRUST_FIELDS = [
  {
    key: "subject_name",
    label: "Subject name",
    source: "Case · Full name",
    locked: true,
  },
  {
    key: "work_email",
    label: "Work email",
    source: "Case · Work email",
    locked: true,
  },
  {
    key: "personal_email",
    label: "Personal email",
    source: "Case · Personal email",
    locked: false,
  },
  {
    key: "matter_number",
    label: "Matter number",
    source: "Case · Matter numbers",
    locked: false,
  },
] as const;

export type OneTrustFieldKey = (typeof ONETRUST_FIELDS)[number]["key"];

/** OneTrust refuses a request without a name and an email, so those stay on. */
export const ALWAYS_REQUIRED: OneTrustFieldKey[] = [
  "subject_name",
  "work_email",
];

/** Reads the stored list; unknown keys are dropped and the fixed ones always count. */
export function parseRequiredFields(
  raw: string | string[] | null | undefined,
): OneTrustFieldKey[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      list = [];
    }
  }
  const known = new Set<string>(ONETRUST_FIELDS.map((field) => field.key));
  const picked = Array.isArray(list)
    ? list.filter((key): key is OneTrustFieldKey => known.has(String(key)))
    : [];
  return ONETRUST_FIELDS.map((field) => field.key).filter(
    (key) => ALWAYS_REQUIRED.includes(key) || picked.includes(key),
  );
}

export interface SubjectDetails {
  name: string;
  email: string;
  personalEmail: string | null;
  matterNumbers: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Why a field cannot be sent as it is, or null when it is fine. */
export function fieldProblem(
  key: OneTrustFieldKey,
  subject: SubjectDetails,
): string | null {
  if (key === "subject_name") {
    return subject.name.trim().split(/\s+/).filter(Boolean).length < 2
      ? "Needs a first name and a surname"
      : null;
  }
  if (key === "work_email") {
    return EMAIL.test(subject.email.trim()) ? null : "Missing";
  }
  if (key === "personal_email") {
    return EMAIL.test((subject.personalEmail ?? "").trim()) ? null : "Missing";
  }
  return (subject.matterNumbers ?? "").trim() ? null : "Missing";
}

/** The required fields this case does not fill, as "Label: problem". */
export function missingRequired(
  required: OneTrustFieldKey[],
  subject: SubjectDetails,
): string[] {
  return required.flatMap((key) => {
    const problem = fieldProblem(key, subject);
    const label = ONETRUST_FIELDS.find((field) => field.key === key)?.label;
    return problem ? [`${label}: ${problem}`] : [];
  });
}

export const ONETRUST_FORM_DEFAULTS = {
  dateRaisedFieldKey: "formField81",
  systemLabel: "AIDA",
  language: "en-gb",
  subjectType: "Customer",
} as const;

/** Form fields as stored, with blanks replaced by the defaults. */
export function formColumns(body: OneTrustFormInput) {
  return {
    name: body.name?.trim() ?? "",
    template_id: body.templateId?.trim() ?? "",
    date_raised_field_key:
      body.dateRaisedFieldKey?.trim() ||
      ONETRUST_FORM_DEFAULTS.dateRaisedFieldKey,
    system_label:
      body.systemLabel?.trim() || ONETRUST_FORM_DEFAULTS.systemLabel,
    language: body.language?.trim() || ONETRUST_FORM_DEFAULTS.language,
    subject_type:
      body.subjectType?.trim() || ONETRUST_FORM_DEFAULTS.subjectType,
    ...(Array.isArray(body.requiredFields)
      ? {
          required_fields: JSON.stringify(
            parseRequiredFields(body.requiredFields),
          ),
        }
      : {}),
  };
}

interface FormRow {
  id: string;
  name: string;
  template_id: string;
  date_raised_field_key: string;
  system_label: string;
  language: string;
  subject_type: string;
  required_fields: string;
}

/** What the browser may see. The API token never leaves the server. */
export function publicForm(row: FormRow) {
  return {
    id: row.id,
    name: row.name,
    templateId: row.template_id,
    dateRaisedFieldKey: row.date_raised_field_key,
    systemLabel: row.system_label,
    language: row.language,
    subjectType: row.subject_type,
    requiredFields: parseRequiredFields(row.required_fields),
  };
}
