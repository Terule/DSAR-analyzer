import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSubjectTokens,
  isSentToPersonalAddress,
  mentionsSubject,
  textShowsSentToPersonalAddress,
} from "../../../src/lib/subject-rules";

const identity = {
  name: "Maria  Souza",
  email: "maria.souza@corp.com",
  personalEmail: "msouza@gmail.com",
  aliases: ["Mari S"],
};

test("tokens cover the full name, parts, aliases, both emails and local parts", () => {
  const tokens = buildSubjectTokens(identity);
  for (const expected of [
    "maria souza",
    "maria",
    "souza",
    "mari s",
    "maria.souza@corp.com",
    "maria.souza",
    "msouza@gmail.com",
    "msouza",
  ]) {
    assert.ok(tokens.includes(expected), `missing ${expected}`);
  }
});

test("short name parts and local parts are not tokens", () => {
  const tokens = buildSubjectTokens({ name: "Li Wu", email: "lw@x.com" });
  assert.deepEqual(tokens, ["li wu", "lw@x.com"]);
});

test("the token set is the same whatever the caller", () => {
  const withEmail = buildSubjectTokens(identity);
  const again = buildSubjectTokens({ ...identity, aliases: ["MARI S"] });
  assert.deepEqual(withEmail.sort(), again.sort());
});

test("matching is by whole word, case-insensitive", () => {
  const tokens = buildSubjectTokens(identity);
  assert.equal(mentionsSubject("Hi MARIA, see you", tokens), true);
  assert.equal(mentionsSubject("from: msouza@gmail.com", tokens), true);
  assert.equal(mentionsSubject("Marianne and Sousa met", tokens), false);
  assert.equal(mentionsSubject("nothing here", tokens), false);
});

test("no tokens means everything matches (client cases)", () => {
  assert.equal(mentionsSubject("anything", []), true);
});

test("sent-to exception: only the personal address, in To, Cc or Bcc", () => {
  assert.equal(
    isSentToPersonalAddress(
      ["a@x.com", "MSouza@Gmail.com"],
      "msouza@gmail.com",
    ),
    true,
  );
  assert.equal(
    isSentToPersonalAddress(["maria.souza@corp.com"], "msouza@gmail.com"),
    false,
  );
  assert.equal(isSentToPersonalAddress(["a@x.com"], undefined), false);
});

test("sent-to exception on text behaves like the address check", () => {
  const personal = "msouza@gmail.com";
  assert.equal(
    textShowsSentToPersonalAddress(
      "To: Maria <msouza@gmail.com>\nSubject: x",
      personal,
    ),
    true,
  );
  assert.equal(
    textShowsSentToPersonalAddress("Cc: a@x.com, msouza@gmail.com", personal),
    true,
  );
  // The work address and a mention in the body do not open the exception.
  assert.equal(
    textShowsSentToPersonalAddress("To: maria.souza@corp.com", personal),
    false,
  );
  assert.equal(
    textShowsSentToPersonalAddress("write to msouza@gmail.com later", personal),
    false,
  );
});
