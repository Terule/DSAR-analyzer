import assert from "node:assert/strict";
import test from "node:test";
import { safeFolderName, scopeForContent } from "../../../src/lib/input-scan";

test("a request folder's scope follows what it holds", () => {
  assert.equal(scopeForContent(3, 0), "mail");
  assert.equal(scopeForContent(0, 10), "files");
  assert.equal(scopeForContent(2, 10), "both");
  assert.equal(scopeForContent(0, 0), null);
});

test("the scan only accepts a single folder name", () => {
  assert.equal(safeFolderName(" ACM Corp "), "ACM Corp");
  for (const bad of ["", "..", "../x", "a/b", "a\\b", ".hidden"]) {
    assert.throws(() => safeFolderName(bad));
  }
});
