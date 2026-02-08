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
  const m = line.match(/^dim\s+([A-Za-z_][\w]*)(?:\(([^)]*)\))?(?:\s+(.+))?$/);
  if (!m) throw new Error(`Invalid dim declaration: "${line}"`);
  const [, name, symbolRaw, descriptionRaw] = m;
  const desc = (descriptionRaw || '').trim();
  return {
    id: name,
    symbol: (symbolRaw || name).trim(),
    description: desc || name
  };
};

const stripQuotes = (s) => {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
};

const parseNodeDecl = (line) => {
  const body = line.replace(/^node\s+/, '').trim();
  const nameMatch = body.match(/^([A-Za-z_][\w]*(?:\[[^\]]+\])?)/);
  if (!nameMatch) throw new Error(`Invalid node declaration: "${line}"`);

  const refRaw = nameMatch[1];
  const ref = parseNodeRef(refRaw);
  let rest = body.slice(refRaw.length).trim();

  let symbol = ref.name;
  const symMatch = rest.match(/^\(([^)]*)\)/);
  if (symMatch) {
    symbol = symMatch[1].trim() || ref.name;
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
    symbol: ref.name,
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

const buildElkGraph = (model) => ({
  id: 'root',
  layoutOptions: {
    'elk.algorithm': 'layered',
    'elk.direction': 'RIGHT',
    'elk.spacing.nodeNode': '62',
    'elk.layered.spacing.nodeNodeBetweenLayers': '84',
    'elk.edgeRouting': 'ORTHOGONAL'
  },
  children: model.nodes.map((n) => {
    const { w, h } = nodeSize(n.type);
    return { id: n.id, width: w, height: h };
  }),
  edges: model.edges.map((e, idx) => ({ id: `e${idx}`, sources: [e.source], targets: [e.target] }))
});

const plateKey = (dims) => dims.join('×');

const render = async () => {
  try {
    errorsEl.textContent = '';
    const model = parseDsl(dslInput.value);
    const layout = await elk.layout(buildElkGraph(model));
    const byId = new Map(layout.children.map((c) => [c.id, c]));

    const width = Math.max((layout.width || 800) + PADDING * 2, canvas.clientWidth);
    const height = Math.max((layout.height || 500) + PADDING * 2, canvas.clientHeight);

    edgeLayer.setAttribute('width', width);
    edgeLayer.setAttribute('height', height);
    edgeLayer.setAttribute('viewBox', `0 0 ${width} ${height}`);
    edgeLayer.innerHTML = '';

    nodeLayer.style.width = `${width}px`;
    nodeLayer.style.height = `${height}px`;
    nodeLayer.innerHTML = '';

    const plates = new Map();
    for (const n of model.nodes) {
      const p = byId.get(n.id);
      if (!p) continue;
      const key = plateKey(n.dims);
      if (!key) continue;
      const { w, h } = nodeSize(n.type);
      const existing = plates.get(key) || { dims: n.dims, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      existing.minX = Math.min(existing.minX, p.x + PADDING);
      existing.minY = Math.min(existing.minY, p.y + PADDING);
      existing.maxX = Math.max(existing.maxX, p.x + PADDING + w);
      existing.maxY = Math.max(existing.maxY, p.y + PADDING + h);
      plates.set(key, existing);
    }

    for (const plate of [...plates.values()].sort((a, b) => b.dims.length - a.dims.length)) {
      const pad = 24;
      const x = plate.minX - pad;
      const y = plate.minY - pad;
      const w = plate.maxX - plate.minX + pad * 2;
      const h = plate.maxY - plate.minY + pad * 2;
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

      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', String(x + 8));
      label.setAttribute('y', String(y + 17));
      label.setAttribute('fill', '#0f172a');
      label.setAttribute('font-size', '12');
      label.textContent = plate.dims.map((dimName) => {
        const d = model.dims.get(dimName);
        return d ? `${d.symbol} (${d.description})` : dimName;
      }).join(' × ');
      group.appendChild(label);
      edgeLayer.appendChild(group);
    }

    for (const edge of layout.edges || []) {
      for (const sec of edge.sections || []) {
        const points = [sec.startPoint, ...(sec.bendPoints || []), sec.endPoint];
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x + PADDING} ${p.y + PADDING}`).join(' '));
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', '#0f172a');
        path.setAttribute('stroke-width', '2');
        edgeLayer.appendChild(path);

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
          <div class="node-symbol fixed-label">$${n.symbol}$</div>
        `;
      } else if (n.type === 'deterministic') {
        el.innerHTML = `
          <div class="node-desc">${n.description}</div>
          <div class="node-symbol">$${n.symbol}$</div>
        `;
      } else {
        const dist = n.distribution ? `<div class="node-dist">$${n.distribution}$</div>` : '';
        el.innerHTML = `
          <div class="node-desc">${n.description}</div>
          <div class="node-symbol">$${n.symbol}$</div>
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
