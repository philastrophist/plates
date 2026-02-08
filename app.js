const elk = new ELK();
const NODE_W = 138;
const NODE_H = 138;
const PADDING = 20;

const dslInput = document.getElementById('dsl');
const errorsEl = document.getElementById('errors');
const edgeLayer = document.getElementById('edge-layer');
const nodeLayer = document.getElementById('node-layer');
const canvas = document.getElementById('canvas');

const NODE_TYPES = new Set(['latent', 'observed', 'fixed', 'deterministic']);

const splitTopLevel = (raw, delimiter) => {
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = null;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (quote) {
      current += ch;
      if (ch === quote && raw[i - 1] !== '\\') quote = null;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);

    if (ch === delimiter && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
};

const parseNodeRef = (raw) => {
  const match = raw.trim().match(/^([A-Za-z_][\w]*)(?:\[([^\]]+)\])?$/);
  if (!match) throw new Error(`Invalid node reference: "${raw}"`);
  const [, name, dimsRaw] = match;
  const dims = dimsRaw ? splitTopLevel(dimsRaw, ',').map((d) => d.trim()).filter(Boolean) : [];
  return { name, dims };
};

const parseDimDecl = (line) => {
  const m = line.match(/^dim\s+([A-Za-z_][\w]*)(?:\s*\(([^)]*)\))?(?:\s+(.+))?$/);
  if (!m) throw new Error(`Invalid dim declaration: "${line}"`);
  const [, symbolRaw, labelRaw, descriptionRaw] = m;
  const symbol = symbolRaw.trim();
  const label = (labelRaw || symbol).trim();
  const desc = (descriptionRaw || '').trim();
  return {
    id: symbol,
    symbol,
    label,
    description: desc
  };
};

const normalizeMathContent = (raw) => {
  const text = raw.trim();
  if (text.startsWith('$') && text.endsWith('$')) return text.slice(1, -1).trim();
  if (text.startsWith('\\(') && text.endsWith('\\)')) return text.slice(2, -2).trim();
  return text;
};

const escapeHtml = (raw) => raw
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('\"', '&quot;')
  .replaceAll("'", '&#39;');

const stripQuotes = (s) => {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
};

const defaultNodeSymbol = (ref) => (ref.dims.length ? `${ref.name}_{${ref.dims.join(',')}}` : ref.name);

const parseNodeDecl = (line) => {
  const body = line.replace(/^node\s+/, '').trim();
  const nameMatch = body.match(/^([A-Za-z_][\w]*(?:\[[^\]]+\])?)/);
  if (!nameMatch) throw new Error(`Invalid node declaration: "${line}"`);

  const refRaw = nameMatch[1];
  const ref = parseNodeRef(refRaw);
  let rest = body.slice(refRaw.length).trim();

  let symbol = defaultNodeSymbol(ref);
  const symMatch = rest.match(/^\(([^)]*)\)/);
  if (symMatch) {
    symbol = normalizeMathContent(symMatch[1].trim() || defaultNodeSymbol(ref));
    rest = rest.slice(symMatch[0].length).trim();
  }

  let distribution = '';
  const distIdx = rest.indexOf('~');
  if (distIdx >= 0) {
    distribution = rest.slice(distIdx + 1).trim();
    rest = rest.slice(0, distIdx).trim();
  }

  let type = 'latent';
  const typeRegex = /\b(latent|observed|fixed|deterministic)\b/i;
  const typeMatch = rest.match(typeRegex);
  if (typeMatch) {
    type = typeMatch[1].toLowerCase();
    rest = (rest.slice(0, typeMatch.index) + rest.slice(typeMatch.index + typeMatch[0].length)).trim();
  }

  const description = stripQuotes(rest || ref.name);
  return {
    id: ref.name,
    dims: ref.dims,
    symbol,
    description,
    distribution,
    type
  };
};

const ensureNode = (nodes, ref) => {
  const existing = nodes.get(ref.name) || {
    id: ref.name,
    dims: ref.dims,
    symbol: defaultNodeSymbol(ref),
    description: ref.name,
    distribution: '',
    type: 'latent'
  };
  if (ref.dims.length && existing.dims.length === 0) existing.dims = ref.dims;
  nodes.set(ref.name, existing);
  return existing;
};

const parseDsl = (source) => {
  const dims = new Map();
  const nodes = new Map();
  const edges = [];

  for (const [idx, line] of source.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('dim ')) {
      const dim = parseDimDecl(trimmed);
      dims.set(dim.id, dim);
      continue;
    }

    if (trimmed.startsWith('node ')) {
      const node = parseNodeDecl(trimmed);
      if (!NODE_TYPES.has(node.type)) throw new Error(`Line ${idx + 1}: unsupported node type "${node.type}"`);
      const existing = ensureNode(nodes, { name: node.id, dims: node.dims });
      Object.assign(existing, node);
      continue;
    }

    if (/(->|<-)/.test(trimmed)) {
      const tokens = trimmed.split(/(->|<-)/).map((t) => t.trim()).filter(Boolean);
      let current = parseNodeRef(tokens[0]);
      ensureNode(nodes, current);
      for (let i = 1; i < tokens.length; i += 2) {
        const op = tokens[i];
        const next = parseNodeRef(tokens[i + 1]);
        ensureNode(nodes, next);
        if (op === '->') edges.push({ source: current.name, target: next.name });
        if (op === '<-') edges.push({ source: next.name, target: current.name });
        current = next;
      }
      continue;
    }

    throw new Error(`Line ${idx + 1}: expected dim, node, or edge chain`);
  }

  return { dims, nodes: [...nodes.values()], edges };
};

const nodeSize = (type) => {
  if (type === 'fixed') return { w: 28, h: 28 };
  if (type === 'deterministic') return { w: 150, h: 94 };
  return { w: NODE_W, h: NODE_H };
};

const plateIdForDims = (dims) => `plate:${dims.join('|')}`;

const buildElkGraph = (model) => {
  const root = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '62',
      'elk.layered.spacing.nodeNodeBetweenLayers': '84',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN'
    },
    children: [],
    edges: model.edges.map((e, idx) => ({ id: `e${idx}`, sources: [e.source], targets: [e.target] }))
  };

  const plateNodes = new Map();

  const ensurePlate = (dims) => {
    if (dims.length === 0) return root;
    const id = plateIdForDims(dims);
    if (plateNodes.has(id)) return plateNodes.get(id);

    const plate = {
      id,
      dims,
      children: [],
      layoutOptions: {
        'elk.padding': '[top=30,left=22,bottom=22,right=22]',
        'elk.spacing.nodeNode': '62',
        'elk.layered.spacing.nodeNodeBetweenLayers': '84'
      }
    };

    const parent = ensurePlate(dims.slice(0, -1));
    parent.children.push(plate);
    plateNodes.set(id, plate);
    return plate;
  };

  for (const n of model.nodes) {
    const parent = ensurePlate(n.dims);
    const { w, h } = nodeSize(n.type);
    parent.children.push({ id: n.id, width: w, height: h });
  }

  return root;
};

const collectAbsoluteLayout = (node, offsetX = 0, offsetY = 0, out = new Map()) => {
  const x = (node.x || 0) + offsetX;
  const y = (node.y || 0) + offsetY;
  out.set(node.id, { ...node, x, y });
  for (const child of node.children || []) collectAbsoluteLayout(child, x, y, out);
  return out;
};

const plateLabel = (dims, dimLookup) => dims.map((dimName) => {
  const d = dimLookup.get(dimName);
  const math = normalizeMathContent(d?.label || d?.symbol || dimName);
  const description = (d?.description || '').trim();
  const descriptionHtml = description ? ` <span class="plate-label-desc">${escapeHtml(description)}</span>` : '';
  return `<span class="plate-label-item">$${math}$${descriptionHtml}</span>`;
}).join('<span class="plate-label-sep"> × </span>');

const render = async () => {
  try {
    errorsEl.textContent = '';
    const model = parseDsl(dslInput.value);
    const layout = await elk.layout(buildElkGraph(model));
    const byId = collectAbsoluteLayout(layout);

    const width = Math.max((layout.width || 800) + PADDING * 2, canvas.clientWidth);
    const height = Math.max((layout.height || 500) + PADDING * 2, canvas.clientHeight);

    edgeLayer.setAttribute('width', width);
    edgeLayer.setAttribute('height', height);
    edgeLayer.setAttribute('viewBox', `0 0 ${width} ${height}`);
    edgeLayer.innerHTML = '';

    nodeLayer.style.width = `${width}px`;
    nodeLayer.style.height = `${height}px`;
    nodeLayer.innerHTML = '';

    const plateLayout = [...byId.values()]
      .filter((n) => n.id.startsWith('plate:'))
      .sort((a, b) => a.dims.length - b.dims.length);

    for (const plate of plateLayout) {
      const x = plate.x + PADDING;
      const y = plate.y + PADDING;
      const w = plate.width || 0;
      const h = plate.height || 0;
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', String(w));
      rect.setAttribute('height', String(h));
      rect.setAttribute('fill', 'none');
      rect.setAttribute('stroke', '#475569');
      rect.setAttribute('stroke-width', '2');
      group.appendChild(rect);

      edgeLayer.appendChild(group);

      const label = document.createElement('div');
      label.className = 'plate-label';
      label.style.left = `${x + 8}px`;
      label.style.top = `${y + 6}px`;
      label.innerHTML = plateLabel(plate.dims || [], model.dims);
      nodeLayer.appendChild(label);
    }

    for (const edge of layout.edges || []) {
      const edgeContainer = byId.get(edge.container || 'root') || { x: 0, y: 0 };
      const sections = (edge.sections || []).filter((sec) => sec.startPoint && sec.endPoint).map((sec) => {
        const translate = (p) => ({ x: p.x + edgeContainer.x, y: p.y + edgeContainer.y });
        return {
          ...sec,
          startPoint: translate(sec.startPoint),
          endPoint: translate(sec.endPoint),
          bendPoints: (sec.bendPoints || []).map(translate)
        };
      });

      for (const sec of sections) {
        const points = [sec.startPoint, ...(sec.bendPoints || []), sec.endPoint];
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x + PADDING} ${p.y + PADDING}`).join(' '));
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', '#0f172a');
        path.setAttribute('stroke-width', '2');
        edgeLayer.appendChild(path);
      }

      const terminalSections = sections.filter((sec) => !(sec.outgoingSections || []).length);
      for (const sec of (terminalSections.length ? terminalSections : sections.slice(-1))) {
        const points = [sec.startPoint, ...(sec.bendPoints || []), sec.endPoint];
        const last = points[points.length - 1];
        const prev = points[points.length - 2] || points[0];
        const dx = last.x - prev.x;
        const dy = last.y - prev.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const size = 8;
        const tipX = last.x + PADDING;
        const tipY = last.y + PADDING;
        const leftX = tipX - ux * size - uy * size * 0.7;
        const leftY = tipY - uy * size + ux * size * 0.7;
        const rightX = tipX - ux * size + uy * size * 0.7;
        const rightY = tipY - uy * size - ux * size * 0.7;
        const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        arrow.setAttribute('points', `${tipX},${tipY} ${leftX},${leftY} ${rightX},${rightY}`);
        arrow.setAttribute('fill', '#0f172a');
        edgeLayer.appendChild(arrow);
      }
    }

    for (const n of model.nodes) {
      const p = byId.get(n.id);
      if (!p) continue;
      const { w, h } = nodeSize(n.type);

      const el = document.createElement('div');
      el.className = `node node-${n.type}`;
      el.style.left = `${p.x + PADDING}px`;
      el.style.top = `${p.y + PADDING}px`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;

      if (n.type === 'fixed') {
        el.innerHTML = `
          <div class="fixed-dot"></div>
          <div class="node-symbol fixed-label">$${normalizeMathContent(n.symbol)}$</div>
        `;
      } else if (n.type === 'deterministic') {
        el.innerHTML = `
          <div class="node-desc">${n.description}</div>
          <div class="node-symbol">$${normalizeMathContent(n.symbol)}$</div>
        `;
      } else {
        const dist = n.distribution ? `<div class="node-dist">$${n.distribution}$</div>` : '';
        el.innerHTML = `
          <div class="node-desc">${n.description}</div>
          <div class="node-symbol">$${normalizeMathContent(n.symbol)}$</div>
          <div class="node-tilde">~</div>
          ${dist}
        `;
      }

      nodeLayer.appendChild(el);
    }

    if (window.MathJax?.typesetPromise) await window.MathJax.typesetPromise([nodeLayer]);
  } catch (err) {
    errorsEl.textContent = String(err.message || err);
  }
};

let timer;
const debounceRender = () => {
  clearTimeout(timer);
  timer = setTimeout(() => { render(); }, 120);
};

dslInput.addEventListener('input', debounceRender);
window.addEventListener('resize', debounceRender);
render();
