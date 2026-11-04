package layout

import (
	"math"
	"math/big"
	"strconv"
	"strings"
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
	// The exact decimal expansion of x: a binary fraction ends, and 1100 places hold every float64.
	exact := new(big.Float).SetFloat64(x).Text('f', 1100)
	point := strings.IndexByte(exact, '.')
	whole, fraction := exact[:point], exact[point+1:]
	rest := strings.TrimRight(fraction[2:], "0")
	if rest == "5" {
		// A tie: the larger of the two neighbours.
		// silent: the text is the decimal digits that big.Float.Text wrote, which SetString always reads.
		cents, _ := new(big.Int).SetString(whole+fraction[:2], 10)
		text := cents.Add(cents, big.NewInt(1)).String()
		if len(text) < 3 {
			text = strings.Repeat("0", 3-len(text)) + text
		}
		return sign + text[:len(text)-2] + "." + text[len(text)-2:]
	}
	return sign + strconv.FormatFloat(x, 'f', 2, 64)
}
