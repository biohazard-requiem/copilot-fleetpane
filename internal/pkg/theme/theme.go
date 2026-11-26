// Package theme defines the colors of the pane: the built-in themes auto and
// gta6, custom theme files, and the arithmetic behind the gta6-style
// background (gradient, glass panels, palm silhouette).
package theme

import (
	"image/color"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// Glass is what panel cells are tinted with: their background is
// Mix(row color, Color, Alpha).
type Glass struct {
	Color RGB
	Alpha float64
}

// DecorKind selects the silhouette drawn on the background.
type DecorKind uint8

// The silhouettes.
const (
	DecorNone  DecorKind = iota // no silhouette
	DecorPalms                  // palm fronds, see PalmMask
)

// Decor is the silhouette of a theme: cells fully covered by its mask have
// the background Mix(row color, Color, Alpha).
type Decor struct {
	Kind  DecorKind
	Color RGB
	Alpha float64
}

// Theme is a loaded theme. It is immutable.
type Theme struct {
	// dark and light hold the colors of the roles fg … live for dark and
	// light terminals. They differ only for roles a theme leaves to auto.
	dark, light [paletteSize]Color
	title       []Color // empty: the title has the color of main
	stops       []RGB   // background gradient from top to bottom; empty: no background
	glass       Glass
	decor       Decor
}

// The color and share of gta6's palms, also the defaults of a custom theme.
var palmColor = RGB{0x19, 0x0b, 0x38}

const palmAlpha = 0.30

var autoTheme = &Theme{
	dark: [paletteSize]Color{
		RoleFG:    defaultColor,
		RoleDim:   faintColor,
		RoleEdge:  faintColor,
		RoleMain:  ansiColor(13),
		RoleAgent: ansiColor(14),
		RoleRun:   ansiColor(11),
		RoleOK:    ansiColor(10),
		RoleFail:  ansiColor(9),
		RoleTool:  ansiColor(14),
		RoleLive:  ansiColor(11),
	},
	light: [paletteSize]Color{
		RoleFG:    defaultColor,
		RoleDim:   faintColor,
		RoleEdge:  faintColor,
		RoleMain:  ansiColor(5),
		RoleAgent: ansiColor(6),
		RoleRun:   ansiColor(3),
		RoleOK:    ansiColor(2),
		RoleFail:  ansiColor(1),
		RoleTool:  ansiColor(6),
		RoleLive:  ansiColor(3),
	},
}

var gta6Palette = [paletteSize]Color{
	RoleFG:    RGB{0xff, 0xff, 0xff}.Color(),
	RoleDim:   RGB{0xe3, 0xcd, 0xf3}.Color(),
	RoleEdge:  RGB{0xd9, 0xb8, 0xee}.Color(),
	RoleMain:  RGB{0xff, 0xc4, 0x6b}.Color(),
	RoleAgent: RGB{0x8f, 0xe0, 0xff}.Color(),
	RoleRun:   RGB{0xff, 0xe5, 0x7a}.Color(),
	RoleOK:    RGB{0x8d, 0xff, 0xbe}.Color(),
	RoleFail:  RGB{0xff, 0x6f, 0x86}.Color(),
	RoleTool:  RGB{0xa8, 0xec, 0xff}.Color(),
	RoleLive:  RGB{0xff, 0xff, 0xff}.Color(),
}

var gta6Theme = &Theme{
	dark:  gta6Palette,
	light: gta6Palette,
	title: []Color{
		RGB{0x6f, 0xb4, 0xff}.Color(),
		RGB{0xb0, 0x7c, 0xff}.Color(),
		RGB{0xff, 0x77, 0xb7}.Color(),
		RGB{0xff, 0xb4, 0x5e}.Color(),
	},
	stops: []RGB{
		{0x2b, 0x1d, 0x5c},
		{0x57, 0x29, 0x8a},
		{0xa0, 0x3a, 0x97},
		{0xdd, 0x5a, 0x8b},
		{0xf5, 0x89, 0x6a},
		{0xf9, 0xb8, 0x80},
	},
	glass: Glass{Color: RGB{0x17, 0x0a, 0x30}, Alpha: 0.60},
	decor: Decor{Kind: DecorPalms, Color: palmColor, Alpha: palmAlpha},
}

// HasBackground reports whether the theme paints a background. Without one
// no background color is emitted at all and the pane follows the terminal.
func (t *Theme) HasBackground() bool { return len(t.stops) > 0 }

// Resolve returns the color of role as a terminal color, and whether the
// text also needs the Faint attribute. dark tells whether the terminal
// background is dark; it only matters for roles the theme leaves to auto.
//
// "#rrggbb" resolves to an RGB, "ansi:N" to ansi.BasicColor(N), "default" to
// lipgloss.NoColor{} and "faint" to lipgloss.NoColor{} with faint set. A
// lipgloss.Style given NoColor emits no color, which leaves the terminal's
// default foreground in place. RoleTitle resolves to the first title color.
func (t *Theme) Resolve(role Role, dark bool) (c color.Color, faint bool) {
	return t.ResolveColor(role.Color(), dark)
}

// ResolveColor is Resolve for the foreground of a canvas cell: a semantic
// color is looked up in the theme, a concrete color is used as it is.
func (t *Theme) ResolveColor(c Color, dark bool) (resolved color.Color, faint bool) {
	if c.kind == kindRole {
		c = t.lookup(c.role, dark)
	}
	switch c.kind {
	case kindRGB:
		return c.rgb, false
	case kindANSI:
		return ansi.BasicColor(c.ansi), false
	case kindFaint:
		return lipgloss.NoColor{}, true
	default:
		return lipgloss.NoColor{}, false
	}
}

// lookup returns the concrete color of role.
func (t *Theme) lookup(role Role, dark bool) Color {
	switch {
	case role == RoleTitle:
		return t.Title(0, 1, dark)
	case dark:
		return t.dark[role]
	default:
		return t.light[role]
	}
}

// Title returns the concrete color of character i of an n-character title:
// the title colors sampled at i / (n − 1). With one character or one color it
// is the first color; a theme without title colors uses the color of main.
// Neighbors that are not both "#rrggbb" cannot be mixed; the nearer of the
// two is used.
func (t *Theme) Title(i, n int, dark bool) Color {
	if len(t.title) == 0 {
		return t.lookup(RoleMain, dark)
	}
	if n <= 1 || len(t.title) == 1 {
		return t.title[0]
	}
	j, k := segment(len(t.title), float64(i)/float64(n-1))
	a, aOK := t.title[j].RGB()
	b, bOK := t.title[j+1].RGB()
	switch {
	case aOK && bOK:
		return Mix(a, b, k).Color()
	case k < 0.5:
		return t.title[j]
	default:
		return t.title[j+1]
	}
}

// Background returns the base background of the cells in row of an h-row
// pane: the gradient sampled at (row + 0.5) / h, always a "#rrggbb" color.
// ok is false when the theme has no background. col and w do not influence
// the base color; glass and decor are mixed in by the caller.
func (t *Theme) Background(row, col, w, h int) (base Color, ok bool) {
	if !t.HasBackground() {
		return Color{}, false
	}
	return Gradient(t.stops, (float64(row)+0.5)/float64(h)).Color(), true
}

// FirstStop returns the top color of the background gradient, which also
// fills the pane's padding (tea.View.BackgroundColor). ok is false when the
// theme has no background.
func (t *Theme) FirstStop() (c RGB, ok bool) {
	if !t.HasBackground() {
		return RGB{}, false
	}
	return t.stops[0], true
}

// Glass returns the tint of panel cells. It is the zero value when the theme
// has no background.
func (t *Theme) Glass() Glass { return t.glass }

// Decor returns the silhouette. It is the zero value, of kind DecorNone, when
// the theme has none or has no background.
func (t *Theme) Decor() Decor { return t.decor }
