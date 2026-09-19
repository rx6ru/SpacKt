package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
)

type Summary struct {
	Covered int64
	Total   int64
	Percent float64
}

var recordPattern = regexp.MustCompile(`^.+:\d+\.\d+,\d+\.\d+ ([0-9]+) ([0-9]+)$`)

func CheckCoverage(r io.Reader, minPercent float64) (Summary, error) {
	var summary Summary
	if math.IsNaN(minPercent) || math.IsInf(minPercent, 0) || minPercent < 0 || minPercent > 100 {
		return summary, errors.New("minimum coverage must be between 0 and 100")
	}
	scanner := bufio.NewScanner(r)
	if !scanner.Scan() {
		return summary, errors.New("coverage profile is empty")
	}
	switch strings.TrimSpace(scanner.Text()) {
	case "mode: set", "mode: count", "mode: atomic":
	default:
		return summary, errors.New("invalid coverage mode header")
	}
	line := 1
	for scanner.Scan() {
		line++
		text := strings.TrimSpace(scanner.Text())
		if text == "" {
			continue
		}
		fields := recordPattern.FindStringSubmatch(text)
		if fields == nil {
			return summary, fmt.Errorf("invalid coverage record at line %d", line)
		}
		statements, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil {
			return summary, fmt.Errorf("invalid statement count at line %d", line)
		}
		count, err := strconv.ParseUint(fields[2], 10, 64)
		if err != nil {
			return summary, fmt.Errorf("invalid execution count at line %d", line)
		}
		if statements > math.MaxInt64-summary.Total {
			return summary, errors.New("coverage statement total overflows")
		}
		summary.Total += statements
		if count > 0 {
			summary.Covered += statements
		}
	}
	if err := scanner.Err(); err != nil {
		return summary, fmt.Errorf("read coverage: %w", err)
	}
	if summary.Total == 0 {
		return summary, errors.New("coverage profile has no statements")
	}
	summary.Percent = float64(summary.Covered) / float64(summary.Total) * 100
	if summary.Percent < minPercent {
		return summary, fmt.Errorf("coverage %.2f%% is below minimum %.2f%%", summary.Percent, minPercent)
	}
	return summary, nil
}

func run(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("checkcoverage", flag.ContinueOnError)
	flags.SetOutput(stderr)
	profile := flags.String("profile", "", "Go coverage profile path")
	minimum := flags.Float64("min", 80, "minimum statement coverage percentage")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *profile == "" || flags.NArg() != 0 {
		fmt.Fprintln(stderr, "provide -profile <path> and optional -min <percent>")
		return 2
	}
	file, err := os.Open(*profile)
	if err != nil {
		fmt.Fprintf(stderr, "open coverage profile: %v\n", err)
		return 2
	}
	defer file.Close()
	summary, err := CheckCoverage(file, *minimum)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintf(stdout, "Go statement coverage: %.2f%% (%d/%d); minimum %.2f%%\n", summary.Percent, summary.Covered, summary.Total, *minimum)
	return 0
}
func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }
