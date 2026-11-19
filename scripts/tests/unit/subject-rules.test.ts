import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSubjectTokens,
  mentionsSubject,
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
