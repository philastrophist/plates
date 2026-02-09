const elk = new ELK();
const NODE_W = 138;
const NODE_H = 138;
const PADDING = 20;

const dslInput = document.getElementById('dsl');
const errorsEl = document.getElementById('errors');
const edgeLayer = document.getElementById('edge-layer');
const nodeLayer = document.getElementById('node-layer');
const viewport = document.getElementById('viewport');
const contentLayer = document.getElementById('content-layer');
const panToggle = document.getElementById('pan-toggle');
const zoomOutBtn = document.getElementById('zoom-out');
const zoomInBtn = document.getElementById('zoom-in');
const zoomLabel = document.getElementById('zoom-label');
const resetViewBtn = document.getElementById('reset-view');
const minimapEl = document.getElementById('minimap');
const minimapSvg = document.getElementById('minimap-svg');
const minimapToggle = document.getElementById('minimap-toggle');

const NODE_TYPES = new Set(['latent', 'observed', 'fixed', 'deterministic']);

const view = {
  scale: 1,
  tx: 0,
  ty: 0,
  panEnabled: true,
  dragging: false,
  dragStartX: 0,
  dragStartY: 0,
  startTx: 0,
  startTy: 0,
  contentWidth: 1,
  contentHeight: 1,
  fittedOnce: false,
  lastSnapshot: null,
  minimap: {
    mmW: 214,
    mmH: 140,
    scale: 1,
    offX: 0,
    offY: 0
  },
  minimapDragging: false
};

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

const canonicalDims = (dims) => [...dims].sort((a, b) => a.localeCompare(b));

const nodeIdFor = (name, dims) => {
  if (!dims.length) return name;
  return `${name}::${dims.join('|')}`;
};

const canonicalNodeRef = (ref) => {
  const dims = canonicalDims(ref.dims || []);
  return {
    ...ref,
    dims,
    id: nodeIdFor(ref.name, dims)
  };
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

const normalizeCompareText = (raw) => normalizeMathContent(raw || '').replaceAll(' ', '').trim();

const shouldShowNodeDescription = (node, dimLookup) => {
  const description = (node.description || '').trim();
  if (!description) return false;

  const normalizedDescription = normalizeCompareText(description);
  const normalizedSymbol = normalizeCompareText(node.symbol || '');
  if (normalizedDescription === normalizedSymbol) return false;

  const normalizedName = normalizeCompareText(node.name || '');
  if (normalizedDescription !== normalizedName) return true;

  const dimAwareDefaultSymbol = normalizeCompareText(defaultNodeSymbol(node, dimLookup));
  if (normalizedSymbol === dimAwareDefaultSymbol) return false;

  const legacyDefaults = legacyDefaultSymbolsFor(node.name, node.dims).map(normalizeCompareText);
  return !legacyDefaults.includes(normalizedSymbol);
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

const dimMathLabel = (dimName, dimLookup) => {
  const d = dimLookup?.get(dimName);
  return normalizeMathContent(d?.label || d?.symbol || dimName);
};

const defaultNodeSymbol = (ref, dimLookup) => {
  if (!ref.dims.length) return ref.name;
  const dims = ref.dims.map((dimName) => dimMathLabel(dimName, dimLookup));
  return `${ref.name}_{${dims.join(',')}}`;
};

const parseNodeDecl = (line) => {
  const typePrefix = line.match(/^(latent|observed|fixed|deterministic)\b\s*(.*)$/i);
  if (!typePrefix) throw new Error(`Invalid node declaration: "${line}"`);

  const type = typePrefix[1].toLowerCase();
  const body = typePrefix[2].trim();
  const nameMatch = body.match(/^([A-Za-z_][\w]*(?:\[[^\]]+\])?)/);
  if (!nameMatch) throw new Error(`Invalid node declaration: "${line}"`);

  const refRaw = nameMatch[1];
  const ref = parseNodeRef(refRaw);
  let rest = body.slice(refRaw.length).trim();

  let symbol = defaultNodeSymbol(ref);
  let autoSymbol = true;
  const symMatch = rest.match(/^\(([^)]*)\)/);
  if (symMatch) {
    symbol = normalizeMathContent(symMatch[1].trim() || defaultNodeSymbol(ref));
    autoSymbol = false;
    rest = rest.slice(symMatch[0].length).trim();
  }

  let distribution = '';
  const distIdx = rest.indexOf('~');
  if (distIdx >= 0) {
    distribution = rest.slice(distIdx + 1).trim();
    rest = rest.slice(0, distIdx).trim();
  }

  const description = stripQuotes(rest || ref.name);
  const canonicalRef = canonicalNodeRef(ref);

  return {
    id: canonicalRef.id,
    name: canonicalRef.name,
    dims: canonicalRef.dims,
    symbol,
    autoSymbol,
    description,
    distribution,
    type
  };
};

const ensureNode = (nodes, ref) => {
  const canonicalRef = canonicalNodeRef(ref);
  const existing = nodes.get(canonicalRef.id) || {
    id: canonicalRef.id,
    name: canonicalRef.name,
    dims: canonicalRef.dims,
    symbol: defaultNodeSymbol(canonicalRef),
    autoSymbol: true,
    description: canonicalRef.name,
    distribution: '',
    type: 'latent'
  };
  if (canonicalRef.dims.length && existing.dims.length === 0) existing.dims = canonicalRef.dims;
  nodes.set(canonicalRef.id, existing);
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

    if (/^(latent|observed|fixed|deterministic)\b/i.test(trimmed)) {
      const node = parseNodeDecl(trimmed);
      if (!NODE_TYPES.has(node.type)) throw new Error(`Line ${idx + 1}: unsupported node type "${node.type}"`);
      const existing = ensureNode(nodes, { name: node.name, dims: node.dims });
      Object.assign(existing, node);
      continue;
    }

    if (/(->|<-)/.test(trimmed)) {
      const tokens = trimmed.split(/(->|<-)/).map((t) => t.trim()).filter(Boolean);
      let current = canonicalNodeRef(parseNodeRef(tokens[0]));
      ensureNode(nodes, current);
      for (let i = 1; i < tokens.length; i += 2) {
        const op = tokens[i];
        const next = canonicalNodeRef(parseNodeRef(tokens[i + 1]));
        ensureNode(nodes, next);
        if (op === '->') edges.push({ source: current.id, target: next.id });
        if (op === '<-') edges.push({ source: next.id, target: current.id });
        current = next;
      }
      continue;
    }

    throw new Error(`Line ${idx + 1}: expected dim, typed node declaration, or edge chain`);
  }

  return { dims, nodes: [...nodes.values()], edges };
};

const legacyDefaultSymbolsFor = (name, dims) => {
  if (!dims.length) return [name];

  if (dims.length === 1) {
    const [d] = dims;
    return [`${name}_${d}`, `${name}_{${d}}`];
  }

  const joined = dims.join(',');
  return [`${name}_{${joined}}`, `${name}_${joined}`];
};

const shouldUseDimAwareDefault = (node) => {
  if (node.autoSymbol) return true;

  const symbol = normalizeMathContent(node.symbol || '').replaceAll(' ', '');
  const legacy = legacyDefaultSymbolsFor(node.name, node.dims).map((v) => v.replaceAll(' ', ''));
  return legacy.includes(symbol);
};

const applyDefaultNodeSymbols = (model) => {
  for (const node of model.nodes) {
    if (!shouldUseDimAwareDefault(node)) continue;
    node.symbol = defaultNodeSymbol(node, model.dims);
  }
};

const baseNodeSize = (type) => {
  if (type === 'fixed') return { w: 28, h: 28 };
  if (type === 'deterministic') return { w: 150, h: 94 };
  return { w: NODE_W, h: NODE_H };
};

const nodeSize = (node) => baseNodeSize(node.type);

const plateIdForDims = (dims) => `plate:${dims.join('|')}`;

const buildElkGraph = (model) => {
  const root = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '62',
      'elk.layered.spacing.nodeNodeBetweenLayers': '84',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.greedySwitch.type': 'TWO_SIDED',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.thoroughness': '20',
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
    const { w, h } = nodeSize(n);
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

const buildRoundedOrthogonalPathD = (points, cornerRadius = 16) => {
  if (!points.length) return '';
  if (points.length === 1) return `M ${points[0].x + PADDING} ${points[0].y + PADDING}`;

  const withPadding = points.map((p) => ({ x: p.x + PADDING, y: p.y + PADDING }));
  let d = `M ${withPadding[0].x} ${withPadding[0].y}`;

  for (let i = 1; i < withPadding.length - 1; i += 1) {
    const prev = withPadding[i - 1];
    const curr = withPadding[i];
    const next = withPadding[i + 1];

    const inDx = curr.x - prev.x;
    const inDy = curr.y - prev.y;
    const outDx = next.x - curr.x;
    const outDy = next.y - curr.y;

    const inLen = Math.hypot(inDx, inDy) || 1;
    const outLen = Math.hypot(outDx, outDy) || 1;

    const uxIn = inDx / inLen;
    const uyIn = inDy / inLen;
    const uxOut = outDx / outLen;
    const uyOut = outDy / outLen;

    const isStraight = Math.abs(uxIn - uxOut) < 1e-6 && Math.abs(uyIn - uyOut) < 1e-6;
    if (isStraight) {
      d += ` L ${curr.x} ${curr.y}`;
      continue;
    }

    const r = Math.min(cornerRadius, inLen / 2, outLen / 2);
    const startX = curr.x - uxIn * r;
    const startY = curr.y - uyIn * r;
    const endX = curr.x + uxOut * r;
    const endY = curr.y + uyOut * r;

    d += ` L ${startX} ${startY}`;
    d += ` Q ${curr.x} ${curr.y} ${endX} ${endY}`;
  }

  const last = withPadding[withPadding.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
};

const updateTransform = () => {
  contentLayer.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
  zoomLabel.textContent = `${Math.round(view.scale * 100)}%`;
  drawMinimap();
};

const fitToWindow = () => {
  const vw = viewport.clientWidth || 1;
  const vh = viewport.clientHeight || 1;
  const sx = vw / Math.max(view.contentWidth, 1);
  const sy = vh / Math.max(view.contentHeight, 1);
  view.scale = Math.min(sx, sy, 1.8);
  view.tx = (vw - view.contentWidth * view.scale) / 2;
  view.ty = (vh - view.contentHeight * view.scale) / 2;
  updateTransform();
};

const zoomAt = (factor, cx, cy) => {
  const oldScale = view.scale;
  const nextScale = Math.max(0.2, Math.min(3.5, oldScale * factor));
  if (nextScale === oldScale) return;

  const localX = (cx - view.tx) / oldScale;
  const localY = (cy - view.ty) / oldScale;
  view.scale = nextScale;
  view.tx = cx - localX * nextScale;
  view.ty = cy - localY * nextScale;
  updateTransform();
};

const panToMinimapPoint = (mmX, mmY) => {
  const { scale, offX, offY } = view.minimap;
  if (!scale) return;

  const contentX = (mmX - offX) / scale;
  const contentY = (mmY - offY) / scale;

  const vpW = viewport.clientWidth / view.scale;
  const vpH = viewport.clientHeight / view.scale;

  view.tx = -(contentX - vpW / 2) * view.scale;
  view.ty = -(contentY - vpH / 2) * view.scale;
  updateTransform();
};

const drawMinimap = () => {
  const snapshot = view.lastSnapshot;
  if (!snapshot) return;

  const { mmW, mmH } = view.minimap;
  const scale = Math.min(mmW / Math.max(view.contentWidth, 1), mmH / Math.max(view.contentHeight, 1));
  const offX = (mmW - view.contentWidth * scale) / 2;
  const offY = (mmH - view.contentHeight * scale) / 2;

  view.minimap.scale = scale;
  view.minimap.offX = offX;
  view.minimap.offY = offY;

  minimapSvg.setAttribute('viewBox', `0 0 ${mmW} ${mmH}`);
  minimapSvg.innerHTML = '';

  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', '0');
  bg.setAttribute('y', '0');
  bg.setAttribute('width', String(mmW));
  bg.setAttribute('height', String(mmH));
  bg.setAttribute('fill', '#f8fafc');
  minimapSvg.appendChild(bg);

  for (const plate of snapshot.plates) {
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('x', String(offX + plate.x * scale));
    r.setAttribute('y', String(offY + plate.y * scale));
    r.setAttribute('width', String(plate.w * scale));
    r.setAttribute('height', String(plate.h * scale));
    r.setAttribute('fill', 'none');
    r.setAttribute('stroke', '#94a3b8');
    r.setAttribute('stroke-width', '1');
    minimapSvg.appendChild(r);
  }

  for (const node of snapshot.nodes) {
    const x = offX + node.x * scale;
    const y = offY + node.y * scale;
    const w = Math.max(1.2, node.w * scale);
    const h = Math.max(1.2, node.h * scale);
    const cx = x + w / 2;
    const cy = y + h / 2;

    if (node.type === 'deterministic') {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', String(w));
      rect.setAttribute('height', String(h));
      rect.setAttribute('fill', '#ffffff');
      rect.setAttribute('stroke', '#0f172a');
      rect.setAttribute('stroke-width', '0.7');
      rect.setAttribute('rx', '1.5');
      minimapSvg.appendChild(rect);
      continue;
    }

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    const radius = node.type === 'fixed'
      ? Math.max(1.3, Math.min(w, h) * 0.28)
      : Math.max(1.3, Math.min(w, h) * 0.5);
    circle.setAttribute('cx', String(cx));
    circle.setAttribute('cy', String(cy));
    circle.setAttribute('r', String(radius));
    circle.setAttribute('fill', node.type === 'observed' ? '#d1d5db' : (node.type === 'fixed' ? '#0f172a' : '#ffffff'));
    circle.setAttribute('stroke', node.type === 'fixed' ? 'none' : '#0f172a');
    circle.setAttribute('stroke-width', node.type === 'fixed' ? '0' : '0.7');
    minimapSvg.appendChild(circle);
  }

  const vp = {
    x: (-view.tx) / view.scale,
    y: (-view.ty) / view.scale,
    w: viewport.clientWidth / view.scale,
    h: viewport.clientHeight / view.scale
  };
  const vr = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  vr.setAttribute('x', String(offX + vp.x * scale));
  vr.setAttribute('y', String(offY + vp.y * scale));
  vr.setAttribute('width', String(vp.w * scale));
  vr.setAttribute('height', String(vp.h * scale));
  vr.setAttribute('fill', 'rgba(59,130,246,0.15)');
  vr.setAttribute('stroke', '#2563eb');
  vr.setAttribute('stroke-width', '1');
  minimapSvg.appendChild(vr);
};

const render = async () => {
  try {
    errorsEl.textContent = '';
    const model = parseDsl(dslInput.value);
    applyDefaultNodeSymbols(model);
    const layout = await elk.layout(buildElkGraph(model));
    const byId = collectAbsoluteLayout(layout);

    const width = (layout.width || 800) + PADDING * 2;
    const height = (layout.height || 500) + PADDING * 2;
    view.contentWidth = width;
    view.contentHeight = height;

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
      rect.setAttribute('stroke-width', '10');
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
        path.setAttribute('d', buildRoundedOrthogonalPathD(points));
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', '#0f172a');
        path.setAttribute('stroke-width', '2');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        edgeLayer.appendChild(path);
      }

      const terminalSections = sections.filter((sec) => !(sec.outgoingSections || []).length);
      for (const sec of (terminalSections.length ? terminalSections : sections.slice(-1))) {
        const points = [sec.startPoint, ...(sec.bendPoints || []), sec.endPoint];
        const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        arrowPath.setAttribute('d', buildRoundedOrthogonalPathD(points));
        const totalLen = arrowPath.getTotalLength();
        const end = arrowPath.getPointAtLength(totalLen);
        const before = arrowPath.getPointAtLength(Math.max(0, totalLen - 10));

        const dx = end.x - before.x;
        const dy = end.y - before.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const size = 8;
        const tipX = end.x;
        const tipY = end.y;
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

    const minimapNodes = [];
    for (const n of model.nodes) {
      const p = byId.get(n.id);
      if (!p) continue;
      const { w, h } = nodeSize(n);

      minimapNodes.push({ x: p.x + PADDING, y: p.y + PADDING, w, h, type: n.type });

      const el = document.createElement('div');
      el.className = `node node-${n.type}`;
      el.dataset.nodeId = n.id;
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
        const description = shouldShowNodeDescription(n, model.dims)
          ? `<div class="node-desc">${escapeHtml(n.description)}</div>`
          : '';
        el.innerHTML = `
          ${description}
          <div class="node-symbol">$${normalizeMathContent(n.symbol)}$</div>
        `;
      } else {
        const tilde = n.distribution ? '<div class="node-tilde">~</div>' : '';
        const dist = n.distribution ? `<div class="node-dist">$${n.distribution}$</div>` : '';
        const description = shouldShowNodeDescription(n, model.dims)
          ? `<div class="node-desc">${escapeHtml(n.description)}</div>`
          : '';
        el.innerHTML = `
          ${description}
          <div class="node-symbol">$${normalizeMathContent(n.symbol)}$</div>
          ${tilde}
          ${dist}
        `;
      }

      nodeLayer.appendChild(el);
    }

    view.lastSnapshot = {
      nodes: minimapNodes,
      plates: plateLayout.map((plate) => ({
        x: plate.x + PADDING,
        y: plate.y + PADDING,
        w: plate.width || 0,
        h: plate.height || 0
      }))
    };

    if (window.MathJax?.typesetPromise) await window.MathJax.typesetPromise([nodeLayer]);

    const adjustableNodes = [...nodeLayer.querySelectorAll('.node')]
      .filter((el) => !el.classList.contains('node-fixed'));

    for (const el of adjustableNodes) {
      let low = 0.18;
      let high = 2.4;
      let best = low;

      for (let i = 0; i < 14; i += 1) {
        const mid = (low + high) / 2;
        el.style.setProperty('--node-font-scale', String(mid));

        const availableW = Math.max(1, el.clientWidth - 6);
        const availableH = Math.max(1, el.clientHeight - 6);
        const fits = el.scrollWidth <= availableW && el.scrollHeight <= availableH;

        if (fits) {
          best = mid;
          low = mid;
        } else {
          high = mid;
        }
      }

      el.style.setProperty('--node-font-scale', String(best));
    }


    if (!view.fittedOnce) {
      fitToWindow();
      view.fittedOnce = true;
    } else {
      updateTransform();
    }
  } catch (err) {
    errorsEl.textContent = String(err.message || err);
  }
};

let timer;
const debounceRender = () => {
  clearTimeout(timer);
  timer = setTimeout(() => { render(); }, 120);
};

panToggle.addEventListener('click', () => {
  view.panEnabled = !view.panEnabled;
  panToggle.classList.toggle('active', view.panEnabled);
  panToggle.textContent = view.panEnabled ? 'Grab to move' : 'Pan disabled';
});

viewport.addEventListener('pointerdown', (event) => {
  if (!view.panEnabled || event.button !== 0) return;
  view.dragging = true;
  view.dragStartX = event.clientX;
  view.dragStartY = event.clientY;
  view.startTx = view.tx;
  view.startTy = view.ty;
  viewport.classList.add('panning');
  viewport.setPointerCapture(event.pointerId);
});

viewport.addEventListener('pointermove', (event) => {
  if (!view.dragging) return;
  view.tx = view.startTx + (event.clientX - view.dragStartX);
  view.ty = view.startTy + (event.clientY - view.dragStartY);
  updateTransform();
});

const endDrag = () => {
  view.dragging = false;
  viewport.classList.remove('panning');
};

viewport.addEventListener('pointerup', endDrag);
viewport.addEventListener('pointercancel', endDrag);

viewport.addEventListener('wheel', (event) => {
  event.preventDefault();
  const rect = viewport.getBoundingClientRect();
  const cx = event.clientX - rect.left;
  const cy = event.clientY - rect.top;
  zoomAt(event.deltaY < 0 ? 1.1 : 0.9, cx, cy);
}, { passive: false });

zoomInBtn.addEventListener('click', () => zoomAt(1.2, viewport.clientWidth / 2, viewport.clientHeight / 2));
zoomOutBtn.addEventListener('click', () => zoomAt(1 / 1.2, viewport.clientWidth / 2, viewport.clientHeight / 2));
resetViewBtn.addEventListener('click', fitToWindow);

minimapToggle.addEventListener('click', () => {
  minimapEl.classList.toggle('collapsed');
  const collapsed = minimapEl.classList.contains('collapsed');
  minimapToggle.textContent = collapsed ? 'Expand' : 'Collapse';
});

const minimapPointFromEvent = (event) => {
  const rect = minimapSvg.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * view.minimap.mmW;
  const y = ((event.clientY - rect.top) / Math.max(rect.height, 1)) * view.minimap.mmH;
  return { x, y };
};

minimapSvg.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  view.minimapDragging = true;
  const { x, y } = minimapPointFromEvent(event);
  panToMinimapPoint(x, y);
  minimapSvg.setPointerCapture(event.pointerId);
});

minimapSvg.addEventListener('pointermove', (event) => {
  if (!view.minimapDragging) return;
  const { x, y } = minimapPointFromEvent(event);
  panToMinimapPoint(x, y);
});

const stopMinimapDrag = () => {
  view.minimapDragging = false;
};

minimapSvg.addEventListener('pointerup', stopMinimapDrag);
minimapSvg.addEventListener('pointercancel', stopMinimapDrag);

dslInput.addEventListener('input', () => {
  view.fittedOnce = false;
  debounceRender();
});
window.addEventListener('resize', fitToWindow);
render();
