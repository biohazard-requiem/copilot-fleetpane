package ui

import (
	"fmt"
	"strings"
	"time"
	"unicode"

	"github.com/charmbracelet/x/ansi"
)

// Clean makes a string from outside (names, summaries, error texts) safe to
// draw: escape sequences are stripped, newlines and tabs become spaces, and
// the remaining C0 and C1 controls, DEL and the Unicode bidirectional
// controls are dropped. Everything else, such as Chinese and emoji, is kept.
func Clean(s string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r == '\n' || r == '\t':
			return ' '
		case unicode.IsControl(r) || unicode.Is(unicode.Bidi_Control, r):
			return -1
		}
		return r
	}, ansi.Strip(s))
}

// Width returns the number of cells s takes on the canvas.
func Width(s string) int { return ansi.StringWidth(s) }

// Truncate shortens s to at most w cells. A shortened string ends with "…",
// which counts towards w.
func Truncate(s string, w int) string { return ansi.Truncate(s, w, Ellipsis) }

// FormatElapsed formats a duration as m:ss, or as h:mm:ss from one hour on.
// Negative durations count as zero.
func FormatElapsed(d time.Duration) string {
	s := max(int(d/time.Second), 0)
	if s < 3600 {
		return fmt.Sprintf("%d:%02d", s/60, s%60)
	}
	return fmt.Sprintf("%d:%02d:%02d", s/3600, s/60%60, s%60)
}
