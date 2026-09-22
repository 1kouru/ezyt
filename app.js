/* ==========================================================================
   ezyt. — логика приложения
   Хранение: Supabase (проекты, группы, ролики — с разделением по аккаунту
   через Row Level Security). localStorage остался только для мелких
   локальных настроек (звук, последний открытый проект в этом браузере).
   ========================================================================== */

(function () {
  'use strict';

  const SOUND_KEY = 'ytStudioSound';
  const GROUP_COLORS = ['blue', 'purple', 'teal', 'pink', 'amber', 'green'];

  // список проектов и текущий выбранный — свои у каждого аккаунта.
  // Сами данные (проекты/группы/ролики) теперь живут в Supabase и разделены
  // между пользователями через Row Level Security; в localStorage остаётся
  // только "какой проект открывал последним" — чисто локальная мелочь для
  // удобства, не критичные данные.
  function currentUsername() {
    const u = Auth.currentUser();
    return u ? u.username : 'guest';
  }
  function activeWorkspaceStorageKey() { return 'ytStudioActiveWorkspace::' + currentUsername(); }

  let workspaces = [];
  let activeWorkspaceId = null;
  let workspaceVideoCounts = {};

  const SORT_OPTIONS = [
    { id: 'new', label: 'Новые сначала' },
    { id: 'old', label: 'Старые сначала' },
    { id: 'az', label: 'По алфавиту (оригинал)' },
    { id: 'group', label: 'По группам' },
  ];

  /** @type {Array<Object>} */
  let videos = [];
  /** @type {Array<{id:string,name:string,color:string}>} */
  let groups = [];
  let currentGroupId = 'all';
  let currentSearch = '';
  let currentSort = 'new';
  let activeSort = 'new';
  let doneSort = 'new';
  let openVideoId = null;
  let isFirstRender = true;
  let newGroupSelectedColor = GROUP_COLORS[0];
  let pendingGroupTargetForForm = false;

  // ------------------------------------------------------------------ звук

  const AudioFX = (function () {
    let ctx = null;
    let enabled = true;
    try { enabled = localStorage.getItem(SOUND_KEY) !== 'off'; } catch (e) {}

    function getCtx() {
      if (!ctx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        ctx = new Ctor();
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }

    function tone(freq, duration, type, gainPeak, when) {
      if (!enabled) return;
      const c = getCtx();
      if (!c) return;
      const t0 = c.currentTime + (when || 0);
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(gainPeak || 0.04, t0 + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    }

    return {
      click() { tone(720, 0.06, 'sine', 0.03); },
      open() { tone(440, 0.08, 'sine', 0.035); tone(660, 0.09, 'sine', 0.028, 0.03); },
      close() { tone(360, 0.08, 'sine', 0.03); },
      success() { tone(523.25, 0.09, 'sine', 0.045); tone(659.25, 0.1, 'sine', 0.04, 0.07); tone(783.99, 0.18, 'sine', 0.04, 0.15); },
      undo() { tone(392, 0.09, 'sine', 0.03); tone(277, 0.13, 'sine', 0.026, 0.05); },
      add() { tone(587.33, 0.08, 'sine', 0.035); tone(880, 0.13, 'sine', 0.035, 0.06); },
      delete() { tone(300, 0.1, 'triangle', 0.03); tone(180, 0.16, 'triangle', 0.025, 0.06); },
      hover() { tone(880, 0.045, 'sine', 0.012); },
      toggle(v) {
        enabled = v;
        try { localStorage.setItem(SOUND_KEY, v ? 'on' : 'off'); } catch (e) {}
        if (v) tone(600, 0.06, 'sine', 0.03);
      },
      isEnabled() { return enabled; },
    };
  })();

  // ---------------------------------------------------------------- группы

  function rowToGroup(row) { return Object.assign({ id: row.id }, row.data); }

  async function loadGroups() {
    const { data, error } = await sb.from('groups').select('*').eq('workspace_id', activeWorkspaceId).order('created_at', { ascending: true });
    if (error) { showToast('Не удалось загрузить группы', 'warn'); groups = []; return; }
    groups = (data || []).map(rowToGroup);
  }

  async function insertGroup(g) {
    const user = Auth.currentUser();
    const { error } = await sb.from('groups').insert({ id: g.id, workspace_id: activeWorkspaceId, user_id: user.id, data: { name: g.name, color: g.color } });
    if (error) showToast('Не удалось сохранить группу', 'warn');
  }
  async function updateGroupRow(g) {
    const { error } = await sb.from('groups').update({ data: { name: g.name, color: g.color } }).eq('id', g.id);
    if (error) showToast('Не удалось сохранить группу', 'warn');
  }
  async function deleteGroupRow(id) {
    const { error } = await sb.from('groups').delete().eq('id', id);
    if (error) showToast('Не удалось удалить группу', 'warn');
  }
  async function reassignVideosGroup(oldGroupId, newGroupId) {
    const { error } = await sb.from('videos').update({ group_id: newGroupId }).eq('group_id', oldGroupId);
    if (error) showToast('Не удалось перенести ролики в другую группу', 'warn');
  }

  function groupById(id) { return groups.find((g) => g.id === id); }

  function groupUid() {
    return 'grp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }

  function grpStyle(group) {
    const color = (group && group.color) || 'blue';
    return `--grp-c:var(--${color})`;
  }

  // ---------------------------------------------------------------- проекты (workspaces)
  // Каждый проект — своя независимая пара "видео + группы". Список проектов
  // и сами данные хранятся в Supabase, разделены по пользователям через RLS.

  function workspaceUid() {
    return 'ws_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }

  function rowToWorkspace(row) {
    return Object.assign({ id: row.id, createdAt: new Date(row.created_at).getTime() }, row.data);
  }

  async function loadWorkspaces() {
    const user = Auth.currentUser();
    const { data, error } = await sb.from('workspaces').select('*').eq('user_id', user.id).order('created_at', { ascending: true });
    if (error) { showToast('Не удалось загрузить проекты', 'warn'); workspaces = []; }
    else workspaces = (data || []).map(rowToWorkspace);

    if (!workspaces.length) {
      // первый вход этого аккаунта — сразу создаём проект по умолчанию
      const mainWs = { id: workspaceUid(), name: 'Main', color: 'blue', createdAt: Date.now() };
      workspaces = [mainWs];
      await insertWorkspace(mainWs);
    }

    try { activeWorkspaceId = localStorage.getItem(activeWorkspaceStorageKey()); } catch (e) {}
    if (!activeWorkspaceId || !workspaces.some((w) => w.id === activeWorkspaceId)) {
      activeWorkspaceId = workspaces[0].id;
    }
  }

  async function insertWorkspace(w) {
    const user = Auth.currentUser();
    const { error } = await sb.from('workspaces').insert({ id: w.id, user_id: user.id, data: { name: w.name, color: w.color } });
    if (error) showToast('Не удалось сохранить проект', 'warn');
    else workspaceVideoCounts[w.id] = 0;
  }
  async function updateWorkspaceRow(w) {
    const { error } = await sb.from('workspaces').update({ data: { name: w.name, color: w.color } }).eq('id', w.id);
    if (error) showToast('Не удалось сохранить проект', 'warn');
  }
  async function deleteWorkspaceRow(id) {
    const { error } = await sb.from('workspaces').delete().eq('id', id);
    if (error) showToast('Не удалось удалить проект', 'warn');
    delete workspaceVideoCounts[id];
  }

  async function refreshWorkspaceVideoCounts() {
    const user = Auth.currentUser();
    const { data, error } = await sb.from('videos').select('workspace_id').eq('user_id', user.id);
    if (error) return;
    const counts = {};
    (data || []).forEach((row) => { counts[row.workspace_id] = (counts[row.workspace_id] || 0) + 1; });
    workspaceVideoCounts = counts;
  }

  function setActiveWorkspace(id) {
    activeWorkspaceId = id;
    try { localStorage.setItem(activeWorkspaceStorageKey(), id); } catch (e) {}
  }

  function workspaceById(id) { return workspaces.find((w) => w.id === id); }

  function switchWorkspace(id) {
    if (id === activeWorkspaceId) return; // уже открыт — панель специально не закрываем
    closeModal(); closePanel(); closeGroupsModal();

    // короткое затухание поля при смене проекта — иначе контент мгновенно
    // подменяется под курсором и ощущается как рывок, а не переключение
    const canvasInnerEl = document.getElementById('canvasInner');
    canvasInnerEl.classList.add('is-switching');

    setTimeout(async () => {
      setActiveWorkspace(id);
      currentGroupId = 'all';
      currentSearch = '';
      currentSort = 'new'; activeSort = 'new'; doneSort = 'new';
      searchInputEl.value = '';
      searchClearBtn.hidden = true;
      isFirstRender = true;
      isFirstNotesRender = true;
      await loadGroups();
      await loadVideos();
      await loadNotes();
      render();
      renderNotes();
      renderWorkspaceList();
      updateWorkspacePeekIndicator();
      requestAnimationFrame(() => canvasInnerEl.classList.remove('is-switching'));
    }, 160);

    // панель специально остаётся открытой после переключения — можно сразу
    // посмотреть, что лежит в выбранном проекте, закроется по уходу курсора.
    AudioFX.open();
  }

  // ---------------------------------------------------------------- storage

  function rowToVideo(row) {
    return Object.assign({ id: row.id, groupId: row.group_id, done: row.done, createdAt: new Date(row.created_at).getTime() }, row.data);
  }
  function videoDataPart(v) {
    return { titleDe: v.titleDe, titleRu: v.titleRu, summaryRu: v.summaryRu, thumbnailPrompt: v.thumbnailPrompt, tags: v.tags, description: v.description, script: v.script, inProcess: !!v.inProcess };
  }

  async function loadVideos() {
    const { data, error } = await sb.from('videos').select('*').eq('workspace_id', activeWorkspaceId).order('created_at', { ascending: false });
    if (error) { showToast('Не удалось загрузить ролики', 'warn'); videos = []; return; }
    videos = (data || []).map(rowToVideo);
  }

  async function insertVideoRow(v) {
    const user = Auth.currentUser();
    const { error } = await sb.from('videos').insert({
      id: v.id, workspace_id: activeWorkspaceId, user_id: user.id,
      group_id: v.groupId, done: !!v.done, data: videoDataPart(v),
    });
    if (error) showToast('Не удалось сохранить ролик', 'warn');
    else workspaceVideoCounts[activeWorkspaceId] = (workspaceVideoCounts[activeWorkspaceId] || 0) + 1;
  }
  async function updateVideoRow(v) {
    const { error } = await sb.from('videos').update({ group_id: v.groupId, done: !!v.done, data: videoDataPart(v) }).eq('id', v.id);
    if (error) showToast('Не удалось сохранить ролик', 'warn');
  }
  async function updateVideoDone(id, done) {
    const { error } = await sb.from('videos').update({ done }).eq('id', id);
    if (error) showToast('Не удалось сохранить статус ролика', 'warn');
  }
  async function deleteVideoRow(id) {
    const { error } = await sb.from('videos').delete().eq('id', id);
    if (error) showToast('Не удалось удалить ролик', 'warn');
    else if (workspaceVideoCounts[activeWorkspaceId]) workspaceVideoCounts[activeWorkspaceId] -= 1;
  }

  // ---------------------------------------------------------------- заметки

  let notes = [];
  function noteUid() {
    return 'note_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }
  function rowToNote(row) {
    return Object.assign({ id: row.id, createdAt: new Date(row.created_at).getTime() }, row.data);
  }

  async function loadNotes() {
    const { data, error } = await sb.from('notes').select('*').eq('workspace_id', activeWorkspaceId).order('created_at', { ascending: true });
    if (error) { showToast('Не удалось загрузить заметки', 'warn'); notes = []; return; }
    notes = (data || []).map(rowToNote);
  }
  function noteDataPart(n) {
    return { text: n.text, rich: !!n.rich, color: n.color, x: n.x, y: n.y, w: n.w, h: n.h, fontSize: n.fontSize };
  }
  async function insertNoteRow(n) {
    const user = Auth.currentUser();
    const { error } = await sb.from('notes').insert({ id: n.id, workspace_id: activeWorkspaceId, user_id: user.id, data: noteDataPart(n) });
    if (error) showToast('Не удалось сохранить заметку', 'warn');
  }
  async function updateNoteRow(n) {
    const { error } = await sb.from('notes').update({ data: noteDataPart(n) }).eq('id', n.id);
    if (error) showToast('Не удалось сохранить заметку', 'warn');
  }
  async function deleteNoteRow(id) {
    const { error } = await sb.from('notes').delete().eq('id', id);
    if (error) showToast('Не удалось удалить заметку', 'warn');
  }

  function debounce(fn, delay) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  function uid() {
    return 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  // ------------------------------------------------------------------ кастомное окно подтверждения
  // (вместо системного window.confirm, который нельзя стилизовать под тему)

  const confirmBackdrop = document.getElementById('confirmBackdrop');
  const confirmTitleEl = document.getElementById('confirmTitle');
  const confirmMessageEl = document.getElementById('confirmMessage');
  const confirmOkBtn = document.getElementById('confirmOkBtn');
  const confirmCancelBtn = document.getElementById('confirmCancelBtn');
  let confirmResolver = null;

  function showConfirm(opts) {
    confirmTitleEl.textContent = opts.title || 'Вы уверены?';
    confirmMessageEl.textContent = opts.message || '';
    confirmOkBtn.textContent = opts.confirmLabel || 'Удалить';
    confirmBackdrop.classList.add('is-open');
    AudioFX.open();
    return new Promise((resolve) => { confirmResolver = resolve; });
  }
  function closeConfirm(result) {
    confirmBackdrop.classList.remove('is-open');
    if (confirmResolver) { confirmResolver(result); confirmResolver = null; }
  }
  confirmOkBtn.addEventListener('click', () => { AudioFX.delete(); closeConfirm(true); });
  confirmCancelBtn.addEventListener('click', () => { AudioFX.close(); closeConfirm(false); });
  wireBackdropClose(confirmBackdrop, () => closeConfirm(false));

  // Закрытие модалки кликом по тёмному фону вокруг неё — но только если
  // клик реально НАЧАЛСЯ на фоне. Иначе выделение текста внутри модалки,
  // если палец/мышь уезжает за край плашки при отпускании, засчитывалось
  // как клик по фону и модалка неожиданно закрывалась.
  function wireBackdropClose(backdrop, closeFn) {
    let downOnBackdrop = false;
    backdrop.addEventListener('pointerdown', (e) => { downOnBackdrop = (e.target === backdrop); });
    backdrop.addEventListener('click', (e) => {
      if (downOnBackdrop && e.target === backdrop) closeFn();
      downOnBackdrop = false;
    });
  }

  // ------------------------------------------------------------------ утилиты

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function wordCount(text) {
    return (text || '').trim().split(/\s+/).filter(Boolean).length;
  }

  // ~300 слов/мин — под этот темп 40 минут выходит примерно на 11 500-12 000 слов
  function estimateMinutes(text) {
    return Math.max(1, Math.round(wordCount(text) / 300));
  }

  // промт для генерации текста ролика — название и суть подставляются, если
  // они уже заполнены, иначе на их месте остаются сами метки как есть
  function thumbnailPromptTemplateFor(titleDe) {
    const title = (titleDe || '').trim() || '[название]';
    return `по теме ${title} сделай превью отражающее суть, но при этом без текста, и используй одну жёлтую стрелку и один красный круг в разных местах, чтобы людям хотелось нажать`;
  }

  // делит текст на две примерно равные половины строго по границе абзаца
  // (никогда не разрывая слово/предложение) — чтобы озвучка не ломалась
  // на середине фразы. Абзац = блок текста между пустыми строками.
  function splitScriptByParagraph(text) {
    const paragraphs = (text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (paragraphs.length < 2) return null;
    const counts = paragraphs.map((p) => wordCount(p));
    const total = counts.reduce((a, b) => a + b, 0);
    let bestIdx = 1;
    let bestDiff = Infinity;
    let running = 0;
    for (let i = 0; i < paragraphs.length - 1; i++) {
      running += counts[i];
      const diff = Math.abs(running - (total - running));
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i + 1; }
    }
    return [
      paragraphs.slice(0, bestIdx).join('\n\n'),
      paragraphs.slice(bestIdx).join('\n\n'),
    ];
  }

  function copyScriptPart(partIndex, btn) {
    const v = videos.find((x) => x.id === openVideoId);
    if (!v) return;
    const parts = splitScriptByParagraph(v.script);
    if (!parts) { showToast('Нужно минимум 2 абзаца (пустая строка между ними), чтобы поделить текст', 'warn'); return; }
    const part = parts[partIndex];
    copyText(part, btn, `${partIndex + 1} часть скопирована — ${wordCount(part)} слов`);
  }
  document.getElementById('copyScriptPart1Btn').addEventListener('click', (e) => copyScriptPart(0, e.currentTarget));
  document.getElementById('copyScriptPart2Btn').addEventListener('click', (e) => copyScriptPart(1, e.currentTarget));

  function scriptPromptFor(titleDe, summaryRu) {
    const title = (titleDe || '').trim() || '[название]';
    const summary = (summaryRu || '').trim() || '[суть]';
    return `напиши на эту тему\n${title}\n${summary}\n\nтекст, на +- 10.000 слов, важно сделать этот текст без воды, интересным и с сюжетными поворотами, чтобы зрителю хотелось дослушать. текст должен быть на том же языке, что и название`;
  }

  async function pasteIntoScript(setter) {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      showToast('Браузер не даёт читать буфер обмена — вставь вручную (Ctrl+V)', 'warn');
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text) { showToast('В буфере обмена пусто', 'warn'); return; }
      setter(text);
      AudioFX.click();
      showToast('Текст вставлен');
    } catch (e) {
      showToast('Не удалось прочитать буфер обмена — вставь вручную (Ctrl+V)', 'warn');
    }
  }

  function formatDate(ts) {
    try {
      return new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch (e) { return ''; }
  }

  function pluralRu(n, one, few, many) {
    const mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
  }

  function formatRelativeDate(ts) {
    if (!ts) return '';
    const diffSec = Math.floor((Date.now() - ts) / 1000);
    if (diffSec < 45) return 'только что';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} ${pluralRu(diffMin, 'минуту', 'минуты', 'минут')} назад`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour} ${pluralRu(diffHour, 'час', 'часа', 'часов')} назад`;
    const diffDay = Math.floor(diffHour / 24);
    if (diffDay === 1) return 'вчера';
    if (diffDay === 2) return 'позавчера';
    if (diffDay < 7) return `${diffDay} ${pluralRu(diffDay, 'день', 'дня', 'дней')} назад`;
    const diffWeek = Math.floor(diffDay / 7);
    if (diffDay < 30) return diffWeek === 1 ? 'неделю назад' : `${diffWeek} ${pluralRu(diffWeek, 'неделю', 'недели', 'недель')} назад`;
    const diffMonth = Math.floor(diffDay / 30);
    if (diffDay < 365) return diffMonth === 1 ? 'месяц назад' : `${diffMonth} ${pluralRu(diffMonth, 'месяц', 'месяца', 'месяцев')} назад`;
    const diffYear = Math.floor(diffDay / 365);
    return diffYear === 1 ? 'год назад' : `${diffYear} ${pluralRu(diffYear, 'год', 'года', 'лет')} назад`;
  }

  // ------------------------------------------------------------------ фильтр + сортировка

  function matchesFilter(v) {
    if (currentGroupId !== 'all' && v.groupId !== currentGroupId) return false;
    if (currentSearch) {
      const hay = (v.titleDe + ' ' + v.titleRu + ' ' + (v.summaryRu || '')).toLowerCase();
      if (!hay.includes(currentSearch)) return false;
    }
    return true;
  }

  function sortVideos(list, sortId) {
    const arr = list.slice();
    if (sortId === 'new') arr.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    else if (sortId === 'old') arr.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    else if (sortId === 'az') arr.sort((a, b) => (a.titleDe || '').localeCompare(b.titleDe || '', 'de'));
    else if (sortId === 'group') {
      arr.sort((a, b) => {
        const ga = groups.findIndex((g) => g.id === a.groupId);
        const gb = groups.findIndex((g) => g.id === b.groupId);
        if (ga !== gb) return ga - gb;
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
    }
    return arr;
  }

  // ------------------------------------------------------------------ рендер сегмент-фильтра

  const segmentFilterWrap = document.getElementById('segmentFilterWrap');
  const segmentFilterTrigger = document.getElementById('segmentFilterTrigger');
  const segmentFilterList = document.getElementById('segmentFilterList');
  const segmentFilterLabel = document.getElementById('segmentFilterLabel');
  const segmentFilterCount = document.getElementById('segmentFilterCount');
  const segmentFilterDot = document.getElementById('segmentFilterDot');

  function renderSegmentFilter() {
    const allCount = videos.length;

    if (currentGroupId === 'all') {
      segmentFilterLabel.textContent = 'Все';
      segmentFilterCount.textContent = allCount;
      segmentFilterDot.hidden = true;
    } else {
      const active = groupById(currentGroupId);
      if (active) {
        segmentFilterLabel.textContent = active.name;
        segmentFilterCount.textContent = videos.filter((v) => v.groupId === active.id).length;
        segmentFilterDot.hidden = false;
        segmentFilterDot.style.background = `var(--${active.color})`;
      }
    }

    let html = `<div class="custom-select-option${currentGroupId === 'all' ? ' is-active' : ''}" data-group="all">Все <span class="seg-count">${allCount}</span></div>`;
    groups.forEach((g) => {
      const count = videos.filter((v) => v.groupId === g.id).length;
      html += `<div class="custom-select-option${currentGroupId === g.id ? ' is-active' : ''}" data-group="${g.id}">
        <span class="grp-dot" style="background:var(--${g.color})"></span>${escapeHtml(g.name)} <span class="seg-count">${count}</span>
      </div>`;
    });
    segmentFilterList.innerHTML = html;
  }

  segmentFilterTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !segmentFilterWrap.classList.contains('is-open');
    closeAllCustomSelects();
    if (willOpen) { AudioFX.click(); segmentFilterWrap.classList.add('is-open'); }
  });
  segmentFilterList.addEventListener('click', (e) => {
    const opt = e.target.closest('.custom-select-option');
    if (!opt) return;
    currentGroupId = opt.dataset.group;
    AudioFX.click();
    closeCustomSelect(segmentFilterWrap);
    renderSegmentFilter();
    render();
  });

  // ------------------------------------------------------------------ рендер карточек

  const currentGrid = document.getElementById('currentGrid');
  const activeGrid = document.getElementById('activeGrid');
  const doneGrid = document.getElementById('doneGrid');
  const currentEmpty = document.getElementById('currentEmpty');
  const activeEmpty = document.getElementById('activeEmpty');
  const doneEmpty = document.getElementById('doneEmpty');
  const currentCountEl = document.getElementById('currentCount');
  const activeCountEl = document.getElementById('activeCount');
  const doneCountEl = document.getElementById('doneCount');
  const statsBar = document.getElementById('statsBar');

  const MIN_SCRIPT_WORDS = 100;

  function cardHtml(v, enterDelay) {
    const g = groupById(v.groupId) || groups[0] || { name: '—', color: 'blue' };
    const styleAttr = enterDelay != null ? `${grpStyle(g)};animation-delay:${enterDelay}ms` : grpStyle(g);
    // заголовок на карточке — русский перевод крупным текстом, оригинал — мелкой подписью
    const words = wordCount(v.script);
    const hasScript = words >= MIN_SCRIPT_WORDS;
    const metaHtml = hasScript
      ? `~${estimateMinutes(v.script)} мин · ${words.toLocaleString('ru-RU')} ${pluralRu(words, 'слово', 'слова', 'слов')}`
      : 'текст ещё не написан';
    const processBtn = v.done ? '' : `
            <button class="card-process${v.inProcess ? ' is-active' : ''}" data-action="toggle-process" title="${v.inProcess ? 'Убрать из «В процессе»' : 'Сейчас работаю над этим'}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M13 3L4 14H11L10 21L20 9H13L13 3Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" fill="${v.inProcess ? 'currentColor' : 'none'}"/></svg>
            </button>`;
    return `
      <article class="card${isFirstRender ? ' card-enter' : ''}${v.done ? ' is-done' : ''}${v.inProcess && !v.done ? ' is-current' : ''}" data-id="${v.id}" style="${styleAttr}">
        <div class="card-top">
          <div class="card-top-left">
            <span class="badge"><span class="grp-dot"></span>${escapeHtml(g.name)}</span>
            <span class="card-date" title="${formatDate(v.createdAt)}">${formatRelativeDate(v.createdAt)}</span>
          </div>
          <div class="card-actions">
            <button class="card-delete" data-action="delete-card" title="Удалить ролик">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 7H19M9 7V5C9 4.4 9.4 4 10 4H14C14.6 4 15 4.4 15 5V7M7 7L8 20C8 20.6 8.4 21 9 21H15C15.6 21 16 20.6 16 20L17 7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            ${processBtn}
            <span class="check" data-action="toggle-done" title="Отметить выполненным">
              <svg viewBox="0 0 24 24" width="13" height="13"><path d="M4 12.5L9.5 18L20 6" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" pathLength="1"/></svg>
            </span>
          </div>
        </div>
        <h3 class="card-title-de">${escapeHtml(v.titleRu)}</h3>
        <p class="card-title-ru">${escapeHtml(v.summaryRu || v.titleDe)}</p>
        <div class="card-bottom">
          <span class="card-meta${hasScript ? '' : ' is-todo'}"><span class="text-status-dot ${hasScript ? 'is-ready' : 'is-empty'}" title="${hasScript ? 'Текст сценария готов' : 'Текст сценария ещё не написан (меньше 100 слов)'}"></span>${metaHtml}</span>
        </div>
      </article>`;
  }

  function render() {
    const current = sortVideos(videos.filter((v) => !v.done && v.inProcess && matchesFilter(v)), currentSort);
    const active = sortVideos(videos.filter((v) => !v.done && !v.inProcess && matchesFilter(v)), activeSort);
    const done = sortVideos(videos.filter((v) => v.done && matchesFilter(v)), doneSort);

    currentGrid.innerHTML = current.map((v, i) => cardHtml(v, isFirstRender ? i * 45 : null)).join('');
    activeGrid.innerHTML = active.map((v, i) => cardHtml(v, isFirstRender ? i * 45 : null)).join('');
    doneGrid.innerHTML = done.map((v, i) => cardHtml(v, isFirstRender ? i * 45 : null)).join('');

    currentEmpty.hidden = current.length !== 0;
    activeEmpty.hidden = active.length !== 0;
    doneEmpty.hidden = done.length !== 0;

    currentCountEl.textContent = current.length;
    activeCountEl.textContent = active.length;
    doneCountEl.textContent = done.length;

    renderStats();
    renderSegmentFilter();

    if (isFirstRender) {
      // класс входной анимации нужно снять после её окончания — иначе
      // animation-fill-mode:both держит transform "залипшим" навсегда,
      // и hover у этих карточек перестаёт визуально работать
      document.querySelectorAll('.card.card-enter').forEach((el) => {
        el.addEventListener('animationend', () => el.classList.remove('card-enter'), { once: true });
      });
    }
    isFirstRender = false;
  }

  function renderStats() {
    const total = videos.length;
    const done = videos.filter((v) => v.done).length;
    statsBar.innerHTML = `<b>${total}</b> роликов <span class="dot">·</span> <b>${done}</b> готово`;
  }

  // ------------------------------------------------------------------ заметки
  // На ПК заметки — свободно перетаскиваемые карточки прямо на холсте, тащить
  // можно взявшись за любое место карточки (кроме кнопок/ручек размера).
  // Сам текст на холсте — только превью (не редактируется напрямую, чтобы
  // клик всегда однозначно означал "тащить"); полноценное редактирование —
  // в отдельном большом окне (кнопка ⤢ или двойной клик по заметке).
  // Нельзя бросить заметку поверх карточки ролика — проверяем пересечение
  // и откатываем, если не влезло. На телефоне (без панорамирования) —
  // простым списком внизу, там текст всегда сразу редактируется на месте.

  const notesLayer = document.getElementById('notesLayer');
  const notesGrid = document.getElementById('notesGrid');
  const notesCountEl = document.getElementById('notesCount');
  let isFirstNotesRender = true;
  try { document.execCommand('defaultParagraphSeparator', false, 'div'); } catch (e) {}

  const RESIZE_CORNERS = ['nw', 'ne', 'sw', 'se'];

  function noteBodyHtml(n) {
    // rich === true — текст уже сохранён как готовый HTML (умная вставка
    // разложила его на заголовок+список или это просто набранный текст),
    // иначе (старые заметки) — сырой текст, просто переносим строки
    if (n.rich) return n.text || '';
    return escapeHtml(n.text || '').replace(/\n/g, '<br>');
  }

  function noteHtml(n, mobile, enterDelay) {
    const styleParts = [`--note-c:var(--${n.color || 'blue'})`];
    if (!mobile) {
      styleParts.push(`left:${Math.round(n.x || 0)}px`, `top:${Math.round(n.y || 0)}px`);
      if (n.w) styleParts.push(`width:${Math.round(n.w)}px`);
    }
    if (enterDelay != null) styleParts.push(`animation-delay:${enterDelay}ms`);
    const textStyleParts = [];
    if (!mobile && n.h) textStyleParts.push(`min-height:${Math.round(n.h)}px`);
    if (n.fontSize) textStyleParts.push(`font-size:${n.fontSize}px`);
    const textStyle = textStyleParts.length ? ` style="${textStyleParts.join(';')}"` : '';
    const resizeHtml = mobile ? '' : RESIZE_CORNERS.map((c) => `<span class="note-resize-handle ${c}" data-resize="${c}"></span>`).join('');
    const fitBtn = (!mobile && n.h) ? `
          <button class="note-fit" data-action="fit-note" title="Подогнать высоту под текст">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M7 10L4 7L4 10M4 7H7M17 10L20 7L20 10M20 7H17M7 14L4 17L4 14M4 17H7M17 14L20 17L20 14M20 17H17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>` : '';
    return `
      <article class="note-card${isFirstNotesRender ? ' note-enter' : ''}" data-id="${n.id}" style="${styleParts.join(';')}">
        <div class="note-top-actions">
          ${fitBtn}
          <button class="note-expand" data-action="expand-note" title="Открыть на весь экран">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M9 4H4V9M15 4H20V9M9 20H4V15M15 20H20V15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button class="note-delete" data-action="delete-note" title="Удалить заметку">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 5L19 19M19 5L5 19" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="note-font-controls">
          <button class="note-font-btn" data-action="font-dec" title="Мельче текст">A−</button>
          <button class="note-font-btn" data-action="font-inc" title="Крупнее текст">A+</button>
        </div>
        <span class="note-saved" data-role="saved">✓ сохранено</span>
        <div class="note-text" data-role="text" contenteditable="${mobile ? 'true' : 'false'}" data-placeholder="Заметка — двойной клик или ⤢, чтобы писать"${textStyle}>${noteBodyHtml(n)}</div>
        ${resizeHtml}
      </article>`;
  }

  function renderNotes() {
    const mobile = isMobileLayout();
    const html = notes.map((n, i) => noteHtml(n, mobile, isFirstNotesRender ? i * 45 : null)).join('');
    if (mobile) {
      const addTileHtml = `
        <button type="button" class="note-card note-card--add" data-action="add-note-tile" title="Добавить заметку">
          <span class="plus-icon">+</span>
          <span>Новая заметка</span>
        </button>`;
      notesGrid.innerHTML = html + addTileHtml;
      notesLayer.innerHTML = '';
    } else {
      notesLayer.innerHTML = html;
      notesGrid.innerHTML = '';
    }
    notesCountEl.textContent = notes.length;

    const container = mobile ? notesGrid : notesLayer;
    if (isFirstNotesRender) {
      container.querySelectorAll('.note-card.note-enter').forEach((el) => {
        el.addEventListener('animationend', () => el.classList.remove('note-enter'), { once: true });
      });
    }
    isFirstNotesRender = false;
  }

  // ---- координаты: экран ↔ локальные координаты холста (та же математика,
  // что и в setZoomAt — panX/panY/scale уже объявлены ниже, но замыкание
  // видит их актуальное значение на момент вызова, а не объявления) ----

  function viewportToLocal(clientX, clientY) {
    const rect = viewport.getBoundingClientRect();
    return { x: (clientX - rect.left - panX) / scale, y: (clientY - rect.top - panY) / scale };
  }
  function localRectFromEl(el) {
    const rect = el.getBoundingClientRect();
    const vrect = viewport.getBoundingClientRect();
    return {
      x: (rect.left - vrect.left - panX) / scale, y: (rect.top - vrect.top - panY) / scale,
      w: rect.width / scale, h: rect.height / scale,
    };
  }
  function rectsOverlapLocal(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }
  function rectsOverlapScreen(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }
  function findFreeSpot(x, y, w, h) {
    const cardRects = Array.from(document.querySelectorAll('.card')).map(localRectFromEl);
    let candidate = { x, y, w, h };
    let attempts = 0;
    while (cardRects.some((r) => rectsOverlapLocal(candidate, r)) && attempts < 24) {
      attempts += 1;
      candidate = { x: x + attempts * 34, y: y + attempts * 24, w, h };
    }
    return candidate;
  }

  function createNewNote(atX, atY) {
    const mobile = isMobileLayout();
    let x = 0, y = 0;
    if (!mobile) {
      let cx, cy;
      if (atX != null) { cx = atX - 130; cy = atY - 75; }
      else {
        const rect = viewport.getBoundingClientRect();
        const center = viewportToLocal(rect.left + rect.width / 2, rect.top + rect.height / 2);
        cx = center.x - 130; cy = center.y - 75;
      }
      const spot = findFreeSpot(cx, cy, 260, 150);
      x = spot.x; y = spot.y;
    }
    const n = { id: noteUid(), text: '', rich: false, color: GROUP_COLORS[notes.length % GROUP_COLORS.length], x, y, createdAt: Date.now() };
    notes.push(n);
    insertNoteRow(n);
    AudioFX.add();
    renderNotes();
    if (mobile) {
      const card = notesGrid.querySelector(`.note-card[data-id="${n.id}"]`);
      const el = card && card.querySelector('.note-text');
      if (el) el.focus();
    } else {
      openNoteEditor(n.id);
    }
  }
  document.getElementById('addNoteBtn').addEventListener('click', () => createNewNote());

  // ---- полноценный редактор заметки (модалка) — открывается по кнопке
  // расширения или двойному клику на заметке на холсте; на телефоне текст
  // и так сразу редактируется прямо в карточке, но модалка тоже доступна,
  // если хочется больше места ----

  const noteModalBackdrop = document.getElementById('noteModalBackdrop');
  const noteModalText = document.getElementById('noteModalText');
  let openNoteId = null;

  function openNoteEditor(id) {
    const n = notes.find((x) => x.id === id);
    if (!n) return;
    openNoteId = id;
    noteModalText.innerHTML = noteBodyHtml(n);
    noteModalText.style.fontSize = (n.fontSize || 17) + 'px';
    noteModalBackdrop.classList.add('is-open');
    AudioFX.open();
    setTimeout(() => {
      noteModalText.focus();
      const range = document.createRange();
      range.selectNodeContents(noteModalText);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }, 50);
  }
  function saveNoteEditorContent() {
    if (!openNoteId) return;
    const n = notes.find((x) => x.id === openNoteId);
    if (!n) return;
    n.text = noteModalText.innerHTML;
    n.rich = true;
    updateNoteRow(n);
    renderNotes();
  }
  function closeNoteEditor() {
    if (!openNoteId) return;
    saveNoteEditorContent();
    noteModalBackdrop.classList.remove('is-open');
    AudioFX.close();
    openNoteId = null;
  }
  document.getElementById('noteModalClose').addEventListener('click', closeNoteEditor);
  wireBackdropClose(noteModalBackdrop, closeNoteEditor);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && noteModalBackdrop.classList.contains('is-open')) closeNoteEditor();
  });

  const saveNoteEditorDebounced = debounce(saveNoteEditorContent, 500);
  noteModalText.addEventListener('input', saveNoteEditorDebounced);
  noteModalText.addEventListener('paste', (e) => {
    e.preventDefault();
    const raw = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertHTML', false, formatPastedNoteText(raw));
  });

  document.getElementById('noteModalFontInc').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!openNoteId) return;
    const n = notes.find((x) => x.id === openNoteId);
    if (n) startFontRepeat(n, noteModalText, 1);
  });
  document.getElementById('noteModalFontDec').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!openNoteId) return;
    const n = notes.find((x) => x.id === openNoteId);
    if (n) startFontRepeat(n, noteModalText, -1);
  });

  // двойной клик по пустому месту холста — заметка появляется прямо там,
  // без лишнего шага "создать и потом тащить куда нужно"
  document.getElementById('viewport').addEventListener('dblclick', (e) => {
    if (isMobileLayout()) return;
    const onRealControl = e.target.closest('button') || e.target.closest('a') || e.target.closest('input')
      || e.target.closest('textarea') || e.target.closest('.custom-select') || e.target.closest('.card') || e.target.closest('.note-card');
    if (onRealControl) return;
    const local = viewportToLocal(e.clientX, e.clientY);
    createNewNote(local.x, local.y);
  });

  function formatPastedNoteText(raw) {
    const lines = raw.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) return '';
    if (lines.length === 1) return escapeHtml(lines[0]);
    const [heading, ...rest] = lines;
    const headingHtml = `<div class="note-heading">${escapeHtml(heading)}</div>`;
    const listHtml = rest.map((l) => `<div class="note-list-item">${escapeHtml(l)}</div>`).join('');
    return headingHtml + listHtml;
  }

  // ---- размер шрифта — удержанием кнопки, а не кликом по тысяче раз:
  // короткое нажатие — один шаг, задержка и дальше саморазгоняющийся повтор ----

  const saveNoteRowDebounced = debounce((n) => updateNoteRow(n), 400);
  let fontRepeat = null;

  function applyFontStep(n, textEl, dir) {
    n.fontSize = Math.max(9, (n.fontSize || 14.5) + dir * 2);
    textEl.style.fontSize = n.fontSize + 'px';
    saveNoteRowDebounced(n);
  }
  function startFontRepeat(n, textEl, dir) {
    stopFontRepeat();
    applyFontStep(n, textEl, dir);
    AudioFX.click();
    let ticks = 0;
    fontRepeat = { timeout: setTimeout(function tick() {
      applyFontStep(n, textEl, dir);
      ticks += 1;
      // чем дольше держишь — тем быстрее растёт: приятно долистать до
      // большого размера, не отпуская кнопку
      fontRepeat.timeout = setTimeout(tick, Math.max(30, 90 - ticks * 4));
    }, 380) };
  }
  function stopFontRepeat() {
    if (!fontRepeat) return;
    clearTimeout(fontRepeat.timeout);
    fontRepeat = null;
  }
  document.addEventListener('pointerup', stopFontRepeat);
  document.addEventListener('pointercancel', stopFontRepeat);

  const saveNoteText = debounce((id, html) => {
    const n = notes.find((x) => x.id === id);
    if (!n) return;
    n.text = html;
    n.rich = true;
    updateNoteRow(n);
    const card = (isMobileLayout() ? notesGrid : notesLayer).querySelector(`.note-card[data-id="${id}"]`);
    const savedDot = card && card.querySelector('[data-role="saved"]');
    if (savedDot) {
      savedDot.classList.add('is-flash');
      setTimeout(() => savedDot.classList.remove('is-flash'), 900);
    }
  }, 500);

  function wireNotesDelegation(container) {
    container.addEventListener('input', (e) => {
      const el = e.target.closest('.note-text');
      if (!el) return;
      const card = el.closest('.note-card');
      saveNoteText(card.dataset.id, el.innerHTML);
    });

    container.addEventListener('pointerdown', (e) => {
      const fontBtn = e.target.closest('[data-action="font-inc"], [data-action="font-dec"]');
      if (!fontBtn) return;
      e.preventDefault();
      const card = fontBtn.closest('.note-card');
      const textEl = card.querySelector('.note-text');
      const n = notes.find((x) => x.id === card.dataset.id);
      if (!n) return;
      startFontRepeat(n, textEl, fontBtn.dataset.action === 'font-inc' ? 1 : -1);
    });

    container.addEventListener('paste', (e) => {
      const el = e.target.closest('.note-text');
      if (!el) return;
      e.preventDefault();
      const raw = (e.clipboardData || window.clipboardData).getData('text/plain');
      const html = formatPastedNoteText(raw);
      document.execCommand('insertHTML', false, html);
    });

    // двойной клик по заметке на холсте сразу открывает полноценный редактор
    // (на телефоне текст и так редактируется прямо в карточке)
    container.addEventListener('dblclick', (e) => {
      if (isMobileLayout()) return;
      if (e.target.closest('.note-top-actions') || e.target.closest('.note-font-controls') || e.target.closest('.note-resize-handle')) return;
      const card = e.target.closest('.note-card');
      if (card) openNoteEditor(card.dataset.id);
    });

    container.addEventListener('click', async (e) => {
      if (e.target.closest('[data-action="add-note-tile"]')) { createNewNote(); return; }

      if (e.target.closest('[data-action="expand-note"]')) {
        const card = e.target.closest('.note-card');
        if (card) openNoteEditor(card.dataset.id);
        return;
      }

      if (e.target.closest('[data-action="fit-note"]')) {
        const card = e.target.closest('.note-card');
        const textEl = card.querySelector('.note-text');
        const n = notes.find((x) => x.id === card.dataset.id);
        if (n) { n.h = undefined; updateNoteRow(n); }
        textEl.style.minHeight = '';
        card.classList.add('note-fit-pulse');
        setTimeout(() => card.classList.remove('note-fit-pulse'), 350);
        renderNotes();
        AudioFX.click();
        return;
      }

      const delBtn = e.target.closest('[data-action="delete-note"]');
      if (!delBtn) return;
      const card = delBtn.closest('.note-card');
      const id = card.dataset.id;
      const n = notes.find((x) => x.id === id);
      if (n && n.text && n.text.trim()) {
        const ok = await showConfirm({ title: 'Удалить заметку?', message: 'Текст заметки будет удалён без возможности восстановления.' });
        if (!ok) return;
      }
      card.classList.add('note-leaving');
      AudioFX.delete();
      setTimeout(() => {
        notes = notes.filter((x) => x.id !== id);
        deleteNoteRow(id);
        renderNotes();
      }, 220);
    });
  }
  wireNotesDelegation(notesGrid);
  wireNotesDelegation(notesLayer);

  // ---- перетаскивание и изменение размера заметок на холсте (только ПК) ----

  let noteDrag = null;
  let noteResize = null;

  notesLayer.addEventListener('pointerdown', (e) => {
    if (isMobileLayout()) return;
    if (e.target.closest('.note-top-actions') || e.target.closest('.note-font-btn')) return;

    const rHandle = e.target.closest('.note-resize-handle');
    if (rHandle) {
      const card = rHandle.closest('.note-card');
      if (!card) return;
      e.preventDefault(); e.stopPropagation();
      const textEl = card.querySelector('.note-text');
      noteResize = {
        id: card.dataset.id, el: card, textEl, corner: rHandle.dataset.resize,
        startClientX: e.clientX, startClientY: e.clientY,
        startW: card.getBoundingClientRect().width / scale,
        startH: textEl.getBoundingClientRect().height / scale,
        startLeft: parseFloat(card.style.left) || 0,
        startTop: parseFloat(card.style.top) || 0,
      };
      card.classList.add('is-resizing');
      try { card.setPointerCapture(e.pointerId); } catch (err) {}
      return;
    }

    const card = e.target.closest('.note-card');
    if (!card) return;
    const textEl = card.querySelector('.note-text');
    if (textEl && textEl.isContentEditable) return; // сейчас пишем текст — не тащим карточку
    // клик (без протаскивания) по строке заголовка/списка — копирует именно
    // эту строку, а не всю заметку целиком
    const copyLineEl = e.target.closest('.note-heading, .note-list-item');
    e.preventDefault();
    e.stopPropagation();
    noteDrag = {
      id: card.dataset.id,
      el: card,
      copyLineEl,
      offsetX: e.clientX - card.getBoundingClientRect().left,
      offsetY: e.clientY - card.getBoundingClientRect().top,
      startLeft: parseFloat(card.style.left) || 0,
      startTop: parseFloat(card.style.top) || 0,
      moved: false,
      invalid: false,
    };
    card.classList.add('is-dragging');
    try { card.setPointerCapture(e.pointerId); } catch (err) {}
  });

  document.addEventListener('pointermove', (e) => {
    if (noteResize) {
      const dx = (e.clientX - noteResize.startClientX) / scale;
      const dy = (e.clientY - noteResize.startClientY) / scale;
      const { startW, startH, startLeft, startTop, corner } = noteResize;
      let w = startW, h = startH, left = startLeft, top = startTop;
      if (corner.includes('e')) w = Math.max(190, startW + dx);
      if (corner.includes('w')) { w = Math.max(190, startW - dx); left = startLeft + (startW - w); }
      if (corner.includes('s')) h = Math.max(60, startH + dy);
      if (corner.includes('n')) { h = Math.max(60, startH - dy); top = startTop + (startH - h); }
      noteResize.el.style.width = w + 'px';
      noteResize.el.style.left = left + 'px';
      noteResize.el.style.top = top + 'px';
      noteResize.textEl.style.minHeight = h + 'px';
      return;
    }

    if (!noteDrag) return;
    noteDrag.moved = true;
    const local = viewportToLocal(e.clientX - noteDrag.offsetX, e.clientY - noteDrag.offsetY);
    noteDrag.el.style.left = local.x + 'px';
    noteDrag.el.style.top = local.y + 'px';

    const dragRect = noteDrag.el.getBoundingClientRect();
    const overlapping = Array.from(document.querySelectorAll('.card')).some((c) => rectsOverlapScreen(dragRect, c.getBoundingClientRect()));
    noteDrag.invalid = overlapping;
    noteDrag.el.classList.toggle('is-invalid-drop', overlapping);
  });

  function endNoteResize(e) {
    const { el, textEl, id } = noteResize;
    el.classList.remove('is-resizing');
    try { el.releasePointerCapture(e.pointerId); } catch (err) {}
    const n = notes.find((x) => x.id === id);
    if (n) {
      n.w = parseFloat(el.style.width) || undefined;
      n.h = parseFloat(textEl.style.minHeight) || undefined;
      n.x = parseFloat(el.style.left) || 0;
      n.y = parseFloat(el.style.top) || 0;
      updateNoteRow(n);
    }
    noteResize = null;
  }

  function copyNoteLine(el) {
    const text = el.textContent.trim();
    if (!text) return;
    copyText(text, null, 'Строка скопирована');
    el.classList.add('is-copy-flash');
    setTimeout(() => el.classList.remove('is-copy-flash'), 700);
  }

  function endNoteDrag(e) {
    const { el, id, invalid, moved, startLeft, startTop, copyLineEl } = noteDrag;
    el.classList.remove('is-dragging');
    try { el.releasePointerCapture(e.pointerId); } catch (err) {}
    noteDrag = null;
    if (!moved) {
      if (copyLineEl) copyNoteLine(copyLineEl);
      return;
    }

    if (invalid) {
      el.classList.add('is-reverting');
      el.classList.remove('is-invalid-drop');
      el.style.left = startLeft + 'px';
      el.style.top = startTop + 'px';
      setTimeout(() => el.classList.remove('is-reverting'), 320);
      showToast('Нельзя разместить заметку поверх ролика', 'warn');
    } else {
      const n = notes.find((x) => x.id === id);
      if (n) {
        n.x = parseFloat(el.style.left) || 0;
        n.y = parseFloat(el.style.top) || 0;
        updateNoteRow(n);
      }
    }
  }

  document.addEventListener('pointerup', (e) => {
    if (noteResize) endNoteResize(e);
    else if (noteDrag) endNoteDrag(e);
  });
  document.addEventListener('pointercancel', (e) => {
    if (noteResize) endNoteResize(e);
    else if (noteDrag) endNoteDrag(e);
  });

  // ------------------------------------------------------------------ клики по карточкам (делегирование)

  // непринуждённый звук при наведении на карточку ролика (срабатывает
  // один раз на карточку, а не на каждый пиксель движения мыши внутри)
  let lastHoveredCardId = null;
  document.getElementById('viewport').addEventListener('pointerover', (e) => {
    const card = e.target.closest('.card');
    const cardId = card ? card.dataset.id : null;
    if (cardId && cardId !== lastHoveredCardId) AudioFX.hover();
    lastHoveredCardId = cardId;
  });

  document.getElementById('viewport').addEventListener('click', (e) => {
    if (dragThresholdExceeded) return; // клик после реального перетаскивания поля игнорируем
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;

    if (e.target.closest('.check')) { e.stopPropagation(); toggleDone(id, card); return; }
    if (e.target.closest('.card-process')) { e.stopPropagation(); toggleInProcess(id, card); return; }
    if (e.target.closest('.card-delete')) { e.stopPropagation(); quickDelete(id); return; }
    openModal(id);
  });

  async function quickDelete(id) {
    const v = videos.find((x) => x.id === id);
    if (!v) return;
    const ok = await showConfirm({ title: 'Удалить ролик?', message: `«${v.titleRu || v.titleDe}» будет удалён без возможности восстановления.` });
    if (!ok) return;
    videos = videos.filter((x) => x.id !== id);
    deleteVideoRow(id);
    AudioFX.delete();
    showToast('Ролик удалён');
    render();
  }

  // ------------------------------------------------------------------ toggle done/process + FLIP-анимация + confetti

  function flipCardTo(id, oldRect) {
    const newCardEl = document.querySelector(`.card[data-id="${id}"]`);
    if (!newCardEl) return;
    const newRect = newCardEl.getBoundingClientRect();
    const dx = oldRect.left - newRect.left;
    const dy = oldRect.top - newRect.top;
    newCardEl.style.animation = 'none';
    newCardEl.style.transition = 'none';
    newCardEl.style.transform = `translate(${dx}px, ${dy}px) scale(1.04)`;
    newCardEl.style.opacity = '0.55';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        newCardEl.style.transition = 'transform .55s var(--ease-bounce), opacity .4s ease';
        newCardEl.style.transform = 'translate(0,0) scale(1)';
        newCardEl.style.opacity = '1';
        newCardEl.classList.add('card--completing');
        setTimeout(() => {
          newCardEl.style.transition = '';
          newCardEl.style.transform = '';
          newCardEl.style.animation = '';
          newCardEl.classList.remove('card--completing');
        }, 620);
      });
    });
  }

  function toggleDone(id, cardEl) {
    const video = videos.find((v) => v.id === id);
    if (!video) return;

    const oldRect = cardEl.getBoundingClientRect();
    const centerX = oldRect.left + oldRect.width / 2;
    const centerY = oldRect.top + oldRect.height / 2;

    video.done = !video.done;
    updateVideoDone(id, video.done);

    if (video.done) { spawnConfetti(centerX, centerY); AudioFX.success(); }
    else { AudioFX.undo(); }

    render();
    flipCardTo(id, oldRect);

    if (video.done) showToast('Готово! 🎉 Ролик уехал вниз');
  }

  function toggleInProcess(id, cardEl) {
    const video = videos.find((v) => v.id === id);
    if (!video || video.done) return;

    const oldRect = cardEl.getBoundingClientRect();
    video.inProcess = !video.inProcess;
    updateVideoRow(video);
    AudioFX.click();

    render();
    flipCardTo(id, oldRect);

    if (video.inProcess) showToast('Отправлено в «В процессе»');
  }

  function spawnConfetti(x, y) {
    const layer = document.getElementById('confettiLayer');
    const colors = ['#46c8ff', '#a875ff', '#4f7fff', '#ffffff'];
    for (let i = 0; i < 18; i++) {
      const piece = document.createElement('span');
      const angle = Math.random() * Math.PI * 2;
      const dist = 60 + Math.random() * 110;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist - 40;
      piece.className = 'confetti-piece';
      piece.style.left = x + 'px';
      piece.style.top = y + 'px';
      piece.style.width = (4 + Math.random() * 5) + 'px';
      piece.style.height = (4 + Math.random() * 5) + 'px';
      piece.style.background = colors[i % colors.length];
      piece.style.setProperty('--dx', dx + 'px');
      piece.style.setProperty('--dy', (dy + 160) + 'px');
      piece.style.setProperty('--rot', (Math.random() * 480 - 240) + 'deg');
      layer.appendChild(piece);
      piece.addEventListener('animationend', () => piece.remove());
    }
  }

  // ------------------------------------------------------------------ модалка

  const modalBackdrop = document.getElementById('modalBackdrop');
  const modalTitleDe = document.getElementById('modalTitleDe');
  const modalTitleRu = document.getElementById('modalTitleRu');
  const modalSegmentBadge = document.getElementById('modalSegmentBadge');
  const modalDate = document.getElementById('modalDate');
  const modalSummary = document.getElementById('modalSummary');
  const modalThumbPrompt = document.getElementById('modalThumbPrompt');
  const modalTags = document.getElementById('modalTags');
  const modalDescription = document.getElementById('modalDescription');
  const modalScript = document.getElementById('modalScript');
  const scriptEstimate = document.getElementById('scriptEstimate');
  const modalDoneCheckbox = document.getElementById('modalDoneCheckbox');
  const ttsBtn = document.getElementById('ttsBtn');

  function openModal(id) {
    const v = videos.find((x) => x.id === id);
    if (!v) return;
    openVideoId = id;
    const g = groupById(v.groupId) || groups[0] || { name: '—', color: 'blue' };

    modalSegmentBadge.innerHTML = `<span class="grp-dot"></span>${escapeHtml(g.name)}`;
    modalSegmentBadge.className = 'badge';
    modalSegmentBadge.setAttribute('style', grpStyle(g));
    modalDate.textContent = formatRelativeDate(v.createdAt);
    modalDate.title = formatDate(v.createdAt);
    // в модалке — оба варианта заголовка, оригинал (рабочий) первым, ниже перевод
    modalTitleDe.textContent = v.titleDe;
    modalTitleRu.textContent = v.titleRu;
    modalSummary.textContent = v.summaryRu || '—';
    modalThumbPrompt.textContent = v.thumbnailPrompt || '—';
    modalDescription.textContent = v.description || '—';
    modalScript.textContent = v.script || '—';
    scriptEstimate.textContent = `~${wordCount(v.script).toLocaleString('ru-RU')} ${pluralRu(wordCount(v.script), 'слово', 'слова', 'слов')}`;
    modalDoneCheckbox.checked = !!v.done;

    modalTags.innerHTML = (v.tags || []).map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('');

    ttsBtn.dataset.script = v.script || '';

    modalBackdrop.classList.add('is-open');
    AudioFX.open();
  }

  function closeModal() {
    if (!modalBackdrop.classList.contains('is-open')) return;
    modalBackdrop.classList.remove('is-open');
    openVideoId = null;
    AudioFX.close();
  }

  // окно ролика закрывается только по явному нажатию крестика — раньше
  // случайный клик по тёмному фону или нажатие Escape (например, при выходе
  // из полноэкранного просмотра видео на обложке) закрывали его незаметно
  document.getElementById('modalClose').addEventListener('click', closeModal);
  // это окно — просто просмотр (не форма с текстовым вводом), поэтому клик
  // мимо плашки закрывает его безопасно, без риска случайно оборвать ввод
  wireBackdropClose(modalBackdrop, closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePanel(); closeGroupsModal(); toggleHelp(false);
      closeAllCustomSelects();
      workspacePinned = false;
      workspacePin.classList.remove('is-active');
      closeWorkspacePanel();
      return;
    }

    const typingInField = e.target.closest('input, textarea, [contenteditable="true"]');

    // "/" — быстро прыгнуть в поиск, если сейчас не печатаешь в другом поле
    if (e.key === '/' && !typingInField) {
      e.preventDefault();
      searchInputEl.focus();
      return;
    }

    // Ctrl/Cmd+N — новый ролик, откуда угодно
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n' && !typingInField) {
      e.preventDefault();
      openPanel(null);
    }
  });

  modalDoneCheckbox.addEventListener('change', () => {
    if (!openVideoId) return;
    const cardEl = document.querySelector(`.card[data-id="${openVideoId}"]`);
    if (cardEl) toggleDone(openVideoId, cardEl);
    else {
      const v = videos.find((x) => x.id === openVideoId);
      if (v) { v.done = modalDoneCheckbox.checked; updateVideoDone(v.id, v.done); render(); }
    }
  });

  document.querySelectorAll('.copy-btn[data-copy-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.copyTarget;
      const el = document.getElementById(targetId);
      const text = targetId === 'modalTags'
        ? Array.from(el.querySelectorAll('.tag-chip')).map((c) => c.textContent).join(', ')
        : el.textContent;
      copyText(text, btn);
    });
  });

  document.getElementById('copyScriptBtn').addEventListener('click', (e) => {
    copyText(modalScript.textContent, e.currentTarget);
  });

  document.getElementById('copyScriptPromptBtn').addEventListener('click', (e) => {
    const v = videos.find((x) => x.id === openVideoId);
    if (!v) return;
    copyText(scriptPromptFor(v.titleDe, v.summaryRu), e.currentTarget, 'Промт скопирован — вставь в чат с ИИ');
  });
  document.getElementById('copyThumbPromptTemplateBtn').addEventListener('click', (e) => {
    const v = videos.find((x) => x.id === openVideoId);
    if (!v) return;
    copyText(thumbnailPromptTemplateFor(v.titleDe), e.currentTarget, 'Шаблон промта для обложки скопирован');
  });
  document.getElementById('pasteScriptBtn').addEventListener('click', () => {
    pasteIntoScript((text) => {
      const v = videos.find((x) => x.id === openVideoId);
      if (!v) return;
      v.script = text;
      updateVideoRow(v);
      modalScript.textContent = v.script || '—';
      scriptEstimate.textContent = `~${wordCount(v.script).toLocaleString('ru-RU')} ${pluralRu(wordCount(v.script), 'слово', 'слова', 'слов')}`;
      render();
    });
  });

  // Резервный способ копирования через скрытое поле ввода — Clipboard API
  // (navigator.clipboard) требует HTTPS и может быть заблокирован настройками
  // браузера/системы, а execCommand работает почти везде, если это прямой
  // результат клика пользователя.
  function legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function onCopySuccess(btn, message) {
    AudioFX.click();
    if (btn) {
      // у кнопок-иконок (без текста) просто подсвечиваем класс — подмена
      // textContent стёрла бы саму иконку и не восстановила бы её обратно
      const isIconOnly = !!btn.querySelector('svg');
      btn.classList.add('is-copied');
      if (isIconOnly) {
        setTimeout(() => btn.classList.remove('is-copied'), 1600);
      } else {
        const original = btn.textContent;
        btn.textContent = 'Скопировано ✓';
        setTimeout(() => { btn.textContent = original; btn.classList.remove('is-copied'); }, 1600);
      }
    }
    showToast(message || 'Скопировано в буфер обмена');
  }

  function copyText(text, btn, message) {
    const fallback = () => {
      if (legacyCopy(text)) onCopySuccess(btn, message);
      else showToast('Не удалось скопировать — выдели текст вручную', 'warn');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => onCopySuccess(btn, message)).catch(fallback);
    } else {
      fallback();
    }
  }

  ttsBtn.addEventListener('click', () => {
    const script = ttsBtn.dataset.script || '';
    if (script) copyText(script, null, 'Текст сценария скопирован — вставь его на edge-tts.com');
  });

  document.getElementById('deleteBtn').addEventListener('click', async () => {
    if (!openVideoId) return;
    const v = videos.find((x) => x.id === openVideoId);
    if (!v) return;
    const ok = await showConfirm({ title: 'Удалить ролик?', message: `«${v.titleRu || v.titleDe}» будет удалён без возможности восстановления.` });
    if (!ok) return;
    videos = videos.filter((x) => x.id !== openVideoId);
    deleteVideoRow(openVideoId);
    closeModal();
    render();
    AudioFX.delete();
    showToast('Ролик удалён');
  });

  // ------------------------------------------------------------------ универсальный кастомный select

  function closeCustomSelect(wrap) { if (wrap) wrap.classList.remove('is-open'); }
  function closeAllCustomSelects(except) {
    [fieldGroupWrap, currentSortWrap, activeSortWrap, doneSortWrap, segmentFilterWrap].forEach((w) => { if (w && w !== except) closeCustomSelect(w); });
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.custom-select')) closeAllCustomSelects();
  });

  // --- селект группы в форме ролика ---
  const fieldGroupWrap = document.getElementById('fieldGroupWrap');
  const fieldGroupTrigger = document.getElementById('fieldGroupTrigger');
  const fieldGroupList = document.getElementById('fieldGroupList');
  const fieldGroupLabel = document.getElementById('fieldGroupLabel');
  const fieldGroupDot = document.getElementById('fieldGroupDot');
  const fieldGroupInput = document.getElementById('fieldGroup');

  function populateGroupSelect(selectedId) {
    const sel = selectedId && groupById(selectedId) ? selectedId : (groups[0] && groups[0].id);
    fieldGroupInput.value = sel || '';
    const g = groupById(sel);
    if (g) {
      fieldGroupLabel.textContent = g.name;
      fieldGroupDot.style.background = `var(--${g.color})`;
    }
    const optionsHtml = groups.map((gr) => `
      <div class="custom-select-option${gr.id === sel ? ' is-active' : ''}" data-id="${gr.id}">
        <span class="grp-dot" style="background:var(--${gr.color})"></span>${escapeHtml(gr.name)}
      </div>`).join('');
    const addOptionHtml = `<div class="custom-select-option custom-select-option--add" data-action="create-group">+ Добавить группу</div>`;
    fieldGroupList.innerHTML = optionsHtml + addOptionHtml;
  }

  fieldGroupTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !fieldGroupWrap.classList.contains('is-open');
    closeAllCustomSelects();
    if (willOpen) { AudioFX.click(); fieldGroupWrap.classList.add('is-open'); }
  });
  fieldGroupList.addEventListener('click', (e) => {
    const opt = e.target.closest('.custom-select-option');
    if (!opt) return;
    closeCustomSelect(fieldGroupWrap);
    AudioFX.click();
    if (opt.dataset.action === 'create-group') {
      pendingGroupTargetForForm = true;
      openGroupsModal();
      return;
    }
    populateGroupSelect(opt.dataset.id);
  });

  // --- селекты сортировки: независимые для "В работе" и "Готово" ---
  function wireZoneSort(prefix, getSort, setSort) {
    const wrap = document.getElementById(prefix + 'SortWrap');
    const trigger = document.getElementById(prefix + 'SortTrigger');
    const list = document.getElementById(prefix + 'SortList');
    const label = document.getElementById(prefix + 'SortLabel');

    function renderList() {
      list.innerHTML = SORT_OPTIONS.map((o) => `
        <div class="custom-select-option${o.id === getSort() ? ' is-active' : ''}" data-id="${o.id}">${escapeHtml(o.label)}</div>`).join('');
    }

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !wrap.classList.contains('is-open');
      closeAllCustomSelects();
      if (willOpen) { AudioFX.click(); renderList(); wrap.classList.add('is-open'); }
    });
    list.addEventListener('click', (e) => {
      const opt = e.target.closest('.custom-select-option');
      if (!opt) return;
      setSort(opt.dataset.id);
      label.textContent = SORT_OPTIONS.find((o) => o.id === opt.dataset.id).label;
      closeCustomSelect(wrap);
      AudioFX.click();
      render();
    });
    return wrap;
  }

  const currentSortWrap = wireZoneSort('current', () => currentSort, (v) => { currentSort = v; });
  const activeSortWrap = wireZoneSort('active', () => activeSort, (v) => { activeSort = v; });
  const doneSortWrap = wireZoneSort('done', () => doneSort, (v) => { doneSort = v; });

  // ------------------------------------------------------------------ панель добавления / редактирования ролика

  const panelBackdrop = document.getElementById('panelBackdrop');
  const panelTitle = document.getElementById('panelTitle');
  const videoForm = document.getElementById('videoForm');
  const fields = {
    id: document.getElementById('fieldId'),
    titleDe: document.getElementById('fieldTitleDe'),
    titleRu: document.getElementById('fieldTitleRu'),
    summaryRu: document.getElementById('fieldSummaryRu'),
    thumbPrompt: document.getElementById('fieldThumbPrompt'),
    tags: document.getElementById('fieldTags'),
    description: document.getElementById('fieldDescription'),
    script: document.getElementById('fieldScript'),
  };

  document.getElementById('fieldScriptPromptBtn').addEventListener('click', (e) => {
    copyText(scriptPromptFor(fields.titleDe.value, fields.summaryRu.value), e.currentTarget, 'Промт скопирован — вставь в чат с ИИ');
  });
  document.getElementById('fieldThumbPromptTemplateBtn').addEventListener('click', (e) => {
    copyText(thumbnailPromptTemplateFor(fields.titleDe.value), e.currentTarget, 'Шаблон промта для обложки скопирован');
  });
  document.getElementById('fieldScriptPasteBtn').addEventListener('click', () => {
    pasteIntoScript((text) => { fields.script.value = text; });
  });

  function openPanel(video) {
    populateGroupSelect(video ? video.groupId : (currentGroupId !== 'all' ? currentGroupId : (groups[0] && groups[0].id)));
    if (video) {
      panelTitle.textContent = 'Редактировать ролик';
      fields.id.value = video.id;
      fields.titleDe.value = video.titleDe || '';
      fields.titleRu.value = video.titleRu || '';
      fields.summaryRu.value = video.summaryRu || '';
      fields.thumbPrompt.value = video.thumbnailPrompt || '';
      fields.tags.value = (video.tags || []).join(', ');
      fields.description.value = video.description || '';
      fields.script.value = video.script || '';
    } else {
      panelTitle.textContent = 'Новый ролик';
      videoForm.reset();
      fields.id.value = '';
      populateGroupSelect(currentGroupId !== 'all' ? currentGroupId : (groups[0] && groups[0].id));
    }
    panelBackdrop.classList.add('is-open');
    if (bulkPasteSection) bulkPasteSection.classList.remove('is-open');
    AudioFX.open();
  }

  function closePanel() {
    if (!panelBackdrop.classList.contains('is-open')) return;
    panelBackdrop.classList.remove('is-open');
    closeBulkPaste();
    AudioFX.close();
  }

  // ------------------------------------------------------------------ быстрая вставка одним текстом
  // Формат: [название] / [перевод] / [суть] / [промт для обложки] / [теги] / [описание] / [текст],
  // дальше на новой строке — сам текст этого поля до следующей метки.

  const bulkPasteSection = document.getElementById('bulkPasteSection');
  const bulkPasteInput = document.getElementById('bulkPasteInput');

  const BULK_MARKERS = {
    'группа': 'groupName', 'тематика': 'groupName', 'группа / тематика': 'groupName', 'group': 'groupName',
    'название': 'titleDe', 'заголовок': 'titleDe', 'title': 'titleDe',
    'перевод': 'titleRu', 'перевод названия': 'titleRu', 'ру': 'titleRu',
    'суть': 'summaryRu', 'краткое содержание': 'summaryRu',
    'обложка': 'thumbnailPrompt', 'промт': 'thumbnailPrompt', 'промт для обложки': 'thumbnailPrompt', 'thumbnail': 'thumbnailPrompt',
    'теги': 'tags', 'tags': 'tags',
    'описание': 'description', 'описание под видео': 'description',
    'текст': 'script', 'сценарий': 'script', 'текст ролика': 'script', 'script': 'script',
  };

  function parseBulkPaste(text) {
    const result = {};
    let currentField = null;
    let buffer = [];
    const markerRe = /^\s*\[([^\]]+)\]\s*$/;
    const flush = () => { if (currentField) result[currentField] = buffer.join('\n').trim(); buffer = []; };
    text.split('\n').forEach((line) => {
      const m = line.match(markerRe);
      const key = m && BULK_MARKERS[m[1].trim().toLowerCase()];
      if (key) { flush(); currentField = key; return; }
      if (currentField) buffer.push(line);
    });
    flush();
    return result;
  }

  const bulkPasteToggleBtn = document.getElementById('bulkPasteToggle');
  function openBulkPaste() {
    bulkPasteSection.classList.add('is-open');
    bulkPasteToggleBtn.classList.add('is-active');
    setTimeout(() => bulkPasteInput.focus(), 150);
  }
  function closeBulkPaste() {
    bulkPasteSection.classList.remove('is-open');
    bulkPasteToggleBtn.classList.remove('is-active');
  }

  bulkPasteToggleBtn.addEventListener('click', () => {
    AudioFX.click();
    if (bulkPasteSection.classList.contains('is-open')) closeBulkPaste();
    else openBulkPaste();
  });
  document.getElementById('bulkPasteCancel').addEventListener('click', () => { AudioFX.close(); closeBulkPaste(); });

  const BULK_TEMPLATE = 'заполни эту форму, именно как шаблон используй и не меняй его, просто добавь что нужно. в группу укажи main. название на немецком пиши, перевод это перевод названия, суть пиши на русском. описание и теги делай чтобы ютуб принял и продвинул.\nполе текста пока не заполняй\n\n[группа]\n\n\n[название]\n\n\n[перевод]\n\n\n[суть]\n\n\n[промт для обложки]\n\n\n[теги]\n\n\n[описание]\n\n\n[текст]\n\nзаполни для этого названия\n';
  document.getElementById('bulkPasteCopyTemplate').addEventListener('click', (e) => {
    copyText(BULK_TEMPLATE, e.currentTarget);
  });

  document.getElementById('bulkPasteApply').addEventListener('click', () => {
    const parsed = parseBulkPaste(bulkPasteInput.value);
    if (!Object.keys(parsed).length) { showToast('Не нашёл ни одной метки вида [название]', 'warn'); return; }

    let createdGroupName = null;
    if (parsed.groupName != null && parsed.groupName.trim()) {
      const wanted = parsed.groupName.trim();
      let g = groups.find((gr) => gr.name.toLowerCase() === wanted.toLowerCase());
      if (!g) {
        g = { id: groupUid(), name: wanted, color: GROUP_COLORS[groups.length % GROUP_COLORS.length] };
        groups.push(g);
        insertGroup(g);
        createdGroupName = g.name;
      }
      populateGroupSelect(g.id);
    }

    if (parsed.titleDe != null) fields.titleDe.value = parsed.titleDe;
    if (parsed.titleRu != null) fields.titleRu.value = parsed.titleRu;
    if (parsed.summaryRu != null) fields.summaryRu.value = parsed.summaryRu;
    if (parsed.thumbnailPrompt != null) fields.thumbPrompt.value = parsed.thumbnailPrompt;
    if (parsed.tags != null) fields.tags.value = parsed.tags;
    if (parsed.description != null) fields.description.value = parsed.description;
    if (parsed.script != null) fields.script.value = parsed.script;
    bulkPasteInput.value = '';
    closeBulkPaste();
    AudioFX.add();
    if (createdGroupName) {
      renderSegmentFilter();
      showToast(`Группа «${createdGroupName}» создана и выбрана`);
    } else {
      showToast('Поля заполнены из вставленного текста');
    }
  });

  document.getElementById('addBtn').addEventListener('click', () => openPanel(null));
  document.getElementById('editBtn').addEventListener('click', () => {
    if (!openVideoId) return;
    const v = videos.find((x) => x.id === openVideoId);
    closeModal();
    openPanel(v);
  });
  document.getElementById('duplicateBtn').addEventListener('click', () => {
    if (!openVideoId) return;
    const v = videos.find((x) => x.id === openVideoId);
    if (!v) return;
    const copy = Object.assign({}, v, {
      id: uid(),
      done: false,
      createdAt: Date.now(),
      titleRu: v.titleRu ? v.titleRu + ' (копия)' : v.titleRu,
    });
    videos.push(copy);
    insertVideoRow(copy);
    closeModal();
    render();
    AudioFX.add();
    showToast('Ролик продублирован');
    const newCardEl = document.querySelector(`.card[data-id="${copy.id}"]`);
    if (newCardEl) {
      newCardEl.classList.add('card-enter');
      newCardEl.addEventListener('animationend', () => newCardEl.classList.remove('card-enter'), { once: true });
      newCardEl.scrollIntoView({ block: 'nearest' });
    }
    openModal(copy.id);
  });
  document.getElementById('panelClose').addEventListener('click', closePanel);
  document.getElementById('panelCancel').addEventListener('click', closePanel);
  // панель редактирования закрывается только явной кнопкой — клик по фону
  // случайно ловил конец выделения/копирования текста внутри формы

  videoForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!groups.length) {
      showToast('Сначала создайте хотя бы одну группу', 'warn');
      pendingGroupTargetForForm = true;
      openGroupsModal();
      return;
    }
    const tags = fields.tags.value.split(',').map((t) => t.trim()).filter(Boolean);
    const payload = {
      groupId: fieldGroupInput.value || (groups[0] && groups[0].id),
      titleDe: fields.titleDe.value.trim(),
      titleRu: fields.titleRu.value.trim(),
      summaryRu: fields.summaryRu.value.trim(),
      thumbnailPrompt: fields.thumbPrompt.value.trim(),
      tags,
      description: fields.description.value.trim(),
      script: fields.script.value.trim(),
    };

    let newId = null;
    if (fields.id.value) {
      const v = videos.find((x) => x.id === fields.id.value);
      if (v) { Object.assign(v, payload); updateVideoRow(v); }
      showToast('Изменения сохранены');
    } else {
      newId = uid();
      const newVideo = Object.assign({ id: newId, done: false, createdAt: Date.now() }, payload);
      videos.push(newVideo);
      insertVideoRow(newVideo);
      AudioFX.add();
      showToast('Ролик добавлен');
    }
    closePanel();
    render();

    if (newId) {
      const newCardEl = document.querySelector(`.card[data-id="${newId}"]`);
      if (newCardEl) {
        newCardEl.classList.add('card-enter');
        newCardEl.addEventListener('animationend', () => newCardEl.classList.remove('card-enter'), { once: true });
      }
    }
  });

  // ------------------------------------------------------------------ модалка "Группы"

  const groupsModalBackdrop = document.getElementById('groupsModalBackdrop');
  const groupsList = document.getElementById('groupsList');
  const newGroupName = document.getElementById('newGroupName');
  const colorSwatches = document.getElementById('colorSwatches');
  const addGroupBtn = document.getElementById('addGroupBtn');

  function renderColorSwatches() {
    colorSwatches.innerHTML = GROUP_COLORS.map((c) => `<span class="color-swatch${c === newGroupSelectedColor ? ' is-selected' : ''}" data-color="${c}" style="background:var(--${c})"></span>`).join('');
  }

  colorSwatches.addEventListener('click', (e) => {
    const sw = e.target.closest('.color-swatch');
    if (!sw) return;
    newGroupSelectedColor = sw.dataset.color;
    AudioFX.click();
    renderColorSwatches();
  });

  function renderGroupsList() {
    groupsList.innerHTML = groups.map((g) => {
      const count = videos.filter((v) => v.groupId === g.id).length;
      return `<div class="group-row" data-id="${g.id}">
        <span class="grp-dot" style="background:var(--${g.color})"></span>
        <input type="text" class="group-name-input" value="${escapeHtml(g.name)}" data-id="${g.id}">
        <span class="group-count">${count} шт.</span>
        <button class="icon-btn" data-action="delete-group" data-id="${g.id}" title="Удалить группу">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M5 7H19M9 7V5C9 4.4 9.4 4 10 4H14C14.6 4 15 4.4 15 5V7M7 7L8 20C8 20.6 8.4 21 9 21H15C15.6 21 16 20.6 16 20L17 7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>`;
    }).join('');
  }

  groupsList.addEventListener('change', (e) => {
    const input = e.target.closest('.group-name-input');
    if (!input) return;
    const g = groupById(input.dataset.id);
    if (!g) return;
    const newName = input.value.trim();
    if (!newName) { input.value = g.name; return; }
    g.name = newName;
    updateGroupRow(g);
    render();
    showToast('Группа переименована');
  });

  groupsList.addEventListener('click', async (e) => {
    const delBtn = e.target.closest('[data-action="delete-group"]');
    if (!delBtn) return;
    if (groups.length <= 1) { showToast('Должна остаться хотя бы одна группа', 'warn'); return; }
    const g = groupById(delBtn.dataset.id);
    if (!g) return;
    const count = videos.filter((v) => v.groupId === g.id).length;
    const msg = count > 0
      ? `${count} ролик(ов) будут перенесены в другую группу.`
      : `Группа «${g.name}» будет удалена без возможности восстановления.`;
    const ok = await showConfirm({ title: `Удалить группу «${g.name}»?`, message: msg });
    if (!ok) return;
    groups = groups.filter((x) => x.id !== g.id);
    const fallbackId = groups[0].id;
    videos.forEach((v) => { if (v.groupId === g.id) v.groupId = fallbackId; });
    if (currentGroupId === g.id) currentGroupId = 'all';
    await reassignVideosGroup(g.id, fallbackId);
    deleteGroupRow(g.id);
    renderGroupsList();
    render();
    AudioFX.delete();
    showToast('Группа удалена');
  });

  addGroupBtn.addEventListener('click', () => {
    const name = newGroupName.value.trim();
    if (!name) { showToast('Введите название группы', 'warn'); return; }
    if (groups.some((g) => g.name.toLowerCase() === name.toLowerCase())) { showToast('Такая группа уже есть', 'warn'); return; }
    const g = { id: groupUid(), name, color: newGroupSelectedColor };
    groups.push(g);
    insertGroup(g);
    newGroupName.value = '';
    newGroupSelectedColor = GROUP_COLORS[(groups.length) % GROUP_COLORS.length];
    renderColorSwatches();
    renderGroupsList();
    render();
    AudioFX.add();
    showToast(`Группа «${g.name}» создана`);

    if (pendingGroupTargetForForm) {
      populateGroupSelect(g.id);
      pendingGroupTargetForForm = false;
      closeGroupsModal();
    }
  });

  function openGroupsModal() {
    renderColorSwatches();
    renderGroupsList();
    groupsModalBackdrop.classList.add('is-open');
    AudioFX.open();
  }
  function closeGroupsModal() {
    if (!groupsModalBackdrop.classList.contains('is-open')) return;
    groupsModalBackdrop.classList.remove('is-open');
    pendingGroupTargetForForm = false;
    AudioFX.close();
  }

  document.getElementById('manageGroupsBtn').addEventListener('click', () => openGroupsModal());
  document.getElementById('groupsModalClose').addEventListener('click', closeGroupsModal);
  wireBackdropClose(groupsModalBackdrop, closeGroupsModal);

  // ------------------------------------------------------------------ аккаунт

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    const ok = await showConfirm({ title: 'Выйти из аккаунта?', message: 'Все данные сохранены в аккаунте — при следующем входе (с любого устройства) они будут на месте.', confirmLabel: 'Выйти' });
    if (!ok) return;
    await Auth.logout();
    window.location.href = '/login/';
  });

  const settingsBackdrop = document.getElementById('settingsBackdrop');
  const settingsUsernameInput = document.getElementById('settingsUsername');
  const usernameErrorEl = document.getElementById('usernameError');
  const passwordErrorEl = document.getElementById('passwordError');

  document.querySelectorAll('.auth-eye-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.for);
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.classList.toggle('is-active', !showing);
      AudioFX.click();
    });
  });

  function openSettings() {
    const user = Auth.currentUser();
    settingsUsernameInput.value = user ? user.username : '';
    usernameErrorEl.textContent = '';
    passwordErrorEl.textContent = '';
    document.getElementById('settingsCurrentPassword').value = '';
    document.getElementById('settingsNewPassword').value = '';
    settingsBackdrop.classList.add('is-open');
    AudioFX.open();
  }
  function closeSettings() {
    settingsBackdrop.classList.remove('is-open');
    AudioFX.close();
  }
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('settingsClose').addEventListener('click', closeSettings);
  wireBackdropClose(settingsBackdrop, closeSettings);

  document.getElementById('formUsername').addEventListener('submit', async (e) => {
    e.preventDefault();
    const result = await Auth.changeUsername(settingsUsernameInput.value);
    if (!result.ok) { usernameErrorEl.textContent = result.message; AudioFX.undo(); return; }
    usernameErrorEl.textContent = '';
    AudioFX.success();
    showToast('Ник обновлён');
  });

  document.getElementById('formPassword').addEventListener('submit', async (e) => {
    e.preventDefault();
    const current = document.getElementById('settingsCurrentPassword').value;
    const next = document.getElementById('settingsNewPassword').value;
    const result = await Auth.changePassword(current, next);
    if (!result.ok) { passwordErrorEl.textContent = result.message; AudioFX.undo(); return; }
    passwordErrorEl.textContent = '';
    document.getElementById('settingsCurrentPassword').value = '';
    document.getElementById('settingsNewPassword').value = '';
    AudioFX.success();
    showToast('Пароль изменён');
  });

  // ------------------------------------------------------------------ панель проектов (слева)

  const workspacePeek = document.getElementById('workspacePeek');
  const workspacePanel = document.getElementById('workspacePanel');
  const workspaceMobileFab = document.getElementById('workspaceMobileFab');
  const workspaceGridEl = document.getElementById('workspaceGrid');

  const workspacePin = document.getElementById('workspacePin');
  let workspacePinned = false;
  let workspaceCloseTimer = null;

  // На ПК — наведением: подвёл курсор к полоске/панели — открылась, увёл — закрылась.
  // Булавка держит её открытой без наведения. На телефоне наведения нет —
  // там отдельная круглая кнопка (workspaceMobileFab), чисто по тапу.
  function openWorkspacePanel() {
    clearTimeout(workspaceCloseTimer);
    workspacePanel.classList.add('is-open');
    workspacePeek.classList.add('is-hidden');
    workspaceMobileFab.classList.add('is-open');
  }
  function closeWorkspacePanel() {
    workspacePanel.classList.remove('is-open');
    workspacePeek.classList.remove('is-hidden');
    workspaceMobileFab.classList.remove('is-open');
  }
  function scheduleCloseWorkspacePanel(force) {
    clearTimeout(workspaceCloseTimer);
    if (workspacePinned && !force) return;
    workspaceCloseTimer = setTimeout(closeWorkspacePanel, force ? 0 : 90);
  }
  function toggleWorkspacePanel() {
    if (workspacePanel.classList.contains('is-open')) closeWorkspacePanel();
    else openWorkspacePanel();
  }

  workspacePeek.addEventListener('mouseenter', () => { if (!isMobileLayout()) openWorkspacePanel(); });
  workspacePanel.addEventListener('mouseenter', () => { if (!isMobileLayout()) openWorkspacePanel(); });
  workspacePeek.addEventListener('mouseleave', () => { if (!isMobileLayout()) scheduleCloseWorkspacePanel(false); });
  workspacePanel.addEventListener('mouseleave', () => { if (!isMobileLayout()) scheduleCloseWorkspacePanel(false); });

  workspacePin.addEventListener('click', () => {
    workspacePinned = !workspacePinned;
    workspacePin.classList.toggle('is-active', workspacePinned);
    workspacePanel.classList.toggle('is-pinned', workspacePinned);
    AudioFX.click();
    if (workspacePinned) openWorkspacePanel();
  });

  // мобильная кнопка — чисто по тапу, без наведения
  workspaceMobileFab.addEventListener('click', () => { AudioFX.click(); toggleWorkspacePanel(); });

  document.addEventListener('click', (e) => {
    if (!workspacePanel.classList.contains('is-open') || workspacePinned) return;
    if (e.target.closest('#workspacePanel') || e.target.closest('#workspacePeek') || e.target.closest('#workspaceMobileFab') || e.target.closest('#topbarWorkspace')) return;
    closeWorkspacePanel();
  });

  const workspaceResizeHandle = document.getElementById('workspaceResizeHandle');
  let resizeStartX = 0, resizeStartWidth = 0;
  workspaceResizeHandle.addEventListener('pointerdown', (e) => {
    if (!workspacePinned) return;
    e.preventDefault();
    resizeStartX = e.clientX;
    resizeStartWidth = workspacePanel.getBoundingClientRect().width;
    workspacePanel.classList.add('is-resizing');
    workspaceResizeHandle.setPointerCapture(e.pointerId);
  });
  workspaceResizeHandle.addEventListener('pointermove', (e) => {
    if (!workspacePanel.classList.contains('is-resizing')) return;
    const next = Math.min(720, Math.max(300, resizeStartWidth + (e.clientX - resizeStartX)));
    workspacePanel.style.width = next + 'px';
  });
  function stopWorkspaceResize() { workspacePanel.classList.remove('is-resizing'); }
  workspaceResizeHandle.addEventListener('pointerup', stopWorkspaceResize);
  workspaceResizeHandle.addEventListener('pointercancel', stopWorkspaceResize);

  function workspaceFolderIconSvg() {
    return `<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M3.5 6.5C3.5 5.7 4.2 5 5 5H9.5L11.5 7.5H19C19.8 7.5 20.5 8.2 20.5 9V17.5C20.5 18.3 19.8 19 19 19H5C4.2 19 3.5 18.3 3.5 17.5V6.5Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`;
  }

  function workspaceVideoCount(w) {
    if (w.id === activeWorkspaceId) return videos.length;
    return workspaceVideoCounts[w.id] || 0;
  }

  const workspacePeekDot = document.getElementById('workspacePeekDot');
  const workspacePeekLabel = document.getElementById('workspacePeekLabel');
  const topbarWorkspaceDot = document.getElementById('topbarWorkspaceDot');
  const topbarWorkspaceName = document.getElementById('topbarWorkspaceName');
  function updateWorkspacePeekIndicator() {
    const w = workspaceById(activeWorkspaceId);
    if (!w) return;
    workspacePeek.style.setProperty('--grp-c', `var(--${w.color})`);
    workspacePeekDot.style.background = `var(--${w.color})`;
    workspacePeekLabel.textContent = w.name;
    document.getElementById('topbarWorkspace').style.setProperty('--grp-c', `var(--${w.color})`);
    topbarWorkspaceDot.style.background = `var(--${w.color})`;
    topbarWorkspaceName.textContent = w.name;
    // цвет текущего проекта доступен глобально — используется, например,
    // для разделителя "выполненные ролики опускаются сюда"
    document.documentElement.style.setProperty('--ws-c', `var(--${w.color})`);
  }
  document.getElementById('topbarWorkspace').addEventListener('click', () => {
    AudioFX.click();
    if (workspacePanel.classList.contains('is-open')) {
      closeWorkspacePanel();
    } else {
      openWorkspacePanel();
    }
  });

  function renderWorkspaceList() {
    const tiles = workspaces.map((w) => `
      <div class="workspace-tile${w.id === activeWorkspaceId ? ' is-active' : ''}" data-id="${w.id}" style="--grp-c:var(--${w.color})">
        <div class="workspace-tile-top">
          <span class="workspace-icon">${workspaceFolderIconSvg()}</span>
          <button class="workspace-edit" data-action="edit-workspace" data-id="${w.id}" title="Настройки проекта">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M4 20L4.6 16.7L16.4 4.9C17 4.3 18 4.3 18.6 4.9L19.1 5.4C19.7 6 19.7 7 19.1 7.6L7.3 19.4L4 20Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <div>
          <div class="workspace-name">${escapeHtml(w.name)}</div>
          <div class="workspace-count">${workspaceVideoCount(w)} ролик(ов)</div>
        </div>
      </div>`).join('');

    const addTile = `
      <div class="workspace-tile workspace-tile--add" id="addWorkspaceTile">
        <span class="plus-icon">+</span>
        <span>Новый проект</span>
      </div>`;

    workspaceGridEl.innerHTML = tiles + addTile;
  }

  workspaceGridEl.addEventListener('click', (e) => {
    if (e.target.closest('#addWorkspaceTile')) { openFolderModal('create', null); return; }
    const editBtn = e.target.closest('[data-action="edit-workspace"]');
    if (editBtn) { e.stopPropagation(); openFolderModal('edit', workspaceById(editBtn.dataset.id)); return; }
    const tile = e.target.closest('.workspace-tile');
    if (tile && tile.dataset.id) switchWorkspace(tile.dataset.id);
  });

  // --- окно создания / редактирования проекта ---
  const folderModalBackdrop = document.getElementById('folderModalBackdrop');
  const folderModalTitle = document.getElementById('folderModalTitle');
  const folderNameInput = document.getElementById('folderNameInput');
  const folderColorSwatches = document.getElementById('folderColorSwatches');
  const folderSaveBtn = document.getElementById('folderSaveBtn');
  const folderDeleteBtn = document.getElementById('folderDeleteBtn');
  let folderModalMode = 'create';
  let folderModalTargetId = null;
  let folderModalColor = GROUP_COLORS[0];

  function renderFolderColorSwatches() {
    folderColorSwatches.innerHTML = GROUP_COLORS.map((c) => `<span class="color-swatch${c === folderModalColor ? ' is-selected' : ''}" data-color="${c}" style="background:var(--${c})"></span>`).join('');
  }
  folderColorSwatches.addEventListener('click', (e) => {
    const sw = e.target.closest('.color-swatch');
    if (!sw) return;
    folderModalColor = sw.dataset.color;
    AudioFX.click();
    renderFolderColorSwatches();
  });

  function openFolderModal(mode, workspace) {
    folderModalMode = mode;
    folderModalTargetId = workspace ? workspace.id : null;
    folderModalTitle.textContent = mode === 'create' ? 'Новый проект' : 'Настройки проекта';
    folderSaveBtn.textContent = mode === 'create' ? 'Создать проект' : 'Сохранить';
    folderNameInput.value = workspace ? workspace.name : '';
    folderModalColor = workspace ? workspace.color : GROUP_COLORS[workspaces.length % GROUP_COLORS.length];
    folderDeleteBtn.hidden = mode !== 'edit';
    renderFolderColorSwatches();
    folderModalBackdrop.classList.add('is-open');
    AudioFX.open();
    setTimeout(() => folderNameInput.focus(), 50);
  }
  function closeFolderModal() {
    folderModalBackdrop.classList.remove('is-open');
    AudioFX.close();
  }
  document.getElementById('folderModalClose').addEventListener('click', closeFolderModal);
  wireBackdropClose(folderModalBackdrop, closeFolderModal);

  folderSaveBtn.addEventListener('click', () => {
    const name = folderNameInput.value.trim();
    if (!name) { showToast('Введите название проекта', 'warn'); return; }
    if (folderModalMode === 'create') {
      const w = { id: workspaceUid(), name, color: folderModalColor, createdAt: Date.now() };
      workspaces.push(w);
      insertWorkspace(w);
      renderWorkspaceList();
      AudioFX.add();
      closeFolderModal();
      switchWorkspace(w.id);
    } else {
      const w = workspaceById(folderModalTargetId);
      if (!w) return;
      w.name = name;
      w.color = folderModalColor;
      updateWorkspaceRow(w);
      renderWorkspaceList();
      if (w.id === activeWorkspaceId) updateWorkspacePeekIndicator();
      showToast('Проект обновлён');
      closeFolderModal();
    }
  });

  folderDeleteBtn.addEventListener('click', async () => {
    if (workspaces.length <= 1) { showToast('Должен остаться хотя бы один проект', 'warn'); return; }
    const w = workspaceById(folderModalTargetId);
    if (!w) return;
    const ok = await showConfirm({
      title: `Удалить проект «${w.name}»?`,
      message: 'Вместе с проектом удалятся все его ролики и группы. Это необратимо.',
    });
    if (!ok) return;
    await deleteWorkspaceRow(w.id); // каскадом удалит все группы и ролики этого проекта
    workspaces = workspaces.filter((x) => x.id !== w.id);
    if (activeWorkspaceId === w.id) {
      setActiveWorkspace(workspaces[0].id);
      await loadGroups(); await loadVideos(); await loadNotes();
      isFirstRender = true; isFirstNotesRender = true; render(); renderNotes();
    }
    renderWorkspaceList();
    AudioFX.delete();
    showToast('Проект удалён');
    closeFolderModal();
  });

  // ------------------------------------------------------------------ поиск

  const searchInputEl = document.getElementById('searchInput');
  const searchClearBtn = document.getElementById('searchClearBtn');

  searchInputEl.addEventListener('input', (e) => {
    currentSearch = e.target.value.trim().toLowerCase();
    searchClearBtn.hidden = !e.target.value;
    render();
  });
  searchClearBtn.addEventListener('click', () => {
    searchInputEl.value = '';
    currentSearch = '';
    searchClearBtn.hidden = true;
    searchInputEl.focus();
    AudioFX.click();
    render();
  });

  // ------------------------------------------------------------------ звук: кнопка

  const soundToggle = document.getElementById('soundToggle');
  const iconSoundOn = document.getElementById('iconSoundOn');
  const iconSoundOff = document.getElementById('iconSoundOff');

  function applySoundIcon() {
    const on = AudioFX.isEnabled();
    iconSoundOn.hidden = !on;
    iconSoundOff.hidden = on;
    soundToggle.classList.toggle('is-off', !on);
  }
  soundToggle.addEventListener('click', () => {
    AudioFX.toggle(!AudioFX.isEnabled());
    applySoundIcon();
  });
  applySoundIcon();

  // ------------------------------------------------------------------ помощь

  const helpBtn = document.getElementById('helpBtn');
  const helpPopover = document.getElementById('helpPopover');
  function toggleHelp(force) {
    const willOpen = typeof force === 'boolean' ? force : !helpPopover.classList.contains('is-open');
    helpPopover.classList.toggle('is-open', willOpen);
  }
  helpBtn.addEventListener('click', (e) => { e.stopPropagation(); AudioFX.click(); toggleHelp(); });
  document.addEventListener('click', (e) => {
    if (!helpPopover.contains(e.target) && e.target !== helpBtn) toggleHelp(false);
  });

  // ------------------------------------------------------------------ pan & zoom поля (плавно, с умеренной инерцией)
  //
  // Важно: .canvas-pan отвечает только за translate (реальные экранные пиксели),
  // .canvas-inner — только за zoom (не transform:scale!), чтобы текст оставался
  // чётким на любом масштабе — transform:scale просто растягивает готовый растр,
  // а zoom заставляет браузер по-настоящему пересчитать раскладку.

  const viewport = document.getElementById('viewport');
  const canvasPan = document.getElementById('canvasPan');
  const canvasInner = document.getElementById('canvasInner');

  // На телефоне (и вообще на узком экране) поле не перетаскивается и не
  // масштабируется — просто обычная прокрутка, как в CSS-медиа-запросе выше.
  function isMobileLayout() { return window.matchMedia('(max-width: 860px)').matches; }

  let panX = 0, panY = 0, scale = 1;
  let pointerDownPos = null, dragThresholdExceeded = false, capturedPointerId = null;
  let startPanX = 0, startPanY = 0;
  const DRAG_THRESHOLD = 6;
  let velocityX = 0, velocityY = 0, lastMoveTime = 0, lastMoveX = 0, lastMoveY = 0;
  let momentumRaf = null;

  // Масштаб всегда идёт через настоящий CSS zoom (не transform:scale) — это
  // единственный способ получить честно чёткий текст на любом приближении:
  // transform:scale просто растягивает готовую картинку слоя, а zoom
  // пересчитывает раскладку и рендерит текст заново под новый размер.
  // Чтобы не дёргать zoom на каждый микро-шаг колеса (это reflow, недёшево),
  // события колеса копятся и применяются одним разом за кадр — не чаще,
  // чем браузер всё равно успевает отрисовать.
  function applyPan() { canvasPan.style.transform = `translate(${panX}px, ${panY}px)`; }

  function setZoomAt(anchorX, anchorY, newScale) {
    const clamped = Math.min(1.6, Math.max(0.45, newScale));
    const worldX = (anchorX - panX) / scale;
    const worldY = (anchorY - panY) / scale;
    scale = clamped;
    panX = anchorX - worldX * scale;
    panY = anchorY - worldY * scale;
    canvasInner.style.zoom = String(scale);
    applyPan();
  }

  function centerCanvas() {
    stopMomentum();
    if (isMobileLayout()) return; // на телефоне поле не масштабируется — обычная прокрутка
    const vw = viewport.clientWidth;
    panX = (vw - 3200) / 2;
    panY = 40;
    scale = Math.min(1, vw / 1700);
    canvasInner.style.zoom = String(scale);
    applyPan();
  }

  function stopMomentum() {
    if (momentumRaf) { cancelAnimationFrame(momentumRaf); momentumRaf = null; }
  }

  function runMomentum() {
    // плавное затухание: резкий рывок ощутимо докатывается по инерции,
    // но не "простреливает" далеко и не отскакивает
    const friction = 0.9;
    velocityX *= friction;
    velocityY *= friction;
    panX += velocityX;
    panY += velocityY;
    applyPan();
    if (Math.abs(velocityX) > 0.12 || Math.abs(velocityY) > 0.12) {
      momentumRaf = requestAnimationFrame(runMomentum);
    } else {
      momentumRaf = null;
    }
  }

  viewport.addEventListener('pointerdown', (e) => {
    if (isMobileLayout()) return; // на телефоне — обычная прокрутка, панорамирование выключено
    const isMiddleButton = e.button === 1;
    const onRealControl = e.target.closest('button') || e.target.closest('a') || e.target.closest('input') || e.target.closest('textarea') || e.target.closest('.custom-select');
    if (onRealControl) return; // настоящие кнопки/поля/дропдауны не трогаем никакой кнопкой мыши
    // ЛКМ панорамирует только с пустого места (по карточке — открывает её).
    // Средняя кнопка мыши (зажать колёсико) панорамирует всегда, даже прямо над карточкой/заметкой.
    if (!isMiddleButton && (e.target.closest('.card') || e.target.closest('.note-card'))) return;

    stopMomentum();
    pointerDownPos = { x: e.clientX, y: e.clientY };
    dragThresholdExceeded = isMiddleButton; // средней кнопкой тащим сразу, без порога в 6px
    capturedPointerId = e.pointerId;
    startPanX = panX; startPanY = panY;
    lastMoveTime = performance.now();
    lastMoveX = e.clientX; lastMoveY = e.clientY;
    velocityX = 0; velocityY = 0;

    if (isMiddleButton) {
      e.preventDefault(); // отключаем стандартный авто-скролл средней кнопкой
      viewport.classList.add('is-panning');
      try { viewport.setPointerCapture(e.pointerId); } catch (err) {}
    }
    // для ЛКМ pointer capture ставим только когда реально начнётся перетаскивание (см. pointermove) —
    // если сделать это сразу на pointerdown, клик по карточке перестаёт открываться,
    // потому что все последующие события (включая click) ретаргетятся на viewport.
  });

  viewport.addEventListener('pointermove', (e) => {
    if (!pointerDownPos) return;
    const dx = e.clientX - pointerDownPos.x;
    const dy = e.clientY - pointerDownPos.y;
    if (!dragThresholdExceeded) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      dragThresholdExceeded = true;
      viewport.classList.add('is-panning');
      try { viewport.setPointerCapture(capturedPointerId); } catch (err) {}
    }
    e.preventDefault();
    panX = startPanX + dx;
    panY = startPanY + dy;
    applyPan();

    const now = performance.now();
    const dt = Math.max(1, now - lastMoveTime);
    velocityX = (e.clientX - lastMoveX) / dt * 11;
    velocityY = (e.clientY - lastMoveY) / dt * 11;
    // ограничиваем максимальную скорость, чтобы очень резкий рывок не "простреливал" поле
    velocityX = Math.max(-38, Math.min(38, velocityX));
    velocityY = Math.max(-38, Math.min(38, velocityY));
    lastMoveTime = now; lastMoveX = e.clientX; lastMoveY = e.clientY;
  });

  function endPan() {
    if (dragThresholdExceeded && (Math.abs(velocityX) > 0.35 || Math.abs(velocityY) > 0.35)) {
      runMomentum();
    }
    pointerDownPos = null;
    viewport.classList.remove('is-panning');
    setTimeout(() => { dragThresholdExceeded = false; }, 0);
  }
  viewport.addEventListener('pointerup', endPan);
  viewport.addEventListener('pointercancel', endPan);

  // события колеса мыши копятся и применяются одним zoom-реflow за кадр —
  // не чаще, чем браузер всё равно успевает нарисовать, вместо reflow на каждое
  // отдельное срабатывание колеса (их может быть десятки в секунду).
  let pendingWheelDelta = 0, pendingAnchor = null, wheelRafPending = false;

  function flushWheelZoom() {
    wheelRafPending = false;
    if (!pendingAnchor) return;
    const newScale = scale * (1 - pendingWheelDelta * 0.0012);
    setZoomAt(pendingAnchor.x, pendingAnchor.y, newScale);
    pendingWheelDelta = 0;
    pendingAnchor = null;
  }

  viewport.addEventListener('wheel', (e) => {
    if (isMobileLayout()) return; // обычная прокрутка вместо зума
    e.preventDefault();
    // пока зажата любая кнопка мыши для перетаскивания (в том числе средняя) —
    // колесо игнорируем: одновременный зум и панорамирование дёргали картинку,
    // потому что оба меняли panX/panY независимо друг от друга
    if (pointerDownPos) return;
    const rect = viewport.getBoundingClientRect();
    pendingAnchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    pendingWheelDelta += e.deltaY;
    if (!wheelRafPending) { wheelRafPending = true; requestAnimationFrame(flushWheelZoom); }
  }, { passive: false });

  function stepZoom(delta) {
    const rect = viewport.getBoundingClientRect();
    setZoomAt(rect.width / 2, rect.height / 2, scale + delta);
  }

  document.getElementById('zoomIn').addEventListener('click', () => { AudioFX.click(); stepZoom(0.15); });
  document.getElementById('zoomOut').addEventListener('click', () => { AudioFX.click(); stepZoom(-0.15); });
  document.getElementById('zoomReset').addEventListener('click', () => { AudioFX.click(); centerCanvas(); });

  window.addEventListener('resize', centerCanvas);

  // высота шапки измеряется по факту, а не подбирается на глаз — так левая
  // панель проектов и полоска всегда стартуют ровно под ней, при любом
  // размере логотипа/контента и любой ширине окна
  const topbarEl = document.querySelector('.topbar');
  function syncTopbarHeight() {
    if (!topbarEl) return;
    document.documentElement.style.setProperty('--topbar-total-height', topbarEl.getBoundingClientRect().height + 'px');
  }
  syncTopbarHeight();
  window.addEventListener('resize', syncTopbarHeight);
  if (window.ResizeObserver) new ResizeObserver(syncTopbarHeight).observe(topbarEl);

  // ------------------------------------------------------------------ toasts

  function showToast(message) {
    const stack = document.getElementById('toastStack');
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span class="dot-accent"></span>${escapeHtml(message)}`;
    stack.appendChild(el);
    setTimeout(() => {
      el.classList.add('is-leaving');
      el.addEventListener('animationend', () => el.remove());
    }, 2600);
  }

  // ------------------------------------------------------------------ init

  (async function initApp() {
    await Auth.ready;
    await loadWorkspaces();
    await refreshWorkspaceVideoCounts();
    renderWorkspaceList();
    updateWorkspacePeekIndicator();
    await loadGroups();
    await loadVideos();
    await loadNotes();
    render();
    renderNotes();
    centerCanvas();
  })();
})();
