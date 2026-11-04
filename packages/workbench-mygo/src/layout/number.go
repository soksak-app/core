package layout

import (
	"math"
	"strconv"
)

// The arithmetic of the JavaScript layout model, where it differs from the Go library: the shared cases compare the two models
// value for value, so each function here gives the value the JavaScript operation gives. JavaScript rounds every product before
// it adds it, and Go may fuse a product and a sum into one rounding, so each product that is added is converted with float64,
// which rounds it first.

func itoa(i int) string { return strconv.Itoa(i) }

// jsRound is Math.round: the nearest integer, and the larger one at a half.
func jsRound(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}
	floor := math.Floor(x)
	if x-floor >= 0.5 {
		return floor + 1
	}
	return floor
}

// jsString is the text of a number as String(v) gives it for a value that is not finite, and the shortest text that reads back
// as the same value otherwise. The callers compare the texts of finite values with each other or show a value that is not
// finite, so the shortest text stands for the JavaScript one.
func jsString(v float64) string {
	switch {
	case math.IsNaN(v):
		return "NaN"
	case math.IsInf(v, 1):
		return "Infinity"
	case math.IsInf(v, -1):
		return "-Infinity"
	}
	// -0 reads as 0 in JavaScript.
	return strconv.FormatFloat(v+0, 'g', -1, 64)
}

// toFixed2 is Number.prototype.toFixed(2): the exact value of x rounded to two decimals, with a tie taking the value further from
// zero, and a minus sign for any negative value.
func toFixed2(x float64) string {
	switch {
	case math.IsNaN(x):
		return "NaN"
	case math.IsInf(x, 1):
		return "Infinity"
	case math.IsInf(x, -1):
		return "-Infinity"
	}
	sign := ""
	if x < 0 {
		sign = "-"
		x = -x
	}
	// x lies midway between two hundredths only if 100x is an odd number of halves, and a binary fraction with that value is an
	// odd number of eighths, less than 2^53 of them. A tie takes the larger neighbour, and FormatFloat takes the exact value of
	// any other x to the nearest one.
	if eighths := x * 8; eighths == math.Floor(eighths) && math.Mod(eighths, 2) == 1 {
		cents := (25*uint64(eighths) + 1) / 2
		return sign + strconv.FormatUint(cents/100, 10) + "." + strconv.FormatUint(100+cents%100, 10)[1:]
	}
	return sign + strconv.FormatFloat(x, 'f', 2, 64)
}
