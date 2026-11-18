import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AiBatchSettings,
  validateAiBatchSettings,
} from "../../../src/lib/pipeline-settings";

const base: AiBatchSettings = {
  maxTokensPerBatch: 1_000_000,
  maxConcurrentBatches: 2,
  sharePointSiteUrl: "",
  sharePointFolderId: "",
  sharePointFolderPath: "",
  oneTrustTenantUrl: "",
  oneTrustTemplateId: "",
  oneTrustPublicWebFormUrl: "",
  oneTrustLanguage: "en-gb",
  oneTrustRequestType: "",
  oneTrustSubjectType: "",
  oneTrustDateRaisedFieldKey: "formField81",
  oneTrustSystemLabel: "AIDA",
};

describe("second-review settings", () => {
  it("defaults to threshold 8 and a 2% control sample", () => {
    const settings = validateAiBatchSettings(base);
    assert.equal(settings.rereviewMinPKeep, 8);
    assert.equal(settings.rereviewSamplePercent, 2);
  });

  it("accepts values inside the range", () => {
    const settings = validateAiBatchSettings({
      ...base,
      rereviewMinPKeep: 0,
      rereviewSamplePercent: 0.5,
    });
    assert.equal(settings.rereviewMinPKeep, 0);
    assert.equal(settings.rereviewSamplePercent, 0.5);
  });

  it("rejects a threshold that is not a whole number from 0 to 100", () => {
    for (const rereviewMinPKeep of [-1, 101, 7.5, Number.NaN]) {
      assert.throws(() =>
        validateAiBatchSettings({ ...base, rereviewMinPKeep }),
      );
    }
  });

  it("rejects a control sample outside 0 to 100 percent", () => {
    for (const rereviewSamplePercent of [-0.1, 100.1, Number.NaN]) {
      assert.throws(() =>
        validateAiBatchSettings({ ...base, rereviewSamplePercent }),
      );
    }
  });
});
