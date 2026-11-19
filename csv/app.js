const FILE_PATH = 'csv/data.csv';
const IMAGE_DIR = 'csv/images';
const STORAGE_KEY = 'pages-csv-editor';
const DEFAULT_HEADERS = ['id', 'name', 'note', 'image'];
const MAX_DIMENSION = 1600;
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|svg)$/i;
const UPLOAD_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const ownerEl = document.getElementById('owner');
const repoEl = document.getElementById('repo');
const branchEl = document.getElementById('branch');
const tokenEl = document.getElementById('token');
const tokenLink = document.getElementById('token-link');
const setupForm = document.getElementById('setup-form');
const setupDetails = document.getElementById('setup-details');
const connectBtn = document.getElementById('connect');
const reloadBtn = document.getElementById('reload');
const forgetBtn = document.getElementById('forget');
const badgeEl = document.getElementById('connection-badge');
const commitMessageEl = document.getElementById('commit-message');
const saveBtn = document.getElementById('save');
const discardBtn = document.getElementById('discard');
const dirtyEl = document.getElementById('dirty');
const tabContentBtn = document.getElementById('tab-content');
const tabImagesBtn = document.getElementById('tab-images');
const panelContent = document.getElementById('panel-content');
const panelImages = document.getElementById('panel-images');
const imagesBadge = document.getElementById('images-badge');
const addRowBtn = document.getElementById('add-row');
const gridEl = document.getElementById('grid');
const gridHead = gridEl.querySelector('thead');
const gridBody = gridEl.querySelector('tbody');
const gridEmpty = document.getElementById('grid-empty');
const imageInput = document.getElementById('image-input');
const uploadLabel = document.getElementById('upload-label');
const galleryEl = document.getElementById('gallery');
const galleryEmpty = document.getElementById('gallery-empty');
const deletedWrap = document.getElementById('deleted-wrap');
const deletedList = document.getElementById('deleted-list');
const replaceInput = document.getElementById('replace-input');
const statusEl = document.getElementById('status');

const state = {
  owner: '',
  repo: '',
  branch: 'main',
  token: '',
  headers: DEFAULT_HEADERS.slice(),
  rows: [],
  remoteCsv: '',
  images: [],
  staged: new Map(),
  deleted: new Set(),
  connected: false,
  busy: false,
  replaceTarget: null
};

let webpSupport = null;

function parseCsv(text) {
  return CSV.parseCsv(text);
}

function serializeCsv(rows) {
  return CSV.serializeCsv(rows);
}

function readConfig() {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeConfig() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      owner: state.owner,
      repo: state.repo,
      branch: state.branch,
      token: state.token
    }));
  } catch {}
}

function detectRepo() {
  const host = location.hostname;
  const segments = location.pathname.split('/').filter(Boolean);
  if (host.endsWith('.github.io')) {
    const owner = host.slice(0, -'.github.io'.length);
    const repo = segments.length ? segments[0] : `${owner}.github.io`;
    return { owner, repo };
  }
  return { owner: '', repo: '' };
}

function setBadge(text, kind) {
  badgeEl.textContent = text;
  badgeEl.className = `badge ${kind || ''}`.trim();
}

function setStatus(message, kind, link) {
  statusEl.textContent = message;
  statusEl.className = `status ${kind || ''}`.trim();
  if (link) {
    const anchor = document.createElement('a');
    anchor.href = link;
    anchor.target = '_blank';
    anchor.rel = 'noreferrer';
    anchor.textContent = 'View commit';
    statusEl.append(' ', anchor);
  }
}

function repoApi(suffix) {
  return `/repos/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}${suffix}`;
}

function branchPath() {
  return state.branch.split('/').map((part) => encodeURIComponent(part)).join('/');
}

async function gh(path, options) {
  const settings = options || {};
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (settings.body) headers['Content-Type'] = 'application/json';
  const response = await fetch(`https://api.github.com${path}`, {
    method: settings.method || 'GET',
    body: settings.body,
    headers
  });
  const raw = await response.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const error = new Error(data && data.message ? data.message : `${response.status} ${response.statusText}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function decodeBase64Utf8(value) {
  const binary = atob(value.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function normalizeCsv(rawRows) {
  if (!rawRows.length) {
    return { headers: DEFAULT_HEADERS.slice(), rows: [] };
  }
  const first = rawRows[0];
  if (!first.some((value) => String(value).trim() !== '')) {
    return { headers: DEFAULT_HEADERS.slice(), rows: [] };
  }
  const headers = first.map((value, index) => String(value).trim() || `column_${index + 1}`);
  const rows = rawRows.slice(1).map((row) => {
    const copy = row.slice(0, headers.length).map((value) => String(value));
    while (copy.length < headers.length) copy.push('');
    return copy;
  });
  return { headers, rows };
}

function applyCsv(text) {
  const { headers, rows } = normalizeCsv(parseCsv(text));
  state.headers = headers;
  state.rows = rows;
  state.remoteCsv = serializeCsv([headers, ...rows]);
}

function csvText() {
  return serializeCsv([state.headers, ...state.rows]);
}

function isCsvDirty() {
  return state.connected && csvText() !== state.remoteCsv;
}

function isImagesDirty() {
  return state.staged.size > 0 || state.deleted.size > 0;
}

function isDirty() {
  return isCsvDirty() || isImagesDirty();
}

function imageColumnIndexes() {
  return state.headers
    .map((header, index) => ({ header: header.toLowerCase(), index }))
    .filter((item) => /image|photo|picture|img|thumbnail/.test(item.header))
    .map((item) => item.index);
}

function imageNames() {
  const names = new Set();
  for (const image of state.images) {
    if (!state.deleted.has(image.name)) names.add(image.name);
  }
  for (const name of state.staged.keys()) names.add(name);
  return [...names].sort((a, b) => a.localeCompare(b));
}

function imageSrc(name) {
  const staged = state.staged.get(name);
  if (staged && staged.blobUrl) return staged.blobUrl;
  const value = String(name || '');
  if (value.includes('/')) {
    return `./${value.split('/').map(encodeURIComponent).join('/')}`;
  }
  const image = state.images.find((img) => img.name === value);
  const version = image && image.sha ? image.sha.slice(0, 8) : '';
  return `./images/${encodeURIComponent(value)}?v=${version}`;
}

function imageReferences(name) {
  const cols = imageColumnIndexes();
  const refs = [];
  state.rows.forEach((row, index) => {
    if (cols.some((col) => row[col] === name)) refs.push(index + 2);
  });
  return refs;
}

function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function revokeImage(image) {
  if (image && image.blobUrl) URL.revokeObjectURL(image.blobUrl);
}

function clearStaged() {
  for (const image of state.staged.values()) revokeImage(image);
  state.staged.clear();
}

function updateControls() {
  const editable = state.connected && !state.busy;
  const dirty = isDirty();
  ownerEl.disabled = state.busy;
  repoEl.disabled = state.busy;
  branchEl.disabled = state.busy;
  tokenEl.disabled = state.busy;
  connectBtn.disabled = state.busy;
  reloadBtn.disabled = state.busy;
  forgetBtn.disabled = state.busy;
  saveBtn.disabled = !editable || !dirty;
  discardBtn.disabled = !editable || !dirty;
  addRowBtn.disabled = !editable;
  commitMessageEl.disabled = !editable;
  imageInput.disabled = !editable;
  uploadLabel.classList.toggle('disabled', !editable);
}

function updateDirty() {
  const dirty = isDirty();
  dirtyEl.textContent = dirty ? 'unsaved' : 'clean';
  dirtyEl.className = dirty ? 'pill dirty' : 'pill';
  const count = state.staged.size + state.deleted.size;
  imagesBadge.hidden = count === 0;
  imagesBadge.textContent = String(count);
  updateControls();
}

function renderGrid() {
  gridHead.replaceChildren();
  gridBody.replaceChildren();
  if (!state.headers.length) {
    gridEmpty.hidden = false;
    return;
  }
  gridEmpty.hidden = state.rows.length > 0;

  const headRow = document.createElement('tr');
  for (const header of state.headers) {
    const th = document.createElement('th');
    th.textContent = header;
    headRow.append(th);
  }
  const actionTh = document.createElement('th');
  actionTh.setAttribute('aria-label', 'Row actions');
  headRow.append(actionTh);
  gridHead.append(headRow);

  const imageCols = new Set(imageColumnIndexes());
  const names = imageNames();
  const editable = state.connected && !state.busy;

  state.rows.forEach((row, rowIndex) => {
    const tr = document.createElement('tr');
    state.headers.forEach((header, colIndex) => {
      const td = document.createElement('td');
      if (imageCols.has(colIndex)) {
        const wrap = document.createElement('div');
        wrap.className = 'cell-image';
        const select = document.createElement('select');
        select.disabled = !editable;
        select.setAttribute('aria-label', `${header} for row ${rowIndex + 2}`);
        const none = document.createElement('option');
        none.value = '';
        none.textContent = '— none —';
        select.append(none);
        const value = row[colIndex] || '';
        const options = names.slice();
        if (value && !options.includes(value)) options.unshift(value);
        for (const name of options) {
          const option = document.createElement('option');
          option.value = name;
          option.textContent = name;
          select.append(option);
        }
        select.value = value;
        const thumb = document.createElement('img');
        thumb.className = 'thumb';
        thumb.alt = '';
        thumb.loading = 'lazy';
        thumb.hidden = !value;
        if (value) thumb.src = imageSrc(value);
        thumb.addEventListener('error', () => {
          thumb.hidden = true;
        });
        select.addEventListener('change', () => {
          state.rows[rowIndex][colIndex] = select.value;
          if (select.value) {
            thumb.src = imageSrc(select.value);
            thumb.hidden = false;
          } else {
            thumb.hidden = true;
            thumb.removeAttribute('src');
          }
          updateDirty();
        });
        wrap.append(thumb, select);
        td.append(wrap);
      } else {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = row[colIndex] || '';
        input.disabled = !editable;
        input.setAttribute('aria-label', `${header} for row ${rowIndex + 2}`);
        input.addEventListener('input', () => {
          state.rows[rowIndex][colIndex] = input.value;
          updateDirty();
        });
        td.append(input);
      }
      tr.append(td);
    });

    const actions = document.createElement('td');
    actions.className = 'row-actions';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Delete';
    remove.disabled = !editable;
    remove.setAttribute('aria-label', `Delete row ${rowIndex + 2}`);
    remove.addEventListener('click', () => {
      state.rows.splice(rowIndex, 1);
      renderGrid();
      updateDirty();
    });
    actions.append(remove);
    tr.append(actions);
    gridBody.append(tr);
  });
}

function renderGallery() {
  galleryEl.replaceChildren();
  const editable = state.connected && !state.busy;
  const items = [];
  for (const image of state.images) {
    if (state.deleted.has(image.name) || state.staged.has(image.name)) continue;
    items.push({ ...image, staged: false });
  }
  for (const [name, image] of state.staged) {
    const existing = state.images.find((img) => img.name === name);
    items.push({
      name,
      size: image.size,
      sha: '',
      staged: true,
      isNew: !existing,
      originalSize: image.originalSize,
      width: image.width,
      height: image.height
    });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  galleryEmpty.hidden = items.length > 0;

  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'image-card';
    const img = document.createElement('img');
    img.alt = item.name;
    img.loading = 'lazy';
    img.src = imageSrc(item.name);
    const meta = document.createElement('div');
    meta.className = 'image-meta';
    const name = document.createElement('div');
    name.className = 'image-name';
    name.textContent = item.name;
    const sub = document.createElement('div');
    sub.className = 'image-sub';
    const parts = [];
    if (item.size) parts.push(formatBytes(item.size));
    if (item.width && item.height) parts.push(`${item.width}×${item.height}`);
    if (item.staged) parts.push(item.isNew ? 'new' : 'replaced');
    if (item.originalSize && item.size && item.originalSize > item.size) {
      parts.push(`was ${formatBytes(item.originalSize)}`);
    }
    sub.textContent = parts.join(' · ');
    meta.append(name, sub);
    if (item.staged) {
      const badge = document.createElement('span');
      badge.className = 'pill staged';
      badge.textContent = 'staged';
      meta.append(badge);
    }
    if (editable) {
      const actions = document.createElement('div');
      actions.className = 'image-actions';
      const replace = document.createElement('button');
      replace.type = 'button';
      replace.textContent = 'Replace';
      replace.addEventListener('click', () => {
        state.replaceTarget = item.name;
        replaceInput.value = '';
        replaceInput.click();
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'danger';
      remove.textContent = 'Delete';
      remove.addEventListener('click', () => deleteImage(item.name));
      actions.append(replace, remove);
      meta.append(actions);
    }
    card.append(img, meta);
    galleryEl.append(card);
  }
}

function renderDeleted() {
  deletedList.replaceChildren();
  deletedWrap.hidden = state.deleted.size === 0;
  for (const name of [...state.deleted].sort()) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const label = document.createElement('span');
    label.textContent = name;
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.textContent = 'Undo';
    undo.disabled = state.busy;
    undo.addEventListener('click', () => {
      state.deleted.delete(name);
      renderAll();
    });
    chip.append(label, undo);
    deletedList.append(chip);
  }
}

function renderAll() {
  renderGrid();
  renderGallery();
  renderDeleted();
  updateDirty();
}

function setBusy(busy, message) {
  state.busy = busy;
  if (message) setStatus(message, 'info');
  renderAll();
}

function addRow() {
  if (!state.connected || state.busy) return;
  const row = state.headers.map(() => '');
  const idIndex = state.headers.findIndex((header) => header.toLowerCase() === 'id');
  if (idIndex >= 0) {
    const max = state.rows.reduce((value, current) => {
      const parsed = Number.parseInt(current[idIndex], 10);
      return Number.isFinite(parsed) ? Math.max(value, parsed) : value;
    }, 0);
    row[idIndex] = String(max + 1);
  }
  state.rows.push(row);
  renderGrid();
  updateDirty();
  const firstInput = gridBody.querySelector('tr:last-child input, tr:last-child select');
  if (firstInput) firstInput.focus();
}

function deleteImage(name) {
  if (!state.connected || state.busy) return;
  const refs = imageReferences(name);
  if (refs.length) {
    setStatus(`Image "${name}" is used by row ${refs.join(', ')}. Clear those cells first.`, 'error');
    return;
  }
  const staged = state.staged.get(name);
  if (staged) {
    revokeImage(staged);
    state.staged.delete(name);
  }
  if (state.images.some((image) => image.name === name)) {
    state.deleted.add(name);
  }
  renderAll();
  setStatus(`Staged deletion of "${name}".`, 'info');
}

function sanitizeBase(name) {
  const base = String(name || 'image').replace(/\.[^.]+$/, '').toLowerCase();
  const slug = base
    .normalize('NFKD')
    .replace(/[^\w]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'image';
}

function extensionFor(type) {
  if (type === 'image/webp') return 'webp';
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/png') return 'png';
  if (type === 'image/gif') return 'gif';
  return 'img';
}

function uniqueImageName(name, ignoreName) {
  const used = new Set([
    ...state.images.map((image) => image.name),
    ...state.staged.keys(),
    ...state.deleted
  ]);
  if (ignoreName) used.delete(ignoreName);
  if (!used.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let counter = 2;
  let candidate = `${base}-${counter}${ext}`;
  while (used.has(candidate)) {
    counter += 1;
    candidate = `${base}-${counter}${ext}`;
  }
  return candidate;
}

function supportsWebp() {
  if (webpSupport !== null) return webpSupport;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  webpSupport = canvas.toDataURL('image/webp').startsWith('data:image/webp');
  return webpSupport;
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read the image.'));
    };
    img.src = url;
  });
}

function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return createImageBitmap(file).catch(() => loadImageElement(file));
    } catch {
      return loadImageElement(file);
    }
  }
  return loadImageElement(file);
}

async function prepareImage(file, options) {
  const opts = options || {};
  if (!UPLOAD_TYPES.has(file.type)) {
    throw new Error('Only PNG, JPEG, WebP, and GIF images are allowed.');
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error('Image is larger than 20 MB.');
  }
  const base = sanitizeBase(opts.baseName || file.name);

  if (file.type === 'image/gif') {
    const buffer = await file.arrayBuffer();
    const name = uniqueImageName(`${base}.gif`, opts.ignoreName);
    return {
      name,
      base64: arrayBufferToBase64(buffer),
      size: file.size,
      type: file.type,
      originalSize: file.size,
      width: null,
      height: null,
      blobUrl: URL.createObjectURL(file),
      isNew: true
    };
  }

  const bitmap = await loadBitmap(file);
  const sourceWidth = bitmap.naturalWidth || bitmap.width;
  const sourceHeight = bitmap.naturalHeight || bitmap.height;
  const scale = Math.min(1, MAX_DIMENSION / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not process the image.');
  context.drawImage(bitmap, 0, 0, width, height);
  if (typeof bitmap.close === 'function') bitmap.close();

  const outputType = supportsWebp() ? 'image/webp' : 'image/jpeg';
  const compressed = await new Promise((resolve) => canvas.toBlob(resolve, outputType, 0.85));
  let blob = compressed;
  let type = outputType;
  if (!blob) {
    blob = file;
    type = file.type;
  } else if (scale === 1 && blob.size >= file.size) {
    blob = file;
    type = file.type;
  }

  const name = uniqueImageName(`${base}.${extensionFor(type)}`, opts.ignoreName);
  const buffer = await blob.arrayBuffer();
  return {
    name,
    base64: arrayBufferToBase64(buffer),
    size: blob.size,
    type,
    originalSize: file.size,
    width,
    height,
    blobUrl: URL.createObjectURL(blob),
    isNew: true
  };
}

async function handleUpload(fileList) {
  if (!state.connected || state.busy) return;
  const files = [...fileList];
  if (!files.length) return;
  setBusy(true, `Preparing ${files.length} image${files.length === 1 ? '' : 's'}...`);
  const errors = [];
  let added = 0;
  for (const file of files) {
    try {
      const image = await prepareImage(file);
      state.staged.set(image.name, image);
      added += 1;
    } catch (error) {
      errors.push(`${file.name}: ${error.message}`);
    }
  }
  imageInput.value = '';
  setBusy(false);
  if (errors.length) {
    setStatus(errors.join(' '), 'error');
  } else if (added) {
    setStatus(`Staged ${added} image${added === 1 ? '' : 's'}. Save to commit.`, 'ok');
  }
}

async function handleReplace(file) {
  const oldName = state.replaceTarget;
  state.replaceTarget = null;
  if (!file || !oldName || !state.connected || state.busy) return;
  setBusy(true, `Preparing replacement for ${oldName}...`);
  try {
    const image = await prepareImage(file, {
      baseName: oldName.replace(/\.[^.]+$/, ''),
      ignoreName: oldName
    });
    const existing = state.images.find((img) => img.name === oldName);
    const oldStaged = state.staged.get(oldName);
    if (image.name !== oldName) {
      for (const row of state.rows) {
        for (const col of imageColumnIndexes()) {
          if (row[col] === oldName) row[col] = image.name;
        }
      }
      if (oldStaged) {
        revokeImage(oldStaged);
        state.staged.delete(oldName);
      }
      if (existing) state.deleted.add(oldName);
    } else if (oldStaged) {
      revokeImage(oldStaged);
      state.staged.delete(oldName);
    }
    image.isNew = !existing;
    state.staged.set(image.name, image);
    setBusy(false);
    setStatus(`Staged replacement for "${oldName}". Save to commit.`, 'ok');
  } catch (error) {
    setBusy(false);
    setStatus(error.message || 'Could not prepare the replacement.', 'error');
  } finally {
    replaceInput.value = '';
  }
}

function discard() {
  if (!isDirty()) return;
  if (!window.confirm('Discard all unsaved changes?')) return;
  applyCsv(state.remoteCsv);
  clearStaged();
  state.deleted.clear();
  renderAll();
  setStatus('Discarded unsaved changes.', 'info');
}

async function loadFile() {
  const path = repoApi(`/contents/${FILE_PATH}?ref=${encodeURIComponent(state.branch)}&t=${Date.now()}`);
  try {
    const data = await gh(path);
    if (data.encoding !== 'base64' || typeof data.content !== 'string') {
      throw new Error('The file is too large for the Contents API.');
    }
    return decodeBase64Utf8(data.content);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function loadImages() {
  const path = repoApi(`/contents/${IMAGE_DIR}?ref=${encodeURIComponent(state.branch)}&t=${Date.now()}`);
  try {
    const data = await gh(path);
    if (!Array.isArray(data)) return [];
    return data
      .filter((item) => item.type === 'file' && IMAGE_EXTENSIONS.test(item.name))
      .map((item) => ({ name: item.name, sha: item.sha, size: item.size }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
}

async function connect(options) {
  const opts = options || {};
  const next = {
    owner: ownerEl.value.trim(),
    repo: repoEl.value.trim(),
    branch: branchEl.value.trim() || 'main',
    token: tokenEl.value.trim()
  };
  if (!next.owner || !next.repo || !next.branch || !next.token) {
    if (!opts.silent) setStatus('Fill in owner, repository, branch, and token.', 'error');
    return;
  }
  if (!opts.silent && isDirty() && !window.confirm('This will discard unsaved changes. Continue?')) {
    return;
  }

  state.owner = next.owner;
  state.repo = next.repo;
  state.branch = next.branch;
  state.token = next.token;
  writeConfig();
  setBadge('Connecting...', 'pending');
  setBusy(true, 'Connecting...');

  try {
    await gh(repoApi(`?t=${Date.now()}`));
    const text = await loadFile();
    if (text === null) {
      applyCsv(serializeCsv([DEFAULT_HEADERS]));
    } else {
      applyCsv(text);
    }
    try {
      state.images = await loadImages();
    } catch {
      state.images = [];
    }
    clearStaged();
    state.deleted.clear();
    state.connected = true;
    setupDetails.open = false;
    setBusy(false);
    setBadge('Connected', 'ok');
    if (text === null) {
      setStatus(`${FILE_PATH} does not exist yet. Saving will create it.`, 'info');
    } else {
      setStatus(`Loaded ${state.rows.length} rows and ${state.images.length} image${state.images.length === 1 ? '' : 's'}.`, 'ok');
    }
    updateTokenLink();
  } catch (error) {
    state.connected = false;
    setBusy(false);
    setBadge('Not connected', 'bad');
    setupDetails.open = true;
    handleError(error);
  }
}

async function loadPublic() {
  state.owner = ownerEl.value.trim();
  state.repo = repoEl.value.trim();
  state.branch = branchEl.value.trim() || 'main';
  setBusy(true, 'Loading...');
  let csvLoaded = false;
  try {
    const response = await fetch(`./data.csv?t=${Date.now()}`, { cache: 'no-store' });
    if (response.ok) {
      applyCsv(await response.text());
      csvLoaded = true;
    } else if (response.status !== 404) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
  } catch {}
  if (!csvLoaded) {
    applyCsv(serializeCsv([DEFAULT_HEADERS]));
  }

  state.connected = false;
  state.images = [];
  try {
    if (state.owner && state.repo) {
      state.images = await loadImages();
    }
  } catch {}
  if (!state.images.length) {
    const referenced = new Set();
    for (const row of state.rows) {
      for (const index of imageColumnIndexes()) {
        if (row[index]) referenced.add(row[index]);
      }
    }
    state.images = [...referenced].sort().map((name) => ({ name, sha: '', size: null }));
  }

  clearStaged();
  state.deleted.clear();
  setBusy(false);
  if (csvLoaded) {
    setStatus('Showing the deployed content. Connect to edit.', 'info');
  } else {
    setStatus('Connect with a token to load the content from GitHub.', 'info');
  }
}

async function commitChanges(changes, message) {
  const ref = await gh(repoApi(`/git/ref/heads/${branchPath()}`));
  const parent = ref.object.sha;
  const parentCommit = await gh(repoApi(`/git/commits/${parent}`));
  const baseTree = parentCommit.tree.sha;
  const tree = [];
  const blobs = new Map();

  for (const change of changes) {
    if (change.delete) {
      tree.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
    } else {
      const blob = await gh(repoApi('/git/blobs'), {
        method: 'POST',
        body: JSON.stringify({ content: change.content, encoding: change.encoding })
      });
      blobs.set(change.path, blob.sha);
      tree.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
  }

  const newTree = await gh(repoApi('/git/trees'), {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTree, tree })
  });
  const commit = await gh(repoApi('/git/commits'), {
    method: 'POST',
    body: JSON.stringify({ message, tree: newTree.sha, parents: [parent] })
  });
  await gh(repoApi(`/git/refs/heads/${branchPath()}`), {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha })
  });
  return { commit, blobs };
}

async function atomicCommit(changes, message) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await commitChanges(changes, message);
    } catch (error) {
      lastError = error;
      if (error.status !== 422 || attempt === 2) throw error;
    }
  }
  throw lastError;
}

async function save() {
  if (!state.connected) {
    setStatus('Connect with a token before saving.', 'error');
    return;
  }
  if (!isDirty()) {
    setStatus('No changes to save.', 'info');
    return;
  }
  if (state.busy) return;

  const message = commitMessageEl.value.trim() || 'Update content from the web editor';
  const text = csvText();
  const csvChanged = isCsvDirty();
  const staged = [...state.staged.values()];
  const deleted = [...state.deleted];
  const changes = [];
  if (csvChanged) changes.push({ path: FILE_PATH, content: text, encoding: 'utf-8' });
  for (const image of staged) {
    changes.push({ path: `${IMAGE_DIR}/${image.name}`, content: image.base64, encoding: 'base64' });
  }
  for (const name of deleted) {
    changes.push({ path: `${IMAGE_DIR}/${name}`, delete: true });
  }
  if (!changes.length) {
    setStatus('No changes to save.', 'info');
    return;
  }

  setBusy(true, 'Saving...');
  try {
    const result = await atomicCommit(changes, message);
    state.remoteCsv = text;

    const deletedSet = new Set(deleted);
    const stagedMap = new Map(staged.map((image) => [image.name, image]));
    const fallback = state.images.filter((image) => !deletedSet.has(image.name));
    for (const [name, image] of stagedMap) {
      const path = `${IMAGE_DIR}/${name}`;
      const sha = result.blobs.get(path);
      const existing = fallback.find((item) => item.name === name);
      if (existing) {
        existing.sha = sha || existing.sha;
        existing.size = image.size;
      } else {
        fallback.push({ name, sha: sha || '', size: image.size });
      }
    }
    fallback.sort((a, b) => a.name.localeCompare(b.name));
    state.images = fallback;
    clearStaged();
    state.deleted.clear();
    try {
      state.images = await loadImages();
    } catch {}

    setBusy(false);
    setStatus(
      `Saved ${changes.length} file${changes.length === 1 ? '' : 's'} in ${result.commit.sha.slice(0, 7)}. Pages will redeploy in about a minute.`,
      'ok',
      result.commit.html_url
    );
  } catch (error) {
    setBusy(false);
    handleError(error);
  }
}

async function reload() {
  if (state.busy) return;
  if (state.token && ownerEl.value.trim() && repoEl.value.trim()) {
    await connect();
  } else {
    await loadPublic();
  }
}

function forget() {
  if (isDirty() && !window.confirm('Forget the token and discard unsaved changes?')) return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
  state.token = '';
  tokenEl.value = '';
  state.connected = false;
  clearStaged();
  state.deleted.clear();
  setBadge('Not connected', 'bad');
  renderAll();
  setupDetails.open = true;
  setStatus('Token forgotten. Content is read-only.', 'info');
}

function handleError(error) {
  if (error && error.status === 401) {
    setStatus('GitHub rejected the token (401). Create a new token and reconnect.', 'error');
  } else if (error && error.status === 403) {
    const message = error.data && error.data.message ? error.data.message : '';
    if (/rate limit/i.test(message)) {
      setStatus('GitHub API rate limit reached. Wait a bit and try again.', 'error');
    } else {
      setStatus('The token cannot write here (403). Check Contents: Read and write, expiry, and SSO.', 'error');
    }
  } else if (error && error.status === 404) {
    setStatus('Repository, branch, or path not found (404). Check owner, repo, branch, and token access.', 'error');
  } else if (error && (error.status === 409 || error.status === 422)) {
    setStatus('The branch changed while saving. Reload and reapply your changes.', 'error');
  } else if (error && error.status === 413) {
    setStatus('A file is too large for the GitHub API.', 'error');
  } else if (error instanceof TypeError) {
    setStatus('Network or CORS error. Check your connection and try again.', 'error');
  } else {
    setStatus((error && error.message) || 'Request failed.', 'error');
  }
}

function updateTokenLink() {
  const url = new URL('https://github.com/settings/personal-access-tokens/new');
  url.searchParams.set('name', 'Sandbox CSV Editor');
  url.searchParams.set('description', 'Contents read/write for the sandbox CSV editor');
  url.searchParams.set('contents', 'write');
  url.searchParams.set('expires_in', '7');
  const owner = state.owner || ownerEl.value.trim();
  if (owner) url.searchParams.set('target_name', owner);
  tokenLink.href = url.toString();
}

function activateTab(name) {
  const content = name === 'content';
  tabContentBtn.setAttribute('aria-selected', String(content));
  tabImagesBtn.setAttribute('aria-selected', String(!content));
  tabContentBtn.tabIndex = content ? 0 : -1;
  tabImagesBtn.tabIndex = content ? -1 : 0;
  panelContent.hidden = !content;
  panelImages.hidden = content;
}

function init() {
  const detected = detectRepo();
  const saved = readConfig();
  ownerEl.value = saved.owner || detected.owner || '';
  repoEl.value = saved.repo || detected.repo || '';
  branchEl.value = saved.branch || 'main';
  tokenEl.value = saved.token || '';
  state.owner = ownerEl.value;
  state.repo = repoEl.value;
  state.branch = branchEl.value;
  state.token = tokenEl.value;
  updateTokenLink();
  activateTab('content');

  setupForm.addEventListener('submit', (event) => {
    event.preventDefault();
    connect();
  });
  reloadBtn.addEventListener('click', reload);
  forgetBtn.addEventListener('click', forget);
  saveBtn.addEventListener('click', save);
  discardBtn.addEventListener('click', discard);
  addRowBtn.addEventListener('click', addRow);
  tabContentBtn.addEventListener('click', () => activateTab('content'));
  tabImagesBtn.addEventListener('click', () => activateTab('images'));
  imageInput.addEventListener('change', () => handleUpload(imageInput.files));
  replaceInput.addEventListener('change', () => handleReplace(replaceInput.files[0]));
  ownerEl.addEventListener('input', updateTokenLink);
  window.addEventListener('beforeunload', (event) => {
    if (isDirty()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  if (state.token && state.owner && state.repo) {
    setupDetails.open = false;
    connect({ silent: true });
  } else {
    loadPublic();
  }
}

init();
