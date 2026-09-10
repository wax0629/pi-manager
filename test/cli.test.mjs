import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { browserCommand, hasWebUi, isCliEntrypoint, parseCliArgs, publicUrl } from "../src/cli.mjs";

test("parses host, port and no-open flags", () => {
  assert.deepEqual(parseCliArgs(["--host", "127.0.0.1", "--port", "9000", "--no-open"]), {
    host: "127.0.0.1",
    port: 9000,
    open: false,
    help: false
  });
  assert.equal(parseCliArgs(["--help"]).help, true);
  assert.equal(parseCliArgs(["--port=8671"]).port, 8671);
  assert.throws(() => parseCliArgs(["--port", "nope"]), /无效端口/);
  assert.throws(() => parseCliArgs(["--wat"]), /未知参数/);
});

test("detects a built web UI by index.html", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-cli-"));
  assert.equal(hasWebUi(dir), false);
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>\n");
  assert.equal(hasWebUi(dir), true);
});

test("browser command matches the current platform family", () => {
  assert.deepEqual(browserCommand("http://127.0.0.1:8670", "darwin"), {
    command: "open",
    args: ["http://127.0.0.1:8670"]
  });
  assert.deepEqual(browserCommand("http://127.0.0.1:8670", "linux"), {
    command: "xdg-open",
    args: ["http://127.0.0.1:8670"]
  });
  assert.equal(publicUrl("0.0.0.0", 8670), "http://127.0.0.1:8670");
  assert.equal(publicUrl("127.0.0.1", 9000), "http://127.0.0.1:9000");
});

test("treats npm bin symlinks and /tmp paths as the CLI entrypoint", () => {
  const moduleUrl = import.meta.url;
  const here = fileURLToPath(moduleUrl);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manager-bin-"));
  const link = path.join(dir, "pi-manager");
  fs.symlinkSync(here, link);
  assert.equal(isCliEntrypoint(link, moduleUrl), true);
  assert.equal(isCliEntrypoint(here, moduleUrl), true);
  assert.equal(isCliEntrypoint(path.join(dir, "other.mjs"), moduleUrl), false);
});
