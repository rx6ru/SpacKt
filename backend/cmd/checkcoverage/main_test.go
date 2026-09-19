package main

import (
	"bytes"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheckCoverageAcceptsWeightedCoverageAtMinimum(t *testing.T) {
	summary, err := CheckCoverage(strings.NewReader(strings.Join([]string{
		"mode: set",
		"spackt/internal/foo/foo.go:1.1,8.2 8 1",
		"spackt/internal/foo/foo.go:9.1,10.2 2 0",
		"",
	}, "\n")), 80)

	if err != nil {
		t.Fatalf("CheckCoverage returned error: %v", err)
	}
	if summary.Covered != 8 || summary.Total != 10 || summary.Percent != 80 {
		t.Fatalf("summary = %#v, want 8 covered, 10 total, 80 percent", summary)
	}
}

func TestCheckCoverageRejectsWeightedCoverageBelowMinimum(t *testing.T) {
	summary, err := CheckCoverage(strings.NewReader(strings.Join([]string{
		"mode: set",
		"spackt/internal/foo/foo.go:1.1,79.2 79 1",
		"spackt/internal/foo/foo.go:80.1,100.2 21 0",
		"",
	}, "\n")), 80)

	if err == nil {
		t.Fatalf("CheckCoverage returned nil error for below-threshold summary %#v", summary)
	}
	if summary.Covered != 79 || summary.Total != 100 || summary.Percent != 79 {
		t.Fatalf("summary = %#v, want 79 covered, 100 total, 79 percent", summary)
	}
}

func TestCheckCoverageRejectsEmptyProfile(t *testing.T) {
	summary, err := CheckCoverage(strings.NewReader(""), 80)

	if err == nil {
		t.Fatalf("CheckCoverage returned nil error for empty profile summary %#v", summary)
	}
}

func TestCheckCoverageRejectsProfileWithNoStatementRecords(t *testing.T) {
	summary, err := CheckCoverage(strings.NewReader("mode: set\n"), 80)

	if err == nil {
		t.Fatalf("CheckCoverage returned nil error for profile with no statement records summary %#v", summary)
	}
}

func TestCheckCoverageRejectsInvalidHeader(t *testing.T) {
	summary, err := CheckCoverage(strings.NewReader(strings.Join([]string{
		"coverage: set",
		"spackt/internal/foo/foo.go:1.1,2.2 1 1",
		"",
	}, "\n")), 80)

	if err == nil {
		t.Fatalf("CheckCoverage returned nil error for invalid header summary %#v", summary)
	}
}

func TestCheckCoverageRejectsUnsupportedMode(t *testing.T) {
	summary, err := CheckCoverage(strings.NewReader(strings.Join([]string{
		"mode: unsupported",
		"spackt/internal/foo/foo.go:1.1,2.2 1 1",
		"",
	}, "\n")), 80)

	if err == nil {
		t.Fatalf("CheckCoverage returned nil error for unsupported mode summary %#v", summary)
	}
}

func TestCheckCoverageRejectsMalformedStatementRecord(t *testing.T) {
	summary, err := CheckCoverage(strings.NewReader(strings.Join([]string{
		"mode: set",
		"spackt/internal/foo/foo.go:1.1,2.2 one 1",
		"",
	}, "\n")), 80)

	if err == nil {
		t.Fatalf("CheckCoverage returned nil error for malformed statement record summary %#v", summary)
	}
}

func TestCheckCoverageRejectsZeroTotalStatements(t *testing.T) {
	summary, err := CheckCoverage(strings.NewReader(strings.Join([]string{
		"mode: set",
		"spackt/internal/foo/foo.go:1.1,2.2 0 1",
		"",
	}, "\n")), 80)

	if err == nil {
		t.Fatalf("CheckCoverage returned nil error for zero-total profile summary %#v", summary)
	}
}

func TestCheckCoverageRejectsInvalidMinimumThresholds(t *testing.T) {
	profile := strings.Join([]string{
		"mode: set",
		"spackt/internal/foo/foo.go:1.1,2.2 1 1",
		"",
	}, "\n")

	for _, minPercent := range []float64{math.NaN(), -1, 101} {
		summary, err := CheckCoverage(strings.NewReader(profile), minPercent)
		if err == nil {
			t.Fatalf("CheckCoverage returned nil error for minPercent %v summary %#v", minPercent, summary)
		}
	}
}

func TestCheckCoverageAcceptsOneFullyCoveredProfile(t *testing.T) {
	summary, err := CheckCoverage(strings.NewReader(strings.Join([]string{
		"mode: count",
		"spackt/internal/foo/foo.go:1.1,2.2 1 3",
		"",
	}, "\n")), 80)

	if err != nil {
		t.Fatalf("CheckCoverage returned error: %v", err)
	}
	if summary.Covered != 1 || summary.Total != 1 || summary.Percent != 100 {
		t.Fatalf("summary = %#v, want 1 covered, 1 total, 100 percent", summary)
	}
}

func TestCheckCoverageAcceptsAtomicModeProfile(t *testing.T) {
	summary, err := CheckCoverage(strings.NewReader(strings.Join([]string{
		"mode: atomic",
		"spackt/internal/foo/foo.go:1.1,2.2 3 2",
		"spackt/internal/foo/foo.go:3.1,4.2 1 0",
		"",
	}, "\n")), 75)

	if err != nil {
		t.Fatalf("CheckCoverage returned error: %v", err)
	}
	if summary.Covered != 3 || summary.Total != 4 || summary.Percent != 75 {
		t.Fatalf("summary = %#v, want 3 covered, 4 total, 75 percent", summary)
	}
}

func TestCheckCoverageMergesDuplicateBlocksBeforeCalculatingWeightedCoverage(t *testing.T) {
	summary, err := CheckCoverage(strings.NewReader(strings.Join([]string{
		"mode: set",
		"spackt/internal/foo/foo.go:1.1,8.2 8 0",
		"spackt/internal/foo/foo.go:1.1,8.2 8 1",
		"spackt/internal/foo/foo.go:9.1,10.2 2 0",
		"spackt/internal/foo/foo.go:9.1,10.2 2 0",
		"",
	}, "\n")), 80)

	if err != nil {
		t.Fatalf("CheckCoverage returned error: %v", err)
	}
	if summary.Covered != 8 || summary.Total != 10 || summary.Percent != 80 {
		t.Fatalf("summary = %#v, want duplicate blocks merged to 8 covered, 10 total, 80 percent", summary)
	}
}

func TestCheckCoverageRejectsDuplicateBlockWithInconsistentStatementCount(t *testing.T) {
	summary, err := CheckCoverage(strings.NewReader(strings.Join([]string{
		"mode: set",
		"spackt/internal/foo/foo.go:1.1,8.2 8 1",
		"spackt/internal/foo/foo.go:1.1,8.2 9 1",
		"",
	}, "\n")), 0)

	if err == nil {
		t.Fatalf("CheckCoverage returned nil error for inconsistent duplicate block summary %#v", summary)
	}
}

func TestRunUsesDefaultMinimumOfEighty(t *testing.T) {
	profile := writeCoverageProfile(t, strings.Join([]string{
		"mode: set",
		"spackt/internal/foo/foo.go:1.1,79.2 79 1",
		"spackt/internal/foo/foo.go:80.1,100.2 21 0",
		"",
	}, "\n"))
	var stdout bytes.Buffer
	var stderr bytes.Buffer

	status := run([]string{"-profile", profile}, &stdout, &stderr)

	if status == 0 {
		t.Fatalf("run status = 0 for 79 percent with default minimum; stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
	if !strings.Contains(stdout.String()+stderr.String(), "80") {
		t.Fatalf("run output %q %q does not mention default minimum 80", stdout.String(), stderr.String())
	}
}

func TestRunAcceptsExplicitMinimum(t *testing.T) {
	profile := writeCoverageProfile(t, strings.Join([]string{
		"mode: set",
		"spackt/internal/foo/foo.go:1.1,79.2 79 1",
		"spackt/internal/foo/foo.go:80.1,100.2 21 0",
		"",
	}, "\n"))
	var stdout bytes.Buffer
	var stderr bytes.Buffer

	status := run([]string{"-profile", profile, "-min", "79"}, &stdout, &stderr)

	if status != 0 {
		t.Fatalf("run status = %d, want 0; stdout=%q stderr=%q", status, stdout.String(), stderr.String())
	}
	if !strings.Contains(stdout.String()+stderr.String(), "79") {
		t.Fatalf("run output %q %q does not mention explicit minimum/result 79", stdout.String(), stderr.String())
	}
}

func TestRunReturnsNonzeroWhenThresholdFails(t *testing.T) {
	profile := writeCoverageProfile(t, strings.Join([]string{
		"mode: set",
		"spackt/internal/foo/foo.go:1.1,8.2 8 1",
		"spackt/internal/foo/foo.go:9.1,10.2 2 0",
		"",
	}, "\n"))
	var stdout bytes.Buffer
	var stderr bytes.Buffer

	status := run([]string{"-profile", profile, "-min", "81"}, &stdout, &stderr)

	if status == 0 {
		t.Fatalf("run status = 0 for below-threshold profile; stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
}

func TestRunReturnsNonzeroForMissingProfile(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer

	status := run([]string{"-profile", filepath.Join(t.TempDir(), "missing.out")}, &stdout, &stderr)

	if status == 0 {
		t.Fatalf("run status = 0 for missing profile; stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
	if !strings.Contains(strings.ToLower(stdout.String()+stderr.String()), "profile") {
		t.Fatalf("run output %q %q does not mention profile error", stdout.String(), stderr.String())
	}
}

func writeCoverageProfile(t *testing.T, text string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "coverage.out")
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatalf("write coverage profile: %v", err)
	}
	return path
}

var _ func([]string, io.Writer, io.Writer) int = run
