package main

import (
	"flag"
	"fmt"
	"io"
	"os"
)

func run(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("checkrepo", flag.ContinueOnError)
	flags.SetOutput(stderr)
	root := flags.String("root", ".", "repository root")
	mode := flags.String("mode", "local", "index, head, or local")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintln(stderr, "unexpected positional arguments")
		return 2
	}
	findings, err := RunScan(*root, *mode)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if len(findings) != 0 {
		for _, finding := range findings {
			fmt.Fprintf(stderr, "%q: %s\n", finding.Path, finding.Reason)
		}
		return 1
	}
	fmt.Fprintf(stdout, "Repository policy passed (%s).\n", *mode)
	return 0
}
func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }
