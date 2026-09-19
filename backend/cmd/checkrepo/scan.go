package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

type gitEntry struct{ path, mode, object string }

func RunScan(root, mode string) ([]Finding, error) {
	if mode != "index" && mode != "head" && mode != "local" {
		return nil, fmt.Errorf("unknown mode %q; use index, head, or local", mode)
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	var records []gitEntry
	switch mode {
	case "index":
		records, err = indexEntries(root)
	case "head":
		records, err = headEntries(root)
	case "local":
		records, err = localEntries(root)
	}
	if err != nil {
		return nil, err
	}
	entries := make([]Entry, 0, len(records))
	for _, record := range records {
		entry := Entry{Path: record.path, Mode: record.mode}
		// Reject forbidden paths before opening them, including actual env files.
		if pathReason(entry) == "" && strings.EqualFold(filepath.Ext(entry.Path), ".md") {
			if mode == "local" {
				entry.Data, err = os.ReadFile(filepath.Join(root, filepath.FromSlash(entry.Path)))
			} else {
				entry.Data, err = gitOutput(root, "cat-file", "blob", record.object)
			}
			if err != nil {
				return nil, fmt.Errorf("read document %q: %w", entry.Path, err)
			}
		}
		entries = append(entries, entry)
	}
	return Evaluate(entries), nil
}

func indexEntries(root string) ([]gitEntry, error) {
	data, err := gitOutput(root, "ls-files", "--stage", "-z")
	if err != nil {
		return nil, err
	}
	var out []gitEntry
	for _, record := range bytes.Split(data, []byte{0}) {
		if len(record) == 0 {
			continue
		}
		halves := bytes.SplitN(record, []byte{'\t'}, 2)
		if len(halves) != 2 {
			return nil, fmt.Errorf("invalid Git index entry")
		}
		fields := strings.Fields(string(halves[0]))
		if len(fields) != 3 {
			return nil, fmt.Errorf("invalid Git index metadata")
		}
		mode := fileMode(fields[0])
		if fields[2] != "0" {
			mode = "unmerged"
		}
		out = append(out, gitEntry{path: string(halves[1]), mode: mode, object: fields[1]})
	}
	return out, nil
}

func headEntries(root string) ([]gitEntry, error) {
	data, err := gitOutput(root, "ls-tree", "-rz", "--full-tree", "HEAD")
	if err != nil {
		return nil, err
	}
	var out []gitEntry
	for _, record := range bytes.Split(data, []byte{0}) {
		if len(record) == 0 {
			continue
		}
		halves := bytes.SplitN(record, []byte{'\t'}, 2)
		if len(halves) != 2 {
			return nil, fmt.Errorf("invalid Git tree entry")
		}
		fields := strings.Fields(string(halves[0]))
		if len(fields) != 3 {
			return nil, fmt.Errorf("invalid Git tree metadata")
		}
		out = append(out, gitEntry{path: string(halves[1]), mode: fileMode(fields[0]), object: fields[2]})
	}
	return out, nil
}

func localEntries(root string) ([]gitEntry, error) {
	data, err := gitOutput(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
	if err != nil {
		return nil, err
	}
	found := map[string]gitEntry{}
	add := func(name string) error {
		info, err := os.Lstat(filepath.Join(root, filepath.FromSlash(name)))
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		mode := "file"
		if info.Mode()&os.ModeSymlink != 0 {
			mode = "symlink"
		} else if info.IsDir() {
			mode = "dir"
		} else if !info.Mode().IsRegular() {
			mode = "unsupported"
		}
		found[name] = gitEntry{path: name, mode: mode}
		return nil
	}
	for _, record := range bytes.Split(data, []byte{0}) {
		if len(record) != 0 {
			if err := add(string(record)); err != nil {
				return nil, err
			}
		}
	}
	rootEntries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	for _, entry := range rootEntries {
		name := entry.Name()
		lower := strings.ToLower(name)
		if generatedNames[lower] || nodeFiles[lower] || isEnvironment(name) || strings.HasSuffix(lower, ".log") || lower == "coverage.out" {
			if err := add(name); err != nil {
				return nil, err
			}
		}
	}
	names := make([]string, 0, len(found))
	for name := range found {
		names = append(names, name)
	}
	sort.Strings(names)
	out := make([]gitEntry, 0, len(names))
	for _, name := range names {
		out = append(out, found[name])
	}
	return out, nil
}

func fileMode(mode string) string {
	switch mode {
	case "100644", "100755":
		return "file"
	case "120000":
		return "symlink"
	default:
		return "unsupported"
	}
}

func gitOutput(root string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
	data, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("Git repository read failed: %w", err)
	}
	return data, nil
}
