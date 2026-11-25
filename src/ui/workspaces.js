const compareLimit = 4;
let projectAction;

function activeProject() {
  return state.projects.find(project => project.id === state.projectId) || state.projects[0];
}

function previewSettings() {
  if (state.view === 'compare') return state.comparisonPreview || state;
  if (state.view === 'projects') return activeProject() || state;
  return state;
}

function syncPreviewSettings() {
  const settings = previewSettings();
  sampleField.value = settings.sample;
  sizeField.value = settings.size;
  updateSample();
  updateSize();
}

function styleSnapshot(card) {
  return { key: card.style.key, axes: [...card.values] };
}

function storeStyle(settings, key, value) {
  Object.defineProperty(settings.styles, key, { configurable: true, enumerable: true, writable: true, value });
}

function updateComparisonButton(card) {
  const chosen = state.compare.includes(familyKey(card.family));
  const label = (chosen ? 'Убрать из сравнения: ' : 'Сравнить: ') + card.family.name;
  card.compareButton.setAttribute('aria-pressed', String(chosen));
  card.compareButton.setAttribute('aria-label', label);
  card.compareButton.title = label;
}

function toggleComparison(card) {
  const key = familyKey(card.family);
  const position = state.compare.indexOf(key);
  if (position !== -1) {
    state.compare.splice(position, 1);
    delete state.comparisonPreview?.styles[key];
    if (!state.compare.length) {
      state.comparisonPreview = null;
      if (state.view === 'compare') syncPreviewSettings();
    }
  } else if (state.compare.length < compareLimit) {
    state.comparisonPreview ??= { sample: sampleField.value, size: Number(sizeField.value), styles: {} };
    state.compare.push(key);
    storeStyle(state.comparisonPreview, key, styleSnapshot(card));
    showStatus('Добавлено в сравнение · ' + state.compare.length + ' из ' + compareLimit);
  } else {
    showStatus('В сравнении уже четыре шрифта. Уберите один, чтобы добавить другой.');
    return;
  }
  updateComparisonButton(card);
  applyFilters();
  save();
}

function clipboardText(card) {
  const line = card.family.name + ' ' + card.style.name;
  const axes = card.style.face.axes.map((axis, index) => axis.tag + '=' + Number(card.values[index].toFixed(4)));
  return axes.length ? line + '\n' + axes.join(', ') : line;
}

async function copySpecimen(card) {
  const text = clipboardText(card);
  if (bridge) {
    bridge.postMessage('copy:' + text);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showStatus('Скопировано для Figma.');
  } catch {
    showStatus('Не удалось скопировать. Попробуйте ещё раз.');
  }
}

function updateProjectButton(card) {
  const inProject = state.view === 'projects';
  const label = (inProject ? 'Убрать из подборки: ' : 'В подборку: ') + card.family.name;
  card.projectButton.setAttribute('aria-label', label);
  card.projectButton.title = label;
  card.projectButton.replaceChildren(icon(inProject ? 'close' : 'folder'));
}

function manageProjectFont(card) {
  if (state.view !== 'projects') {
    showProjectDialog('add', card);
    return;
  }
  const project = activeProject();
  if (!project) return;
  const key = familyKey(card.family);
  project.fonts = project.fonts.filter(font => font !== key);
  delete project.styles[key];
  applyFilters();
  save();
  showStatus('Шрифт убран из подборки.');
}

function showProjectControls() {
  const visible = state.view === 'projects';
  byId('project-controls').hidden = !visible;
  byId('count-projects').textContent = state.projects.length || '';
  if (!visible) return;
  const project = activeProject();
  const picker = byId('project-picker');
  const projectsChanged = picker.options.length !== state.projects.length ||
    state.projects.some((item, index) => picker.options[index].value !== item.id || picker.options[index].text !== item.name);
  if (projectsChanged) picker.replaceChildren(...state.projects.map(item => new Option(item.name, item.id)));
  if (project) picker.value = project.id;
  for (const id of ['project-picker-group', 'project-rename', 'project-delete']) byId(id).hidden = !project;
}

function showProjectDialog(mode, card) {
  const current = activeProject();
  if ((mode === 'rename' || mode === 'delete') && !current) return;
  const name = byId('project-name');
  const target = byId('project-target');
  const detail = byId('project-dialog-detail');
  const confirm = byId('project-confirm');
  const title = { new: 'Новая подборка', add: 'Добавить в подборку', rename: 'Переименовать подборку', delete: 'Удалить подборку?' };
  projectAction = { mode, card, current };
  byId('project-dialog-title').textContent = title[mode];
  byId('project-target-field').hidden = mode !== 'add';
  detail.hidden = mode !== 'delete';
  detail.textContent = mode === 'delete' ? '«' + current.name + '» исчезнет из Fonty. Файлы шрифтов останутся на месте.' : '';
  confirm.textContent = mode === 'delete' ? 'Удалить' : mode === 'add' ? 'Добавить' : 'Сохранить';
  confirm.classList.toggle('danger', mode === 'delete');
  name.value = mode === 'rename' ? current.name : '';
  name.setCustomValidity('');
  if (mode === 'add') {
    target.replaceChildren(...state.projects.map(item => new Option(item.name, item.id)), new Option('Новая подборка…', 'new'));
    target.value = current?.id || 'new';
  }
  showProjectNameField();
  byId('project-dialog').showModal();
  if (!byId('project-name-field').hidden) name.focus();
  else if (mode === 'add') target.focus();
  else byId('project-cancel').focus();
}

function showProjectNameField() {
  const { mode } = projectAction;
  const visible = mode === 'new' || mode === 'rename' || (mode === 'add' && byId('project-target').value === 'new');
  byId('project-name-field').hidden = !visible;
  byId('project-name').disabled = !visible;
}

function commitProject(event) {
  event.preventDefault();
  const { mode, card, current } = projectAction;
  const input = byId('project-name');
  const dialog = byId('project-dialog');
  const name = input.value.trim();
  let project = current;
  if (!input.disabled) {
    const duplicate = state.projects.some(item => (mode !== 'rename' || item !== current) && collator.compare(item.name, name) === 0);
    if (!name || duplicate) {
      input.setCustomValidity(name ? 'Подборка с таким названием уже есть.' : 'Введите название подборки.');
      input.reportValidity();
      return;
    }
    if (mode === 'rename') project.name = name;
    else {
      project = { id: crypto.randomUUID(), name, fonts: [], styles: {}, sample: sampleField.value, size: Number(sizeField.value) };
      state.projects.push(project);
    }
  } else if (mode === 'add') {
    project = state.projects.find(item => item.id === byId('project-target').value);
    if (!project) return;
  }
  if (mode === 'delete') {
    state.projects = state.projects.filter(item => item !== project);
    state.projectId = state.projects[0]?.id || '';
  } else {
    state.projectId = project.id;
    if (mode === 'add') {
      const key = familyKey(card.family);
      if (project.fonts.includes(key)) showStatus('Шрифт уже в подборке «' + project.name + '».');
      else {
        project.fonts.push(key);
        storeStyle(project, key, styleSnapshot(card));
        showStatus('Добавлено в подборку «' + project.name + '».');
      }
    }
  }
  dialog.close();
  if (state.view === 'projects') syncPreviewSettings();
  applyFilters();
  save();
}

function bindWorkspaces() {
  byId('project-new').addEventListener('click', () => showProjectDialog('new'));
  byId('project-rename').addEventListener('click', () => showProjectDialog('rename'));
  byId('project-delete').addEventListener('click', () => showProjectDialog('delete'));
  byId('project-target').addEventListener('change', () => {
    showProjectNameField();
    if (!byId('project-name').disabled) byId('project-name').focus();
  });
  byId('project-name').addEventListener('input', event => event.target.setCustomValidity(''));
  byId('project-cancel').addEventListener('click', () => byId('project-dialog').close());
  byId('project-form').addEventListener('submit', commitProject);
  byId('project-picker').addEventListener('change', event => {
    state.projectId = event.target.value;
    displayLimit = pageSize;
    syncPreviewSettings();
    applyFilters(true);
    save();
  });
  byId('clear-compare').addEventListener('click', () => {
    state.compare = [];
    state.comparisonPreview = null;
    syncPreviewSettings();
    applyFilters();
    save();
  });
}
