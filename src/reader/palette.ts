export type PaletteName = 'theme' | 'soft' | 'warm' | 'cool';
export interface ReadingPalette { foreground?: string; dialogue?: string; innerQuotes?: string; keywords?: string }

/** Foreground-only presets: never recolor the workbench or ordinary code editors. */
export function readingPalette(name: string, light: boolean, highContrast = false): ReadingPalette {
  if (highContrast || name === 'theme') return {};
  if (name === 'soft') return light
    ? { foreground: '#374151', dialogue: '#34675C', innerQuotes: '#765B8A', keywords: '#49688F' }
    : { foreground: '#CCD1D8', dialogue: '#A9C8B5', innerQuotes: '#BEB0D3', keywords: '#ACC5DE' };
  if (name === 'warm') return light
    ? { foreground: '#4A3D2F', dialogue: '#805D35', innerQuotes: '#795B73', keywords: '#476553' }
    : { foreground: '#D8CEBF', dialogue: '#DDBA8C', innerQuotes: '#CBB1C1', keywords: '#B3C6A7' };
  if (name === 'cool') return light
    ? { foreground: '#334454', dialogue: '#356786', innerQuotes: '#765B97', keywords: '#326E61' }
    : { foreground: '#CAD5DF', dialogue: '#A1C6DE', innerQuotes: '#BCB1DC', keywords: '#9FCABF' };
  return {};
}

export function validColor(value: unknown): string {
  return typeof value === 'string' && /^#[\da-f]{6}([\da-f]{2})?$/i.test(value) ? value : '';
}
