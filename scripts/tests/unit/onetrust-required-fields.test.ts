import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fieldProblem,
  missingRequired,
  parseRequiredFields,
} from "../../../src/lib/onetrust-forms";

const subject = {
  name: "Maria Souza",
  email: "maria@acm.example",
  personalEmail: null,
  matterNumbers: null,
};

describe("OneTrust required fields", () => {
  it("always requires the name and the work email", () => {
    assert.deepEqual(parseRequiredFields([]), ["subject_name", "work_email"]);
    assert.deepEqual(parseRequiredFields("not json"), [
      "subject_name",
      "work_email",
    ]);
  });

  it("keeps the chosen optional fields and drops unknown ones", () => {
    assert.deepEqual(
      parseRequiredFields('["matter_number","bogus","personal_email"]'),
      ["subject_name", "work_email", "personal_email", "matter_number"],
    );
  });

  it("flags what the case does not fill", () => {
    assert.equal(fieldProblem("subject_name", subject), null);
    assert.equal(
      fieldProblem("subject_name", { ...subject, name: "Maria" }),
      "Needs a first name and a surname",
    );
    assert.equal(fieldProblem("matter_number", subject), "Missing");
    assert.deepEqual(
      missingRequired(
        ["subject_name", "work_email", "personal_email", "matter_number"],
        subject,
      ),
      ["Personal email: Missing", "Matter number: Missing"],
    );
  });
});
