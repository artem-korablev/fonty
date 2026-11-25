const googleWeights = {
  100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium',
  600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black', 1000: 'ExtraBlack'
};

function googleFamily(entry, index) {
  const result = {
    name: entry.name,
    id: 'google-' + index,
    remote: true,
    cyrillic: entry.scripts.includes('cyrillic'),
    popular: entry.popular,
    trending: entry.trending,
    faces: []
  };
  const axes = entry.axes.filter(axis => /^[a-zA-Z0-9]{4}$/.test(axis[0]) &&
    axis.slice(1).every(Number.isFinite) && axis[1] < axis[3])
    .map(([tag, min, value, max]) => ({ tag, min, max, value, name: tag }));
  const variableWeight = axes.find(axis => axis.tag === 'wght');
  const styles = entry.styles.length ? entry.styles : ['400'];
  for (const style of styles) {
    const italic = style.endsWith('i');
    const weight = Number.parseInt(style, 10);
    const name = googleWeights[weight] || String(weight);
    const hasWeightAxis = variableWeight && weight >= variableWeight.min && weight <= variableWeight.max;
    let face = result.faces.find(item => hasWeightAxis && item.italic === italic && item.axes.some(axis => axis.tag === 'wght'));
    if (face) {
      face.instances.push({
        name: italic ? (weight === 400 ? 'Italic' : name + ' Italic') : name,
        values: face.axes.map(axis => axis.tag === 'wght' ? weight : axis.value)
      });
      continue;
    }
    const faceAxes = axes.filter(axis => axis.tag !== 'ital' && (axis.tag !== 'wght' || hasWeightAxis));
    const startingWeight = hasWeightAxis ? variableWeight.value : weight;
    const startingName = googleWeights[startingWeight] || String(startingWeight);
    face = {
      id: result.id + '-' + style,
      name: italic ? (startingWeight === 400 ? 'Italic' : startingName + ' Italic') : startingName,
      weight: startingWeight,
      italic,
      cyrillic: result.cyrillic,
      axes: faceAxes,
      instances: [],
      remote: result.name
    };
    if (hasWeightAxis && weight !== startingWeight) {
      face.instances.push({
        name: italic ? (weight === 400 ? 'Italic' : name + ' Italic') : name,
        values: faceAxes.map(axis => axis.tag === 'wght' ? weight : axis.value)
      });
    }
    result.faces.push(face);
  }
  return result;
}

function googleCssUrl(face, variable) {
  const positions = new Map();
  if (variable) for (const axis of face.axes) positions.set(axis.tag, axis.min + '..' + axis.max);
  if (!positions.has('wght') && face.weight !== 400) positions.set('wght', String(face.weight));
  if (face.italic) positions.set('ital', '1');
  const tags = [...positions.keys()].sort((a, b) => a.localeCompare(b, 'en'));
  const design = tags.length ? ':' + tags.join(',') + '@' + tags.map(tag => positions.get(tag)).join(',') : '';
  return 'https://fonts.googleapis.com/css2?family=' + encodeURIComponent(face.remote).replaceAll('%20', '+') + design;
}

function readUnicodeRanges(value) {
  if (!value) return [[0, 0x10ffff]];
  const ranges = [];
  for (const [, start, end] of value.matchAll(/U\+([0-9A-F?]{1,6})(?:-([0-9A-F]{1,6}))?/gi)) {
    ranges.push([parseInt(start.replaceAll('?', '0'), 16), parseInt((end || start).replaceAll('?', 'F'), 16)]);
  }
  return ranges;
}

async function fetchGoogleFont(face) {
  const getCss = url => fetch(url, { signal: AbortSignal.timeout(12000), referrerPolicy: 'no-referrer' });
  let response = await getCss(googleCssUrl(face, true));
  if (!response.ok && face.axes.length) response = await getCss(googleCssUrl(face, false));
  if (!response.ok) throw new Error('Google Fonts returned ' + response.status);

  const css = await response.text();
  const family = 'Fonty-' + face.id;
  const ranges = [];
  const fontFaces = [];
  for (const [, entry] of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
    const source = entry.match(/url\(['"]?(https:\/\/fonts\.gstatic\.com\/[^)'",\s]+)['"]?\)/i);
    if (!source) continue;
    const unicodeRange = entry.match(/unicode-range:\s*([^;]+);/i)?.[1].trim();
    const descriptors = unicodeRange ? { unicodeRange } : {};
    const cssFont = new FontFace(family, 'url("' + source[1] + '")', descriptors);
    ranges.push(...readUnicodeRanges(unicodeRange));
    fontFaces.push(cssFont);
  }
  if (!fontFaces.length) throw new Error('No usable Google Fonts sources');
  fontFaces.forEach(font => document.fonts.add(font));
  const merged = [];
  for (const [min, max] of ranges.sort((a, b) => a[0] - b[0])) {
    if (merged.length && min <= merged.at(-1) + 1) merged[merged.length - 1] = Math.max(max, merged.at(-1));
    else merged.push(min, max);
  }
  return { family, coverage: merged, fontFaces };
}
