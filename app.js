const FILE_PATH = 'data.json';
const STORAGE_KEY = 'pages-self-editor';

const ownerEl = document.getElementById('owner');
const repoEl = document.getElementById('repo');
const branchEl = document.getElementById('branch');
const tokenEl = document.getElementById('token');
const tokenLink = document.getElementById('token-link');
const setupForm = document.getElementById('setup-form');
const setupDetails = document.getElementById('setup-details');
const badgeEl = document.getElementById('connection-badge');
const viewerEl = document.getElementById('viewer');
const editorEl = document.getElementById('editor');
const dirtyEl = document.getElementById('dirty');
const statusEl = document.getElementById('status');
const reloadBtn = document.getElementById('reload');
const commitBtn = document.getElementById('commit');
const resetBtn = document.getElementById('reset');
const forgetBtn = document.getElementById('forget');

const state = {
  owner: '',
  repo: '',
  branch: 'main',
  token: '',
  sha: null,
  remoteText: ''
};

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
  } catch {
    return;
  }
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

function setDirty() {
  const dirty = editorEl.value !== state.remoteText;
  dirtyEl.textContent = dirty ? 'unsaved' : 'clean';
  dirtyEl.className = dirty ? 'pill dirty' : 'pill';
}

function render(text) {
  if (!text.trim()) {
    viewerEl.textContent = 'No data.json content yet.';
    return;
  }
  try {
    viewerEl.textContent = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    viewerEl.textContent = text;
  }
}

function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decodeBase64Utf8(value) {
  const binary = atob(value.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

async function gh(path, options) {
  const settings = options || {};
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${state.token}`,
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (settings.body) {
    headers['Content-Type'] = 'application/json';
  }
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

async function loadFile() {
  const stamp = Date.now();
  try {
    const data = await gh(`/repos/${state.owner}/${state.repo}/contents/${FILE_PATH}?ref=${encodeURIComponent(state.branch)}&t=${stamp}`);
    if (data.encoding !== 'base64' || typeof data.content !== 'string') {
      throw new Error('This file is too large for the simple Contents API demo.');
    }
    return { text: decodeBase64Utf8(data.content), sha: data.sha };
  } catch (error) {
    if (error.status === 404) {
      return { text: '', sha: null };
    }
    throw error;
  }
}

function handleError(error) {
  if (error.status === 401) {
    setStatus('GitHub rejected the token (401). Check that it is valid.', 'error');
  } else if (error.status === 403) {
    setStatus('The token cannot write here (403). Check Contents: Read and write and any SSO authorization.', 'error');
  } else if (error.status === 404) {
    setStatus('Repository, branch, or file not found (404). Check the owner, repo, branch, and token access.', 'error');
  } else if (error.status === 409 || error.status === 422) {
    setStatus('Conflict: the file changed on GitHub. Click Reload and reapply your edit.', 'error');
  } else {
    setStatus(error.message || 'Request failed.', 'error');
  }
}

async function connect(options) {
  const opts = options || {};
  state.owner = ownerEl.value.trim();
  state.repo = repoEl.value.trim();
  state.branch = branchEl.value.trim() || 'main';
  state.token = tokenEl.value.trim();

  if (!state.owner || !state.repo || !state.branch || !state.token) {
    if (!opts.silent) {
      setStatus('Fill in owner, repository, branch, and token.', 'error');
    }
    return;
  }

  writeConfig();
  setBadge('Connecting...', 'pending');
  commitBtn.disabled = true;
  reloadBtn.disabled = true;

  try {
    await gh(`/repos/${state.owner}/${state.repo}?t=${Date.now()}`);
    const file = await loadFile();
    state.sha = file.sha;
    state.remoteText = file.text;
    editorEl.value = file.text;
    render(file.text);
    setDirty();
    setBadge('Connected', 'ok');
    setupDetails.open = false;
    if (state.sha) {
      setStatus(`Loaded ${FILE_PATH} at ${state.sha.slice(0, 7)}.`, 'ok');
    } else {
      setStatus(`${FILE_PATH} does not exist yet. Committing will create it.`, 'info');
    }
    updateTokenLink();
  } catch (error) {
    setBadge('Not connected', 'bad');
    setupDetails.open = true;
    handleError(error);
  } finally {
    commitBtn.disabled = false;
    reloadBtn.disabled = false;
  }
}

async function commit() {
  if (!state.token) {
    setStatus('Connect with a token before committing.', 'error');
    return;
  }
  if (!state.owner || !state.repo) {
    setStatus('Connect to a repository before committing.', 'error');
    return;
  }
  const text = editorEl.value;
  try {
    JSON.parse(text);
  } catch (error) {
    setStatus(`Invalid JSON: ${error.message}`, 'error');
    return;
  }

  commitBtn.disabled = true;
  reloadBtn.disabled = true;
  setStatus('Committing...', 'info');
  try {
    const body = {
      message: `Update ${FILE_PATH} from the web editor`,
      content: encodeBase64Utf8(text),
      branch: state.branch
    };
    if (state.sha) {
      body.sha = state.sha;
    }
    const result = await gh(`/repos/${state.owner}/${state.repo}/contents/${FILE_PATH}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    state.sha = result.content.sha;
    state.remoteText = text;
    setDirty();
    render(text);
    setStatus(`Committed ${result.commit.sha.slice(0, 7)}. Pages will redeploy in about a minute.`, 'ok', result.commit.html_url);
  } catch (error) {
    handleError(error);
  } finally {
    commitBtn.disabled = false;
    reloadBtn.disabled = false;
  }
}

async function loadPublic() {
  try {
    const response = await fetch(`./${FILE_PATH}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`${response.status}`);
    }
    const text = await response.text();
    state.remoteText = text;
    editorEl.value = text;
    render(text);
    setDirty();
    setStatus('Showing the deployed file. Connect to edit and commit.', 'info');
  } catch {
    setStatus('Connect with a token to load the file from GitHub.', 'info');
  }
}

function updateTokenLink() {
  const url = new URL('https://github.com/settings/personal-access-tokens/new');
  url.searchParams.set('name', 'Pages Self-Editor');
  url.searchParams.set('description', 'Contents read/write for the Pages self-editor proof of concept');
  url.searchParams.set('contents', 'write');
  url.searchParams.set('expires_in', '7');
  const owner = state.owner || ownerEl.value.trim();
  if (owner) {
    url.searchParams.set('target_name', owner);
  }
  tokenLink.href = url.toString();
}

function forget() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
  state.token = '';
  tokenEl.value = '';
  setBadge('Not connected', 'bad');
  setStatus('Token forgotten for this tab.', 'info');
}

function reset() {
  editorEl.value = state.remoteText;
  setDirty();
  setStatus('Editor reset to the loaded content.', 'info');
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

  setupForm.addEventListener('submit', (event) => {
    event.preventDefault();
    connect();
  });
  reloadBtn.addEventListener('click', () => connect());
  commitBtn.addEventListener('click', commit);
  resetBtn.addEventListener('click', reset);
  forgetBtn.addEventListener('click', forget);
  editorEl.addEventListener('input', setDirty);
  ownerEl.addEventListener('input', updateTokenLink);

  if (state.token && state.owner && state.repo) {
    setupDetails.open = false;
    connect({ silent: true });
  } else {
    loadPublic();
  }
}

init();
