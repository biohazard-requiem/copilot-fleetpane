package theme

import (
	"image/color"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// writeTheme creates <dir>/<name>.json.
func writeTheme(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name+".json"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// loadJSON loads content as a custom theme.
func loadJSON(t *testing.T, content string) (*Theme, error) {
	t.Helper()
	dir := t.TempDir()
	writeTheme(t, dir, "mine", content)
	return Load("mine", dir)
}

func mustLoadJSON(t *testing.T, content string) *Theme {
	t.Helper()
	th, err := loadJSON(t, content)
	if err != nil {
		t.Fatalf("Load failed: %v\n%s", err, content)
	}
	return th
}

// wantResolve checks what a role resolves to on a dark and on a light terminal.
func wantResolve(t *testing.T, th *Theme, role Role, dark, light color.Color, faint bool) {
	t.Helper()
	if got, f := th.Resolve(role, true); got != dark || f != faint {
		t.Errorf("%v, dark: Resolve = %#v, faint=%v; want %#v, faint=%v", role, got, f, dark, faint)
	}
	if got, f := th.Resolve(role, false); got != light || f != faint {
		t.Errorf("%v, light: Resolve = %#v, faint=%v; want %#v, faint=%v", role, got, f, light, faint)
	}
}

// wantAutoColors checks that the given roles have auto's colors.
func wantAutoColors(t *testing.T, th *Theme, roles ...Role) {
	t.Helper()
	auto := mustLoad(t, "auto", "")
	for _, role := range roles {
		dark, faint := auto.Resolve(role, true)
		light, _ := auto.Resolve(role, false)
		wantResolve(t, th, role, dark, light, faint)
	}
}

func TestLoadExampleTheme(t *testing.T) {
	example, err := os.ReadFile(filepath.Join("..", "..", "..", "extension", "themes", "example.json"))
	if err != nil {
		t.Fatal(err)
	}
	th := mustLoadJSON(t, string(example))

	colors := map[Role]string{
		RoleFG: "#e6edf3", RoleDim: "#8b949e", RoleEdge: "#3d444d", RoleMain: "#bc8cff", RoleAgent: "#58a6ff",
		RoleRun: "#d29922", RoleOK: "#3fb950", RoleFail: "#f85149", RoleTool: "#79c0ff", RoleLive: "#58a6ff",
		RoleTitle: "#58a6ff",
	}
	for role, want := range colors {
		wantResolve(t, th, role, hex(t, want), hex(t, want), false)
	}
	if got, want := th.Title(1, 2, true), hex(t, "#bc8cff").Color(); got != want {
		t.Errorf("last title color = %v, want %v", got, want)
	}
	if !th.HasBackground() {
		t.Error("HasBackground() = false, want true")
	}
	if want := []RGB{hex(t, "#0d1117"), hex(t, "#161b22")}; len(th.stops) != 2 || th.stops[0] != want[0] || th.stops[1] != want[1] {
		t.Errorf("stops = %v, want %v", th.stops, want)
	}
	if got, want := th.Glass(), (Glass{Color: hex(t, "#010409"), Alpha: 0.5}); got != want {
		t.Errorf("Glass() = %+v, want %+v", got, want)
	}
	if got := th.Decor(); got != (Decor{}) {
		t.Errorf("Decor() = %+v, want kind none", got)
	}
}

func TestLoadCustomTheme(t *testing.T) {
	th := mustLoadJSON(t, `{
		"colors": {"fg": "#e6edf3", "dim": "faint", "edge": "default", "main": "ansi:4", "tool": "#ABCDEF", "fail": "ansi:0", "live": "ansi:15"},
		"title": "#58a6ff",
		"background": {"stops": ["#0d1117"]},
		"glass": {"color": "#010409", "alpha": 0.25},
		"decor": {"kind": "palms", "color": "#112233", "alpha": 0.4}
	}`)
	none := lipgloss.NoColor{}

	t.Run("colors in all four notations", func(t *testing.T) {
		wantResolve(t, th, RoleFG, hex(t, "#e6edf3"), hex(t, "#e6edf3"), false)
		wantResolve(t, th, RoleDim, none, none, true)
		wantResolve(t, th, RoleEdge, none, none, false)
		wantResolve(t, th, RoleMain, ansi.BasicColor(4), ansi.BasicColor(4), false)
		wantResolve(t, th, RoleTool, hex(t, "#abcdef"), hex(t, "#abcdef"), false)
		wantResolve(t, th, RoleFail, ansi.BasicColor(0), ansi.BasicColor(0), false)
		wantResolve(t, th, RoleLive, ansi.BasicColor(15), ansi.BasicColor(15), false)
	})
	t.Run("missing colors take auto's value", func(t *testing.T) {
		wantAutoColors(t, th, RoleAgent, RoleRun, RoleOK)
	})
	t.Run("title", func(t *testing.T) {
		wantResolve(t, th, RoleTitle, hex(t, "#58a6ff"), hex(t, "#58a6ff"), false)
		for i := range 5 {
			if got, want := th.Title(i, 5, true), hex(t, "#58a6ff").Color(); got != want {
				t.Errorf("Title(%d, 5) = %v, want %v", i, got, want)
			}
		}
	})
	t.Run("background, glass and decor", func(t *testing.T) {
		if !th.HasBackground() {
			t.Error("HasBackground() = false, want true")
		}
		if got, ok := th.FirstStop(); !ok || got != hex(t, "#0d1117") {
			t.Errorf("FirstStop() = %v, %v; want #0d1117, true", got, ok)
		}
		if got, ok := th.Background(3, 0, 80, 24); !ok || got != hex(t, "#0d1117").Color() {
			t.Errorf("Background(3, 0, 80, 24) = %v, %v; want #0d1117, true", got, ok)
		}
		if got, want := th.Glass(), (Glass{Color: hex(t, "#010409"), Alpha: 0.25}); got != want {
			t.Errorf("Glass() = %+v, want %+v", got, want)
		}
		if got, want := th.Decor(), (Decor{Kind: DecorPalms, Color: hex(t, "#112233"), Alpha: 0.4}); got != want {
			t.Errorf("Decor() = %+v, want %+v", got, want)
		}
	})
}

func TestLoadCustomThemeDefaults(t *testing.T) {
	const bg = `"background": {"stops": ["#101010", "#202020"]}`
	palms := Decor{Kind: DecorPalms, Color: hex(t, "#190b38"), Alpha: 0.30}
	black := Glass{Color: RGB{}, Alpha: 0.5}

	tests := []struct {
		name      string
		json      string
		wantGlass Glass
		wantDecor Decor
	}{
		{"background without glass", `{` + bg + `}`, black, Decor{}},
		{"decor is the string palms", `{` + bg + `, "decor": "palms"}`, black, palms},
		{"decor is the string none", `{` + bg + `, "decor": "none"}`, black, Decor{}},
		{"decor object with only a kind", `{` + bg + `, "decor": {"kind": "palms"}}`, black, palms},
		{"decor object without color", `{` + bg + `, "decor": {"kind": "palms", "alpha": 0.8}}`, black,
			Decor{Kind: DecorPalms, Color: hex(t, "#190b38"), Alpha: 0.8}},
		{"decor object without alpha", `{` + bg + `, "decor": {"kind": "palms", "color": "#010203"}}`, black,
			Decor{Kind: DecorPalms, Color: hex(t, "#010203"), Alpha: 0.30}},
		{"decor object of kind none", `{` + bg + `, "decor": {"kind": "none", "color": "#010203"}}`, black, Decor{}},
		{"decor object without kind", `{` + bg + `, "decor": {"color": "#010203"}}`, black, Decor{}},
		{"glass without color", `{` + bg + `, "glass": {"alpha": 0.2}}`, Glass{Color: RGB{}, Alpha: 0.2}, Decor{}},
		{"glass without alpha", `{` + bg + `, "glass": {"color": "#111111"}}`, Glass{Color: hex(t, "#111111"), Alpha: 0.5}, Decor{}},
		{"alphas at the limits", `{` + bg + `, "glass": {"alpha": 0}, "decor": {"kind": "palms", "alpha": 1}}`,
			Glass{Color: RGB{}, Alpha: 0}, Decor{Kind: DecorPalms, Color: hex(t, "#190b38"), Alpha: 1}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			th := mustLoadJSON(t, tt.json)
			if !th.HasBackground() {
				t.Error("HasBackground() = false, want true")
			}
			if got := th.Glass(); got != tt.wantGlass {
				t.Errorf("Glass() = %+v, want %+v", got, tt.wantGlass)
			}
			if got := th.Decor(); got != tt.wantDecor {
				t.Errorf("Decor() = %+v, want %+v", got, tt.wantDecor)
			}
		})
	}

	t.Run("glass and decor without background are ignored", func(t *testing.T) {
		th := mustLoadJSON(t, `{"glass": {"color": "#010409", "alpha": 0.5}, "decor": "palms"}`)
		if th.HasBackground() {
			t.Error("HasBackground() = true, want false")
		}
		if base, ok := th.Background(0, 0, 80, 24); ok {
			t.Errorf("Background() = %v, true; want ok=false", base)
		}
		if c, ok := th.FirstStop(); ok {
			t.Errorf("FirstStop() = %v, true; want ok=false", c)
		}
		if got := th.Glass(); got != (Glass{}) {
			t.Errorf("Glass() = %+v, want the zero value", got)
		}
		if got := th.Decor(); got != (Decor{}) {
			t.Errorf("Decor() = %+v, want kind none", got)
		}
	})
	t.Run("empty theme is auto", func(t *testing.T) {
		th := mustLoadJSON(t, `{}`)
		if th.HasBackground() {
			t.Error("HasBackground() = true, want false")
		}
		for role := RoleFG; role <= RoleTitle; role++ {
			wantAutoColors(t, th, role)
		}
	})
	t.Run("title defaults to the color of main", func(t *testing.T) {
		th := mustLoadJSON(t, `{"colors": {"main": "#bc8cff"}}`)
		want := hex(t, "#bc8cff")
		wantResolve(t, th, RoleTitle, want, want, false)
		for i := range 9 {
			if got := th.Title(i, 9, false); got != want.Color() {
				t.Errorf("Title(%d, 9) = %v, want %v", i, got, want)
			}
		}
	})
	t.Run("title array", func(t *testing.T) {
		th := mustLoadJSON(t, `{"title": ["#000000", "#646464", "#c8c8c8"]}`)
		for i, v := range []uint8{0, 50, 100, 150, 200} {
			if got, want := th.Title(i, 5, true), (RGB{v, v, v}).Color(); got != want {
				t.Errorf("Title(%d, 5) = %v, want %v", i, got, want)
			}
		}
	})
}

func TestCustomThemeWithOnlyMainFollowsTheTerminalElsewhere(t *testing.T) {
	th := mustLoadJSON(t, `{"colors": {"main": "#bc8cff"}}`)
	wantResolve(t, th, RoleOK, ansi.BasicColor(10), ansi.BasicColor(2), false)
	wantResolve(t, th, RoleMain, hex(t, "#bc8cff"), hex(t, "#bc8cff"), false)
}

func TestLoadRejectsBrokenThemeFiles(t *testing.T) {
	const bg = `"background": {"stops": ["#101010"]}`
	tests := []struct {
		name    string
		json    string
		wantErr string // part of the error text
	}{
		{"invalid JSON: truncated", `{"colors": {"main": "#bc8cff"}`, "JSON"},
		{"invalid JSON: trailing text", `{} x`, "JSON"},
		{"invalid JSON: empty file", ``, "JSON"},

		{"bad color: short hex", `{"colors": {"main": "#fff"}}`, "colors.main"},
		{"bad color: long hex", `{"colors": {"main": "#1234567"}}`, "colors.main"},
		{"bad color: not hex", `{"colors": {"main": "#gggggg"}}`, "colors.main"},
		{"bad color: signed hex", `{"colors": {"main": "#+12345"}}`, "colors.main"},
		{"bad color: name", `{"colors": {"ok": "green"}}`, "colors.ok"},
		{"bad color: empty", `{"colors": {"ok": ""}}`, "colors.ok"},
		{"bad color: padded", `{"colors": {"ok": " #ffffff"}}`, "colors.ok"},
		{"bad color: ansi 16", `{"colors": {"run": "ansi:16"}}`, "colors.run"},
		{"bad color: ansi negative", `{"colors": {"run": "ansi:-1"}}`, "colors.run"},
		{"bad color: ansi without number", `{"colors": {"run": "ansi:"}}`, "colors.run"},
		{"bad color: 256-color index", `{"colors": {"run": "ansi:200"}}`, "colors.run"},
		{"bad color: in title", `{"title": "blue"}`, "title"},
		{"bad color: in title array", `{"title": ["#58a6ff", "blue"]}`, "title[1]"},
		{"bad color: in stops", `{"background": {"stops": ["#101010", "#12345"]}}`, "background.stops[1]"},
		{"bad color: stop is not #rrggbb", `{"background": {"stops": ["ansi:4"]}}`, "background.stops[0]"},
		{"bad color: in glass", `{` + bg + `, "glass": {"color": "#12"}}`, "glass.color"},
		{"bad color: glass is not #rrggbb", `{` + bg + `, "glass": {"color": "default"}}`, "glass.color"},
		{"bad color: in decor", `{` + bg + `, "decor": {"kind": "palms", "color": "faint"}}`, "decor.color"},
		{"bad color: in glass without background", `{"glass": {"color": "#12"}}`, "glass.color"},

		{"wrong type: top level", `["#101010"]`, "JSON"},
		{"wrong type: colors", `{"colors": ["#101010"]}`, "colors: wrong type"},
		{"wrong type: color", `{"colors": {"main": 5}}`, "colors: wrong type"},
		{"wrong type: title", `{"title": 5}`, "title: wrong type"},
		{"wrong type: title element", `{"title": ["#101010", 5]}`, "title: wrong type"},
		{"wrong type: background", `{"background": "#101010"}`, "background: wrong type"},
		{"wrong type: stops", `{"background": {"stops": "#101010"}}`, "background.stops: wrong type"},
		{"wrong type: glass", `{` + bg + `, "glass": "#101010"}`, "glass: wrong type"},
		{"wrong type: glass alpha", `{` + bg + `, "glass": {"alpha": "0.5"}}`, "glass.alpha: wrong type"},
		{"wrong type: decor", `{` + bg + `, "decor": 1}`, "decor: wrong type"},
		{"wrong type: decor alpha", `{` + bg + `, "decor": {"kind": "palms", "alpha": "0.3"}}`, "decor.alpha: wrong type"},

		{"background without stops", `{"background": {}}`, "background.stops"},
		{"background with no stop", `{"background": {"stops": []}}`, "background.stops"},
		{"title with no color", `{"title": []}`, "title"},
		{"glass alpha below 0", `{` + bg + `, "glass": {"alpha": -0.1}}`, "glass.alpha"},
		{"glass alpha above 1", `{` + bg + `, "glass": {"alpha": 1.5}}`, "glass.alpha"},
		{"decor alpha below 0", `{` + bg + `, "decor": {"kind": "palms", "alpha": -1}}`, "decor.alpha"},
		{"decor alpha above 1", `{` + bg + `, "decor": {"kind": "palms", "alpha": 1.01}}`, "decor.alpha"},
		{"unknown decor", `{` + bg + `, "decor": "waves"}`, "decor"},
		{"unknown decor kind", `{` + bg + `, "decor": {"kind": "waves"}}`, "decor.kind"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			th, err := loadJSON(t, tt.json)
			if err == nil {
				t.Fatal("Load succeeded, want an error")
			}
			if th != nil {
				t.Errorf("Load returned a theme along with the error %v", err)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("error = %q, want it to mention %q", err, tt.wantErr)
			}
		})
	}
}

func TestLoadFileSizeLimit(t *testing.T) {
	const limit = 64 << 10
	padded := func(size int) string {
		const theme = `{"colors": {"main": "#bc8cff"}}`
		return theme + strings.Repeat(" ", size-len(theme))
	}
	dir := t.TempDir()
	writeTheme(t, dir, "fits", padded(limit))
	writeTheme(t, dir, "toobig", padded(limit+1))

	if _, err := Load("fits", dir); err != nil {
		t.Errorf("a file of exactly 64 KiB: %v, want it to load", err)
	}
	if _, err := Load("toobig", dir); err == nil {
		t.Error("a file of 64 KiB + 1 byte loaded, want an error")
	} else if !strings.Contains(err.Error(), "64 KiB") {
		t.Errorf("error = %q, want it to mention the 64 KiB limit", err)
	}
}

func TestLoadRejectsInvalidNamesWithoutReadingAFile(t *testing.T) {
	const valid = `{"colors": {"main": "#bc8cff"}}`
	root := t.TempDir()
	dir := filepath.Join(root, "themes")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	long33 := strings.Repeat("a", 33)

	// Each invalid name gets a valid theme file exactly where a Load that
	// skipped validation would read it, so an error proves it was not read.
	writeTheme(t, root, "x", valid)
	for _, name := range []string{"A B", "", long33} {
		writeTheme(t, dir, name, valid)
	}
	if _, err := Load("x", root); err != nil {
		t.Fatalf("the file behind ../x does not load by itself: %v", err)
	}

	for _, name := range []string{"../x", "A B", "", long33} {
		if _, err := Load(name, dir); err == nil {
			t.Errorf("Load(%q) succeeded, want an error", name)
		} else if !strings.Contains(err.Error(), "name") {
			t.Errorf("Load(%q): error = %q, want it to blame the name", name, err)
		}
	}

	long32 := strings.Repeat("a", 32)
	writeTheme(t, dir, long32, valid)
	if _, err := Load(long32, dir); err != nil {
		t.Errorf("a 32-character name: %v, want it to load", err)
	}
	writeTheme(t, dir, "0my_theme-2", valid)
	if _, err := Load("0my_theme-2", dir); err != nil {
		t.Errorf("a name with digits, _ and -: %v, want it to load", err)
	}
}

func TestLoadRequiresARegularFile(t *testing.T) {
	const valid = `{"colors": {"main": "#bc8cff"}}`
	dir := t.TempDir()

	writeTheme(t, dir, "real", valid)
	if _, err := Load("real", dir); err != nil {
		t.Fatalf("the symlink's target does not load by itself: %v", err)
	}
	if err := os.Symlink(filepath.Join(dir, "real.json"), filepath.Join(dir, "link.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "folder.json"), 0o700); err != nil {
		t.Fatal(err)
	}

	for _, name := range []string{"link", "folder"} {
		if _, err := Load(name, dir); err == nil {
			t.Errorf("Load(%q) succeeded, want an error", name)
		} else if !strings.Contains(err.Error(), "regular file") {
			t.Errorf("Load(%q): error = %q, want it to say the file is not a regular file", name, err)
		}
	}
}

func TestLoadMissingTheme(t *testing.T) {
	for _, dir := range []string{t.TempDir(), filepath.Join(t.TempDir(), "nosuchdir"), ""} {
		if _, err := Load("nosuch", dir); err == nil {
			t.Errorf("Load(nosuch, %q) succeeded, want an error", dir)
		} else if err.Error() != "not found" {
			t.Errorf("Load(nosuch, %q): error = %q, want %q", dir, err, "not found")
		}
	}
}

func TestLoadWithoutADirectoryIgnoresTheWorkingDirectory(t *testing.T) {
	const valid = `{"colors": {"main": "#bc8cff"}}`
	cwd := t.TempDir()
	t.Chdir(cwd)

	// Each name has something exactly where a Load that joined the empty
	// directory would look for it, so "not found" proves it did not look.
	writeTheme(t, cwd, "foo", valid)
	writeTheme(t, cwd, "broken", `{`)
	if err := os.Mkdir(filepath.Join(cwd, "folder.json"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := Load("foo", "."); err != nil {
		t.Fatalf("the file in the working directory does not load by itself: %v", err)
	}

	for _, name := range []string{"foo", "broken", "folder"} {
		if th, err := Load(name, ""); err == nil {
			t.Errorf("Load(%q, \"\") loaded %s.json from the working directory, want an error", name, name)
		} else if th != nil || err.Error() != "not found" {
			t.Errorf("Load(%q, \"\") = %v, %q; want nil, %q", name, th, err, "not found")
		}
	}
	for _, name := range []string{"auto", "gta6"} {
		if th, err := Load(name, ""); err != nil || th == nil {
			t.Errorf("Load(%q, \"\") failed: %v", name, err)
		}
	}
}
