package theme

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// maxFileSize is the largest custom theme file Load accepts.
const maxFileSize = 64 << 10

var nameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

// Load returns the theme called name: the built-in "auto" or "gta6", or the
// custom theme in <dir>/<name>.json (appendix D.5). The name is validated
// before anything is read. Without a dir there are only the built-in themes.
//
// The error is a short reason without the theme's name, such as "not found"
// or "colors.main: invalid color", for the caller to show after the name.
func Load(name, dir string) (*Theme, error) {
	if !nameRE.MatchString(name) {
		return nil, errors.New("invalid name")
	}
	switch name {
	case "auto":
		return autoTheme, nil
	case "gta6":
		return gta6Theme, nil
	}
	// Joining an empty dir would name a file in the working directory.
	if dir == "" {
		return nil, errors.New("not found")
	}

	path := filepath.Join(dir, name+".json")
	// Lstat first: opening a FIFO would block, and a symlink could point anywhere.
	fi, err := os.Lstat(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return nil, errors.New("not found")
	case err != nil:
		return nil, err
	case !fi.Mode().IsRegular():
		return nil, errors.New("not a regular file")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxFileSize+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxFileSize {
		return nil, errors.New("file larger than 64 KiB")
	}
	return parse(data)
}

// themeFile is the JSON form of a custom theme. Every field is optional.
type themeFile struct {
	Colors     map[string]string `json:"colors"`
	Title      *titleJSON        `json:"title"`
	Background *struct {
		Stops []string `json:"stops"`
	} `json:"background"`
	Glass *struct {
		Color *string  `json:"color"`
		Alpha *float64 `json:"alpha"`
	} `json:"glass"`
	Decor *decorJSON `json:"decor"`
}

// titleJSON is one color or an array of colors.
type titleJSON []string

func (t *titleJSON) UnmarshalJSON(b []byte) error {
	var one string
	if json.Unmarshal(b, &one) == nil {
		*t = titleJSON{one}
		return nil
	}
	return json.Unmarshal(b, (*[]string)(t))
}

// decorJSON is a kind given as a string, or an object.
type decorJSON struct {
	Kind  *string  `json:"kind"`
	Color *string  `json:"color"`
	Alpha *float64 `json:"alpha"`
}

func (d *decorJSON) UnmarshalJSON(b []byte) error {
	var kind string
	if json.Unmarshal(b, &kind) == nil {
		d.Kind = &kind
		return nil
	}
	type object decorJSON
	return json.Unmarshal(b, (*object)(d))
}

// parse builds a theme from the content of a custom theme file. Roles the
// file does not mention keep auto's colors.
func parse(data []byte) (*Theme, error) {
	var f themeFile
	if err := json.Unmarshal(data, &f); err != nil {
		var typeErr *json.UnmarshalTypeError
		if errors.As(err, &typeErr) && typeErr.Field != "" {
			return nil, fmt.Errorf("%s: wrong type", typeErr.Field)
		}
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}

	t := &Theme{dark: autoTheme.dark, light: autoTheme.light}
	for role, name := range roleNames[:paletteSize] {
		s, ok := f.Colors[name]
		if !ok {
			continue
		}
		c, err := parseColor(s)
		if err != nil {
			return nil, fmt.Errorf("colors.%s: %w", name, err)
		}
		t.dark[role], t.light[role] = c, c
	}

	if f.Title != nil {
		if len(*f.Title) == 0 {
			return nil, errors.New("title: no colors")
		}
		for i, s := range *f.Title {
			c, err := parseColor(s)
			if err != nil {
				return nil, fmt.Errorf("title[%d]: %w", i, err)
			}
			t.title = append(t.title, c)
		}
	}

	if f.Background != nil {
		if len(f.Background.Stops) == 0 {
			return nil, errors.New("background.stops: no colors")
		}
		for i, s := range f.Background.Stops {
			c, err := parseRGB(s)
			if err != nil {
				return nil, fmt.Errorf("background.stops[%d]: %w", i, err)
			}
			t.stops = append(t.stops, c)
		}
	}

	glass := Glass{Color: RGB{}, Alpha: 0.5} // the default: #000000, 0.5
	if g := f.Glass; g != nil {
		var err error
		if glass.Color, glass.Alpha, err = parseTint("glass", g.Color, g.Alpha, glass.Color, glass.Alpha); err != nil {
			return nil, err
		}
	}

	var decor Decor
	if d := f.Decor; d != nil {
		c, alpha, err := parseTint("decor", d.Color, d.Alpha, palmColor, palmAlpha)
		if err != nil {
			return nil, err
		}
		switch {
		case d.Kind == nil || *d.Kind == "none":
		case *d.Kind == "palms":
			decor = Decor{Kind: DecorPalms, Color: c, Alpha: alpha}
		default:
			return nil, errors.New(`decor.kind: neither "none" nor "palms"`)
		}
	}

	// Glass and decor only exist on a background.
	if t.HasBackground() {
		t.glass, t.decor = glass, decor
	}
	return t, nil
}

// parseTint parses the color and alpha of the glass or decor field. An absent
// one keeps its default.
func parseTint(field string, color *string, alpha *float64, c RGB, a float64) (RGB, float64, error) {
	if color != nil {
		var err error
		if c, err = parseRGB(*color); err != nil {
			return c, a, fmt.Errorf("%s.color: %w", field, err)
		}
	}
	if alpha != nil {
		if a = *alpha; a < 0 || a > 1 {
			return c, a, fmt.Errorf("%s.alpha: not between 0 and 1", field)
		}
	}
	return c, a, nil
}

// parseColor parses one of the four notations of appendix D.1.
func parseColor(s string) (Color, error) {
	switch s {
	case "default":
		return defaultColor, nil
	case "faint":
		return faintColor, nil
	}
	if index, ok := strings.CutPrefix(s, "ansi:"); ok {
		if n, err := strconv.ParseUint(index, 10, 8); err == nil && n <= 15 {
			return ansiColor(uint8(n)), nil
		}
	} else if c, err := parseRGB(s); err == nil {
		return c.Color(), nil
	}
	return Color{}, errors.New("invalid color")
}

// parseRGB parses "#rrggbb".
func parseRGB(s string) (RGB, error) {
	if len(s) == 7 && s[0] == '#' {
		if v, err := strconv.ParseUint(s[1:], 16, 24); err == nil {
			return RGB{uint8(v >> 16), uint8(v >> 8), uint8(v)}, nil
		}
	}
	return RGB{}, errors.New("not a #rrggbb color")
}
