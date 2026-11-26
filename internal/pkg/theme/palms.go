package theme

import "math"

// The palm silhouette is laid out in a virtual coordinate system in which a
// cell is 9.6 wide and 20 high: x grows to the right, y downwards.
const (
	cellW, cellH   = 9.6, 20.0
	blockW, blockH = cellW / 2, cellH / 2
	// Both clusters grow from this point, just outside the top left corner.
	palmX, palmY = -24.0, -30.0
)

var quadrants = [16]string{" ", "▘", "▝", "▀", "▖", "▌", "▞", "▛", "▗", "▚", "▐", "▜", "▄", "▙", "▟", "█"}

// QuadrantChar returns the block character that fills the sub-blocks of a
// cell given by the low four bits of bits: top left 1, top right 2, bottom
// left 4, bottom right 8.
func QuadrantChar(bits int) string { return quadrants[bits&15] }

// Mask is a silhouette on the sub-blocks of a pane, each cell being split
// into 2 × 2 of them. The zero Mask is empty.
type Mask struct {
	w, h int    // size in sub-blocks
	set  []bool // row by row
}

// PalmMask computes the palm silhouette of appendix D.4 for a pane of w × h
// cells: one cluster of fronds in the top left corner and one in the bottom
// right. The result depends only on the size, so callers keep it until the
// pane is resized.
func PalmMask(w, h int) Mask {
	m := Mask{w: 2 * w, h: 2 * h, set: make([]bool, 4*w*h)}
	l := 0.62 * min(cellW*float64(w), cellH*float64(h))
	for _, deg := range []float64{4, 21, 39, 58, 79} {
		m.frond(deg, l, 0.30*l, false)
	}
	for _, deg := range []float64{8, 27, 47, 68} {
		m.frond(deg, 0.85*l, 0.26*l, true)
	}
	return m
}

// frond marks one palm frond growing from the top left at the angle deg
// (clockwise from the x axis), or its point reflection in the bottom right.
func (m *Mask) frond(deg, length, droop float64, mirror bool) {
	const steps = 400
	sin, cos := math.Sincos(deg * math.Pi / 180)
	for i := 0; i <= steps; i++ {
		t := float64(i) / steps
		px := palmX + length*t*cos
		py := palmY + length*t*sin + droop*t*t
		// The unit normal is the tangent turned by 90°.
		tx, ty := length*cos, length*sin+2*droop*t
		norm := math.Hypot(tx, ty)
		nx, ny := -ty/norm, tx/norm
		half := 15*math.Pow(1-t, 0.7)*(0.55+0.45*math.Abs(math.Sin(38*t))) + 1.2
		for s := -half; s <= half; s += 2 {
			x := int(math.Floor((px + s*nx) / blockW))
			y := int(math.Floor((py + s*ny) / blockH))
			if mirror {
				x, y = m.w-1-x, m.h-1-y
			}
			if x >= 0 && x < m.w && y >= 0 && y < m.h {
				m.set[y*m.w+x] = true
			}
		}
	}
}

// has reports whether the sub-block in column x, row y is part of the mask.
func (m Mask) has(x, y int) bool {
	return x >= 0 && x < m.w && y >= 0 && y < m.h && m.set[y*m.w+x]
}

// Bits returns which sub-blocks of the cell at row, col belong to the mask:
// top left 1, top right 2, bottom left 4, bottom right 8. It is 0 for an
// untouched cell or one outside the pane, and 15 for a fully covered cell.
func (m Mask) Bits(row, col int) int {
	x, y := 2*col, 2*row
	bits := 0
	for i, in := range [...]bool{m.has(x, y), m.has(x+1, y), m.has(x, y+1), m.has(x+1, y+1)} {
		if in {
			bits |= 1 << i
		}
	}
	return bits
}
