type Rgba = [number, number, number, number];

const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));

/** Parses `#rgb[a]`, `#rrggbb[aa]`, `rgb()/rgba()` and `hsl()/hsla()` (comma or space separated,
 * `/` or `,` alpha). Channels are cut to 0..255 and alpha to 0..1, as CSS does. */
function parse(color: string): Rgba {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c);
  if (hex) {
    let h = hex[1];
    if (h.length <= 4) h = [...h].map((d) => d + d).join("");
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const hslFn = /^hsla?\(\s*([^)]*)\)$/i.exec(c);
  if (hslFn) {
    const parts = hslFn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length === 3 || parts.length === 4) {
      const [h, s, l] = parts.slice(0, 3).map((p) => {
        const v = parseFloat(p);
        if (Number.isNaN(v)) throw new Error(`Unreadable colour: ${color}`);
        return v;
      });
      const hue = parts[0].toLowerCase().endsWith("turn") ? h * 360 : h;
      const sat = clamp(s, 100) / 100;
      const light = clamp(l, 100) / 100;
      const k = (n: number) => (n + (((hue % 360) + 360) % 360) / 30) % 12;
      const a = sat * Math.min(light, 1 - light);
      const channel = (n: number) =>
        (light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))) * 255;
      return [channel(0), channel(8), channel(4), alpha(parts[3], color)];
    }
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
      const [r, g, b] = parts.slice(0, 3).map((p) => clamp(num(p, 255), 255));
      return [r, g, b, parts[3] === undefined ? 1 : clamp(num(parts[3], 1), 1)];
    }
  }
  throw new Error(`Unreadable colour: ${color}`);
}

function alpha(part: string | undefined, color: string): number {
  if (part === undefined) return 1;
  const v = part.endsWith("%") ? parseFloat(part) / 100 : parseFloat(part);
  if (Number.isNaN(v)) throw new Error(`Unreadable colour: ${color}`);
  return clamp(v, 1);
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
