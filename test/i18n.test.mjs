import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("web i18n dictionary contains no unicode replacement characters", () => {
  const content = fs.readFileSync("web/src/i18n-messages.ts", "utf8");
  assert.equal(content.includes("\ufffd"), false, "Found replacement character \\ufffd in web/src/i18n-messages.ts");
});
