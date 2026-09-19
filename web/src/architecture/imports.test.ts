import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path, { join, relative } from "node:path";
import ts from "typescript";

const srcRoot = join(process.cwd(), "src");

const allowedLocalImports: Record<string, string[]> = {
  domain: [],
  net: ["domain", "net/wire"],
  "net/wire": ["domain"],
  engines: ["domain"],
  store: ["domain"],
  chart: ["domain"],
  ui: ["domain", "store", "chart"],
  runtime: ["net", "engines", "store", "domain"],
};

const allowedExternalPrefixes: Record<string, string[]> = {
  domain: [],
  net: [],
  "net/wire": ["zod/mini"],
  engines: [],
  store: ["zustand", "zustand/vanilla"],
  chart: ["lightweight-charts"],
  ui: ["react", "react-dom", "@radix-ui/"],
  runtime: [],
};

function tsFiles(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((entry) => {
      const file = join(dir, entry);
      const stat = statSync(file);
      if (stat.isDirectory()) {
        return tsFiles(file);
      }
      if (
        (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) ||
        entry.endsWith(".test.ts") ||
        entry.endsWith(".test.tsx") ||
        entry.endsWith(".d.ts")
      ) {
        return [];
      }
      return [file];
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function importedSpecifiers(sourceText: string, filename: string): string[] {
  const source = ts.createSourceFile(filename, sourceText, ts.ScriptTarget.Latest, true, filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports: string[] = [];

  function maybeAddModuleSpecifier(moduleSpecifier: ts.Expression | undefined): void {
    if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) {
      imports.push(moduleSpecifier.text);
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      maybeAddModuleSpecifier(node.moduleSpecifier);
    }
    if (ts.isExportDeclaration(node)) {
      maybeAddModuleSpecifier(node.moduleSpecifier);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return imports;
}

function boundaryForSourceFile(filename: string): string | null {
  const normalized = filename.replaceAll("\\", "/");
  const marker = "/src/";
  const relativeToSrc = normalized.includes(marker)
    ? normalized.slice(normalized.indexOf(marker) + marker.length)
    : normalized.replace(/^src\//, "");
  const parts = relativeToSrc.split("/");
  if (parts[0] === "net" && parts[1] === "wire") {
    return "net/wire";
  }
  return parts[0] in allowedLocalImports ? parts[0] : null;
}

function boundaryForLocalSpecifier(fromFile: string, specifier: string): string | null {
  let relativeToSrc: string;
  if (specifier.startsWith("@/")) {
    relativeToSrc = specifier.slice(2);
  } else if (specifier.startsWith(".")) {
    const fromRelative = relative(srcRoot, fromFile).replaceAll("\\", "/");
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromRelative), specifier));
    relativeToSrc = resolved.replace(/^(\.\.\/)+/, "");
  } else {
    return null;
  }

  const parts = relativeToSrc.split("/");
  if (parts[0] === "net" && parts[1] === "wire") {
    return "net/wire";
  }
  return parts[0] in allowedLocalImports ? parts[0] : null;
}

function isAllowedExternal(boundary: string, specifier: string): boolean {
  return (allowedExternalPrefixes[boundary] ?? []).some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`));
}

function importBoundaryViolations(sourceText: string, filename: string): string[] {
  const boundary = boundaryForSourceFile(filename);
  if (!boundary) {
    return [];
  }

  const violations: string[] = [];
  for (const specifier of importedSpecifiers(sourceText, filename)) {
    const targetBoundary = boundaryForLocalSpecifier(filename, specifier);
    if (targetBoundary) {
      const allowedTargets = allowedLocalImports[boundary] ?? [];
      if (targetBoundary !== boundary && !allowedTargets.includes(targetBoundary)) {
        violations.push(`${boundary} imports ${specifier}, resolved to ${targetBoundary}`);
      }
      continue;
    }

    if (specifier.startsWith(".") || specifier.startsWith("@/")) {
      violations.push(`${boundary} imports ${specifier}, which does not resolve to a known boundary`);
      continue;
    }

    if (!isAllowedExternal(boundary, specifier)) {
      violations.push(`${boundary} imports external package ${specifier}`);
    }
  }
  return violations;
}

describe("frontend import boundary checker", () => {
  it("ignores comments, strings, and identifiers that mention forbidden APIs", () => {
    const source = `
      const commentText = "import React from 'react'";
      const fetchStatus = "WebSocket document window";
      // export * from "zustand";
      export type Trade = { id: number };
    `;

    expect(importBoundaryViolations(source, join(srcRoot, "domain", "model.ts"))).toEqual([]);
  });

  it("allows imports inside the same boundary", () => {
    const source = `export { decodeWire } from "./schema";`;

    expect(importBoundaryViolations(source, join(srcRoot, "net", "wire", "mapping.ts"))).toEqual([]);
  });

  it("accepts allowed alias imports and zod mini inside net wire", () => {
    const source = `
      import { z } from "zod/mini";
      export type { Trade } from "@/domain/model";
    `;

    expect(importBoundaryViolations(source, join(srcRoot, "net", "wire", "schema.ts"))).toEqual([]);
  });

  it("accepts approved Radix UI primitive imports inside ui", () => {
    const source = `
      import * as Dialog from "@radix-ui/react-dialog";
      import * as ToggleGroup from "@radix-ui/react-toggle-group";
      import { Tooltip } from "@radix-ui/react-tooltip";
      export { CheckIcon } from "@radix-ui/react-icons";
    `;

    expect(importBoundaryViolations(source, join(srcRoot, "ui", "controls.tsx"))).toEqual([]);
  });

  it("rejects Radix lookalike package prefixes inside ui", () => {
    const source = `import * as Dialog from "@radix-ui-fake/react-dialog";`;

    expect(importBoundaryViolations(source, join(srcRoot, "ui", "controls.tsx"))).toEqual([
      "ui imports external package @radix-ui-fake/react-dialog",
    ]);
  });

  it("rejects side-effect imports, re-exports, dynamic imports, and wrong zod entrypoints", () => {
    const source = `
      import "react";
      export * from "@/store/state";
      async function load() { return import("zod"); }
    `;
    const violations = importBoundaryViolations(source, join(srcRoot, "net", "wire", "schema.ts"));

    expect(violations).toEqual([
      "net/wire imports external package react",
      "net/wire imports @/store/state, resolved to store",
      "net/wire imports external package zod",
    ]);
  });

  it("includes TSX files when checking real source", () => {
    expect(tsFiles(srcRoot).every((file) => file.endsWith(".ts") || file.endsWith(".tsx"))).toBe(true);
  });
});

describe("frontend import boundaries", () => {
  it("allows imports only along the documented frontend graph", () => {
    const violations = tsFiles(srcRoot).flatMap((file) =>
      importBoundaryViolations(readFileSync(file, "utf8"), file).map((violation) => `${relative(srcRoot, file)}: ${violation}`),
    );

    expect(violations).toEqual([]);
  });
});
