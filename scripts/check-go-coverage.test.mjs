import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const repoRoot = new URL("..", import.meta.url).pathname;
const scriptPath = join(repoRoot, "scripts", "check-go-coverage.mjs");

function runCoverageChecker(profileText, threshold = "80") {
  const dir = mkdtempSync(join(tmpdir(), "spackt-coverage-"));
  const profile = join(dir, "coverage.out");
  writeFileSync(profile, profileText);
  const result = spawnSync(process.execPath, [scriptPath, profile, threshold], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  rmSync(dir, { recursive: true, force: true });
  return result;
}

describe("check-go-coverage CLI", () => {
  it("rejects an empty coverage profile", () => {
    const result = runCoverageChecker("");

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /empty|coverage|statement/i);
  });

  it("rejects a coverage profile with no statement records", () => {
    const result = runCoverageChecker("mode: set\n");

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /empty|coverage|statement/i);
  });

  it("accepts a coverage profile at the configured threshold", () => {
    const result = runCoverageChecker([
      "mode: set",
      "spackt/internal/foo/foo.go:1.1,8.2 8 1",
      "spackt/internal/foo/foo.go:9.1,10.2 2 0",
      "",
    ].join("\n"));

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  it("rejects a coverage profile below the configured threshold", () => {
    const result = runCoverageChecker([
      "mode: set",
      "spackt/internal/foo/foo.go:1.1,79.2 79 1",
      "spackt/internal/foo/foo.go:80.1,100.2 21 0",
      "",
    ].join("\n"));

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /80|coverage|below/i);
  });

  it("rejects a missing coverage profile path", () => {
    const result = spawnSync(process.execPath, [scriptPath, join(tmpdir(), "missing-spackt-coverage.out"), "80"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /missing|no such file|coverage/i);
  });
});
