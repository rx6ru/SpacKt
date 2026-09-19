package precision

import (
	"errors"
	"strconv"
)

const maxSafeInteger = int64(1<<53 - 1)

var errInvalidDecimal = errors.New("invalid decimal")

func ParsePrice(text string) (int64, error) {
	return parseFixed(text, 2)
}

func ParseQuantity(text string) (int64, error) {
	return parseFixed(text, 4)
}

func FormatPrice(ticks int64) string {
	return formatFixed(ticks, 2)
}

func FormatQuantity(lots int64) string {
	return formatFixed(lots, 4)
}

func parseFixed(text string, scale int) (int64, error) {
	if text == "" {
		return 0, errInvalidDecimal
	}

	var whole int64
	var frac int64
	seenDot := false
	fracDigits := 0
	digits := 0

	for _, ch := range text {
		switch {
		case ch >= '0' && ch <= '9':
			digit := int64(ch - '0')
			digits++
			if seenDot {
				fracDigits++
				if fracDigits > scale {
					return 0, errInvalidDecimal
				}
				frac = frac*10 + digit
				continue
			}
			if whole > (maxSafeInteger-digit)/10 {
				return 0, errInvalidDecimal
			}
			whole = whole*10 + digit
		case ch == '.':
			if seenDot {
				return 0, errInvalidDecimal
			}
			seenDot = true
		default:
			return 0, errInvalidDecimal
		}
	}

	if digits == 0 || (seenDot && fracDigits == 0) {
		return 0, errInvalidDecimal
	}

	multiplier := int64(1)
	for i := 0; i < scale; i++ {
		multiplier *= 10
	}
	for fracDigits < scale {
		frac *= 10
		fracDigits++
	}
	if whole > (maxSafeInteger-frac)/multiplier {
		return 0, errInvalidDecimal
	}
	return whole*multiplier + frac, nil
}

func formatFixed(value int64, scale int) string {
	if value < 0 {
		return "-" + formatFixed(-value, scale)
	}
	multiplier := int64(1)
	for i := 0; i < scale; i++ {
		multiplier *= 10
	}
	whole := value / multiplier
	frac := value % multiplier
	return strconv.FormatInt(whole, 10) + "." + leftPadZeros(strconv.FormatInt(frac, 10), scale)
}

func leftPadZeros(text string, length int) string {
	for len(text) < length {
		text = "0" + text
	}
	return text
}
