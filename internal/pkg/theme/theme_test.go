package theme

import (
	"fmt"
	"image/color"
	"slices"
	"testing"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// hex turns the "#rrggbb" notation into an RGB without going
// through the package's own parser.
func hex(t *testing.T, s string) RGB {
	t.Helper()
	var c RGB
	if _, err := fmt.Sscanf(s, "#%02x%02x%02x", &c.R, &c.G, &c.B); err != nil || len(s) != 7 {
		t.Fatalf("bad test color %q: %v", s, err)
	}
	return c
}

func mustLoad(t *testing.T, name, dir string) *Theme {
	t.Helper()
	th, err := Load(name, dir)
	if err != nil {
		t.Fatalf("Load(%q) failed: %v", name, err)
	}
	return th
}

func TestLoadBuiltinsNeedNoDirectory(t *testing.T) {
	for _, name := range []string{"auto", "gta6"} {
		for _, dir := range []string{"", "/nonexistent/themes"} {
			if th, err := Load(name, dir); err != nil || th == nil {
				t.Errorf("Load(%q, %q) failed: %v", name, dir, err)
			}
		}
	}
}

func TestGTA6MatchesAppendixD3(t *testing.T) {
	th := mustLoad(t, "gta6", "")

	if !th.HasBackground() {
		t.Error("HasBackground() = false, want true")
	}
	var stops []RGB
	for _, s := range []string{"#2b1d5c", "#57298a", "#a03a97", "#dd5a8b", "#f5896a", "#f9b880"} {
		stops = append(stops, hex(t, s))
	}
	if !slices.Equal(th.stops, stops) {
		t.Errorf("stops = %v, want %v", th.stops, stops)
	}
	if got, ok := th.FirstStop(); !ok || got != stops[0] {
		t.Errorf("FirstStop() = %v, %v; want %v, true", got, ok, stops[0])
	}
	if got, want := th.Glass(), (Glass{Color: hex(t, "#170a30"), Alpha: 0.60}); got != want {
		t.Errorf("Glass() = %+v, want %+v", got, want)
	}
	if got, want := th.Decor(), (Decor{Kind: DecorPalms, Color: hex(t, "#190b38"), Alpha: 0.30}); got != want {
		t.Errorf("Decor() = %+v, want %+v", got, want)
	}

	roles := []struct {
		role Role
		want string
	}{
		{RoleFG, "#ffffff"},
		{RoleDim, "#e3cdf3"},
		{RoleEdge, "#d9b8ee"},
		{RoleMain, "#ffc46b"},
		{RoleAgent, "#8fe0ff"},
		{RoleRun, "#ffe57a"},
		{RoleOK, "#8dffbe"},
		{RoleFail, "#ff6f86"},
		{RoleTool, "#a8ecff"},
		{RoleLive, "#ffffff"},
		{RoleTitle, "#6fb4ff"},
	}
	for _, tt := range roles {
		for _, dark := range []bool{true, false} {
			got, faint := th.Resolve(tt.role, dark)
			if got != color.Color(hex(t, tt.want)) || faint {
				t.Errorf("Resolve(%v, dark=%v) = %v, faint=%v; want %s, faint=false", tt.role, dark, got, faint, tt.want)
			}
		}
	}

	title := []string{"#6fb4ff", "#b07cff", "#ff77b7", "#ffb45e"}
	for i, want := range title {
		if got := th.Title(i, len(title), true); got != hex(t, want).Color() {
			t.Errorf("Title(%d, %d) = %v, want %s", i, len(title), got, want)
		}
	}
}

func TestAutoResolvesPerAppendixD2(t *testing.T) {
	th := mustLoad(t, "auto", "")
	none := lipgloss.NoColor{}
	tests := []struct {
		role        Role
		dark, light color.Color
		faint       bool
	}{
		{RoleFG, none, none, false},
		{RoleDim, none, none, true},
		{RoleEdge, none, none, true},
		{RoleMain, ansi.BasicColor(13), ansi.BasicColor(5), false},
		{RoleTitle, ansi.BasicColor(13), ansi.BasicColor(5), false},
		{RoleAgent, ansi.BasicColor(14), ansi.BasicColor(6), false},
		{RoleTool, ansi.BasicColor(14), ansi.BasicColor(6), false},
		{RoleRun, ansi.BasicColor(11), ansi.BasicColor(3), false},
		{RoleLive, ansi.BasicColor(11), ansi.BasicColor(3), false},
		{RoleOK, ansi.BasicColor(10), ansi.BasicColor(2), false},
		{RoleFail, ansi.BasicColor(9), ansi.BasicColor(1), false},
	}
	for _, tt := range tests {
		t.Run(tt.role.String(), func(t *testing.T) {
			if got, faint := th.Resolve(tt.role, true); got != tt.dark || faint != tt.faint {
				t.Errorf("dark: Resolve = %#v, faint=%v; want %#v, faint=%v", got, faint, tt.dark, tt.faint)
			}
			if got, faint := th.Resolve(tt.role, false); got != tt.light || faint != tt.faint {
				t.Errorf("light: Resolve = %#v, faint=%v; want %#v, faint=%v", got, faint, tt.light, tt.faint)
			}
		})
	}
}

func TestAutoHasNoBackgroundGlassOrDecor(t *testing.T) {
	th := mustLoad(t, "auto", "")
	if th.HasBackground() {
		t.Error("HasBackground() = true, want false")
	}
	if base, ok := th.Background(3, 5, 80, 24); ok {
		t.Errorf("Background() = %v, true; want ok=false", base)
	}
	if c, ok := th.FirstStop(); ok {
		t.Errorf("FirstStop() = %v, true; want ok=false", c)
	}
	if got := th.Glass(); got != (Glass{}) {
		t.Errorf("Glass() = %+v, want the zero value", got)
	}
	if got := th.Decor(); got != (Decor{}) || got.Kind != DecorNone {
		t.Errorf("Decor() = %+v, want kind none", got)
	}
}

func TestResolveDimFaint(t *testing.T) {
	if _, faint := mustLoad(t, "auto", "").Resolve(RoleDim, true); !faint {
		t.Error("auto dim: faint = false, want true")
	}
	if _, faint := mustLoad(t, "gta6", "").Resolve(RoleDim, true); faint {
		t.Error("gta6 dim: faint = true, want false")
	}
}

func TestResolveColor(t *testing.T) {
	auto, gta6 := mustLoad(t, "auto", ""), mustLoad(t, "gta6", "")

	if got, faint := auto.ResolveColor(RoleOK.Color(), false); got != color.Color(ansi.BasicColor(2)) || faint {
		t.Errorf("auto, semantic ok, light = %#v, faint=%v; want ANSI 2, faint=false", got, faint)
	}
	if got, faint := auto.ResolveColor(RoleEdge.Color(), true); got != color.Color(lipgloss.NoColor{}) || !faint {
		t.Errorf("auto, semantic edge = %#v, faint=%v; want no color, faint=true", got, faint)
	}
	if got, faint := gta6.ResolveColor(RoleMain.Color(), true); got != color.Color(hex(t, "#ffc46b")) || faint {
		t.Errorf("gta6, semantic main = %v, faint=%v; want #ffc46b, faint=false", got, faint)
	}
	concrete := hex(t, "#123456")
	for _, th := range []*Theme{auto, gta6} {
		if got, faint := th.ResolveColor(concrete.Color(), true); got != color.Color(concrete) || faint {
			t.Errorf("concrete color = %v, faint=%v; want it unchanged, faint=false", got, faint)
		}
	}
}

func TestColorValues(t *testing.T) {
	if (Color{}) != RoleFG.Color() {
		t.Error("the zero Color is not the semantic color fg")
	}
	if RoleMain.Color() == RoleAgent.Color() {
		t.Error("semantic colors of different roles compare equal")
	}
	c := RGB{0xff, 0xc4, 0x6b}
	if got, ok := c.Color().RGB(); !ok || got != c {
		t.Errorf("RGB color: RGB() = %v, %v; want %v, true", got, ok, c)
	}
	if _, ok := RoleMain.Color().RGB(); ok {
		t.Error("semantic color: RGB() ok = true, want false")
	}
	if _, ok := mustLoad(t, "auto", "").Title(0, 1, true).RGB(); ok {
		t.Error("ANSI color: RGB() ok = true, want false")
	}
}

func TestStrings(t *testing.T) {
	names := []string{"fg", "dim", "edge", "main", "agent", "run", "ok", "fail", "tool", "live", "title"}
	for i, want := range names {
		if got := Role(i).String(); got != want {
			t.Errorf("Role(%d).String() = %q, want %q", i, got, want)
		}
	}
	colors := []struct {
		c    Color
		want string
	}{
		{RoleTool.Color(), "tool"},
		{RGB{0xff, 0xc4, 0x6b}.Color(), "#ffc46b"},
		{ansiColor(13), "ansi:13"},
		{defaultColor, "default"},
		{faintColor, "faint"},
	}
	for _, tt := range colors {
		if got := tt.c.String(); got != tt.want {
			t.Errorf("Color.String() = %q, want %q", got, tt.want)
		}
	}
}

func TestBackground(t *testing.T) {
	t.Run("gta6 single row is the middle of the gradient", func(t *testing.T) {
		th := mustLoad(t, "gta6", "")
		// t = 0.5 lies halfway between the third and fourth stop.
		want := hex(t, "#bf4a91").Color()
		if got, ok := th.Background(0, 0, 80, 1); !ok || got != want {
			t.Errorf("Background(0, 0, 80, 1) = %v, %v; want %v, true", got, ok, want)
		}
	})
	t.Run("depends on the row only", func(t *testing.T) {
		th := mustLoad(t, "gta6", "")
		first, _ := th.Background(7, 0, 57, 45)
		for _, col := range []int{1, 28, 56} {
			if got, _ := th.Background(7, col, 57, 45); got != first {
				t.Errorf("row 7, col %d = %v, want %v as in col 0", col, got, first)
			}
		}
		if got, _ := th.Background(7, 0, 170, 45); got != first {
			t.Errorf("row 7 in a wider pane = %v, want %v", got, first)
		}
		if other, _ := th.Background(8, 0, 57, 45); other == first {
			t.Errorf("rows 7 and 8 share the base color %v", first)
		}
	})
	t.Run("row r of h samples the gradient at (r + 0.5) / h", func(t *testing.T) {
		th := &Theme{stops: []RGB{{0, 0, 0}, {200, 200, 200}}}
		for row, v := range []uint8{25, 75, 125, 175} {
			want := RGB{v, v, v}.Color()
			if got, ok := th.Background(row, 0, 10, 4); !ok || got != want {
				t.Errorf("Background(%d, 0, 10, 4) = %v, %v; want %v, true", row, got, ok, want)
			}
		}
	})
	t.Run("single stop is a solid color", func(t *testing.T) {
		th := &Theme{stops: []RGB{{1, 2, 3}}}
		for _, row := range []int{0, 5, 9} {
			if got, ok := th.Background(row, 0, 10, 10); !ok || got != (RGB{1, 2, 3}).Color() {
				t.Errorf("Background(%d, 0, 10, 10) = %v, %v; want #010203, true", row, got, ok)
			}
		}
	})
}

func TestTitleGradient(t *testing.T) {
	gta6 := mustLoad(t, "gta6", "")
	first, last := hex(t, "#6fb4ff").Color(), hex(t, "#ffb45e").Color()

	t.Run("9 characters, 4 colors", func(t *testing.T) {
		if got := gta6.Title(0, 9, true); got != first {
			t.Errorf("Title(0, 9) = %v, want the first color %v", got, first)
		}
		if got := gta6.Title(8, 9, true); got != last {
			t.Errorf("Title(8, 9) = %v, want the last color %v", got, last)
		}
		// i / (n − 1) = 0.5 lies halfway between the second and third color.
		if got, want := gta6.Title(4, 9, true), hex(t, "#d87adb").Color(); got != want {
			t.Errorf("Title(4, 9) = %v, want %v", got, want)
		}
	})
	t.Run("1 character", func(t *testing.T) {
		if got := gta6.Title(0, 1, true); got != first {
			t.Errorf("Title(0, 1) = %v, want the first color %v", got, first)
		}
	})
	t.Run("1 color", func(t *testing.T) {
		only := hex(t, "#123456").Color()
		th := &Theme{title: []Color{only}}
		for i := range 9 {
			if got := th.Title(i, 9, true); got != only {
				t.Errorf("Title(%d, 9) = %v, want %v", i, got, only)
			}
		}
		if got := th.Title(0, 1, true); got != only {
			t.Errorf("Title(0, 1) = %v, want %v", got, only)
		}
	})
	t.Run("auto follows the terminal", func(t *testing.T) {
		auto := mustLoad(t, "auto", "")
		for i := range 9 {
			if got, _ := auto.ResolveColor(auto.Title(i, 9, true), true); got != color.Color(ansi.BasicColor(13)) {
				t.Errorf("dark: Title(%d, 9) resolves to %#v, want ANSI 13", i, got)
			}
			if got, _ := auto.ResolveColor(auto.Title(i, 9, false), false); got != color.Color(ansi.BasicColor(5)) {
				t.Errorf("light: Title(%d, 9) resolves to %#v, want ANSI 5", i, got)
			}
		}
	})
	t.Run("colors that cannot be mixed switch at the halfway point", func(t *testing.T) {
		th := &Theme{title: []Color{ansiColor(1), ansiColor(2)}}
		want := []Color{ansiColor(1), ansiColor(1), ansiColor(2), ansiColor(2)}
		for i, w := range want {
			if got := th.Title(i, len(want), true); got != w {
				t.Errorf("Title(%d, %d) = %v, want %v", i, len(want), got, w)
			}
		}
	})
}

// The canvas hands Resolve's result to Lip Gloss: the default foreground must
// emit no color at all, ANSI colors the 16-color codes, RGB colors true color.
func TestResolvedColorsRenderThroughLipGloss(t *testing.T) {
	auto, gta6 := mustLoad(t, "auto", ""), mustLoad(t, "gta6", "")
	tests := []struct {
		name string
		th   *Theme
		role Role
		dark bool
		want string
	}{
		{"auto fg", auto, RoleFG, true, "x"},
		{"auto dim", auto, RoleDim, true, "\x1b[2mx\x1b[m"},
		{"auto main, dark", auto, RoleMain, true, "\x1b[95mx\x1b[m"},
		{"auto main, light", auto, RoleMain, false, "\x1b[35mx\x1b[m"},
		{"gta6 main", gta6, RoleMain, true, "\x1b[38;2;255;196;107mx\x1b[m"},
	}
	for _, tt := range tests {
		c, faint := tt.th.Resolve(tt.role, tt.dark)
		if got := lipgloss.NewStyle().Foreground(c).Faint(faint).Render("x"); got != tt.want {
			t.Errorf("%s renders as %q, want %q", tt.name, got, tt.want)
		}
	}
}
