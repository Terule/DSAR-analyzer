import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampFilesConcurrency,
  FILES_CONCURRENCY_LIMITS,
} from "../../../src/lib/files-concurrency";
import { validateAiBatchSettings } from "../../../src/lib/pipeline-settings";

describe("clampFilesConcurrency", () => {
  it("keeps a sensible whole number", () => {
    assert.equal(clampFilesConcurrency(6), 6);
    assert.equal(clampFilesConcurrency(1), 1);
    assert.equal(clampFilesConcurrency(FILES_CONCURRENCY_LIMITS.max), 8);
  });
  it("pulls out-of-range values back into range", () => {
    assert.equal(clampFilesConcurrency(0), 1);
    assert.equal(clampFilesConcurrency(-3), 1);
    assert.equal(clampFilesConcurrency(500), FILES_CONCURRENCY_LIMITS.max);
  });
  it("rounds down fractions and falls back to the default for junk", () => {
    assert.equal(clampFilesConcurrency(3.9), 3);
    assert.equal(
      clampFilesConcurrency(Number.NaN),
      FILES_CONCURRENCY_LIMITS.default,
    );
    assert.equal(clampFilesConcurrency(null), FILES_CONCURRENCY_LIMITS.default);
    assert.equal(
      clampFilesConcurrency(undefined),
      FILES_CONCURRENCY_LIMITS.default,
    );
  });
  it("defaults to 6, within the limits", () => {
    assert.equal(FILES_CONCURRENCY_LIMITS.default, 6);
    assert.ok(FILES_CONCURRENCY_LIMITS.min <= FILES_CONCURRENCY_LIMITS.default);
    assert.ok(FILES_CONCURRENCY_LIMITS.default <= FILES_CONCURRENCY_LIMITS.max);
  });
});

const base = {
  sharePointSiteUrl: "",
  sharePointFolderId: "",
  sharePointFolderPath: "",
  oneTrustTenantUrl: "",
  oneTrustTemplateId: "",
  oneTrustPublicWebFormUrl: "",
  oneTrustLanguage: "en-gb",
  oneTrustRequestType: "RequestType3",
  oneTrustSubjectType: "SubjectType3",
  oneTrustDateRaisedFieldKey: "formField81",
  oneTrustSystemLabel: "AIDA",
};

describe("validateAiBatchSettings: files workers", () => {
  it("accepts a number within the limits and returns it", () => {
    assert.equal(
      validateAiBatchSettings({ ...base, filesConcurrency: 6 })
        .filesConcurrency,
      6,
    );
    assert.equal(
      validateAiBatchSettings({ ...base, filesConcurrency: 1 })
        .filesConcurrency,
      1,
    );
    assert.equal(
      validateAiBatchSettings({ ...base, filesConcurrency: 8 })
        .filesConcurrency,
      8,
    );
  });
  it("uses the default when it is not supplied", () => {
    assert.equal(validateAiBatchSettings(base).filesConcurrency, 6);
  });
  it("rejects zero, too many, and non-whole numbers with a clear message", () => {
    for (const bad of [0, 9, 100, -1, 2.5, Number.NaN]) {
      assert.throws(
        () => validateAiBatchSettings({ ...base, filesConcurrency: bad }),
        /Files workers must be a whole number between 1 and 8/,
        `value ${bad}`,
      );
    }
  });
});
