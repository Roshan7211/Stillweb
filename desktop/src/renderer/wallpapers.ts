// The home page's built-in backgrounds. They are drawn with gradients, so there are no
// picture files to ship or credit, and they are sharp at any window size.

export type Wallpaper = {
  id: string;
  name: string;
  /** A CSS `background` value. */
  background: string;
  /** Whether text on it is light (on a dark picture) or dark. */
  ink: 'light' | 'dark';
};

const glow = (x: number, y: number, color: string, size = 55) => `radial-gradient(${size + 30}% ${size + 10}% at ${x}% ${y}%, ${color} 0%, transparent ${size}%)`;

export const WALLPAPERS: Wallpaper[] = [
  {
    id: 'brand',
    name: 'Stillweb',
    ink: 'light',
    background: [glow(12, 8, '#5b54e8'), glow(92, 18, '#2f6feb', 60), glow(62, 104, '#0891b2', 60), '#1b2470'].join(', '),
  },
  {
    id: 'aurora',
    name: 'Aurora',
    ink: 'light',
    background: [glow(18, 100, '#12b886', 50), glow(72, 92, '#22d3ee', 45), glow(88, 6, '#7c3aed', 50), glow(30, 0, '#1d4ed8', 45), '#07111f'].join(', '),
  },
  {
    id: 'dusk',
    name: 'Dusk',
    ink: 'light',
    background: [glow(50, 108, '#fb923c', 55), glow(8, 70, '#e11d74', 50), glow(92, 60, '#9333ea', 50), glow(50, 0, '#312e81', 60), '#1a1033'].join(', '),
  },
  {
    id: 'forest',
    name: 'Forest',
    ink: 'light',
    background: [glow(14, 12, '#15803d', 55), glow(86, 26, '#0f766e', 55), glow(56, 104, '#84cc16', 42), '#0b2a1f'].join(', '),
  },
  {
    id: 'graphite',
    name: 'Graphite',
    ink: 'light',
    background: [glow(20, 0, '#3f4652', 60), glow(90, 100, '#2a3340', 60), '#15171b'].join(', '),
  },
  {
    id: 'sand',
    name: 'Sand',
    ink: 'dark',
    background: [glow(10, 10, '#ffd9b8', 55), glow(90, 14, '#ffe9c7', 55), glow(64, 104, '#f8c8d8', 55), '#fbf1e6'].join(', '),
  },
  {
    id: 'mist',
    name: 'Mist',
    ink: 'dark',
    background: [glow(12, 6, '#cfe3ff', 55), glow(88, 24, '#d9f2ee', 55), glow(50, 106, '#e4dcff', 55), '#f3f6fb'].join(', '),
  },
];

/** The background and text color for a wallpaper setting; null for a plain page. */
export function wallpaperStyle(setting: string, customImage: string | null): { background: string; ink: 'light' | 'dark' } | null {
  if (setting.startsWith('custom')) {
    // A veil over the picture keeps the text readable whatever the picture is.
    return customImage ? { background: `linear-gradient(rgba(0, 0, 0, 0.38), rgba(0, 0, 0, 0.38)), url("${customImage}") center / cover no-repeat`, ink: 'light' } : null;
  }
  const found = WALLPAPERS.find((wallpaper) => wallpaper.id === setting);
  return found ? { background: found.background, ink: found.ink } : null;
}
