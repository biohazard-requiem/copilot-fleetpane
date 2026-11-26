package theme

import "testing"

func TestMix(t *testing.T) {
	black, white := RGB{}, RGB{0xff, 0xff, 0xff}
	tests := []struct {
		name string
		a, b RGB
		k    float64
		want RGB
	}{
		{"k=0 is a", RGB{0x10, 0x20, 0x30}, RGB{0x30, 0x40, 0x50}, 0, RGB{0x10, 0x20, 0x30}},
		{"k=1 is b", RGB{0x10, 0x20, 0x30}, RGB{0x30, 0x40, 0x50}, 1, RGB{0x30, 0x40, 0x50}},
		{"midpoint", RGB{0x10, 0x20, 0x30}, RGB{0x30, 0x40, 0x50}, 0.5, RGB{0x20, 0x30, 0x40}},
		{"midpoint rounds to nearest", black, white, 0.5, RGB{0x80, 0x80, 0x80}},
		{"components move independently", RGB{0xff, 0, 0}, RGB{0, 0, 0xff}, 0.25, RGB{0xbf, 0, 0x40}},
		{"gta6 top stop under glass", RGB{0x2b, 0x1d, 0x5c}, RGB{0x17, 0x0a, 0x30}, 0.60, RGB{0x1f, 0x12, 0x42}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Mix(tt.a, tt.b, tt.k); got != tt.want {
				t.Errorf("Mix(%v, %v, %v) = %v, want %v", tt.a, tt.b, tt.k, got, tt.want)
			}
		})
	}
}

func TestGradient(t *testing.T) {
	two := []RGB{{0, 0, 0}, {200, 100, 50}}
	three := []RGB{{0, 0, 0}, {100, 100, 100}, {100, 200, 0}}
	tests := []struct {
		name  string
		stops []RGB
		t     float64
		want  RGB
	}{
		{"two stops, start", two, 0, RGB{0, 0, 0}},
		{"two stops, end", two, 1, RGB{200, 100, 50}},
		{"two stops, midpoint", two, 0.5, RGB{100, 50, 25}},
		{"three stops, start", three, 0, RGB{0, 0, 0}},
		{"three stops, end", three, 1, RGB{100, 200, 0}},
		{"three stops, midpoint is the middle stop", three, 0.5, RGB{100, 100, 100}},
		{"three stops, first segment", three, 0.25, RGB{50, 50, 50}},
		{"three stops, second segment", three, 0.75, RGB{100, 150, 50}},
		{"single stop, start", two[1:], 0, RGB{200, 100, 50}},
		{"single stop, midpoint", two[1:], 0.5, RGB{200, 100, 50}},
		{"single stop, end", two[1:], 1, RGB{200, 100, 50}},
		{"below 0 clamps to the first stop", three, -1, RGB{0, 0, 0}},
		{"above 1 clamps to the last stop", three, 2, RGB{100, 200, 0}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Gradient(tt.stops, tt.t); got != tt.want {
				t.Errorf("Gradient(%v, %v) = %v, want %v", tt.stops, tt.t, got, tt.want)
			}
		})
	}
}

func TestRGBIsAnOpaqueColor(t *testing.T) {
	r, g, b, a := RGB{0x12, 0xab, 0xff}.RGBA()
	if r != 0x1212 || g != 0xabab || b != 0xffff || a != 0xffff {
		t.Errorf("RGBA() = %#x %#x %#x %#x, want 0x1212 0xabab 0xffff 0xffff", r, g, b, a)
	}
}
