package precision_test

import (
	"testing"

	"spackt/internal/precision"
)

func TestParsePriceConvertsCentsWithoutBinaryFloatDrift(t *testing.T) {
	ticks, err := precision.ParsePrice("0.29")
	if err != nil {
		t.Fatalf("ParsePrice returned error: %v", err)
	}
	if ticks != 29 {
		t.Fatalf("ParsePrice(\"0.29\") = %d ticks, want 29", ticks)
	}
}

func TestParseQuantityConvertsLotsWithoutBinaryFloatDrift(t *testing.T) {
	lots, err := precision.ParseQuantity("1.2300")
	if err != nil {
		t.Fatalf("ParseQuantity returned error: %v", err)
	}
	if lots != 12300 {
		t.Fatalf("ParseQuantity(\"1.2300\") = %d lots, want 12300", lots)
	}
}

func TestParsePriceRejectsExcessPrecision(t *testing.T) {
	if _, err := precision.ParsePrice("1.001"); err == nil {
		t.Fatal("ParsePrice accepted a price with more than two decimal places")
	}
}

func TestParseQuantityRejectsExponentNotation(t *testing.T) {
	if _, err := precision.ParseQuantity("1e-4"); err == nil {
		t.Fatal("ParseQuantity accepted exponent notation")
	}
}

func TestFormatPricePreservesTwoDecimalPlaces(t *testing.T) {
	got := precision.FormatPrice(6423050)
	if got != "64230.50" {
		t.Fatalf("FormatPrice(6423050) = %q, want %q", got, "64230.50")
	}
}
