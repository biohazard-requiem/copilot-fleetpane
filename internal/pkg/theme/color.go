package theme

import (
	"fmt"
	"math"
)

// Role names one of the colors every theme defines.
type Role uint8

// The roles, in the order of appendix D.1.
const (
	RoleFG    Role = iota // body text
	RoleDim               // secondary text: types, times, labels, hints
	RoleEdge              // borders and connectors that are neither selected nor active
	RoleMain              // the main agent's name and box, the join line, "back to main"
	RoleAgent             // running sub-agents: name and box
	RoleRun               // "running" icons and status text
	RoleOK                // "succeeded" icons and status text
	RoleFail              // "failed" icons and status text
	RoleTool              // tool names
	RoleLive              // active connectors, arrows, moving dots
	RoleTitle             // the title; Theme.Title gives its per-character gradient
)

// paletteSize is the number of roles with exactly one color: all but the title.
const paletteSize = int(RoleTitle)

var roleNames = [...]string{"fg", "dim", "edge", "main", "agent", "run", "ok", "fail", "tool", "live", "title"}

// String returns the role's name as written in theme files.
func (r Role) String() string {
	if int(r) < len(roleNames) {
		return roleNames[r]
	}
	return fmt.Sprintf("Role(%d)", uint8(r))
}

// Color returns the semantic color that a theme resolves to this role's color.
func (r Role) Color() Color { return Color{kind: kindRole, role: r} }

// RGB is a true color, written "#rrggbb" in theme files. It implements
// color.Color.
type RGB struct{ R, G, B uint8 }

// RGBA implements color.Color.
func (c RGB) RGBA() (r, g, b, a uint32) {
	return uint32(c.R) * 0x101, uint32(c.G) * 0x101, uint32(c.B) * 0x101, 0xffff
}

// String returns the "#rrggbb" notation.
func (c RGB) String() string { return fmt.Sprintf("#%02x%02x%02x", c.R, c.G, c.B) }

// Color returns c as a concrete Color.
func (c RGB) Color() Color { return Color{kind: kindRGB, rgb: c} }

type colorKind uint8

const (
	kindRole colorKind = iota
	kindRGB
	kindANSI
	kindDefault
	kindFaint
)

// Color is the foreground of a canvas cell: either a semantic color (a Role,
// looked up in the theme when rendering) or a concrete color in one of the
// four notations of appendix D.1. The zero value is the semantic color of
// RoleFG. Colors are comparable with ==.
type Color struct {
	kind colorKind
	role Role  // kindRole
	rgb  RGB   // kindRGB
	ansi uint8 // kindANSI: palette index 0–15
}

var (
	defaultColor = Color{kind: kindDefault}
	faintColor   = Color{kind: kindFaint}
)

func ansiColor(n uint8) Color { return Color{kind: kindANSI, ansi: n} }

// RGB returns the true color of c. ok is false for semantic colors and for
// the terminal-relative notations ("ansi:N", "default", "faint"), which have
// no RGB value and cannot be mixed.
func (c Color) RGB() (rgb RGB, ok bool) { return c.rgb, c.kind == kindRGB }

// String returns the role name of a semantic color or the theme-file notation
// of a concrete one.
func (c Color) String() string {
	switch c.kind {
	case kindRole:
		return c.role.String()
	case kindRGB:
		return c.rgb.String()
	case kindANSI:
		return fmt.Sprintf("ansi:%d", c.ansi)
	case kindFaint:
		return "faint"
	default:
		return "default"
	}
}

// Mix interpolates linearly between a and b on each sRGB component:
// a + (b − a) × k, with k from 0 to 1.
func Mix(a, b RGB, k float64) RGB {
	lerp := func(a, b uint8) uint8 {
		return uint8(math.Round(float64(a) + (float64(b)-float64(a))*k))
	}
	return RGB{lerp(a.R, b.R), lerp(a.G, b.G), lerp(a.B, b.B)}
}

// Gradient returns the color at position t (0–1) on evenly spaced stops,
// interpolating linearly between neighbors. A single stop is a solid color.
func Gradient(stops []RGB, t float64) RGB {
	switch len(stops) {
	case 0:
		return RGB{}
	case 1:
		return stops[0]
	}
	i, k := segment(len(stops), t)
	return Mix(stops[i], stops[i+1], k)
}

// segment locates t (clamped to 0–1) on n ≥ 2 evenly spaced stops: the stop
// at or before t and how far t is on the way to the next one.
func segment(n int, t float64) (i int, k float64) {
	pos := min(max(t, 0), 1) * float64(n-1)
	i = min(int(pos), n-2)
	return i, pos - float64(i)
}
