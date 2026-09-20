package architecture

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestBackendImportBoundariesMatchArchitectureDocument(t *testing.T) {
	root := filepath.Join("..", "..")
	allowed := map[string][]string{
		"cmd/server":              {"internal/transport", "internal/market", "internal/delivery", "internal/config"},
		"internal/transport":      {"internal/transport/wire", "internal/delivery", "internal/model", "internal/precision"},
		"internal/market":         {"internal/sim", "internal/candle", "internal/model"},
		"internal/sim":            {"internal/matching", "internal/model"},
		"internal/matching":       {"internal/model"},
		"internal/candle":         {"internal/model"},
		"internal/tier":           {"internal/model"},
		"internal/delivery":       {"internal/tier", "internal/model"},
		"internal/precision":      {"internal/model"},
		"internal/config":         {},
		"internal/transport/wire": {"internal/model", "internal/precision"},
		"internal/model":          {},
	}
	for pkg, allowedLocal := range allowed {
		dir := filepath.Join(root, filepath.FromSlash(pkg))
		entries, err := os.ReadDir(dir)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			t.Fatal(err)
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
				continue
			}
			file := filepath.Join(dir, entry.Name())
			parsed, err := parser.ParseFile(token.NewFileSet(), file, nil, parser.ImportsOnly)
			if err != nil {
				t.Fatalf("parse imports from %s: %v", file, err)
			}
			for _, imp := range parsed.Imports {
				path := strings.Trim(imp.Path.Value, `"`)
				if !strings.HasPrefix(path, "spackt/") {
					continue
				}
				local := strings.TrimPrefix(path, "spackt/")
				if !slices.Contains(allowedLocal, local) {
					t.Fatalf("%s imports %s; allowed local imports are %v", pkg, local, allowedLocal)
				}
			}
		}
	}
}

func TestDomainModelDoesNotImportTransportOrFrameworkPackages(t *testing.T) {
	checkPurePackage(t, filepath.Join("..", "..", "internal", "model"))
}

func TestPurePackagesDoNotImportTransportJSONWebSocketOrThirdPartyPackages(t *testing.T) {
	for _, pkg := range []string{"model", "matching", "candle", "sim", "tier", "precision", "config"} {
		checkPurePackage(t, filepath.Join("..", "..", "internal", pkg))
	}
}

func TestPureImportCheckerAllowsStandardMathAndLocalModel(t *testing.T) {
	source := `package precision

import (
	"math"
	"spackt/internal/model"
)

var _ = math.Max
var _ = model.Trade{}
`
	if violations := pureImportViolations("precision", "allowed.go", source); len(violations) != 0 {
		t.Fatalf("pure import checker rejected allowed imports: %v", violations)
	}
}

func TestPureImportCheckerRejectsTransportEncodingAndThirdPartyImports(t *testing.T) {
	source := `package model

import (
	"encoding/json"
	"net/http"
	"github.com/coder/websocket"
)

var _ = json.Valid
var _ = http.MethodGet
var _ = websocket.StatusNormalClosure
`
	violations := pureImportViolations("model", "forbidden.go", source)
	for _, want := range []string{"encoding/json", "net/http", "github.com/coder/websocket"} {
		if !slices.ContainsFunc(violations, func(got string) bool { return strings.Contains(got, want) }) {
			t.Fatalf("pure import checker did not reject %s; violations were %v", want, violations)
		}
	}
}

func checkPurePackage(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return
		}
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		file := filepath.Join(dir, entry.Name())
		source, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if violations := pureImportViolations(filepath.Base(dir), file, string(source)); len(violations) != 0 {
			t.Fatalf("pure package import violation:\n%s", strings.Join(violations, "\n"))
		}
	}
}

func pureImportViolations(pkg, filename, source string) []string {
	parsed, err := parser.ParseFile(token.NewFileSet(), filename, source, parser.ImportsOnly)
	if err != nil {
		return []string{"parse imports from " + filename + ": " + err.Error()}
	}
	var violations []string
	for _, imp := range parsed.Imports {
		path := strings.Trim(imp.Path.Value, `"`)
		switch {
		case path == "encoding/json" || path == "net/http":
			violations = append(violations, pkg+" must not import transport or JSON package "+path+" in "+filename)
		case strings.Contains(path, "websocket"):
			violations = append(violations, pkg+" must not import WebSocket package "+path+" in "+filename)
		case strings.HasPrefix(path, "spackt/"):
			continue
		case strings.Contains(path, "."):
			violations = append(violations, pkg+" must not import third-party package "+path+" in "+filename)
		}
	}
	return violations
}
