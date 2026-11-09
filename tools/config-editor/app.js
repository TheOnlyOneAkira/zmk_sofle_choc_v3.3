/*
 * Éditeur de configuration du Sofle : interface.
 * Les données viennent de /api/config (scripts/config_editor.py, lecture seule).
 */
(function () {
  'use strict';

  const C = window.Core;
  const K = window.Keycodes;
  const DRAFT_KEY = 'sofle-config-editor:draft';

  // ---------------------------------------------------------------------
  // Utilitaires DOM
  // ---------------------------------------------------------------------
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const $ = (id) => document.getElementById(id);

  function hashString(s) {
    let x = 2166136261;
    for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
    return (x >>> 0).toString(16);
  }

  function textColorFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55 ? '#111' : '#fff';
  }

  // ---------------------------------------------------------------------
  // État
  // ---------------------------------------------------------------------
  const S = {
    source: null,           // réponse de /api/config
    keymap: null,           // {defines, behaviors}
    parsedLayers: null,     // fichier sofle_layers.dtsi lu
    parsedColors: null,     // fichier sofle_colors.dtsi lu
    layers: [],             // [{header, node, displayName, comments, bindings[60], sensor}]
    colors: [],             // [li] -> 60 jetons ou null
    origLayers: [],
    origColors: [],
    extraDefines: [],       // [{name, value}]
    layerDefineNames: [],   // [li] -> "SYMBOLS"
    labeler: null,
    current: 0,
    mode: 'keys',
    selected: null,
    brush: 'WHT',
    showBg: true,
    renderLayers: new Set([0]),
    hash: '',
    exportStale: true,
  };

  const colorDefines = () => {
    const d = { ...S.parsedColors.defines };
    S.extraDefines.forEach((e) => { d[e.name] = e.value; });
    return d;
  };
  const layerNames = () => S.layers.map((l, i) => S.layerDefineNames[i] || l.displayName || l.node);

  // ---------------------------------------------------------------------
  // Chargement
  // ---------------------------------------------------------------------
  async function load(discardDraft) {
    let data;
    try {
      const res = await fetch('/api/config', { cache: 'no-store' });
      data = await res.json();
      if (data.error) throw new Error(data.error);
    } catch (e) {
      showBanner('error', `Impossible de lire la configuration : ${e.message}. Lancez la page avec « python scripts/config_editor.py ».`);
      return;
    }
    S.source = data;
    S.hash = hashString(data.files.keymap + '\0' + data.files.layers + '\0' + data.files.colors);
    S.keymap = C.parseKeymap(data.files.keymap);
    S.parsedLayers = C.parseLayers(data.files.layers);
    S.parsedColors = C.parseColors(data.files.colors);

    S.layers = S.parsedLayers.layers.map((l) => ({ ...l, bindings: l.bindings.slice() }));
    S.origLayers = S.parsedLayers.layers.map((l) => ({ bindings: l.bindings.slice(), sensor: l.sensor }));

    // Nom du #define de chaque layer (BASE, SETTINGS...) d'après sofle.keymap
    S.layerDefineNames = S.layers.map((l, i) => {
      const hit = Object.entries(S.keymap.defines).find(([, v]) => String(v).trim() === String(i));
      return hit ? hit[0] : null;
    });

    S.colors = S.layers.map(() => null);
    S.parsedColors.nodes.forEach((n) => {
      const li = C.layerIndex(n.layerExpr, S.keymap.defines);
      if (li !== null && li < S.colors.length) S.colors[li] = n.colors.slice();
    });
    S.origColors = S.colors.map((c) => (c ? c.slice() : null));
    S.extraDefines = [];

    S.labeler = C.makeLabeler(data.labels, layerNames(), S.keymap.behaviors, K.FALLBACK_LABELS);
    const firstHex = Object.keys(S.parsedColors.defines).find((n) => {
      const c = C.resolveColor(n, S.parsedColors.defines);
      return c && c.hex && c.hex !== '#000000';
    });
    S.brush = firstHex || '___';

    $('source-info').textContent =
      `Fichiers lus : ${data.paths.keymap}, ${data.paths.layers}, ${data.paths.colors} — ${S.layers.length} layers`;

    hideBanner();
    if (discardDraft) clearDraft();
    else restoreDraftIfAny();

    // Paramètres d'URL facultatifs : ?layer=2&mode=colors&sel=5
    const q = new URLSearchParams(location.search);
    if (q.has('layer')) S.current = Math.min(S.layers.length - 1, Math.max(0, parseInt(q.get('layer'), 10) || 0));
    if (['keys', 'colors', 'render'].includes(q.get('mode'))) S.mode = q.get('mode');
    if (q.has('sel')) S.selected = Math.min(C.NUM_KEYS - 1, Math.max(0, parseInt(q.get('sel'), 10) || 0));
    if (S.mode === 'render') S.renderLayers.add(S.current);

    renderAll();
    if (q.has('export')) renderExport();
    if (q.has('selftest')) runSelfTest();
  }

  // ---------------------------------------------------------------------
  // Brouillon (navigateur)
  // ---------------------------------------------------------------------
  let draftTimer = null;
  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      try {
        if (!isModified()) { localStorage.removeItem(DRAFT_KEY); return; }
        localStorage.setItem(DRAFT_KEY, JSON.stringify({
          hash: S.hash,
          savedAt: new Date().toISOString(),
          layers: S.layers.map((l) => ({ bindings: l.bindings, sensor: l.sensor })),
          colors: S.colors,
          extraDefines: S.extraDefines,
        }));
      } catch (e) { /* stockage indisponible : pas de brouillon */ }
    }, 300);
  }
  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ } }

  function applyDraft(d) {
    d.layers.forEach((l, i) => {
      if (!S.layers[i] || !Array.isArray(l.bindings)) return;
      S.layers[i].bindings = l.bindings.slice();
      S.layers[i].sensor = l.sensor;
    });
    (d.colors || []).forEach((c, i) => { if (i < S.colors.length) S.colors[i] = c ? c.slice() : null; });
    S.extraDefines = d.extraDefines || [];
  }

  function restoreDraftIfAny() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { d = null; }
    if (!d || !Array.isArray(d.layers)) return;
    const when = new Date(d.savedAt).toLocaleString('fr-FR');
    if (d.hash === S.hash) {
      applyDraft(d);
      showBanner('info', `Brouillon du ${when} restauré (modifications non exportées).`,
        h('button', { type: 'button', onclick: () => load(true) }, 'Abandonner le brouillon'));
    } else {
      showBanner('warn', `Un brouillon du ${when} existe, mais les fichiers ont changé depuis.`,
        h('button', { type: 'button', onclick: () => { applyDraft(d); hideBanner(); renderAll(); saveDraft(); } }, 'Le restaurer quand même'),
        h('button', { type: 'button', onclick: () => { clearDraft(); hideBanner(); } }, 'Le supprimer'));
    }
  }

  function showBanner(kind, text, ...actions) {
    const b = $('banner');
    b.className = 'banner ' + (kind === 'info' ? 'info' : kind === 'error' ? 'error' : '');
    b.replaceChildren(h('span', {}, text), ...actions);
    b.hidden = false;
  }
  function hideBanner() { $('banner').hidden = true; }

  // ---------------------------------------------------------------------
  // Modifications
  // ---------------------------------------------------------------------
  const isKeyModified = (li, pos) => C.normBinding(S.layers[li].bindings[pos]) !== C.normBinding(S.origLayers[li].bindings[pos]);
  const isColorModified = (li, pos) => (S.colors[li] ? S.colors[li][pos] : null) !== (S.origColors[li] ? S.origColors[li][pos] : null);

  function layerChangeCount(li) {
    let n = 0;
    for (let p = 0; p < C.NUM_KEYS; p++) {
      if (isKeyModified(li, p)) n++;
      else if (isColorModified(li, p)) n++;
    }
    if (C.normBinding(S.layers[li].sensor) !== C.normBinding(S.origLayers[li].sensor)) n++;
    return n;
  }
  const isModified = () => S.layers.some((_, li) => layerChangeCount(li) > 0) || S.extraDefines.length > 0;

  function changed() {
    S.exportStale = true;
    $('export-status').textContent = 'Code à régénérer (modifications depuis le dernier export).';
    saveDraft();
    renderTabs();
    renderBoard();
    renderIssues();
  }

  function setBinding(li, pos, binding) {
    S.layers[li].bindings[pos] = C.normBinding(binding);
    changed();
    renderPreview();
  }

  function paint(pos) {
    if (C.ENCODER_POSITIONS.includes(pos)) return;
    const li = S.current;
    if (!S.colors[li]) S.colors[li] = Array(C.NUM_KEYS).fill('___');
    if (S.colors[li][pos] === S.brush) return;
    S.colors[li][pos] = S.brush;
    changed();
  }

  // ---------------------------------------------------------------------
  // Géométrie du Sofle (en unités de touche)
  // ---------------------------------------------------------------------
  const GEO = (function () {
    const total = 15;
    const stagger = [0.45, 0.45, 0.2, 0, 0.2, 0.32];
    const left = {};
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 6; c++) {
        const pos = r < 3 ? r * 12 + c : 36 + c;
        left[pos] = { x: c, y: r + stagger[c], rot: 0 };
      }
    }
    left[42] = { x: 6.3, y: 2.55, rot: 0, enc: true };
    const thumbs = [[1.5, 4.6, 0], [2.5, 4.45, 0], [3.5, 4.25, 0], [4.55, 4.45, 0], [5.75, 4.8, 25]];
    thumbs.forEach(([x, y, rot], i) => { left[50 + i] = { x, y, rot }; });

    const geo = {};
    const mirror = (g) => ({ x: total - 1 - g.x, y: g.y, rot: -g.rot, enc: g.enc });
    for (const [p, g] of Object.entries(left)) geo[p] = g;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) geo[r * 12 + 6 + (5 - c)] = mirror(left[r * 12 + c]);
    for (let c = 0; c < 6; c++) geo[44 + (5 - c)] = mirror(left[36 + c]);
    geo[43] = mirror(left[42]);
    for (let i = 0; i < 5; i++) geo[55 + i] = mirror(left[54 - i]);
    return { geo, width: total, height: 6 };
  })();

  // ---------------------------------------------------------------------
  // Rendu du clavier
  // ---------------------------------------------------------------------
  function unitSize() {
    const wrap = document.querySelector('.board-wrap');
    const avail = (wrap ? wrap.clientWidth : 900) - 30;
    return Math.max(40, Math.min(60, Math.floor(avail / GEO.width)));
  }

  function keyContent(lab, opts) {
    const el = opts.el;
    const type = lab.type || '';
    el.classList.toggle('trans', type === 'trans');
    el.classList.toggle('danger', type === 'danger');
    el.classList.toggle('layer', type === 'layer');
    const len = String(lab.t || '').length;
    el.classList.toggle('small-t', len > 6 && len <= 9);
    el.classList.toggle('tiny-t', len > 9);
    el.append(
      h('span', { class: 's' }, lab.s || ''),
      h('span', { class: 't' }, lab.t || ''),
      h('span', { class: 'h' }, lab.h || ''),
    );
  }

  function colorForCell(li, pos) {
    const tok = S.colors[li] ? S.colors[li][pos] : '___';
    return { tok, res: C.resolveColor(tok, colorDefines()) };
  }

  function applyBg(el, res) {
    if (!res) { el.classList.add('bg-unknown'); return; }
    if (res.trans) { el.classList.add('bg-trans'); return; }
    el.style.background = res.hex;
    el.style.color = textColorFor(res.hex);
    el.classList.add('colored');
  }

  function renderBoard() {
    const u = unitSize();
    const board = $('board');
    board.style.setProperty('--u', u + 'px');
    board.style.width = GEO.width * u + 'px';
    board.style.height = GEO.height * u + 'px';
    board.replaceChildren();
    const li = S.current;
    const active = new Set([...S.renderLayers, 0]);

    for (let pos = 0; pos < C.NUM_KEYS; pos++) {
      const g = GEO.geo[pos];
      const el = h('div', {
        class: 'key' + (g.enc ? ' enc' : '') + (S.selected === pos && S.mode === 'keys' ? ' sel' : ''),
        'data-pos': pos,
        title: '',
        style: { left: g.x * u + 2 + 'px', top: g.y * u + 2 + 'px', transform: g.rot ? `rotate(${g.rot}deg)` : '' },
      });

      let binding;
      let fromLayer = li;
      if (S.mode === 'render') {
        const eb = C.effectiveBinding(pos, active, S.layers);
        binding = eb.binding;
        fromLayer = eb.layer;
      } else {
        binding = S.layers[li].bindings[pos];
      }
      keyContent(S.labeler.label(binding), { el });

      if (S.mode === 'render') {
        if (!g.enc) {
          const hex = C.effectiveColor(pos, active, S.colors, colorDefines());
          applyBg(el, { hex });
        }
        el.title = `${binding}  (layer ${layerNames()[fromLayer]})`;
      } else {
        const { tok, res } = colorForCell(li, pos);
        if (!g.enc && (S.mode === 'colors' || S.showBg)) applyBg(el, res);
        el.title = `Position ${pos}\n${binding}` + (g.enc ? '\n(clic d\'encodeur : pas de LED)' : `\nCouleur : ${tok}`);
        if (isKeyModified(li, pos) || isColorModified(li, pos)) el.append(h('span', { class: 'mod-dot', title: 'Modifié' }));
      }
      board.append(el);
    }

    const legends = {
      keys: 'Cliquez sur une touche pour la modifier. ▽ = transparent (layer du dessous), case vide = aucune action. Le fond montre la couleur de ce layer (rayé = transparent).',
      colors: 'Choisissez une couleur dans la palette, puis cliquez ou glissez sur les touches. Rayé = transparent (couleur du layer du dessous).',
      render: 'Ce que donne réellement le clavier avec les layers cochés actifs : touches et couleurs, transparences comprises.',
    };
    $('legend').textContent = legends[S.mode];
    renderSensors();
  }

  // Peinture à la souris / au doigt
  let painting = false;
  function posFromEvent(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const key = el && el.closest('.key[data-pos]');
    return key && key.parentElement === $('board') ? parseInt(key.dataset.pos, 10) : null;
  }
  function onBoardDown(e) {
    const pos = posFromEvent(e);
    if (pos === null) return;
    if (S.mode === 'colors') {
      painting = true;
      paint(pos);
      e.preventDefault();
    } else if (S.mode === 'keys') {
      S.selected = pos;
      renderBoard();
      renderPanel();
    }
  }
  function onBoardMove(e) {
    if (!painting) return;
    const pos = posFromEvent(e);
    if (pos !== null) paint(pos);
  }

  // ---------------------------------------------------------------------
  // Onglets et modes
  // ---------------------------------------------------------------------
  function renderTabs() {
    const tabs = $('layer-tabs');
    tabs.replaceChildren(...S.layers.map((l, i) => {
      const n = layerChangeCount(i);
      return h('button', {
        type: 'button', role: 'tab', class: i === S.current ? 'on' : '',
        'aria-selected': i === S.current ? 'true' : 'false',
        title: `Layer ${i} (${l.node})`,
        onclick: () => { S.current = i; S.renderLayers.add(i); renderAll(); },
      }, `${i} · ${layerNames()[i]}`, n ? h('span', { class: 'badge', title: `${n} modification(s)` }, n) : null);
    }));
    document.querySelectorAll('#mode-switch button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.mode));
    $('bg-toggle-wrap').hidden = S.mode !== 'keys';
  }

  // ---------------------------------------------------------------------
  // Encodeurs (sensor-bindings)
  // ---------------------------------------------------------------------
  function sensorPreview(text) {
    const parts = [];
    const re = /&(\w+)\s+(\S+)\s+(\S+)/g;
    let m;
    while ((m = re.exec(text || ''))) parts.push([m[2], m[3]]);
    const side = ['Molette gauche', 'Molette droite'];
    return parts.map(([cw, ccw], i) => {
      const a = S.labeler.keyLabel(cw).t;
      const b = S.labeler.keyLabel(ccw).t;
      return `${side[i] || 'Molette ' + (i + 1)} : ↻ ${a} / ↺ ${b}`;
    }).join('   •   ');
  }

  function renderSensors() {
    const box = $('sensors');
    const l = S.layers[S.current];
    if (S.mode === 'render') { box.replaceChildren(); return; }
    const preview = h('div', { class: 'preview' }, sensorPreview(l.sensor));
    const input = h('input', {
      type: 'text', value: l.sensor || '', spellcheck: 'false',
      'aria-label': 'sensor-bindings',
      onchange: (e) => {
        l.sensor = C.normBinding(e.target.value) || null;
        preview.textContent = sensorPreview(l.sensor);
        changed();
      },
    });
    box.replaceChildren(
      h('label', {}, `Molettes du layer ${layerNames()[S.current]} (sensor-bindings, code ZMK) :`),
      input, preview,
    );
  }

  // ---------------------------------------------------------------------
  // Panneau latéral
  // ---------------------------------------------------------------------
  function renderPanel() {
    const p = $('panel');
    const parts = S.mode === 'colors' ? colorsPanel() : S.mode === 'render' ? renderModePanel() : keysPanel();
    p.replaceChildren(...parts.filter((x) => x !== null && x !== undefined && x !== false));
  }

  // ---- Mode Rendu ------------------------------------------------------
  function renderModePanel() {
    const names = layerNames();
    return [
      h('h3', {}, 'Layers actifs'),
      h('p', { class: 'hint' }, 'Cochez les layers actifs en même temps (comme en maintenant les touches de layer). Le plus haut l\'emporte, sauf là où il est transparent.'),
      h('div', { class: 'layers-check' }, ...S.layers.map((_, i) => h('label', { class: 'check' },
        h('input', {
          type: 'checkbox', checked: i === 0 || S.renderLayers.has(i), disabled: i === 0,
          onchange: (e) => { if (e.target.checked) S.renderLayers.add(i); else S.renderLayers.delete(i); renderBoard(); },
        }),
        `${i} · ${names[i]}`, i === 0 ? h('span', { class: 'muted' }, ' (toujours actif)') : null))),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => { S.renderLayers = new Set([0]); renderPanel(); renderBoard(); } }, 'BASE seul'),
        h('button', { type: 'button', onclick: () => { S.renderLayers = new Set([0, S.current]); renderPanel(); renderBoard(); } }, `BASE + ${names[S.current]}`)),
    ];
  }

  // ---- Mode Couleurs ---------------------------------------------------
  function paletteEntries() {
    const defs = colorDefines();
    const out = [];
    for (const name of Object.keys(defs)) {
      const res = C.resolveColor(name, defs);
      if (res) out.push({ name, res });
    }
    if (!out.some((e) => e.res.trans)) out.unshift({ name: C.TRANS, res: { trans: true } });
    return out;
  }

  function colorsPanel() {
    const li = S.current;
    const defs = colorDefines();
    const entries = paletteEntries();
    const swatch = (e) => h('button', {
      type: 'button', class: 'swatch' + (S.brush === e.name ? ' on' : ''),
      title: e.res.trans ? 'Transparent : couleur du layer du dessous' : e.res.hex,
      onclick: () => { S.brush = e.name; renderPanel(); },
    },
    h('span', { class: 'chip' + (e.res.trans ? ' bg-trans' : ''), style: e.res.trans ? {} : { background: e.res.hex } }),
    h('span', {}, h('span', { class: 'nm' }, e.name),
      h('span', { class: 'hx' }, e.res.trans ? 'transparent' : e.res.hex === '#000000' ? 'éteint' : e.res.hex)));

    const nameIn = h('input', { type: 'text', placeholder: 'Nom (ex. ROSE)', maxlength: 16, style: { textTransform: 'uppercase' } });
    const colorIn = h('input', { type: 'color', value: '#ff66cc' });
    const err = h('div', { class: 'hint' });
    const add = () => {
      const name = nameIn.value.trim().toUpperCase();
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) { err.textContent = 'Nom invalide : lettres, chiffres et _ uniquement, sans commencer par un chiffre.'; return; }
      if (defs[name] !== undefined || S.keymap.defines[name] !== undefined) { err.textContent = `« ${name} » existe déjà.`; return; }
      S.extraDefines.push({ name, value: '0x' + colorIn.value.slice(1).toUpperCase() });
      S.brush = name;
      changed();
      renderPanel();
    };

    const brushRes = C.resolveColor(S.brush, defs);
    return [
      h('h3', {}, `Couleurs — ${layerNames()[li]}`),
      h('p', { class: 'hint' }, S.colors[li] ? 'Cliquez ou glissez sur les touches pour appliquer la couleur choisie.'
        : 'Ce layer n\'a pas encore de couleurs (tout est transparent). Peindre une touche les crée.'),
      h('h4', {}, 'Palette'),
      h('div', { class: 'palette' }, ...entries.map(swatch)),
      h('p', { class: 'hint' }, 'OFF = LED éteinte. Transparent (', h('code', {}, '___'), ' / RGB_TRANS) = couleur du layer en dessous.'),
      h('h4', {}, 'Nouvelle couleur'),
      h('div', { class: 'row' }, colorIn, nameIn, h('button', { type: 'button', onclick: add }, 'Ajouter')),
      err,
      S.extraDefines.length ? h('p', { class: 'hint' }, 'Ajoutées : ', S.extraDefines.map((d) => `${d.name} = ${d.value}`).join(', '),
        ' — exportées en #define dans sofle_colors.dtsi.') : null,
      h('h4', {}, 'Tout le layer'),
      h('div', { class: 'row' },
        h('button', {
          type: 'button',
          onclick: () => {
            S.colors[li] = Array(C.NUM_KEYS).fill(S.brush);
            C.ENCODER_POSITIONS.forEach((p) => { S.colors[li][p] = '___'; });
            changed();
          },
        }, `Remplir avec ${brushRes && brushRes.trans ? 'transparent' : S.brush}`),
        h('button', {
          type: 'button',
          onclick: () => { S.colors[li] = S.origColors[li] ? S.origColors[li].slice() : null; changed(); },
        }, 'Annuler les changements du layer')),
    ];
  }

  // ---- Mode Touches ----------------------------------------------------
  const LAYER_BEHAVIORS = { mo: 'Layer maintenu (&mo)', tog: 'Bascule de layer (&tog)', to: 'Aller au layer (&to)', sl: 'Layer one-shot (&sl)' };

  function bindingTypes() {
    const types = [
      ['kp', 'Touche (&kp)'],
      ...Object.entries(LAYER_BEHAVIORS),
      ['lt', 'Layer-tap : maintien = layer, tap = touche (&lt)'],
      ['mt', 'Mod-tap : maintien = modificateur, tap = touche (&mt)'],
    ];
    for (const b of Object.values(S.keymap.behaviors)) {
      let desc = b.compatible.replace(/^zmk,behavior-/, '');
      if (/hold-tap/.test(b.compatible) && b.bindings.length >= 2) {
        desc = `maintien = ${b.bindings[0]}, tap = ${b.bindings[1]}`;
      } else if (/tap-dance/.test(b.compatible)) {
        desc = 'tap-dance : ' + b.bindings.map((x) => S.labeler.label(x).t).join(' / ');
      } else if (/macro/.test(b.compatible)) {
        desc = 'macro';
      }
      types.push(['custom:' + b.name, `Perso : &${b.name} (${desc})`]);
    }
    types.push(
      ['bt', 'Bluetooth (&bt)'],
      ['rgb_ug', 'Éclairage RGB (&rgb_ug)'],
      ['ext_power', 'Alimentation externe (&ext_power)'],
      ['bootloader', 'Bootloader (&bootloader)'],
      ['sys_reset', 'Reset (&sys_reset)'],
      ['trans', 'Transparent (&trans)'],
      ['none', 'Aucune action (&none)'],
      ['raw', 'Code brut (avancé)'],
    );
    return types;
  }

  function detectType(binding) {
    const b = C.normBinding(binding);
    const [beh] = b.split(' ');
    const name = beh.replace(/^&/, '');
    if (['kp', 'mo', 'tog', 'to', 'sl', 'lt', 'mt', 'bt', 'rgb_ug', 'ext_power', 'bootloader', 'sys_reset', 'trans', 'none'].includes(name)) return name;
    if (S.keymap.behaviors[name]) return 'custom:' + name;
    return 'raw';
  }

  function defaultBinding(type) {
    switch (type) {
      case 'kp': return '&kp A';
      case 'mo': case 'tog': case 'to': case 'sl': return `&${type} ${Math.min(1, S.layers.length - 1)}`;
      case 'lt': return '&lt 1 A';
      case 'mt': return '&mt LSHIFT A';
      case 'bt': return '&bt BT_SEL 0';
      case 'rgb_ug': return '&rgb_ug RGB_TOG';
      case 'ext_power': return '&ext_power EP_TOG';
      case 'bootloader': case 'sys_reset': case 'trans': case 'none': return '&' + type;
      default: break;
    }
    if (type.startsWith('custom:')) {
      const b = S.keymap.behaviors[type.slice(7)];
      const params = [];
      for (let i = 0; i < b.cells; i++) {
        const sub = (b.bindings[i] || '').trim();
        params.push(sub === '&mo' ? '1' : sub === '&kp' ? 'A' : '0');
      }
      return ['&' + b.name, ...params].join(' ');
    }
    return null;
  }

  function layerSelect(value, onChange) {
    const names = layerNames();
    return h('select', { onchange: (e) => onChange(e.target.value) },
      ...S.layers.map((_, i) => h('option', { value: String(i), selected: String(value) === String(i) ? 'selected' : null }, `${i} · ${names[i]}`)),
      /^\d+$/.test(String(value)) && parseInt(value, 10) < S.layers.length ? null
        : h('option', { value: String(value), selected: 'selected' }, `${value} (inconnu)`));
  }

  function simpleSelect(options, value, onChange) {
    return h('select', { onchange: (e) => onChange(e.target.value) },
      ...options.map(([v, label]) => h('option', { value: v, selected: v === value ? 'selected' : null }, label)),
      options.some(([v]) => v === value) ? null : h('option', { value, selected: 'selected' }, value));
  }

  let allCodesCache = null;
  function allCodes() {
    if (allCodesCache) return allCodesCache;
    const seen = new Set();
    const list = [];
    K.KEYCODES.forEach((g) => g.codes.forEach((code) => { seen.add(code); list.push({ code, cat: g.cat }); }));
    Object.keys((S.source.labels || {}).zmk_keycode_map || {}).forEach((code) => {
      if (!seen.has(code)) { seen.add(code); list.push({ code, cat: 'Autres (alias)' }); }
    });
    allCodesCache = list;
    return list;
  }

  /** Sélecteur de keycode : recherche par code ou par caractère AZERTY. */
  function keyPicker(param, onChange, withMods) {
    const { mods, key } = C.splitMods(param);
    const state = { mods: mods.slice(), key };
    const emit = () => onChange(withMods ? C.joinMods(state.mods, state.key) : state.key);

    const cats = ['Toutes', ...K.KEYCODES.map((g) => g.cat), 'Autres (alias)'];
    const catSel = h('select', { 'aria-label': 'Catégorie' }, ...cats.map((c) => h('option', { value: c }, c)));
    const search = h('input', { type: 'text', placeholder: 'Rechercher : é, A, Suppr, F5…', spellcheck: 'false' });
    const results = h('div', { class: 'results' });

    const fill = () => {
      const q = search.value.trim().toLowerCase();
      const cat = catSel.value;
      const items = allCodes()
        .filter((c) => cat === 'Toutes' || c.cat === cat)
        .map((c) => ({ ...c, lab: S.labeler.keyLabel(c.code) }))
        .filter((c) => !q || c.code.toLowerCase().includes(q)
          || String(c.lab.t || '').toLowerCase().includes(q) || String(c.lab.s || '').toLowerCase().includes(q))
        .sort((a, b) => {
          if (!q) return 0;
          const ea = String(a.lab.t).toLowerCase() === q || String(a.lab.s).toLowerCase() === q || a.code.toLowerCase() === q;
          const eb = String(b.lab.t).toLowerCase() === q || String(b.lab.s).toLowerCase() === q || b.code.toLowerCase() === q;
          return (eb ? 1 : 0) - (ea ? 1 : 0);
        })
        .slice(0, 150);
      results.replaceChildren(...items.map((c) => h('button', {
        type: 'button', class: c.code === state.key ? 'on' : '', title: c.code,
        onclick: () => { state.key = c.code; emit(); fill(); },
      }, h('span', { class: 'lt' }, c.lab.t || c.code), c.lab.s ? h('span', { class: 'lc' }, c.lab.s) : null, h('span', { class: 'lc' }, c.code))));
      if (!items.length) results.append(h('span', { class: 'hint' }, 'Aucun résultat — utilisez le code brut.'));
    };
    search.addEventListener('input', fill);
    catSel.addEventListener('change', fill);
    fill();

    const modsBox = withMods ? h('div', { class: 'mods' }, ...K.MODIFIERS.map(([fn, label]) => h('label', { class: 'check' },
      h('input', {
        type: 'checkbox', checked: state.mods.includes(fn),
        onchange: (e) => {
          state.mods = e.target.checked ? [...state.mods, fn] : state.mods.filter((m) => m !== fn);
          emit();
        },
      }), label))) : null;

    return h('div', { class: 'picker' },
      h('div', { class: 'row' }, h('label', {}, 'Touche'), h('span', { class: 'current' }, state.key)),
      modsBox ? h('div', {}, h('span', { class: 'hint' }, 'Modificateurs ajoutés :'), modsBox) : null,
      h('div', { class: 'row' }, catSel, search),
      results);
  }

  function paramEditors(type, binding, update, getCurrent) {
    // Toujours repartir du binding actuel (plusieurs paramètres modifiés à la suite)
    const cur = () => C.normBinding(getCurrent()).split(' ');
    const p = C.normBinding(binding).split(' ').slice(1);
    const set = (arr) => update([cur()[0], ...arr].join(' '));
    const row = (label, el) => h('div', { class: 'row' }, h('label', {}, label), el);

    if (type === 'kp') return [keyPicker(p.join(' '), (v) => set([v]), true)];
    if (LAYER_BEHAVIORS[type]) return [row('Layer', layerSelect(p[0], (v) => set([v])))];
    if (type === 'lt') {
      return [row('Maintien', layerSelect(p[0], (v) => set([v, ...cur().slice(2)]))),
        keyPicker(p.slice(1).join(' '), (v) => set([cur()[1], v]), true)];
    }
    if (type === 'mt') {
      return [row('Maintien', simpleSelect(K.HOLD_MODS.map((m) => [m, S.labeler.keyLabel(m).t + ' (' + m + ')']), p[0], (v) => set([v, ...cur().slice(2)]))),
        keyPicker(p.slice(1).join(' '), (v) => set([cur()[1], v]), true)];
    }
    if (type === 'bt') {
      const action = K.BT_ACTIONS.find(([a]) => a === p[0]);
      const needsN = action ? action[2] : p.length > 1;
      return [row('Action', simpleSelect(K.BT_ACTIONS.map(([a, l]) => [a, l]), p[0], (v) => {
        const a = K.BT_ACTIONS.find(([x]) => x === v);
        set(a && a[2] ? [v, cur()[2] || '0'] : [v]);
        renderPanel();
      })),
      needsN ? row('Profil', h('input', { type: 'number', min: 0, max: 4, value: p[1] || '0', onchange: (e) => set([cur()[1], String(e.target.value)]) })) : null];
    }
    if (type === 'rgb_ug') return [row('Action', simpleSelect(K.RGB_ACTIONS, p[0], (v) => set([v])))];
    if (type === 'ext_power') return [row('Action', simpleSelect(K.EXT_POWER_ACTIONS, p[0], (v) => set([v])))];
    if (type.startsWith('custom:')) {
      const b = S.keymap.behaviors[type.slice(7)];
      if (!b.cells) return [h('p', { class: 'hint' }, 'Behavior sans paramètre : défini dans sofle.keymap.')];
      const out = [];
      for (let i = 0; i < b.cells; i++) {
        const sub = (b.bindings[i] || '').trim();
        const val = p[i] || '';
        const setI = (v) => { const arr = cur().slice(1); arr[i] = v; set(arr); };
        const role = /hold-tap/.test(b.compatible) ? (i === 0 ? 'Maintien' : 'Tap') : `Paramètre ${i + 1}`;
        if (sub === '&mo') out.push(row(role, layerSelect(val, setI)));
        else if (sub === '&kp') out.push(h('h4', {}, role), keyPicker(val, setI, true));
        else out.push(row(role, h('input', { type: 'text', value: val, onchange: (e) => setI(e.target.value.trim()) })));
      }
      return out;
    }
    return [];
  }

  let previewBox = null;
  function renderPreview() {
    if (!previewBox || S.selected === null) return;
    const b = S.layers[S.current].bindings[S.selected];
    const el = h('div', { class: 'key', style: { '--u': '64px', width: '60px', height: '60px' } });
    keyContent(S.labeler.label(b), { el });
    previewBox.replaceChildren(el, h('code', {}, b));
    const raw = document.querySelector('#panel .raw');
    if (raw && document.activeElement !== raw) raw.value = b;
  }

  function keysPanel() {
    previewBox = null;
    if (S.selected === null) {
      return [h('h3', {}, 'Touches'), h('p', { class: 'hint' }, 'Cliquez sur une touche du clavier pour la modifier.')];
    }
    const li = S.current;
    const pos = S.selected;
    const binding = S.layers[li].bindings[pos];
    const orig = S.origLayers[li].bindings[pos];
    const type = detectType(binding);
    const isEnc = C.ENCODER_POSITIONS.includes(pos);

    const update = (b) => {
      const prevType = detectType(S.layers[li].bindings[pos]);
      setBinding(li, pos, b);
      if (detectType(b) !== prevType) renderPanel();
    };

    const typeSel = h('select', {
      onchange: (e) => {
        const t = e.target.value;
        const def = defaultBinding(t);
        if (def) setBinding(li, pos, def);
        renderPanel();
      },
    }, ...bindingTypes().map(([v, l]) => h('option', { value: v, selected: v === type ? 'selected' : null }, l)));

    const raw = h('input', {
      type: 'text', class: 'raw', value: binding, spellcheck: 'false', 'aria-label': 'Code brut',
      onchange: (e) => { update(e.target.value); },
    });

    previewBox = h('div', { class: 'preview-key' });
    const out = [
      h('h3', {}, `Position ${pos} — ${layerNames()[li]}`),
      isEnc ? h('p', { class: 'hint' }, 'Clic d\'encodeur (pas de LED).') : null,
      isKeyModified(li, pos) ? h('div', { class: 'row' },
        h('span', { class: 'orig' }, 'Original : ' + orig),
        h('button', { type: 'button', onclick: () => { setBinding(li, pos, orig); renderPanel(); } }, 'Revenir à l\'original')) : null,
      previewBox,
      h('h4', {}, 'Type d\'action'),
      typeSel,
      ...paramEditors(type, binding, update, () => S.layers[li].bindings[pos]),
      h('h4', {}, 'Code ZMK'),
      raw,
      h('p', { class: 'hint' }, 'Modifiable directement (Entrée ou sortie du champ pour valider).'),
    ];
    setTimeout(renderPreview, 0);
    return out;
  }

  // ---------------------------------------------------------------------
  // Contrôles
  // ---------------------------------------------------------------------
  const KNOWN = new Set(['kp', 'mo', 'tog', 'to', 'sl', 'lt', 'mt', 'bt', 'rgb_ug', 'ext_power', 'bootloader',
    'sys_reset', 'trans', 'none', 'out', 'key_repeat', 'caps_word', 'sk', 'mkp', 'msc', 'mmv', 'soft_off', 'studio_unlock', 'gresc', 'kt']);

  function collectIssues() {
    const issues = [];
    const names = layerNames();
    const defs = colorDefines();
    S.layers.forEach((l, li) => {
      if (l.bindings.length !== C.NUM_KEYS) issues.push(`Layer ${names[li]} : ${l.bindings.length} bindings au lieu de ${C.NUM_KEYS}.`);
      l.bindings.forEach((b, pos) => {
        const name = b.split(' ')[0].replace(/^&/, '');
        if (!b.startsWith('&')) issues.push(`Layer ${names[li]}, position ${pos} : « ${b} » ne commence pas par &.`);
        else if (!KNOWN.has(name) && !S.keymap.behaviors[name]) issues.push(`Layer ${names[li]}, position ${pos} : behavior inconnu « &${name} ».`);
      });
      const cols = S.colors[li];
      if (cols) {
        if (cols.length !== C.NUM_KEYS) issues.push(`Couleurs du layer ${names[li]} : ${cols.length} valeurs au lieu de ${C.NUM_KEYS}.`);
        cols.forEach((t, pos) => {
          if (!C.resolveColor(t, defs)) issues.push(`Couleurs du layer ${names[li]}, position ${pos} : couleur inconnue « ${t} ».`);
        });
      }
    });
    return issues;
  }

  function renderIssues() {
    const issues = collectIssues();
    const box = $('issues');
    box.hidden = !issues.length;
    box.replaceChildren(h('h2', {}, `À vérifier (${issues.length})`),
      h('ul', {}, ...issues.slice(0, 50).map((i) => h('li', {}, i))),
      issues.length > 50 ? h('p', {}, `… et ${issues.length - 50} autres.`) : null);
  }

  // ---------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------
  function buildExports() {
    const layersText = C.exportLayers(S.parsedLayers, S.layers);
    const colorsText = C.exportColors(S.parsedColors, S.colors, S.extraDefines, S.layerDefineNames, S.keymap.defines);
    return [
      { path: S.source.paths.layers, text: layersText },
      { path: S.source.paths.colors, text: colorsText },
    ];
  }

  function renderExport() {
    const files = buildExports();
    const grid = $('export-grid');
    grid.replaceChildren(...files.map((f) => {
      const ta = h('textarea', { readonly: true, spellcheck: 'false', 'aria-label': f.path }, f.text);
      const status = h('span', { class: 'muted' });
      const fileName = f.path.split('/').pop();
      return h('div', { class: 'export-card' },
        h('header', {},
          h('code', {}, f.path),
          h('span', {},
            h('button', {
              type: 'button',
              onclick: async () => {
                try { await navigator.clipboard.writeText(f.text); status.textContent = ' Copié.'; } catch (e) {
                  ta.select(); document.execCommand('copy'); status.textContent = ' Copié.';
                }
              },
            }, 'Copier'), ' ',
            h('button', {
              type: 'button',
              onclick: () => {
                const blob = new Blob([f.text.replace(/\r?\n/g, '\r\n')], { type: 'text/plain;charset=utf-8' });
                const a = h('a', { href: URL.createObjectURL(blob), download: fileName });
                document.body.append(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(a.href), 1000);
              },
            }, 'Télécharger'),
            status)),
        ta);
    }));
    S.exportStale = false;
    const n = S.layers.reduce((acc, _, li) => acc + layerChangeCount(li), 0);
    $('export-status').textContent = n || S.extraDefines.length
      ? `${n} modification(s) incluse(s). Remplacez le contenu des fichiers par ce code, puis committez.`
      : 'Aucune modification : le code correspond aux fichiers actuels (mise en forme près).';
  }

  // ---------------------------------------------------------------------
  // Auto-test (?selftest=1)
  // ---------------------------------------------------------------------
  function runSelfTest() {
    const out = [];
    const ok = (cond, msg) => out.push((cond ? 'OK   ' : 'FAIL ') + msg);
    const norm = (t) => C.maskComments(t.replace(/\r\n/g, '\n')).replace(/\s+/g, ' ').trim();
    try {
      const L = S.parsedLayers;
      const expL = C.exportLayers(L, L.layers);
      const reL = C.parseLayers(expL);
      ok(reL.layers.length === L.layers.length, `layers relus : ${reL.layers.length}`);
      ok(reL.layers.every((l, i) => l.bindings.join('|') === L.layers[i].bindings.join('|') && l.sensor === L.layers[i].sensor), 'bindings et encodeurs identiques après export/relecture');
      ok(norm(expL) === norm(S.source.files.layers), 'export layers = fichier (hors espaces et commentaires)');
      ok(L.layers.every((l) => l.bindings.length === 60), 'chaque layer a 60 bindings');

      const Cp = S.parsedColors;
      const expC = C.exportColors(Cp, S.origColors, [], S.layerDefineNames, S.keymap.defines);
      const reC = C.parseColors(expC);
      ok(reC.nodes.length === Cp.nodes.length && reC.nodes.every((n, i) => n.colors.join('|') === Cp.nodes[i].colors.join('|')), 'couleurs identiques après export/relecture');
      ok(norm(expC) === norm(S.source.files.colors), 'export couleurs = fichier (hors espaces et commentaires)');

      const lab = S.labeler.label;
      ok(lab('&kp Q').t === 'A', `&kp Q -> ${lab('&kp Q').t}`);
      const td = lab('&TD 1 N5');
      ok(td.t === '(' && td.h === layerNames()[1], `&TD 1 N5 -> t=${td.t} h=${td.h}`);
      ok(lab('&kp LC(V)').t === 'Coller', `&kp LC(V) -> ${lab('&kp LC(V)').t}`);
      ok(lab('&kp LS(Q)').t === 'Maj+A', `&kp LS(Q) -> ${lab('&kp LS(Q)').t}`);
      ok(lab('&mo 3').t === layerNames()[3], `&mo 3 -> ${lab('&mo 3').t}`);
      ok(lab('&TTH__LGUI_SYMBL').t === 'Win', `&TTH__LGUI_SYMBL -> ${lab('&TTH__LGUI_SYMBL').t}`);

      const defs = colorDefines();
      const base1 = C.resolveColor(S.origColors[0][1], defs);
      ok(C.effectiveColor(1, new Set([0]), S.origColors, defs) === base1.hex, `couleur BASE pos 1 = ${base1.hex}`);
      ok(C.effectiveColor(12, new Set([0, 2]), S.origColors, defs) === C.effectiveColor(12, new Set([0]), S.origColors, defs), 'transparent SYMBOLS pos 12 -> couleur BASE');
      ok(collectIssues().length === 0, `contrôles : ${collectIssues().length} problème(s) ${collectIssues().slice(0, 3).join(' ; ')}`);

      // Export avec une modification
      const saved = S.layers[0].bindings[1];
      S.layers[0].bindings[1] = '&kp LC(RA(N5))';
      const reMod = C.parseLayers(C.exportLayers(L, S.layers));
      ok(reMod.layers[0].bindings[1] === '&kp LC(RA(N5))', 'modification présente dans l\'export');
      S.layers[0].bindings[1] = saved;

      // Peinture + nouvelle couleur
      const savedColors = S.colors.map((c) => (c ? c.slice() : null));
      const savedCur = S.current;
      S.current = 0; S.brush = 'RED'; paint(0);
      S.extraDefines.push({ name: 'ROSE', value: '0xFF66CC' });
      S.current = 5; S.brush = 'ROSE'; paint(3);
      const expMod = C.exportColors(Cp, S.colors, S.extraDefines, S.layerDefineNames, S.keymap.defines);
      const reMod2 = C.parseColors(expMod);
      ok(reMod2.nodes[0].colors[0] === 'RED', 'peinture BASE pos 0 = RED dans l\'export');
      ok(/#define ROSE 0xFF66CC/.test(expMod), 'nouvelle couleur exportée en #define');
      const extras = reMod2.nodes.find((n) => C.layerIndex(n.layerExpr, S.keymap.defines) === 5);
      ok(extras && extras.colors[3] === 'ROSE' && C.resolveColor('ROSE', reMod2.defines).hex === '#FF66CC', 'EXTRAS pos 3 = ROSE (#FF66CC)');
      S.colors = savedColors; S.extraDefines = []; S.current = savedCur;
      clearTimeout(draftTimer); clearDraft(); renderAll();
    } catch (e) {
      out.push('FAIL exception : ' + e.message + '\n' + e.stack);
    }
    const pre = $('selftest');
    pre.textContent = (out.some((l) => l.startsWith('FAIL')) ? 'SELFTEST FAIL\n' : 'SELFTEST OK\n') + out.join('\n');
    pre.hidden = false;
  }

  // ---------------------------------------------------------------------
  // Démarrage
  // ---------------------------------------------------------------------
  function renderAll() {
    if (!S.layers.length) return;
    if (S.current >= S.layers.length) S.current = 0;
    renderTabs();
    renderBoard();
    renderPanel();
    renderIssues();
    if (!S.exportStale) renderExport();
  }

  document.querySelectorAll('#mode-switch button').forEach((b) => b.addEventListener('click', () => {
    S.mode = b.dataset.mode;
    if (S.mode === 'render') S.renderLayers.add(S.current);
    renderAll();
  }));
  $('bg-toggle').addEventListener('change', (e) => { S.showBg = e.target.checked; renderBoard(); });
  $('btn-reload').addEventListener('click', () => {
    if (isModified() && !confirm('Abandonner toutes les modifications non exportées et relire les fichiers ?')) return;
    S.selected = null;
    load(true);
  });
  $('btn-export').addEventListener('click', renderExport);
  $('board').addEventListener('pointerdown', onBoardDown);
  window.addEventListener('pointermove', onBoardMove);
  window.addEventListener('pointerup', () => { painting = false; });
  window.addEventListener('resize', () => { if (S.layers.length) renderBoard(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.mode === 'keys' && S.selected !== null) { S.selected = null; renderBoard(); renderPanel(); }
  });

  load(false);
})();
