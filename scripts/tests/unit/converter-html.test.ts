import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  imageDimensionsToStyle,
  normalizeHtmlForPdf,
} from "../../../src/lib/converter";

describe("imageDimensionsToStyle", () => {
  it("copies width/height attributes into an inline style", () => {
    const out = imageDimensionsToStyle(
      '<img width="32" height="24" src="a.png" alt="Icon">',
    );
    assert.match(out, /style="width:32px;height:24px;"/);
  });

  it("prepends to an existing style that has no width", () => {
    const out = imageDimensionsToStyle(
      '<img width="32" height="32" style="display:block" src="a.png">',
    );
    assert.match(out, /style="width:32px;height:32px;display:block"/);
  });

  it("leaves an image that already declares a width in its style", () => {
    const tag =
      '<img width="110" height="51" style="width:1.15in; height:.5333in" src="a.png">';
    assert.equal(imageDimensionsToStyle(tag), tag);
  });

  it("leaves an image without dimensions alone", () => {
    const tag = '<img src="a.png" alt="x">';
    assert.equal(imageDimensionsToStyle(tag), tag);
  });

  it("handles several images and ignores other tags", () => {
    const out = imageDimensionsToStyle(
      '<p width="9"><img width="12" height="12" src="a"><img src="b"></p>',
    );
    assert.match(out, /<p width="9">/);
    assert.match(out, /<img style="width:12px;height:12px;" width="12"/);
    assert.match(out, /<img src="b">/);
  });
});

describe("email stylesheet", () => {
  const html = normalizeHtmlForPdf(
    '<html><head></head><body><img width="32" height="32" src="a.png"></body></html>',
  );

  it("does not put a percentage max-width on every element (crashes WeasyPrint)", () => {
    assert.doesNotMatch(html, /body \*\s*\{[^}]*max-width/);
    assert.match(html, /body div, body p, body td[^{]*\{\s*max-width: 100%/);
  });

  it("does not force tables or images to a width", () => {
    assert.doesNotMatch(
      html,
      /\btable\s*\{[^}]*(?<![-\w])width: 100% !important/,
    );
    assert.doesNotMatch(html, /\bimg\s*\{[^}]*(?<![-\w])width: auto/);
    assert.doesNotMatch(html, /\bimg\s*\{[^}]*(?<![-\w])height: auto/);
  });

  it("lets table cells shrink to the printable width", () => {
    assert.match(html, /td, th\s*\{\s*width: auto !important/);
  });

  it("applies the image dimensions to the final html", () => {
    assert.match(html, /<img style="width:32px;height:32px;"/);
  });
});
