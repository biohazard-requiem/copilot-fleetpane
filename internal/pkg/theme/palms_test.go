package theme

import (
	"math/bits"
	"slices"
	"testing"
)

func TestQuadrantChar(t *testing.T) {
	want := []string{" ", "▘", "▝", "▀", "▖", "▌", "▞", "▛", "▗", "▚", "▐", "▜", "▄", "▙", "▟", "█"}
	for b, w := range want {
		if got := QuadrantChar(b); got != w {
			t.Errorf("QuadrantChar(%d) = %q, want %q", b, got, w)
		}
	}
}

func TestMaskBits(t *testing.T) {
	// The four sub-blocks of cell (row 1, col 2) in a 3 × 2 cell pane.
	quadrants := []struct {
		name string
		x, y int
		bit  int
	}{
		{"top left", 4, 2, 1},
		{"top right", 5, 2, 2},
		{"bottom left", 4, 3, 4},
		{"bottom right", 5, 3, 8},
	}
	all := Mask{w: 6, h: 4, set: make([]bool, 24)}
	for _, q := range quadrants {
		m := Mask{w: 6, h: 4, set: make([]bool, 24)}
		m.set[q.y*m.w+q.x] = true
		all.set[q.y*all.w+q.x] = true
		if got := m.Bits(1, 2); got != q.bit {
			t.Errorf("%s block: Bits(1, 2) = %d, want %d", q.name, got, q.bit)
		}
		if got := m.Bits(1, 1) | m.Bits(0, 2) | m.Bits(1, 0); got != 0 {
			t.Errorf("%s block leaks into another cell: bits %d", q.name, got)
		}
	}
	if got := all.Bits(1, 2); got != 15 {
		t.Errorf("fully covered cell: Bits(1, 2) = %d, want 15", got)
	}
	for _, cell := range [][2]int{{-1, 2}, {2, 2}, {1, -1}, {1, 3}} {
		if got := all.Bits(cell[0], cell[1]); got != 0 {
			t.Errorf("Bits(%d, %d) outside the pane = %d, want 0", cell[0], cell[1], got)
		}
	}
	if got := (Mask{}).Bits(0, 0); got != 0 {
		t.Errorf("zero Mask: Bits(0, 0) = %d, want 0", got)
	}
}

func TestPalmMask(t *testing.T) {
	for _, size := range []struct{ w, h int }{{57, 45}, {170, 15}} {
		w, h := size.w, size.h
		m := PalmMask(w, h)

		if m.w != 2*w || m.h != 2*h || len(m.set) != 4*w*h {
			t.Fatalf("%dx%d: mask is %d×%d with %d blocks, want %d×%d", w, h, m.w, m.h, len(m.set), 2*w, 2*h)
		}
		blocks := 0
		for _, set := range m.set {
			if set {
				blocks++
			}
		}
		if blocks == 0 {
			t.Errorf("%dx%d: the mask is empty", w, h)
		}

		// Every block of the mask belongs to exactly one cell of the pane.
		var inCells, topLeft, bottomRight int
		for row := range h {
			for col := range w {
				n := bits.OnesCount(uint(m.Bits(row, col)))
				inCells += n
				switch {
				case row < h/2 && col < w/2:
					topLeft += n
				case row >= h/2 && col >= w/2:
					bottomRight += n
				}
			}
		}
		if inCells != blocks {
			t.Errorf("%dx%d: the cells of the pane cover %d blocks, the mask has %d", w, h, inCells, blocks)
		}
		for row := -1; row <= h; row++ {
			for col := -1; col <= w; col++ {
				if inside := row >= 0 && row < h && col >= 0 && col < w; !inside && m.Bits(row, col) != 0 {
					t.Errorf("%dx%d: cell (%d, %d) outside the pane has bits %d", w, h, row, col, m.Bits(row, col))
				}
			}
		}

		if topLeft == 0 || bottomRight == 0 {
			t.Errorf("%dx%d: %d blocks top left, %d bottom right; want a cluster in both corners", w, h, topLeft, bottomRight)
		}
		if got := m.Bits(0, w-1) | m.Bits(h-1, 0); got != 0 {
			t.Errorf("%dx%d: the top right or bottom left corner is covered (bits %d)", w, h, got)
		}

		if again := PalmMask(w, h); again.w != m.w || again.h != m.h || !slices.Equal(again.set, m.set) {
			t.Errorf("%dx%d: computing the mask twice gives different results", w, h)
		}
	}
}

// For a 57 × 45 pane L = 0.62 × min(547.2, 900) = 339.264. The expected
// blocks below are frond tips P(1) worked out by hand from appendix D.4.
func TestPalmMaskGeometry(t *testing.T) {
	has := PalmMask(57, 45).has

	// Top left, 4° frond: P(1) = (−24 + L cos 4°, −30 + L sin 4° + 0.30 L) = (314.4, 95.4).
	if !has(65, 9) {
		t.Error("the tip of the 4° frond, block (65, 9), is not set")
	}
	// Top left, 79° frond: P(1) = (40.7, 404.8). It is the lowest point of the cluster.
	if !has(8, 40) {
		t.Error("the tip of the 79° frond, block (8, 40), is not set")
	}
	if has(8, 42) {
		t.Error("block (8, 42) below the tip of the 79° frond is set")
	}
	// Bottom right, 8° frond with length 0.85 L and droop 0.26 L:
	// P(1) = (261.6, 98.3), block (54, 9), mirrored to (113 − 54, 89 − 9).
	if !has(59, 80) {
		t.Error("the mirrored tip of the 8° frond, block (59, 80), is not set")
	}
}

func TestPalmMaskMirrorsTheSecondCluster(t *testing.T) {
	const w, h = 57, 45
	plain := Mask{w: 2 * w, h: 2 * h, set: make([]bool, 4*w*h)}
	mirrored := Mask{w: 2 * w, h: 2 * h, set: make([]bool, 4*w*h)}
	plain.frond(27, 250, 80, false)
	mirrored.frond(27, 250, 80, true)

	for y := range plain.h {
		for x := range plain.w {
			if plain.has(x, y) != mirrored.has(2*w-1-x, 2*h-1-y) {
				t.Fatalf("block (%d, %d) is not mirrored to (%d, %d)", x, y, 2*w-1-x, 2*h-1-y)
			}
		}
	}
}
