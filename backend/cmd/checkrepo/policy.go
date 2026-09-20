package main

import (
	"path"
	"regexp"
	"strings"
	"unicode"
)

type Entry struct {
	Path string
	Data []byte
	Mode string
}
type Finding struct {
	Path   string
	Reason string
}

var rootFiles = map[string]bool{"README.md": true, "AGENTS.md": true, "CONTRIBUTING.md": true, "LICENSE": true, "NOTICE": true, ".gitignore": true, ".dockerignore": true, "compose.yaml": true, "render.yaml": true, "Makefile": true}
var nodeFiles = map[string]bool{"package.json": true, "package-lock.json": true, "npm-shrinkwrap.json": true, "pnpm-lock.yaml": true, "pnpm-workspace.yaml": true, "yarn.lock": true, "bun.lock": true, "bun.lockb": true}
var generatedNames = map[string]bool{"node_modules": true, ".pnpm-store": true, ".next": true, "out": true, "coverage": true, "playwright-report": true, "test-results": true, ".gocache": true, ".cache": true}
var privateNames = map[string]bool{"agents.md": true, "claude.md": true, ".omx": true, ".codex": true, ".claude": true, ".agents": true, "dev_n_aidocs": true, "kb": true, "assignment_details": true, "user_given": true, ".worktrees": true}
var planningFiles = map[string]bool{"prd.md": true, "implementation-plan.md": true, "test-plan.md": true, "acceptance-map.md": true, "handoff.md": true, "user-prompts.md": true, "execution-report.md": true, "session-log.md": true}
var phaseFile = regexp.MustCompile(`(?i)^p\d{2}(?:-p\d{2})?\.md$`)
var planningHeading = regexp.MustCompile(`(?i)^(?:.*\b(?:product requirements(?: document)?|implementation plan|independent test plan|test plan|acceptance map|execution report|session log|conversation record|red contract)\b.*|prd(?:\b.*)?|p\d{2}(?:\b.*)?|verified (?:red|green)(?:\b.*)?)$`)
var privateLink = regexp.MustCompile(`(?i)(?:^|[\s/(<])(?:dev_n_aidocs|kb|assignment_details|user_given|\.worktrees)/|(?:^|[\s/(<])\.dump\.env\b|(?:^|[\s(<])/(?:home|Users|tmp)/|[A-Za-z]:\\Users\\`)

func Evaluate(entries []Entry) []Finding {
	var findings []Finding
	for _, entry := range entries {
		reason := pathReason(entry)
		if reason == "" && strings.EqualFold(path.Ext(entry.Path), ".md") {
			reason = documentReason(string(entry.Data))
		}
		if reason != "" {
			findings = append(findings, Finding{Path: entry.Path, Reason: reason})
		}
	}
	return findings
}

func pathReason(entry Entry) string {
	p := entry.Path
	if p == "" || path.IsAbs(p) || path.Clean(p) != p || p == ".." || strings.HasPrefix(p, "../") || strings.Contains(p, "\\") || strings.ContainsFunc(p, unicode.IsControl) {
		return "use a canonical repository-relative path"
	}
	if entry.Mode == "symlink" {
		return "tracked symlinks are not permitted"
	}
	if entry.Mode != "file" && entry.Mode != "dir" {
		return "unsupported or unmerged repository entry"
	}
	parts := strings.Split(p, "/")
	base := parts[len(parts)-1]
	lower := strings.ToLower(base)
	if isEnvironment(base) {
		if p == "web/.env.example" || p == "backend/.env.example" {
			return ""
		}
		if lower == ".env.example" {
			return "keep example environment files inside web or backend, not the root"
		}
		return "actual environment files are private and must not ship"
	}
	if len(parts) == 1 && nodeFiles[lower] {
		return "root JavaScript tooling is prohibited; move frontend tooling into web"
	}
	if len(parts) == 1 && generatedNames[lower] {
		return "remove generated root artifacts; frontend dependencies belong in web"
	}
	if p == "AGENTS.md" {
		if entry.Mode == "file" {
			return ""
		}
		return "root AGENTS.md must be a regular file"
	}
	for _, part := range parts {
		name := strings.ToLower(part)
		if generatedNames[name] {
			return "generated dependencies, caches, builds, and reports must not be tracked"
		}
		if privateNames[name] {
			return "private workspace and local tool material must remain outside the repository"
		}
	}
	if strings.HasSuffix(lower, ".log") || strings.HasSuffix(lower, ".tsbuildinfo") || lower == "coverage.out" || lower == ".ds_store" {
		return "generated output must not be tracked"
	}
	if planningFiles[lower] || phaseFile.MatchString(lower) {
		return "private planning and development reports must remain outside the repository"
	}
	if len(parts) == 1 {
		if entry.Mode == "file" && rootFiles[p] {
			return ""
		}
		if entry.Mode == "dir" && (p == "backend" || p == "web" || p == "docs" || p == "protocol" || p == ".github") {
			return ""
		}
		return "unknown top-level path; use the documented repository layout"
	}
	switch parts[0] {
	case "backend":
		ext := strings.ToLower(path.Ext(p))
		if nodeFiles[lower] || ext == ".js" || ext == ".jsx" || ext == ".ts" || ext == ".tsx" || ext == ".mjs" || ext == ".cjs" {
			return "backend contains Go; move frontend JavaScript tooling into web"
		}
	case "web":
		if lower == "go.mod" || lower == "go.sum" || strings.HasSuffix(lower, ".go") {
			return "web contains the frontend; move Go source and modules into backend"
		}
	case "docs":
	case "fixtures":
		return "move shared fixtures into protocol/fixtures"
	case "protocol":
		if len(parts) < 3 || parts[1] != "fixtures" {
			return "top-level protocol content belongs under protocol/fixtures"
		}
	case ".github":
		if len(parts) < 3 || parts[1] != "workflows" {
			return "top-level .github content belongs under .github/workflows"
		}
	case ".githooks":
		if p != ".githooks/pre-commit" {
			return "only .githooks/pre-commit is allowed"
		}
	default:
		return "unknown top-level path; use the documented repository layout"
	}
	return ""
}

func isEnvironment(name string) bool {
	lower := strings.ToLower(name)
	return lower == ".env" || strings.HasPrefix(lower, ".env.") || strings.HasSuffix(lower, ".env")
}

func documentReason(data string) string {
	fence := ""
	previous := ""
	for _, line := range strings.Split(data, "\n") {
		text := strings.TrimSpace(line)
		if strings.HasPrefix(text, "```") || strings.HasPrefix(text, "~~~") {
			marker := text[:3]
			if fence == "" {
				fence = marker
			} else if fence == marker {
				fence = ""
			}
			previous = ""
			continue
		}
		if fence != "" {
			continue
		}
		heading := ""
		if strings.HasPrefix(text, "#") {
			heading = strings.TrimSpace(strings.Trim(text, "# "))
		}
		if text != "" && (strings.Trim(text, "=") == "" || strings.Trim(text, "-") == "") {
			heading = previous
		}
		if heading != "" && planningHeading.MatchString(heading) {
			return "private planning and development reports must remain outside the repository"
		}
		if privateLink.MatchString(text) {
			return "remove private workspace links and absolute workstation paths"
		}
		previous = text
	}
	return ""
}
