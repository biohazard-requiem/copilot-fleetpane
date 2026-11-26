package ui

import (
	"strings"
	"testing"
	"time"
	"unicode"
)

// bidiControls are all code points with the Unicode property Bidi_Control.
const bidiControls = "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"

func TestClean(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"plain text", `grep "joinSession" ext/`, `grep "joinSession" ext/`},
		{"Chinese and emoji", "读取 文件 🚀 ok", "读取 文件 🚀 ok"},
		{"emoji joined by ZWJ", "👨\u200d👩\u200d👧 é", "👨\u200d👩\u200d👧 é"},
		{"SGR sequences", "a\x1b[31mred\x1b[0m b", "ared b"},
		{"OSC window title", "\x1b]0;evil\x07x", "x"},
		{"OSC 8 hyperlink", "\x1b]8;;http://example.com\x1b\\link\x1b]8;;\x1b\\", "link"},
		{"cursor movement", "a\x1b[2J\x1b[Hb", "ab"},
		{"C0", "a\x00b\x07c\x08d\x1fe", "abcde"},
		{"trailing ESC", "ab\x1b", "ab"},
		{"DEL", "a\x7fb", "ab"},
		{"C1", "a\u0080b\u0085c\u009bd\u009fe", "abcde"},
		{"bidi controls of the plan", "a\u061cb\u200ec\u202ed\u2066e", "abcde"},
		{"every bidi control", "a" + bidiControls + "b", "ab"},
		{"newline and tab", "a\nb\tc", "a b c"},
		{"CR LF", "a\r\nb", "a b"},
		{"everything at once", "\x1b[1mfix\x1b[0m:\t读取\n🚀\u202e\u009b\x7f!", "fix: 读取 🚀!"},
		{"empty", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Clean(tt.in); got != tt.want {
				t.Errorf("Clean(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestCleanLeavesNoControlCharacter(t *testing.T) {
	var in strings.Builder
	for r := rune(0); r <= 0xa0; r++ {
		in.WriteRune(r)
		in.WriteString("x")
	}
	in.WriteString(bidiControls)

	for _, r := range Clean(in.String()) {
		if unicode.IsControl(r) || unicode.Is(unicode.Bidi_Control, r) {
			t.Errorf("Clean left %U in its result", r)
		}
	}
}

func TestFormatElapsed(t *testing.T) {
	tests := []struct {
		d    time.Duration
		want string
	}{
		{5 * time.Second, "0:05"},
		{72 * time.Second, "1:12"},
		{3723 * time.Second, "1:02:03"},
		{0, "0:00"},
		{5900 * time.Millisecond, "0:05"},
		{59*time.Minute + 59*time.Second, "59:59"},
		{time.Hour, "1:00:00"},
		{-3 * time.Second, "0:00"},
	}
	for _, tt := range tests {
		if got := FormatElapsed(tt.d); got != tt.want {
			t.Errorf("FormatElapsed(%v) = %q, want %q", tt.d, got, tt.want)
		}
	}
}

func TestWidth(t *testing.T) {
	tests := []struct {
		s    string
		want int
	}{
		{"", 0},
		{"abc", 3},
		{"中文", 4},
		{"a🚀b", 4},
		{"👨\u200d👩\u200d👧", 2},
		{"✓ done", 6},
	}
	for _, tt := range tests {
		if got := Width(tt.s); got != tt.want {
			t.Errorf("Width(%q) = %d, want %d", tt.s, got, tt.want)
		}
	}
}

func TestTruncate(t *testing.T) {
	tests := []struct {
		s    string
		w    int
		want string
	}{
		{"explore-auth", 12, "explore-auth"},
		{"explore-auth", 20, "explore-auth"},
		{"explore-auth", 11, "explore-au…"},
		{"explore-auth", 1, "…"},
		{"explore-auth", 0, ""},
		{"explore-auth", -1, ""},
		{"中文字符", 8, "中文字符"},
		{"中文字符", 5, "中文…"},
		// 文 would end in the cell the ellipsis needs.
		{"中文字符", 4, "中…"},
		{"a🚀b", 3, "a…"},
		{"", 3, ""},
	}
	for _, tt := range tests {
		got := Truncate(tt.s, tt.w)
		if got != tt.want {
			t.Errorf("Truncate(%q, %d) = %q, want %q", tt.s, tt.w, got, tt.want)
		}
		if w := Width(got); w > max(tt.w, 0) {
			t.Errorf("Truncate(%q, %d) = %q is %d cells wide", tt.s, tt.w, got, w)
		}
	}
}
