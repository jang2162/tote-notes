type Rgba = [number, number, number, number];

/** Parses `#rgb[a]`, `#rrggbb[aa]` and `rgb()/rgba()` (comma or space separated, `/` or `,` alpha). */
function parse(color: string): Rgba {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((d) => d + d).join("");
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const fn = /^rgba?\(\s*([^)]*)\)$/i.exec(c);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length === 3 || parts.length === 4) {
      const num = (s: string, scale: number) => {
        const v = s.endsWith("%") ? (parseFloat(s) / 100) * scale : parseFloat(s);
        if (Number.isNaN(v)) throw new Error(`Unreadable colour: ${color}`);
        return v;
      };
      const [r, g, b] = parts.slice(0, 3).map((p) => num(p, 255));
      return [r, g, b, parts[3] === undefined ? 1 : num(parts[3], 1)];
    }
  }
  throw new Error(`Unreadable colour: ${color}`);
}

function over([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1];
}

function luminance([r, g, b]: Rgba): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of `fg` on `bg`. A translucent `bg` is mixed over `base`, a translucent
 * `fg` over the resulting background. Throws on a colour it cannot read. */
export function contrastRatio(fg: string, bg: string, base = "#ffffff"): number {
  const background = over(parse(bg), over(parse(base), [255, 255, 255, 1]));
  const foreground = over(parse(fg), background);
  const [hi, lo] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}
