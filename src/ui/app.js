const byId = id => document.getElementById(id);
const sampleField = byId('sample');
const sampleEntry = sampleField.closest('.sample-entry');
const sizeField = byId('size');
const sort = byId('sort');
const search = byId('search');
const cyrillic = byId('cyrillic');
const rows = byId('rows');
const refresh = byId('refresh');
const localState = byId('local-state');
const scanTime = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const compactGrid = matchMedia('(max-width: 840px)');
const motionEasing = getComputedStyle(rows).getPropertyValue('--ease-out').trim();
const presets = {
  ru: 'Тихий свет',
  en: 'Shape & rhythm',
  numbers: '0123456789'
};
const axisNames = {
  wght: 'Толщина', wdth: 'Ширина', ital: 'Курсив',
  slnt: 'Наклон', opsz: 'Оптический размер', GRAD: 'Насыщенность',
  EDPT: 'Глубина', EHLT: 'Блики'
};
const names = { all: 'Мои шрифты', google: 'Google Fonts', trends: 'Тренды', favorites: 'Избранное', compare: 'Сравнение', projects: 'Подборки' };
const state = {
  view: 'all', layout: 'grid', sort: 'recent', favorites: [], styles: {}, size: 48, sample: presets.en,
  compare: [], comparisonPreview: null, projects: [], projectId: ''
};
try {
  const saved = JSON.parse(localStorage.getItem('litera') || '{}');
  Object.assign(state, saved);
} catch {}
const favorites = new Set(state.favorites);
const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });
let cards = [];
let mountedSettings;
let localFamilies = [];
let googleFamilies = [];
let googlePending = true;
let googleError = false;
let ranking = 'trending';
const pageSize = 36;
let displayLimit = pageSize;
let revision = 0;
let fontRequests = new Map();
const googleFontRequests = new Map();
let loadError = false;
let loading = false;
let renderFrame = 0;
let saveTimer = 0;
let typingTimer = 0;
const familyKey = family => family.remote ? 'Google Fonts:' + family.name : family.name;
const bridge = window.chrome?.webview;

function save() {
  clearTimeout(saveTimer);
  try {
    localStorage.setItem('litera', JSON.stringify({
      layout: state.layout, sort: state.sort, size: state.size, sample: state.sample,
      favorites: [...favorites], styles: state.styles, compare: state.compare, comparisonPreview: state.comparisonPreview,
      projects: state.projects, projectId: state.projectId
    }));
  } catch {}
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 180);
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const use = document.createElementNS(ns, 'use');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

function iconButton(className, symbol, label) {
  const button = node('button', className);
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(icon(symbol));
  return button;
}

function displayName(family, face) {
  const prefix = family + ' ';
  return face.name.toLowerCase().startsWith(prefix.toLowerCase()) ? face.name.slice(prefix.length) : face.name;
}

function styleChoices(family) {
  return family.faces.flatMap(face => {
    const name = displayName(family.name, face);
    const options = [{ name, face, values: face.axes.map(axis => axis.value) }];
    if (face.axes.length) {
      for (const instance of face.instances) {
        if (instance.values.every((value, index) => value === options[0].values[index])) continue;
        options.push({ name: instance.name, face, values: instance.values });
      }
    }
    return options.map(option => ({ ...option, key: face.name + '|' + option.name + '|' + option.values.join(',') }));
  });
}

const observer = new IntersectionObserver(entries => {
  for (const entry of entries) {
    const card = entry.target.card;
    card.inRange = entry.isIntersecting;
    if (card.inRange && card.element.isConnected) paint(card);
  }
}, { rootMargin: '330px 0px' });

function makeCard(family) {
  const element = node('article', 'card');
  const header = node('div', 'card-head');
  const identity = node('div', 'identity');
  identity.append(node('h3', '', family.name));
  if (family.remote) {
    const link = node('a', 'google-tag', 'Google Fonts ');
    link.href = 'https://fonts.google.com/specimen/' + encodeURIComponent(family.name).replaceAll('%20', '+');
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', family.name + ' в Google Fonts');
    link.append(icon('arrow'));
    identity.append(link);
  }
  const scriptBadge = node('span', 'script-tag');
  identity.append(scriptBadge);
  const favorite = iconButton('favorite', 'heart', 'Избранное');
  const compareButton = iconButton('card-action compare-button', 'compare', 'Сравнить');
  const projectButton = iconButton('card-action', 'folder', 'В подборку');
  const copyButton = iconButton('card-action', 'copy', 'Копировать для Figma: ' + family.name);
  const actions = node('div', 'card-actions');
  if (!family.remote && bridge) {
    const remove = iconButton('remove-font', 'trash', family.removable ? 'Удалить ' + family.name : 'Управлять шрифтом в Windows');
    remove.addEventListener('click', () => askRemoval(family, remove));
    actions.append(remove);
  }
  actions.append(compareButton, favorite);
  const sample = node('div', 'sample', sampleField.value || presets.en);
  sample.dir = 'auto';
  sample.dataset.load = 'loading';
  header.append(identity, actions);

  const footer = node('div', 'card-foot');
  const styleTools = node('div', 'style-tools');
  const note = node('span', 'style-note');
  const panel = node('div', 'axis-panel');
  panel.id = 'axes-' + family.faces[0].id;
  panel.hidden = true;
  const axisButton = iconButton('axis-button', 'sliders', 'Настроить вариативный шрифт');
  axisButton.setAttribute('aria-controls', panel.id);
  axisButton.setAttribute('aria-expanded', 'false');
  const styles = styleChoices(family);
  const card = { family, element, favorite, compareButton, projectButton, sample, note, panel, axisButton, styles, scriptBadge, inRange: false };
  element.card = card;
  const standard = styles.find(style => !style.face.italic && /^(regular|normal|book|roman)$/i.test(style.name)) ||
    styles.find(style => !style.face.italic && style.face.weight === 400) || styles[0];
  const key = familyKey(family);
  const settings = previewSettings();
  const stored = Object.hasOwn(settings.styles, key) ? settings.styles[key] : undefined;
  const selected = styles.find(style => style.key === (typeof stored === 'string' ? stored : stored?.key)) || standard;
  const styleNames = styles.map(style => style.name);
  if (styles.length > 1) {
    const wrapper = node('div', 'style-select');
    const select = node('select');
    select.setAttribute('aria-label', 'Начертание ' + family.name);
    for (const [index, option] of styles.entries()) {
      const duplicate = styleNames.indexOf(option.name) !== styleNames.lastIndexOf(option.name);
      const label = duplicate ? option.name + (option.face.axes.length ? ' · вариативное' : ' · ' + option.face.weight) : option.name;
      select.add(new Option(label, String(index)));
    }
    select.value = String(styles.indexOf(selected));
    select.addEventListener('change', () => {
      const style = styles[Number(select.value)];
      setStyle(card, style);
      storeStyle(previewSettings(), key, styleSnapshot(card));
      save();
    });
    wrapper.append(select, icon('chevron'));
    styleTools.append(wrapper);
  } else {
    styleTools.append(node('span', 'single-style', selected.name));
  }
  styleTools.append(axisButton);
  const specimenActions = node('div', 'specimen-actions');
  specimenActions.append(note, projectButton, copyButton);
  footer.append(styleTools, specimenActions);
  element.append(header, sample, footer, panel);
  favorite.addEventListener('click', () => {
    if (favorites.has(key)) favorites.delete(key);
    else favorites.add(key);
    updateFavorite(card);
    applyFilters();
    save();
  });
  axisButton.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    axisButton.setAttribute('aria-expanded', String(!panel.hidden));
  });
  compareButton.addEventListener('click', () => toggleComparison(card));
  projectButton.addEventListener('click', () => manageProjectFont(card));
  copyButton.addEventListener('click', () => copySpecimen(card));
  updateFavorite(card);
  updateComparisonButton(card);
  updateProjectButton(card);
  setStyle(card, selected, stored?.key === selected.key ? stored.axes : undefined);
  observer.observe(element);
  return card;
}

function setStyle(card, style, values) {
  card.style = style;
  card.scriptBadge.classList.toggle('supported', style.face.cyrillic);
  card.scriptBadge.textContent = style.face.cyrillic ? '✓ Кириллица' : 'Без кириллицы';
  card.scriptBadge.title = style.face.cyrillic ? 'В этом начертании есть кириллица' : 'В этом начертании нет полной кириллицы';
  card.values = style.values.map((value, index) => {
    if (!Number.isFinite(values?.[index])) return value;
    const axis = style.face.axes[index];
    return Math.min(axis.max, Math.max(axis.min, values[index]));
  });
  card.axisButton.hidden = !style.face.axes.length;
  if (card.axisButton.hidden) {
    card.panel.hidden = true;
    card.axisButton.setAttribute('aria-expanded', 'false');
  }
  buildAxes(card);
  paint(card);
}

function buildAxes(card) {
  const axes = card.style.face.axes;
  card.panel.replaceChildren();
  if (!axes.length) return;
  const sliders = axes.map((axis, index) => {
    const row = node('label', 'axis-row');
    const input = node('input');
    input.type = 'range';
    input.min = axis.min;
    input.max = axis.max;
    input.step = axis.tag === 'ital' ? 1 : (axis.max - axis.min >= 50 ? 1 : 0.01);
    input.value = card.values[index];
    const output = node('output', '', number(card.values[index]));
    input.addEventListener('input', () => {
      card.values[index] = Number(input.value);
      output.value = number(card.values[index]);
      applyAxes(card);
      storeStyle(previewSettings(), familyKey(card.family), styleSnapshot(card));
      saveSoon();
    });
    row.append(node('span', '', axisNames[axis.tag] || axis.name), input, output);
    card.panel.append(row);
    return { input, output };
  });
  const reset = node('button', 'axis-reset', 'Сбросить оси');
  reset.type = 'button';
  reset.addEventListener('click', () => {
    card.values = [...card.style.values];
    sliders.forEach(({ input, output }, index) => {
      input.value = card.values[index];
      output.value = number(card.values[index]);
    });
    applyAxes(card);
    storeStyle(previewSettings(), familyKey(card.family), styleSnapshot(card));
    save();
  });
  card.panel.append(reset);
}

function number(value) {
  return value.toLocaleString('ru', { maximumFractionDigits: 2 });
}

function applyAxes(card) {
  if (card.displayed?.face !== card.style.face) return;
  const axes = card.style.face.axes;
  card.sample.style.fontVariationSettings = axes.length ?
    axes.map((axis, index) => '"' + axis.tag + '" ' + card.values[index]).join(', ') : 'normal';
  card.sample.style.fontOpticalSizing = axes.some(axis => axis.tag === 'opsz') ? 'none' : 'auto';
}

function updateFavorite(card) {
  const active = favorites.has(familyKey(card.family));
  const label = (active ? 'Убрать из избранного: ' : 'В избранное: ') + card.family.name;
  card.favorite.setAttribute('aria-pressed', String(active));
  card.favorite.setAttribute('aria-label', label);
  card.favorite.title = label;
}

function covered(ranges, code) {
  let left = 0;
  let right = ranges.length / 2;
  while (left < right) {
    const mid = (left + right) >> 1;
    if (code < ranges[2 * mid]) right = mid;
    else if (code > ranges[2 * mid + 1]) left = mid + 1;
    else return true;
  }
  return false;
}

function specimen(card, face, coverage = face.coverage) {
  const content = sampleField.value || presets.en;
  if (card.rendered?.text === content && card.rendered.face === face && card.rendered.coverage === coverage) return;
  card.rendered = { text: content, face, coverage };
  const fragments = [];
  let segment = '';
  let missingBefore = false;
  let lacksGlyphs = false;
  function flush() {
    if (!segment) return;
    if (missingBefore) fragments.push(node('span', 'missing', segment));
    else fragments.push(document.createTextNode(segment));
    segment = '';
  }
  for (const char of content) {
    const missing = coverage && !/^[\s\p{Cf}\p{Variation_Selector}]$/u.test(char) && !covered(coverage, char.codePointAt(0));
    if (missing !== missingBefore) flush();
    missingBefore = missing;
    lacksGlyphs ||= missing;
    segment += char;
  }
  flush();
  card.sample.replaceChildren(...fragments);
  card.note.textContent = lacksGlyphs ? 'Подчёркнутые знаки отсутствуют' : (face.axes.length ? 'Вариативный' : '');
}

function requestFont(face) {
  if (!fontRequests.has(face.id)) {
    const name = 'LiteraFont-' + revision + '-' + face.id;
    const font = new FontFace(name, 'url("/font/' + revision + '/' + face.id + '")');
    const catalog = fontRequests;
    catalog.set(face.id, font.load().then(result => {
      if (catalog === fontRequests) document.fonts.add(result);
      return result;
    }).catch(() => null));
  }
  return fontRequests.get(face.id);
}

function paint(card) {
  if (!card.inRange) return;
  const face = card.style.face;
  if (card.displayed) {
    specimen(card, card.displayed.face, card.displayed.coverage);
    applyAxes(card);
  }
  if (card.requested === face.id) return;
  card.requested = face.id;
  if (!card.displayed) {
    card.sample.dataset.load = 'loading';
    card.sample.textContent = sampleField.value || presets.en;
  }
  const request = face.remote ? requestGoogleFont(face) : requestFont(face);
  request.then(async font => {
    try {
      if (!font) throw new Error('Font unavailable');
      if (face.remote) await document.fonts.load('16px "' + font.family + '"', sampleField.value || presets.en);
      if (face !== card.style.face || !card.element.isConnected) return;
      const previous = card.displayed?.face;
      card.displayed = { face, coverage: face.remote ? font.coverage : face.coverage };
      specimen(card, face, card.displayed.coverage);
      applyAxes(card);
      card.sample.style.fontFamily = '"' + font.family + '", "Segoe UI", sans-serif';
      card.sample.dataset.load = 'ready';
      if (previous && previous !== face && !reducedMotion.matches) {
        card.swap?.cancel();
        card.swap = card.sample.animate([{ opacity: .72 }, { opacity: 1 }], { duration: 125, easing: motionEasing });
      }
    } catch {
      if (face !== card.style.face || !card.element.isConnected) return;
      card.swap?.cancel();
      card.displayed = null;
      card.rendered = null;
      card.sample.style.removeProperty('font-family');
      card.sample.style.removeProperty('font-variation-settings');
      card.sample.dataset.load = 'failed';
      card.note.textContent = '';
      if (!face.remote) {
        card.sample.textContent = 'Не удалось показать это начертание';
        return;
      }
      card.sample.replaceChildren(node('span', '', 'Образец недоступен. '));
      const retry = node('button', 'font-retry', 'Повторить');
      retry.type = 'button';
      retry.addEventListener('click', () => {
        if (font && googleFontRequests.get(face.id) === request) {
          font.fontFaces.forEach(fontFace => document.fonts.delete(fontFace));
          googleFontRequests.delete(face.id);
        }
        card.requested = null;
        paint(card);
      });
      card.sample.append(retry);
    }
  });
}

function requestGoogleFont(face) {
  if (!googleFontRequests.has(face.id)) {
    googleFontRequests.set(face.id, fetchGoogleFont(face).catch(() => {
      googleFontRequests.delete(face.id);
      return null;
    }));
  }
  return googleFontRequests.get(face.id);
}

function applyFilters(reveal = false) {
  const query = search.value.trim().toLocaleLowerCase();
  const inGoogle = state.view === 'google' || state.view === 'trends';
  const inCompare = state.view === 'compare', inProjects = state.view === 'projects';
  const inWorkspace = inCompare || inProjects;
  const project = inProjects ? activeProject() : undefined;
  const allFamilies = [...localFamilies, ...googleFamilies];
  const starred = allFamilies.filter(family => favorites.has(familyKey(family)));
  let families = state.view === 'favorites' ? starred : (inGoogle ? googleFamilies : localFamilies);
  let workspaceKeys = [];
  if (inWorkspace) {
    workspaceKeys = inCompare ? state.compare : project?.fonts || [];
    const byKey = new Map(allFamilies.map(family => [familyKey(family), family]));
    families = workspaceKeys.map(key => byKey.get(key)).filter(Boolean);
  }
  if (state.view === 'all' && state.sort === 'recent') {
    families = [...families].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0) || collator.compare(a.name, b.name));
  }
  if (state.view === 'trends') {
    families = families.filter(family => Number.isFinite(family[ranking]) && family[ranking] > 0)
      .sort((a, b) => a[ranking] - b[ranking] || collator.compare(a.name, b.name))
      .slice(0, 100);
  }
  const results = inWorkspace ? families : families.filter(family => family.name.toLocaleLowerCase().includes(query) &&
    (!cyrillic.checked || family.faces.some(face => face.cyrillic)));
  rows.classList.toggle('compare', inCompare);
  byId('composer').hidden = (inProjects && !project) || (inCompare && !state.compare.length);
  mountResults(results.slice(0, displayLimit), reveal);
  const pending = inWorkspace ? workspaceKeys.length > 0 && (googlePending || loading) : (inGoogle ? googlePending : loading);
  byId('count-all').textContent = loading && !localFamilies.length ? '' : localFamilies.length;
  byId('count-google').textContent = googlePending ? '' : googleFamilies.length.toLocaleString('ru');
  byId('count-favorites').textContent = starred.length;
  byId('count-compare').textContent = state.compare.length || '';
  showProjectControls();
  byId('page-title').textContent = names[state.view];
  byId('library-title').textContent = inCompare ? 'В сравнении' : inProjects && project ? project.name :
    state.view === 'all' || state.view === 'google' ? 'Коллекция' :
    state.view === 'trends' ? 'Рейтинг Google Fonts' : 'Сохранённые шрифты';
  byId('trends-switch').hidden = state.view !== 'trends';
  byId('local-sort').hidden = state.view !== 'all';
  byId('collection-tools').hidden = inWorkspace;
  byId('clear-compare').hidden = !inCompare || !state.compare.length;
  byId('result-count').textContent = pending && !results.length ? '…' : results.length.toLocaleString('ru');
  byId('load-more').hidden = results.length <= displayLimit;
  byId('scan-note').hidden = state.view !== 'all' || !byId('scan-note').textContent;
  rows.setAttribute('aria-busy', String(pending));
  const empty = byId('empty');
  empty.hidden = results.length !== 0;
  if (empty.hidden) return;
  const filters = !inWorkspace && (Boolean(query) || cyrillic.checked);
  byId('clear-filters').hidden = !filters;
  let message = ['Шрифты не найдены', 'Установите шрифты в Windows и обновите список.'];
  if (pending) message = [inWorkspace ? 'Загружаем шрифты…' : inGoogle ? 'Открываем каталог Google Fonts…' : 'Ищем установленные шрифты…', ''];
  else if (inWorkspace && workspaceKeys.length) message = ['Шрифты сейчас недоступны', 'Откройте каталог или убедитесь, что локальные шрифты установлены.'];
  else if (inCompare) message = ['Выберите шрифты для сравнения', 'Нажмите «Сравнить» на карточках в любой коллекции. Можно закрепить до четырёх шрифтов.'];
  else if (inProjects) message = project
    ? ['Подборка пока пуста', 'Нажмите «В подборку» на карточке шрифта, чтобы добавить его сюда.']
    : ['Создайте подборку для проекта', 'В ней сохранятся шрифты, текст образца и настройки начертаний.'];
  else if (inGoogle && googleError) message = ['Каталог Google Fonts недоступен', 'Перезапустите Fonty и попробуйте ещё раз.'];
  else if (!inGoogle && loadError && !localFamilies.length) message = ['Не удалось прочитать коллекцию', 'Обновите список через меню.'];
  else if (filters) message = ['Нет совпадений', 'Попробуйте изменить поиск или сбросить фильтры.'];
  else if (state.view === 'favorites') message = ['Здесь будут любимые шрифты', 'Нажмите на сердечко на карточке, чтобы добавить шрифт.'];
  byId('empty-title').textContent = message[0];
  byId('empty-detail').textContent = message[1];
}

function mountResults(families, reveal) {
  const settings = previewSettings();
  if (settings !== mountedSettings) {
    for (const old of cards) observer.unobserve(old.element);
    rows.replaceChildren();
    cards = [];
    mountedSettings = settings;
  }
  const rendered = new Map(cards.map(card => [card.family, card]));
  const wanted = new Set(families);
  for (const old of cards) {
    if (wanted.has(old.family)) continue;
    observer.unobserve(old.element);
    old.element.remove();
  }
  cards = families.map(family => rendered.get(family) || makeCard(family));
  const added = [];
  for (const [index, card] of cards.entries()) {
    if (rows.children[index] !== card.element) rows.insertBefore(card.element, rows.children[index] || null);
    if (reveal && !rendered.has(card.family)) added.push(card);
  }
  if (added.length && !reducedMotion.matches) {
    for (const [index, { card }] of visibleCards(added, 4).entries()) {
      card.layoutMotion = card.element.animate(
        [{ opacity: .25, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
        { duration: 200, delay: index * 30, fill: 'backwards', easing: motionEasing }
      );
    }
  }
}

function visibleCards(candidates, limit) {
  const viewport = document.documentElement.clientHeight;
  const visible = [];
  for (const card of candidates) {
    const rect = card.element.getBoundingClientRect();
    if (rect.top >= viewport) break;
    if (rect.bottom <= 42) continue;
    visible.push({ card, rect });
    if (visible.length === limit) break;
  }
  return visible;
}

function updateGrid(animate = false) {
  const list = state.layout === 'list';
  const compact = compactGrid.matches;
  const wasSingle = rows.matches('.list, .compact');
  const changing = wasSingle !== (list || compact);
  const previous = animate && changing && !reducedMotion.matches ? visibleCards(cards, 6) : [];
  for (const { card } of previous) card.layoutMotion?.cancel();
  rows.classList.toggle('list', list);
  rows.classList.toggle('compact', compact);
  const next = new Map(previous.map(({ card }) => [card, card.element.getBoundingClientRect()]));
  for (const { card, rect } of previous) {
    const target = next.get(card);
    if (target.top >= window.innerHeight || target.bottom <= 42) continue;
    const x = rect.x - target.x;
    const y = rect.y - target.y;
    if (Math.abs(x) + Math.abs(y) < 1) continue;
    // Large column swaps settle in place so samples do not sweep across neighboring cards.
    const nearby = Math.abs(x) < 26 && Math.abs(y) < 36;
    const transform = nearby ? 'translate(' + x + 'px,' + y + 'px)' : 'translateY(7px)';
    card.layoutMotion = card.element.animate(
      [{ opacity: nearby ? 1 : .66, transform }, { opacity: 1, transform: 'none' }],
      { duration: 200, easing: motionEasing }
    );
  }
}

async function readGoogle() {
  try {
    const response = await fetch('/google-catalog.json');
    if (!response.ok) throw new Error('Catalog unavailable');
    const entries = await response.json();
    googleFamilies = entries.map(googleFamily).sort((a, b) => collator.compare(a.name, b.name));
  } catch {
    googleError = true;
  } finally {
    googlePending = false;
    applyFilters(state.view === 'google' || state.view === 'trends');
  }
}

async function readCatalog() {
  if (loading) return;
  loading = true;
  refresh.disabled = true;
  rows.setAttribute('aria-busy', 'true');
  localState.dataset.scan = 'pending';
  localState.lastElementChild.textContent = 'Обновление…';
  applyFilters();
  try {
    const response = await fetch('/api/fonts', { cache: 'no-store' });
    if (!response.ok) throw new Error('Catalog unavailable');
    const catalog = await response.json();
    for (const request of fontRequests.values()) request.then(font => { if (font) document.fonts.delete(font); });
    fontRequests = new Map();
    revision = catalog.revision;
    localFamilies = catalog.families.sort((a, b) => collator.compare(a.name, b.name));
    const note = byId('scan-note');
    note.hidden = !catalog.skipped;
    note.textContent = catalog.skipped ? 'Не удалось прочитать некоторые файлы шрифтов: ' + catalog.skipped + '.' : '';
    loadError = false;
  } catch {
    loadError = true;
  } finally {
    loading = false;
    refresh.disabled = false;
    rows.setAttribute('aria-busy', 'false');
    localState.dataset.scan = loadError ? 'error' : 'ready';
    localState.lastElementChild.textContent = loadError ? 'Ошибка обновления' : 'Обновлено в ' + scanTime.format(new Date());
    applyFilters(!loadError);
  }
}

function updateSample() {
  previewSettings().sample = sampleField.value;
  for (const button of document.querySelectorAll('[data-preset]')) {
    button.setAttribute('aria-pressed', String(presets[button.dataset.preset] === sampleField.value));
  }
  if (!renderFrame) {
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      cards.forEach(paint);
    });
  }
  saveSoon();
}

function updateSize() {
  previewSettings().size = Number(sizeField.value);
  rows.style.setProperty('--preview-size', sizeField.value + 'px');
  byId('size-value').value = sizeField.value + ' px';
  saveSoon();
}

function setLayout(layout, animate) {
  state.layout = layout;
  updateGrid(animate);
  for (const button of document.querySelectorAll('[data-layout]')) {
    button.setAttribute('aria-pressed', String(button.dataset.layout === layout));
  }
  save();
}

let pendingRemoval = null;
let removing = false;
let statusTimeout;
const removalDialog = byId('remove-dialog');
const menu = byId('window-menu');

function showStatus(message) {
  const status = byId('status');
  status.textContent = message;
  status.hidden = false;
  clearTimeout(statusTimeout);
  statusTimeout = setTimeout(() => { status.hidden = true; }, 5000);
}

function askRemoval(family, trigger) {
  if (!family.removable) {
    bridge.postMessage('fonts-settings');
    return;
  }
  pendingRemoval = { family, trigger, revision };
  byId('remove-title').textContent = 'Удалить «' + family.name + '»?';
  byId('remove-message').textContent = 'Файлы всех начертаний отправятся в корзину. Семейство исчезнет из программ, которые используют установленные шрифты Windows.';
  byId('remove-result').hidden = true;
  byId('remove-confirm').disabled = false;
  byId('remove-confirm').textContent = 'В корзину';
  byId('remove-cancel').textContent = 'Отмена';
  removalDialog.showModal();
}

function setView(view, reveal = false) {
  state.view = view;
  displayLimit = pageSize;
  syncPreviewSettings();
  for (const button of document.querySelectorAll('[data-view]')) {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  applyFilters(reveal);
}

function changeFilters(reveal = false) {
  displayLimit = pageSize;
  applyFilters(reveal);
}

sampleField.value = state.sample;
sizeField.value = state.size;
sort.value = state.sort === 'name' ? 'name' : 'recent';
sampleField.addEventListener('input', () => {
  if (!reducedMotion.matches) {
    sampleEntry.setAttribute('data-typing', '');
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => sampleEntry.removeAttribute('data-typing'), 250);
  }
  updateSample();
});
sampleField.addEventListener('change', save);
sizeField.addEventListener('input', updateSize);
sizeField.addEventListener('change', save);
sort.addEventListener('change', () => {
  state.sort = sort.value;
  changeFilters();
  save();
});
search.addEventListener('input', () => changeFilters());
cyrillic.addEventListener('change', () => changeFilters());
compactGrid.addEventListener('change', () => updateGrid(true));
reducedMotion.addEventListener('change', () => {
  if (!reducedMotion.matches) return;
  sampleEntry.removeAttribute('data-typing');
  for (const card of cards) {
    card.layoutMotion?.cancel();
    card.swap?.cancel();
  }
});
window.addEventListener('pagehide', save);
refresh.addEventListener('click', () => {
  menu.open = false;
  readCatalog();
});
byId('clear-filters').addEventListener('click', () => {
  search.value = '';
  cyrillic.checked = false;
  changeFilters();
  search.focus();
});
byId('load-more').addEventListener('click', event => {
  displayLimit += pageSize;
  applyFilters(event.detail > 0);
});
byId('about').addEventListener('click', async () => {
  menu.open = false;
  byId('about-dialog').showModal();
  const label = byId('license');
  if (label.textContent) return;
  try {
    const response = await fetch('/license.txt');
    if (response.ok) label.textContent = await response.text();
  } catch {}
});
for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', event => setView(button.dataset.view, event.detail > 0));
}
for (const button of document.querySelectorAll('[data-menu-view]')) {
  button.addEventListener('click', event => {
    menu.open = false;
    setView(button.dataset.menuView, event.detail > 0);
    document.querySelector('.nav-item.active').focus();
  });
}
for (const button of document.querySelectorAll('[data-ranking]')) {
  button.addEventListener('click', event => {
    ranking = button.dataset.ranking;
    for (const item of document.querySelectorAll('[data-ranking]')) item.setAttribute('aria-pressed', String(item === button));
    changeFilters(event.detail > 0);
  });
}
for (const button of document.querySelectorAll('[data-layout]')) {
  button.addEventListener('click', event => setLayout(button.dataset.layout, event.detail > 0));
}
for (const button of document.querySelectorAll('[data-preset]')) {
  button.addEventListener('click', () => {
    sampleField.value = presets[button.dataset.preset];
    updateSample();
  });
}
for (const button of document.querySelectorAll('[data-window]')) {
  button.addEventListener('click', () => {
    if (button.dataset.window === 'close') save();
    bridge?.postMessage(button.dataset.window);
  });
}
document.addEventListener('click', event => {
  if (menu.open && !menu.contains(event.target)) menu.open = false;
});
byId('remove-confirm').addEventListener('click', () => {
  if (!pendingRemoval || removing) return;
  removing = true;
  byId('remove-confirm').disabled = true;
  byId('remove-confirm').textContent = 'Удаляем…';
  byId('remove-cancel').disabled = true;
  bridge.postMessage('remove:' + pendingRemoval.revision + ':' + pendingRemoval.family.faces[0].id);
});
removalDialog.addEventListener('cancel', event => {
  if (removing) event.preventDefault();
});
removalDialog.addEventListener('close', () => {
  if (pendingRemoval?.trigger.isConnected) pendingRemoval.trigger.focus();
  pendingRemoval = null;
});
bridge?.addEventListener('message', ({ data }) => {
  if (data.type === 'window') {
    const button = document.querySelector('[data-window=maximize]');
    const label = data.maximized ? 'Восстановить размер' : 'Развернуть';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.replaceChildren(icon(data.maximized ? 'restore' : 'max'));
  }
  if (data.type === 'status') showStatus(data.message);
  if (data.type === 'removal') {
    removing = false;
    byId('remove-cancel').disabled = false;
    if (data.success) {
      removalDialog.close();
      showStatus('Шрифт отправлен в корзину.');
    } else {
      byId('remove-result').hidden = false;
      byId('remove-result').textContent = data.message;
      byId('remove-confirm').textContent = 'В корзину';
      byId('remove-cancel').textContent = 'Закрыть';
    }
    readCatalog();
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menu.open) {
    menu.open = false;
    menu.querySelector('summary').focus();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !byId('collection-tools').hidden && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    search.focus();
    search.select();
  }
});
updateSample();
updateSize();
setLayout(state.layout);
bindWorkspaces();
readCatalog();
readGoogle();
