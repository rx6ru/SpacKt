package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestEvaluateAllowsStandardRootAgentGuide(t *testing.T) {
	entry := Entry{Path: "AGENTS.md", Mode: "file", Data: []byte("# Agent guide\n\nRead README.md and docs/architecture.md before changing the software.\n")}
	if findings := Evaluate([]Entry{entry}); len(findings) != 0 {
		t.Fatalf("standard root guide rejected: %#v", findings)
	}
}

func TestRootAgentGuideDoesNotBypassContentRules(t *testing.T) {
	for _, test := range []struct{ name, content, reason string }{
		{"plan", "# Implementation Plan\nPrivate task tracking.\n", "private planning"},
		{"workstation path", "Read /home/example/private-notes.md.\n", "private workspace"},
	} {
		t.Run(test.name, func(t *testing.T) {
			entry := Entry{Path: "AGENTS.md", Mode: "file", Data: []byte(test.content)}
			assertFinding(t, Evaluate([]Entry{entry}), entry.Path, test.reason)
		})
	}
}

func TestRootAgentGuideExceptionIsExactAndFileOnly(t *testing.T) {
	for _, entry := range []Entry{
		{Path: "agents.md", Mode: "file"},
		{Path: "web/AGENTS.md", Mode: "file"},
		{Path: "docs/AGENTS.md", Mode: "file"},
		{Path: "AGENTS.md/notes.md", Mode: "file"},
		{Path: "AGENTS.md", Mode: "dir"},
		{Path: "AGENTS.md", Mode: "symlink"},
		{Path: "CLAUDE.md", Mode: "file"},
	} {
		t.Run(entry.Path+"/"+entry.Mode, func(t *testing.T) {
			if len(Evaluate([]Entry{entry})) == 0 {
				t.Fatalf("guide exception accepted unintended entry: %+v", entry)
			}
		})
	}
}

func TestEvaluateAllowsLegitimateReadmeWithAIAndFencedExamples(t *testing.T) {
	entries := []Entry{{
		Path: "README.md",
		Mode: "file",
		Data: []byte(strings.Join([]string{
			"# SpacKt",
			"",
			"The architecture explains how AI-assisted code review can support maintenance.",
			"",
			"```text",
			"# Product Requirements Document",
			"Example rejected path: Dev_N_AIDocs/user-prompts.md",
			"Example workstation path: /home/example/project",
			"```",
		}, "\n")),
	}}

	if findings := Evaluate(entries); len(findings) != 0 {
		t.Fatalf("Evaluate() returned findings for allowed README: %#v", findings)
	}
}

func TestEvaluateRejectsRenamedPRDByMarkdownHeading(t *testing.T) {
	entries := []Entry{{
		Path: "docs/product-overview.md",
		Mode: "file",
		Data: []byte("# Product Requirements Document\n\nPrivate planning belongs outside shipping docs.\n"),
	}}

	assertFinding(t, Evaluate(entries), "docs/product-overview.md", "private planning")
}

func TestEvaluateRejectsRedContractHeadingBelowAllowedSourceRoot(t *testing.T) {
	entries := []Entry{{
		Path: "backend/cmd/checkcoverage/CONTRACT.md",
		Mode: "file",
		Data: []byte("# Go Coverage Checker RED Contract\n\nPrivate RED planning belongs outside product content.\n"),
	}}

	assertFinding(t, Evaluate(entries), "backend/cmd/checkcoverage/CONTRACT.md", "private planning")
}

func TestEvaluateRejectsPrivateWorkspaceLinks(t *testing.T) {
	entries := []Entry{{
		Path: "docs/usage.md",
		Mode: "file",
		Data: []byte("See Dev_N_AIDocs/user-prompts.md for the conversation record.\n"),
	}}

	assertFinding(t, Evaluate(entries), "docs/usage.md", "private workspace")
}

func TestEvaluateRejectsRootJavaScriptManifest(t *testing.T) {
	entries := []Entry{{
		Path: "package.json",
		Mode: "file",
		Data: []byte(`{"private": true}`),
	}}

	assertFinding(t, Evaluate(entries), "package.json", "root JavaScript")
}

func TestEvaluateRejectsBackendNodeManifest(t *testing.T) {
	entries := []Entry{{
		Path: "backend/package-lock.json",
		Mode: "file",
		Data: []byte("{}"),
	}}

	assertFinding(t, Evaluate(entries), "backend/package-lock.json", "backend")
}

func TestEvaluateRejectsWebGoModuleFile(t *testing.T) {
	entries := []Entry{{
		Path: "web/go.mod",
		Mode: "file",
		Data: []byte("module example.com/spackt/web\n"),
	}}

	assertFinding(t, Evaluate(entries), "web/go.mod", "web")
}

func TestEvaluateRejectsGeneratedTrackedFiles(t *testing.T) {
	entries := []Entry{{
		Path: "web/playwright-report/index.html",
		Mode: "file",
		Data: []byte("<html></html>\n"),
	}}

	assertFinding(t, Evaluate(entries), "web/playwright-report/index.html", "generated")
}

func TestEvaluateRejectsEnvironmentFilesExceptExample(t *testing.T) {
	entries := []Entry{
		{Path: "web/.env.example", Mode: "file", Data: []byte("NEXT_PUBLIC_API_URL=http://localhost:8080\n")},
		{Path: "backend/.env.example", Mode: "file", Data: []byte("PORT=8080\n")},
		{Path: "web/.env.local", Mode: "file", Data: []byte("SECRET=value\n")},
	}

	findings := Evaluate(entries)
	if len(findings) != 1 {
		t.Fatalf("Evaluate() findings count = %d, want 1: %#v", len(findings), findings)
	}
	assertFinding(t, findings, "web/.env.local", "environment")
}

func TestEvaluateRejectsRootEnvExample(t *testing.T) {
	entries := []Entry{{
		Path: ".env.example",
		Mode: "file",
		Data: []byte("PUBLIC_API_URL=http://localhost:8080\n"),
	}}

	assertFinding(t, Evaluate(entries), ".env.example", "root")
}

func TestEvaluateRejectsTrackedSymlinks(t *testing.T) {
	entries := []Entry{{
		Path: "docs/latest.md",
		Mode: "symlink",
		Data: []byte("architecture.md"),
	}}

	assertFinding(t, Evaluate(entries), "docs/latest.md", "symlink")
}

func TestEvaluateAllowsStandardPreCommitHookLocation(t *testing.T) {
	entries := []Entry{{
		Path: ".githooks/pre-commit",
		Mode: "file",
		Data: []byte("#!/bin/sh\nexec go run ./backend/cmd/checkrepo -root . -mode index\n"),
	}}

	if findings := Evaluate(entries); len(findings) != 0 {
		t.Fatalf("Evaluate() rejected standard pre-commit hook: %#v", findings)
	}
}

func TestEvaluateRejectsOtherGitHookLocations(t *testing.T) {
	entries := []Entry{{
		Path: ".githooks/post-commit",
		Mode: "file",
		Data: []byte("#!/bin/sh\n"),
	}}

	assertFinding(t, Evaluate(entries), ".githooks/post-commit", ".githooks/pre-commit")
}

func TestEvaluateAllowsProtocolFixturesJSON(t *testing.T) {
	entries := []Entry{{
		Path: "protocol/fixtures/book-snapshot.json",
		Mode: "file",
		Data: []byte(`{"type":"book_snapshot"}`),
	}}

	if findings := Evaluate(entries); len(findings) != 0 {
		t.Fatalf("Evaluate() rejected protocol fixture JSON: %#v", findings)
	}
}

func TestEvaluateRejectsUnknownTopLevelPaths(t *testing.T) {
	entries := []Entry{
		{Path: "misc/file.md", Mode: "file", Data: []byte("# Misc\n")},
		{Path: "fixtures/book-snapshot.json", Mode: "file", Data: []byte(`{"type":"book_snapshot"}`)},
		{Path: "protocol/foo/readme.md", Mode: "file", Data: []byte("# Protocol notes\n")},
		{Path: ".github/pull_request_template.md", Mode: "file", Data: []byte("## Summary\n")},
	}

	findings := Evaluate(entries)
	assertFinding(t, findings, "misc/file.md", "top-level")
	assertFinding(t, findings, "fixtures/book-snapshot.json", "protocol/fixtures")
	assertFinding(t, findings, "protocol/foo/readme.md", "protocol/fixtures")
	assertFinding(t, findings, ".github/pull_request_template.md", ".github/workflows")
}

func TestRunScanIndexScansEntireIndex(t *testing.T) {
	root := newGitRepo(t)
	writeFile(t, root, "docs/execution-report.md", "# Execution Report\n")
	writeFile(t, root, "README.md", "# SpacKt\n")
	git(t, root, "add", "docs/execution-report.md", "README.md")
	git(t, root, "commit", "-m", "add repository files")

	findings, err := RunScan(root, "index")
	if err != nil {
		t.Fatalf("RunScan(index) error = %v", err)
	}
	assertFinding(t, findings, "docs/execution-report.md", "private planning")
}

func TestRunScanIndexDoesNotSeeDeletedStagedContent(t *testing.T) {
	root := newGitRepo(t)
	writeFile(t, root, "docs/implementation-plan.md", "# Implementation Plan\n")
	git(t, root, "add", "docs/implementation-plan.md")
	git(t, root, "commit", "-m", "add private plan")
	removeFile(t, root, "docs/implementation-plan.md")
	git(t, root, "add", "docs/implementation-plan.md")

	findings, err := RunScan(root, "index")
	if err != nil {
		t.Fatalf("RunScan(index) error = %v", err)
	}
	assertNoFindingForPath(t, findings, "docs/implementation-plan.md")
}

func TestRunScanIndexKeepsStagedBadContentWhenWorkingTreeIsCleaned(t *testing.T) {
	root := newGitRepo(t)
	writeFile(t, root, "docs/architecture.md", "# Architecture\n\nShipping architecture.\n")
	git(t, root, "add", "docs/architecture.md")
	git(t, root, "commit", "-m", "add architecture")
	writeFile(t, root, "docs/architecture.md", "# Product Requirements Document\n\nStaged private content.\n")
	git(t, root, "add", "docs/architecture.md")
	writeFile(t, root, "docs/architecture.md", "# Architecture\n\nClean unstaged working tree content.\n")

	findings, err := RunScan(root, "index")
	if err != nil {
		t.Fatalf("RunScan(index) error = %v", err)
	}
	assertFinding(t, findings, "docs/architecture.md", "private planning")
}

func TestRunScanIndexDoesNotUseUnstagedWorkingTreeContent(t *testing.T) {
	root := newGitRepo(t)
	writeFile(t, root, "docs/architecture.md", "# Architecture\n\nShipping architecture.\n")
	git(t, root, "add", "docs/architecture.md")
	git(t, root, "commit", "-m", "add architecture")
	writeFile(t, root, "docs/architecture.md", "# Product Requirements Document\n\nUnstaged private rewrite.\n")

	findings, err := RunScan(root, "index")
	if err != nil {
		t.Fatalf("RunScan(index) error = %v", err)
	}
	assertNoFindingForPath(t, findings, "docs/architecture.md")
}

func TestRunScanHeadIgnoresStagedContent(t *testing.T) {
	root := newGitRepo(t)
	writeFile(t, root, "docs/architecture.md", "# Architecture\n\nShipping architecture.\n")
	git(t, root, "add", "docs/architecture.md")
	git(t, root, "commit", "-m", "add architecture")
	writeFile(t, root, "docs/architecture.md", "# Product Requirements Document\n\nStaged private rewrite.\n")
	git(t, root, "add", "docs/architecture.md")

	findings, err := RunScan(root, "head")
	if err != nil {
		t.Fatalf("RunScan(head) error = %v", err)
	}
	assertNoFindingForPath(t, findings, "docs/architecture.md")
}

func TestRunScanHeadRejectsCommittedPrivatePlanningDocument(t *testing.T) {
	root := newGitRepo(t)
	writeFile(t, root, "docs/product-overview.md", "# Product Requirements Document\n\nCommitted private planning.\n")
	git(t, root, "add", "docs/product-overview.md")
	git(t, root, "commit", "-m", "add product overview")

	findings, err := RunScan(root, "head")
	if err != nil {
		t.Fatalf("RunScan(head) error = %v", err)
	}
	assertFinding(t, findings, "docs/product-overview.md", "private planning")
}

func TestRunScanLocalUsesUnstagedWorkingTreeContent(t *testing.T) {
	root := newGitRepo(t)
	writeFile(t, root, "docs/architecture.md", "# Architecture\n\nShipping architecture.\n")
	git(t, root, "add", "docs/architecture.md")
	git(t, root, "commit", "-m", "add architecture")
	writeFile(t, root, "docs/architecture.md", "# Product Requirements Document\n\nUnstaged private rewrite.\n")

	findings, err := RunScan(root, "local")
	if err != nil {
		t.Fatalf("RunScan(local) error = %v", err)
	}
	assertFinding(t, findings, "docs/architecture.md", "private planning")
}

func TestRunScanLocalFlagsNonignoredUntrackedPrivateDocument(t *testing.T) {
	root := newGitRepo(t)
	writeFile(t, root, "README.md", "# SpacKt\n")
	git(t, root, "add", "README.md")
	git(t, root, "commit", "-m", "add readme")
	writeFile(t, root, "docs/product-overview.md", "# Product Requirements Document\n\nUntracked private planning.\n")

	findings, err := RunScan(root, "local")
	if err != nil {
		t.Fatalf("RunScan(local) error = %v", err)
	}
	assertFinding(t, findings, "docs/product-overview.md", "private planning")
}

func TestRunScanLocalFlagsIgnoredRootNodeModules(t *testing.T) {
	root := newGitRepo(t)
	writeFile(t, root, ".gitignore", "node_modules/\n")
	writeFile(t, root, "README.md", "# SpacKt\n")
	writeFile(t, root, "node_modules/.package-lock.json", "{}")
	git(t, root, "add", ".gitignore", "README.md")
	git(t, root, "commit", "-m", "add repository files")

	findings, err := RunScan(root, "local")
	if err != nil {
		t.Fatalf("RunScan(local) error = %v", err)
	}
	assertFinding(t, findings, "node_modules", "root")
}

func TestRunScanLocalFlagsEnvFileByPathWithoutReadingContent(t *testing.T) {
	root := newGitRepo(t)
	writeFile(t, root, "README.md", "# SpacKt\n")
	writeFile(t, root, ".env", "SECRET=fixture-value\n")
	git(t, root, "add", "README.md")
	git(t, root, "commit", "-m", "add readme")
	if err := os.Chmod(filepath.Join(root, ".env"), 0o000); err != nil {
		t.Fatalf("chmod .env unreadable: %v", err)
	}
	defer func() {
		_ = os.Chmod(filepath.Join(root, ".env"), 0o600)
	}()

	findings, err := RunScan(root, "local")
	if err != nil {
		t.Fatalf("RunScan(local) error = %v", err)
	}
	assertFinding(t, findings, ".env", "environment")
}

func TestRunScanLocalFlagsDumpEnvByPathWithoutReadingContent(t *testing.T) {
	root := newGitRepo(t)
	writeFile(t, root, "README.md", "# SpacKt\n")
	writeFile(t, root, ".dump.env", "SECRET=fixture-value\n")
	git(t, root, "add", "README.md")
	git(t, root, "commit", "-m", "add readme")
	if err := os.Chmod(filepath.Join(root, ".dump.env"), 0o000); err != nil {
		t.Fatalf("chmod .dump.env unreadable: %v", err)
	}
	defer func() {
		_ = os.Chmod(filepath.Join(root, ".dump.env"), 0o600)
	}()

	findings, err := RunScan(root, "local")
	if err != nil {
		t.Fatalf("RunScan(local) error = %v", err)
	}
	assertFinding(t, findings, ".dump.env", "environment")
}

func TestRunScanRejectsUnknownMode(t *testing.T) {
	root := newGitRepo(t)
	writeFile(t, root, "README.md", "# SpacKt\n")
	git(t, root, "add", "README.md")
	git(t, root, "commit", "-m", "add readme")

	if _, err := RunScan(root, "working-tree"); err == nil {
		t.Fatal("RunScan() error = nil, want unknown mode error")
	}
}

func TestRunReturnsZeroForCleanIndex(t *testing.T) {
	root := newGitRepo(t)
	writeFile(t, root, "README.md", "# SpacKt\n")
	git(t, root, "add", "README.md")
	git(t, root, "commit", "-m", "add readme")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := run([]string{"-root", root, "-mode", "index"}, &stdout, &stderr)

	if code != 0 {
		t.Fatalf("run() code = %d, want 0\nstdout=%s\nstderr=%s", code, stdout.String(), stderr.String())
	}
}

func TestRunReturnsNonzeroForBadRepository(t *testing.T) {
	root := filepath.Join(t.TempDir(), "missing")
	var stdout bytes.Buffer
	var stderr bytes.Buffer

	if code := run([]string{"-root", root, "-mode", "index"}, &stdout, &stderr); code == 0 {
		t.Fatalf("run() code = 0, want nonzero\nstdout=%s\nstderr=%s", stdout.String(), stderr.String())
	}
}

func TestRunReportsFindingsForBadHeadRepository(t *testing.T) {
	root := newGitRepo(t)
	writeFile(t, root, "package.json", `{"private": true}`)
	git(t, root, "add", "package.json")
	git(t, root, "commit", "-m", "add bad root manifest")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	code := run([]string{"-root", root, "-mode", "head"}, &stdout, &stderr)
	output := stdout.String() + stderr.String()

	if code == 0 {
		t.Fatalf("run() code = 0, want nonzero\nstdout=%s\nstderr=%s", stdout.String(), stderr.String())
	}
	if !strings.Contains(output, "package.json") {
		t.Fatalf("run() output missing package.json\nstdout=%s\nstderr=%s", stdout.String(), stderr.String())
	}
	if !strings.Contains(strings.ToLower(output), "root javascript") {
		t.Fatalf("run() output missing root JavaScript reason\nstdout=%s\nstderr=%s", stdout.String(), stderr.String())
	}
}

func TestRunReturnsNonzeroForInvalidMode(t *testing.T) {
	root := newGitRepo(t)
	writeFile(t, root, "README.md", "# SpacKt\n")
	git(t, root, "add", "README.md")
	git(t, root, "commit", "-m", "add readme")

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if code := run([]string{"-root", root, "-mode", "staged"}, &stdout, &stderr); code == 0 {
		t.Fatalf("run() code = 0, want nonzero\nstdout=%s\nstderr=%s", stdout.String(), stderr.String())
	}
}

func assertFinding(t *testing.T, findings []Finding, path string, reasonContains string) {
	t.Helper()
	for _, finding := range findings {
		if finding.Path == path && strings.Contains(strings.ToLower(finding.Reason), strings.ToLower(reasonContains)) {
			return
		}
	}
	t.Fatalf("missing finding path %q reason containing %q in %#v", path, reasonContains, findings)
}

func assertNoFindingForPath(t *testing.T, findings []Finding, path string) {
	t.Helper()
	for _, finding := range findings {
		if finding.Path == path {
			t.Fatalf("unexpected finding for %q: %#v", path, finding)
		}
	}
}

func newGitRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	git(t, root, "init")
	git(t, root, "config", "user.email", "test@example.invalid")
	git(t, root, "config", "user.name", "Repository Gate Test")
	return root
}

func writeFile(t *testing.T, root string, name string, data string) {
	t.Helper()
	fullPath := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(fullPath), err)
	}
	if err := os.WriteFile(fullPath, []byte(data), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

func removeFile(t *testing.T, root string, name string) {
	t.Helper()
	if err := os.Remove(filepath.Join(root, filepath.FromSlash(name))); err != nil {
		t.Fatalf("remove %s: %v", name, err)
	}
}

func git(t *testing.T, root string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = root
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s failed: %v\n%s", strings.Join(args, " "), err, string(output))
	}
}
