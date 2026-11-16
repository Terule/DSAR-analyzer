export interface OneTrustFormInput {
  name?: string;
  templateId?: string;
  apiToken?: string;
  dateRaisedFieldKey?: string;
  systemLabel?: string;
  language?: string;
  subjectType?: string;
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
  };
}
