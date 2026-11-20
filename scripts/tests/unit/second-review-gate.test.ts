import assert from "node:assert/strict";
import test from "node:test";
import { subjectIsDirectParty } from "../../../src/lib/batch-worker";

const criteria = {
  name: "Maria Souza",
  email: "maria.souza@corp.com",
  personalEmail: "msouza@gmail.com",
  aliases: [],
};

test("the subject is a direct party when their address is in From or To", () => {
  assert.equal(
    subjectIsDirectParty(
      "From: Alice <alice@corp.com>\nTo: Maria Souza <maria.souza@corp.com>\nSubject: Hi\n\nBody",
      criteria,
    ),
    true,
  );
  assert.equal(
    subjectIsDirectParty(
      "From: Maria <MSouza@gmail.com>\nTo: Bob <bob@corp.com>\nSubject: Hi\n\nBody",
      criteria,
    ),
    true,
  );
});

test("a name in the subject line or in the body is not enough", () => {
  assert.equal(
    subjectIsDirectParty(
      "From: Alice <alice@corp.com>\nTo: Bob <bob@corp.com>\nSubject: Maria Souza leave\n\nMaria Souza asked. Maria Souza again.",
      criteria,
    ),
    false,
  );
  assert.equal(
    subjectIsDirectParty(
      "From: Alice <alice@corp.com>\nTo: Bob <bob@corp.com>\nCc: maria.souza@corp.com\nSubject: Hi\n\nBody",
      criteria,
    ),
    false,
  );
});
