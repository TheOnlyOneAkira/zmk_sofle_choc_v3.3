/*
 * Éditeur de configuration du Sofle : logique sans interface.
 * Lecture des fichiers (keymap, layers, couleurs), libellés lisibles,
 * calcul des couleurs et génération du code à exporter.
 */
(function (root) {
  'use strict';

  const NUM_KEYS = 60;
  const ENCODER_POSITIONS = [42, 43]; // clics d'encodeur : pas de LED
  const TRANS = 'RGB_TRANS';

  // Position -> {row, col} dans la grille de texte (14 colonnes visuelles,
  // 0-6 = moitié gauche, 7-13 = moitié droite), comme dans les fichiers.
  const GRID = [];
  (function buildGrid() {
    const rows = [
      // [premier index, nombre, première colonne] pour chaque moitié
      [[0, 6, 0], [6, 6, 8]],
      [[12, 6, 0], [18, 6, 8]],
      [[24, 6, 0], [30, 6, 8]],
      [[36, 7, 0], [43, 7, 7]],
      [[50, 5, 2], [55, 5, 7]],
    ];
    rows.forEach((halves, row) => {
      halves.forEach(([start, n, col0]) => {
        for (let i = 0; i < n; i++) GRID[start + i] = { row, col: col0 + i };
      });
    });
  })();

  // ---------------------------------------------------------------------
  // Outils de lecture
  // ---------------------------------------------------------------------

  /** Remplace les commentaires par des espaces (même longueur, mêmes indices). */
  function maskComments(text) {
    let out = '';
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      const n = text[i + 1];
      if (c === '/' && n === '*') {
        const end = text.indexOf('*/', i + 2);
        const stop = end === -1 ? text.length : end + 2;
        out += text.slice(i, stop).replace(/[^\n]/g, ' ');
        i = stop;
      } else if (c === '/' && n === '/') {
        let end = text.indexOf('\n', i);
        if (end === -1) end = text.length;
        out += ' '.repeat(end - i);
        i = end;
      } else if (c === '"') {
        let j = i + 1;
        while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
        out += text.slice(i, j + 1);
        i = j + 1;
      } else {
        out += c;
        i++;
      }
    }
    return out;
  }

  /** Index de l'accolade fermante correspondant à celle ouverte en `open`. */
  function matchBrace(masked, open) {
    let depth = 0;
    for (let i = open; i < masked.length; i++) {
      if (masked[i] === '{') depth++;
      else if (masked[i] === '}' && --depth === 0) return i;
    }
    return -1;
  }

  /** Découpe en jetons (espaces), sans couper à l'intérieur des parenthèses. */
  function tokenize(text) {
    const tokens = [];
    let cur = '';
    let depth = 0;
    for (const c of text) {
      if (c === '(') depth++;
      if (c === ')') depth = Math.max(0, depth - 1);
      if (/\s/.test(c) && depth === 0) {
        if (cur) tokens.push(cur);
        cur = '';
      } else {
        cur += c;
      }
    }
    if (cur) tokens.push(cur);
    return tokens;
  }

  /** Regroupe les jetons en bindings ("&kp A", "&TD 1 N5"...). */
  function groupBindings(tokens) {
    const out = [];
    for (const t of tokens) {
      if (t.startsWith('&') || !out.length) out.push(t);
      else out[out.length - 1] += ' ' + t;
    }
    return out;
  }

  const normBinding = (b) => String(b || '').trim().replace(/\s+/g, ' ');

  /** #define NOM VALEUR -> {NOM: VALEUR} (commentaires ignorés). */
  function parseDefines(text) {
    const defs = {};
    const masked = maskComments(text);
    const re = /^[ \t]*#define[ \t]+([A-Za-z_]\w*)[ \t]+(\S[^\n]*?)[ \t]*$/gm;
    let m;
    while ((m = re.exec(masked))) defs[m[1]] = m[2];
    return defs;
  }

  /** Lignes de commentaire "//" situées juste au-dessus de l'indice donné. */
  function leadingComments(raw, idx) {
    const before = raw.slice(0, raw.lastIndexOf('\n', idx - 1) + 1);
    const lines = before.split('\n');
    lines.pop(); // fragment vide après le dernier \n
    const out = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (!t.startsWith('//')) break;
      out.unshift(t);
    }
    return out;
  }

  /** Nœuds enfants directs d'un bloc { ... } : en-tête, propriétés, position. */
  function parseChildren(masked, raw, bodyStart, bodyEnd) {
    const children = [];
    const props = {};
    let segStart = bodyStart;
    let i = bodyStart;
    while (i < bodyEnd) {
      const c = masked[i];
      if (c === '{') {
        const close = matchBrace(masked, i);
        const header = masked.slice(segStart, i).trim();
        const headerStart = segStart + masked.slice(segStart, i).search(/\S/);
        const child = {
          header,
          name: header.includes(':') ? header.split(':')[1].trim() : header,
          label: header.includes(':') ? header.split(':')[0].trim() : null,
          headerStart,
          bodyStart: i + 1,
          bodyEnd: close,
        };
        child.props = parseChildren(masked, raw, i + 1, close).props;
        child.comments = leadingComments(raw, headerStart);
        children.push(child);
        i = close + 1;
        while (i < bodyEnd && masked[i] !== ';') i++;
        segStart = i + 1;
      } else if (c === ';') {
        const stmt = masked.slice(segStart, i).trim();
        const eq = stmt.indexOf('=');
        if (eq > 0) props[stmt.slice(0, eq).trim()] = stmt.slice(eq + 1).trim();
        else if (stmt) props[stmt] = true;
        segStart = i + 1;
      }
      i++;
    }
    return { children, props };
  }

  /** Contenu entre < > d'une valeur de propriété (plusieurs groupes joints). */
  function cells(value) {
    if (typeof value !== 'string') return '';
    const groups = [];
    const re = /<([^>]*)>/g;
    let m;
    while ((m = re.exec(value))) groups.push(m[1]);
    return groups.join(' ');
  }

  function cellGroups(value) {
    if (typeof value !== 'string') return [];
    const out = [];
    const re = /<([^>]*)>/g;
    let m;
    while ((m = re.exec(value))) out.push(m[1].trim().replace(/\s+/g, ' '));
    return out;
  }

  const unquote = (v) => (typeof v === 'string' ? v.replace(/^"(.*)"$/s, '$1') : v);

  /** Trouve "nom {" (hors commentaires) et renvoie les bornes du nœud. */
  function findNode(raw, masked, name) {
    const re = new RegExp('(^|[\\s;{}])' + name + '\\s*\\{', 'm');
    const m = re.exec(masked);
    if (!m) return null;
    const start = m.index + m[1].length;
    const open = masked.indexOf('{', start);
    const close = matchBrace(masked, open);
    if (close < 0) return null;
    let semi = close + 1;
    while (semi < masked.length && /\s/.test(masked[semi])) semi++;
    const end = masked[semi] === ';' ? semi + 1 : close + 1;
    const lineStart = raw.lastIndexOf('\n', start - 1) + 1;
    return { start, open, close, end, lineStart };
  }

  // ---------------------------------------------------------------------
  // Lecture des fichiers
  // ---------------------------------------------------------------------

  /** sofle.keymap : noms de layers (#define) et behaviors personnalisés. */
  function parseKeymap(raw) {
    raw = raw.replace(/\r\n/g, '\n');
    const masked = maskComments(raw);
    const defines = parseDefines(raw);
    const behaviors = {};
    const node = findNode(raw, masked, 'behaviors');
    if (node) {
      for (const ch of parseChildren(masked, raw, node.open + 1, node.close).children) {
        const name = ch.label || ch.name;
        behaviors[name] = {
          name,
          compatible: unquote(ch.props.compatible) || '',
          cells: parseInt(cells(ch.props['#binding-cells']) || '0', 10),
          bindings: cellGroups(ch.props.bindings),
        };
      }
    }
    return { defines, behaviors };
  }

  /** sofle_layers.dtsi : les layers (bindings + encodeurs). */
  function parseLayers(raw) {
    raw = raw.replace(/\r\n/g, '\n');
    const masked = maskComments(raw);
    const node = findNode(raw, masked, 'keymap');
    if (!node) throw new Error('Nœud "keymap { ... }" introuvable dans sofle_layers.dtsi');
    const { children } = parseChildren(masked, raw, node.open + 1, node.close);
    const layers = children.map((ch) => ({
      header: ch.header,
      node: ch.name,
      comments: ch.comments,
      displayName: unquote(ch.props['display-name']) || null,
      bindings: groupBindings(tokenize(cells(ch.props.bindings))).map(normBinding),
      sensor: ch.props['sensor-bindings'] !== undefined
        ? normBinding(cells(ch.props['sensor-bindings'])) : null,
    }));
    return {
      prelude: raw.slice(0, node.lineStart),
      postlude: raw.slice(node.end),
      layers,
    };
  }

  /** sofle_colors.dtsi : #define de couleurs et couleurs par layer. */
  function parseColors(raw) {
    raw = raw.replace(/\r\n/g, '\n');
    const masked = maskComments(raw);
    const node = findNode(raw, masked, 'underglow_layer_colors');
    if (!node) throw new Error('Nœud "underglow_layer_colors { ... }" introuvable dans sofle_colors.dtsi');
    const { children } = parseChildren(masked, raw, node.open + 1, node.close);
    return {
      prelude: raw.slice(0, node.lineStart),
      postlude: raw.slice(node.end),
      defines: parseDefines(raw.slice(0, node.lineStart)),
      nodes: children.map((ch) => ({
        header: ch.header,
        comments: ch.comments,
        layerExpr: cells(ch.props.layer).trim(),
        colors: tokenize(cells(ch.props.colors)),
      })),
    };
  }

  /** Numéro de layer d'une expression ("2", "SYMBOLS"). */
  function layerIndex(expr, keymapDefines) {
    let v = String(expr).trim();
    for (let i = 0; i < 5 && !/^\d+$/.test(v); i++) {
      if (keymapDefines[v] === undefined) return null;
      v = String(keymapDefines[v]).trim();
    }
    return /^\d+$/.test(v) ? parseInt(v, 10) : null;
  }

  // ---------------------------------------------------------------------
  // Couleurs
  // ---------------------------------------------------------------------

  /**
   * Résout un jeton de couleur : {trans:true}, {hex:'#RRGGBB'} ou null (inconnu).
   */
  function resolveColor(token, defines) {
    let v = String(token || '').trim();
    for (let i = 0; i < 8; i++) {
      if (v === TRANS) return { trans: true };
      if (/^0x[0-9a-f]+$/i.test(v)) {
        const n = parseInt(v, 16);
        if (n > 0xffffff) return { trans: true };
        return { hex: '#' + n.toString(16).padStart(6, '0').toUpperCase() };
      }
      if (defines[v] === undefined) return null;
      v = String(defines[v]).trim();
    }
    return null;
  }

  /** Couleur réellement affichée par une touche pour un ensemble de layers actifs. */
  function effectiveColor(pos, activeLayers, colorsByLayer, defines) {
    for (let li = colorsByLayer.length - 1; li >= 0; li--) {
      if (!activeLayers.has(li) || !colorsByLayer[li]) continue;
      const c = resolveColor(colorsByLayer[li][pos], defines);
      if (c && !c.trans) return c.hex;
    }
    return '#000000';
  }

  /** Binding réellement actif (les &trans laissent passer le layer du dessous). */
  function effectiveBinding(pos, activeLayers, layers) {
    for (let li = layers.length - 1; li >= 0; li--) {
      if (!activeLayers.has(li)) continue;
      const b = layers[li].bindings[pos];
      if (b && b !== '&trans') return { binding: b, layer: li };
    }
    return { binding: '&trans', layer: 0 };
  }

  // ---------------------------------------------------------------------
  // Libellés (mêmes règles que keymap_drawer.config.yaml)
  // ---------------------------------------------------------------------

  const MOD_FN = {
    LC: 'left_ctrl', LS: 'left_shift', LA: 'left_alt', LG: 'left_gui',
    RC: 'right_ctrl', RS: 'right_shift', RA: 'right_alt', RG: 'right_gui',
  };
  const MOD_FN_RE = /^(LC|LS|LA|LG|RC|RS|RA|RG)\((.*)\)$/;

  /** "LC(RA(N5))" -> {mods:['LC','RA'], key:'N5'} */
  function splitMods(param) {
    const mods = [];
    let v = String(param || '').trim();
    let m;
    while ((m = MOD_FN_RE.exec(v))) {
      mods.push(m[1]);
      v = m[2].trim();
    }
    return { mods, key: v };
  }

  const joinMods = (mods, key) => mods.reduceRight((acc, m) => `${m}(${acc})`, key);

  const asLabel = (v) => (v == null ? null : typeof v === 'string' ? { t: v } : { ...v });

  function makeLabeler(cfg, layerNames, behaviors, fallbackKeyLabels) {
    cfg = cfg || {};
    const keyMap = cfg.zmk_keycode_map || {};
    const rawMap = {};
    for (const [k, v] of Object.entries(cfg.raw_binding_map || {})) rawMap[normBinding(k)] = v;
    const modMap = cfg.modifier_fn_map || {};
    const transLegend = cfg.trans_legend || { t: '▽' };
    const fallback = fallbackKeyLabels || {};

    const layerName = (p) => {
      const n = /^\d+$/.test(p) ? parseInt(p, 10) : null;
      return n !== null && layerNames[n] ? layerNames[n] : String(p);
    };

    function keyLabel(param) {
      const { mods, key } = splitMods(param);
      const base = asLabel(keyMap[key]) || asLabel(fallback[key]) || { t: key };
      if (!mods.length) return base;
      const names = mods.map((m) => modMap[MOD_FN[m]] || m);
      let modsText = names[0];
      for (let i = 1; i < names.length; i++) {
        modsText = (modMap.mod_combiner || '{mod_1}+{mod_2}')
          .replace('{mod_1}', modsText).replace('{mod_2}', names[i]);
      }
      const t = (modMap.keycode_combiner || '{mods}+{key}')
        .replace('{mods}', modsText).replace('{key}', base.t);
      return { t };
    }

    function label(binding) {
      const b = normBinding(binding);
      if (!b) return { t: '?', type: 'error' };
      if (rawMap[b] !== undefined) return asLabel(rawMap[b]);
      const [beh, ...params] = b.split(' ');
      const name = beh.slice(1);
      switch (name) {
        case 'trans': return { ...asLabel(transLegend), type: 'trans' };
        case 'none': return { t: '', type: 'none' };
        case 'kp': return keyLabel(params.join(' '));
        case 'mo': return { t: layerName(params[0]), s: 'maintien', type: 'layer' };
        case 'tog': return { t: layerName(params[0]), s: cfg.toggle_label || 'bascule', type: 'layer' };
        case 'to': return { t: layerName(params[0]), s: 'aller à', type: 'layer' };
        case 'sl': return { t: layerName(params[0]), s: cfg.sticky_label || 'one-shot', type: 'layer' };
        case 'lt': return { ...keyLabel(params.slice(1).join(' ')), h: layerName(params[0]) };
        case 'mt': return { ...keyLabel(params.slice(1).join(' ')), h: keyLabel(params[0]).t };
        case 'bt': return { t: params.slice(1).join(' ') ? `BT ${params.slice(1).join(' ')}` : params[0].replace(/^BT_/, ''), s: 'BT' };
        case 'rgb_ug': return { t: (params[0] || '').replace(/^RGB_/, ''), s: 'RGB' };
        case 'ext_power': return { t: (params[0] || '').replace(/^EP_/, ''), s: 'Alim. ext.' };
        default: break;
      }
      const custom = behaviors[name];
      if (custom && /hold-tap/.test(custom.compatible) && custom.bindings.length >= 2) {
        const hold = label(`${custom.bindings[0]} ${params[0] || ''}`);
        const tap = label(`${custom.bindings[1]} ${params[1] || ''}`);
        return { t: tap.t, s: tap.s, h: hold.t };
      }
      if (custom && /nice-view-anim/.test(custom.compatible)) {
        const p = (params[0] || '').replace(/^ANIM_/, '');
        return { t: p === 'SEL' ? `Anim ${params[1] || ''}`.trim() : `Anim ${p}`, s: 'écran' };
      }
      if (custom) return { t: name, type: 'custom' };
      return { t: b };
    }

    return { label, keyLabel, layerName };
  }

  // ---------------------------------------------------------------------
  // Génération du code
  // ---------------------------------------------------------------------

  /** Met 60 valeurs en forme sur 5 rangées, colonnes alignées. */
  function formatGrid(values, sep) {
    const cellsArr = Array.from({ length: 5 }, () => Array(14).fill(''));
    values.forEach((v, i) => {
      const g = GRID[i];
      if (g) cellsArr[g.row][g.col] = v;
    });
    const widths = Array(14).fill(0);
    cellsArr.forEach((row) => row.forEach((v, c) => { widths[c] = Math.max(widths[c], v.length); }));
    return cellsArr
      .map((row) => {
        const parts = [];
        row.forEach((v, c) => { if (widths[c] > 0) parts.push(v.padEnd(widths[c])); });
        return parts.join(sep).replace(/\s+$/, '');
      })
      .join('\n');
  }

  function exportLayers(parsed, layers) {
    let out = parsed.prelude;
    out += '    keymap {\n        compatible = "zmk,keymap";\n';
    layers.forEach((l) => {
      out += '\n';
      (l.comments || []).forEach((c) => { out += `        ${c}\n`; });
      out += `        ${l.header} {\n`;
      if (l.displayName) out += `            display-name = "${l.displayName}";\n`;
      out += '            bindings = <\n';
      out += formatGrid(l.bindings.map(normBinding), '  ') + '\n';
      out += '            >;\n';
      if (l.sensor) out += `            sensor-bindings = <${normBinding(l.sensor)}>;\n`;
      out += '        };\n';
    });
    out += '    };' + parsed.postlude;
    return out;
  }

  /**
   * colorsByLayer[li] : 60 jetons ou null ; extraDefines : [{name, value}] ;
   * layerDefineNames[li] : nom du #define du layer (ex. "SYMBOLS") ou null.
   */
  function exportColors(parsed, colorsByLayer, extraDefines, layerDefineNames, keymapDefines) {
    let out = parsed.prelude;
    if (extraDefines.length) {
      out = out.replace(/\n*$/, '\n');
      out += '// Couleurs ajoutées avec l\'éditeur (tools/config-editor)\n';
      extraDefines.forEach((d) => { out += `#define ${d.name} ${d.value}\n`; });
      out += '\n';
    }
    out += '    underglow_layer_colors {\n        compatible = "zmk,underglow-layer-colors";\n';
    const done = new Set();
    const emit = (header, comments, layerExpr, colors) => {
      out += '\n';
      comments.forEach((c) => { out += `        ${c}\n`; });
      out += `        ${header} {\n`;
      out += `            layer = <${layerExpr}>;\n`;
      out += '            colors = <\n' + formatGrid(colors, ' ') + '\n            >;\n';
      out += '        };\n';
    };
    parsed.nodes.forEach((n) => {
      const li = layerIndex(n.layerExpr, keymapDefines);
      const colors = li !== null && colorsByLayer[li] ? colorsByLayer[li] : n.colors;
      if (li !== null) done.add(li);
      emit(n.header, n.comments, n.layerExpr, colors);
    });
    colorsByLayer.forEach((colors, li) => {
      if (!colors || done.has(li) || colors.every((c) => c === '___' || c === TRANS)) return;
      const name = layerDefineNames[li];
      emit(`${(name || 'layer' + li).toLowerCase()}_colors`, [], name || String(li), colors);
    });
    out += '    };' + parsed.postlude;
    return out;
  }

  const api = {
    NUM_KEYS, ENCODER_POSITIONS, TRANS, GRID,
    maskComments, tokenize, groupBindings, normBinding, parseDefines,
    parseKeymap, parseLayers, parseColors, layerIndex,
    resolveColor, effectiveColor, effectiveBinding,
    splitMods, joinMods, makeLabeler,
    formatGrid, exportLayers, exportColors,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Core = api;
})(typeof window !== 'undefined' ? window : globalThis);
