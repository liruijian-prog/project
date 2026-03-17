const express = require('express');
const fs = require('fs');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
const { OpenAI } = require('openai');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;

    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value.replace(/\\n/g, '\n');
  }
}

loadEnvFile(path.join(__dirname, '.env'));
loadEnvFile(path.join(__dirname, '.env.example'));

const app = express();
const PORT = process.env.PORT || 3000;

const PROJECT_ROOT = __dirname;
const DEFAULT_SCAN_ROOTS = ['skill'];
const MEMO_DIR = path.join(__dirname, 'memo');
const ANALYSIS_DIR = path.join(__dirname, 'analysis');
const LEGACY_RESULT_DIR = path.join(__dirname, 'result');
const BATCH_ASK_DIR = path.join(__dirname, 'batch-ask');
const OPENROUTER_MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

if (!fs.existsSync(ANALYSIS_DIR)) {
  fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
}
if (!fs.existsSync(LEGACY_RESULT_DIR)) {
  fs.mkdirSync(LEGACY_RESULT_DIR, { recursive: true });
}
if (!fs.existsSync(MEMO_DIR)) {
  fs.mkdirSync(MEMO_DIR, { recursive: true });
}
if (!fs.existsSync(BATCH_ASK_DIR)) {
  fs.mkdirSync(BATCH_ASK_DIR, { recursive: true });
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[warn] ANTHROPIC_API_KEY is not set. AI analysis will fail.');
}
if (!process.env.OPENROUTER_API_KEY) {
  console.warn('[warn] OPENROUTER_API_KEY is not set. Batch Ask will fail.');
}

const anthropic = new Anthropic();
const openRouterModelsCache = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/favicon.ico', (_req, res) => {
  const rootFavicon = path.join(__dirname, 'favicon.ico');
  const publicFavicon = path.join(__dirname, 'public', 'favicon.ico');
  const faviconPath = fs.existsSync(rootFavicon) ? rootFavicon : publicFavicon;
  if (!fs.existsSync(faviconPath)) return res.sendStatus(404);
  res.setHeader('Cache-Control', 'no-cache');
  return res.sendFile(faviconPath);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const MARKITDOWN_BIN = path.join(__dirname, '.markitdown-venv/bin/markitdown');
const CONVERTIBLE_EXTS = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.xls', '.html', '.htm', '.csv', '.json', '.xml', '.epub']);

function convertToMarkdown(filePath) {
  return new Promise((resolve, reject) => {
    execFile(MARKITDOWN_BIN, [filePath], { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

async function scanDirectory(dir, base = '') {
  const items = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return items;
  }

  const conversionPromises = [];

  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      items.push({
        type: 'dir',
        name: entry.name,
        path: rel,
        children: await scanDirectory(path.join(dir, entry.name), rel),
      });
    } else if (entry.name.endsWith('.md')) {
      items.push({ type: 'file', name: entry.name, path: rel });
    } else if (CONVERTIBLE_EXTS.has(path.extname(entry.name).toLowerCase())) {
      const mdName = entry.name.replace(/\.[^.]+$/, '.md');
      const mdAbsPath = path.join(dir, mdName);
      const mdRel = base ? `${base}/${mdName}` : mdName;

      // If .md version already exists, skip (will appear as normal .md entry)
      if (!fs.existsSync(mdAbsPath)) {
        const absPath = path.join(dir, entry.name);
        conversionPromises.push(
          convertToMarkdown(absPath)
            .then(mdContent => {
              fs.writeFileSync(mdAbsPath, mdContent, 'utf-8');
              console.log(`[convert] ${entry.name} → ${mdName}`);
              items.push({ type: 'file', name: mdName, path: mdRel });
            })
            .catch(err => {
              console.error(`[convert] Failed to convert ${entry.name}:`, err.message);
            })
        );
      }
    }
  }

  await Promise.all(conversionPromises);
  return items;
}

function normalizeRelativePath(value) {
  if (typeof value !== 'string') return '';
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
  return normalized === '.' ? '' : normalized;
}

function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveRoots(rawRoots) {
  const source = rawRoots == null
    ? DEFAULT_SCAN_ROOTS
    : Array.isArray(rawRoots)
      ? rawRoots
      : [rawRoots];
  const roots = [];
  const seen = new Set();

  for (const rawRoot of source) {
    const rel = normalizeRelativePath(rawRoot);
    if (!rel) continue;

    const abs = path.resolve(PROJECT_ROOT, rel);
    if (!isWithin(PROJECT_ROOT, abs)) continue;

    const normalizedRel = path.relative(PROJECT_ROOT, abs).replace(/\\/g, '/');
    if (!normalizedRel || seen.has(normalizedRel)) continue;

    seen.add(normalizedRel);
    roots.push({ rel: normalizedRel, abs });
  }

  return roots;
}

async function scanRoots(roots) {
  const items = [];

  for (const root of roots) {
    let stat;
    try {
      stat = fs.statSync(root.abs);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    items.push({
      type: 'dir',
      name: root.rel,
      path: root.rel,
      children: await scanDirectory(root.abs, root.rel),
    });
  }

  return items;
}

function safeMemoId(value) {
  const id = String(value || '').trim();
  return /^[a-z0-9][a-z0-9_-]{2,63}$/i.test(id) ? id : null;
}

function memoFilePath(id) {
  const safeId = safeMemoId(id);
  if (!safeId) throw new Error('Invalid memo id');
  return path.join(MEMO_DIR, `${safeId}.json`);
}

function memoSummary(memo) {
  return {
    id: memo.id,
    name: memo.name,
    count: memo.entries.length,
    updatedAt: memo.updatedAt || memo.createdAt || null,
  };
}

function normalizeMemoRecord(record, fallbackId) {
  const id = safeMemoId(record?.id) || fallbackId;
  if (!id) throw new Error('Invalid memo id');

  const entries = Array.isArray(record?.entries)
    ? record.entries
        .map(entry => ({
          text: String(entry?.text || '').trim(),
          sourcePath: String(entry?.sourcePath || '').trim(),
        }))
        .filter(entry => entry.text && entry.sourcePath)
    : [];

  return {
    id,
    name: String(record?.name || id).trim() || id,
    entries,
    createdAt: record?.createdAt || new Date().toISOString(),
    updatedAt: record?.updatedAt || record?.createdAt || new Date().toISOString(),
  };
}

function readMemo(id) {
  const filePath = memoFilePath(id);
  if (!fs.existsSync(filePath)) throw new Error('Memo not found');
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return normalizeMemoRecord(raw, id);
}

function writeMemo(memo) {
  const normalized = normalizeMemoRecord(memo, memo.id);
  fs.writeFileSync(memoFilePath(normalized.id), JSON.stringify(normalized, null, 2));
  return normalized;
}

function listMemos() {
  const files = fs.readdirSync(MEMO_DIR)
    .filter(name => name.endsWith('.json'))
    .sort();

  const memos = [];
  for (const file of files) {
    const id = path.basename(file, '.json');
    try {
      memos.push(readMemo(id));
    } catch {
      // ignore malformed memo files
    }
  }
  return memos.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

function nextMemoName(memos) {
  const used = new Set(memos.map(memo => memo.name));
  let index = 1;
  while (used.has(`备忘录 ${String(index).padStart(2, '0')}`)) index += 1;
  return `备忘录 ${String(index).padStart(2, '0')}`;
}

function createMemo(name = '') {
  const memos = listMemos();
  const memo = {
    id: `memo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: String(name || '').trim() || nextMemoName(memos),
    entries: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return writeMemo(memo);
}

function ensureMemoSeed() {
  const memos = listMemos();
  if (memos.length) return memos;
  createMemo('备忘录 01');
  return listMemos();
}

function parseMarkdownBlocks(content) {
  const blocks = [];
  let id = 0;

  // Frontmatter
  let rest = content;
  const fmMatch = rest.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fmMatch) {
    const raw = fmMatch[1];
    const meta = {};
    raw.split('\n').forEach(line => {
      const colon = line.indexOf(':');
      if (colon > 0) meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    });
    blocks.push({ id: id++, type: 'frontmatter', heading: '文档元信息', content: fmMatch[0].trim(), meta });
    rest = rest.slice(fmMatch[0].length).trimStart();
  }

  // Split on H1 and H2 headings (keep delimiter via lookahead)
  const sections = rest.split(/(?=^#{1,2} )/m).filter(s => s.trim());

  for (const section of sections) {
    const hMatch = section.match(/^(#{1,2}) (.+)/);
    if (hMatch) {
      const level = hMatch[1].length;
      blocks.push({
        id: id++,
        type: level === 1 ? 'h1' : 'h2',
        heading: hMatch[2].trim(),
        content: section.trim(),
      });
    } else if (section.trim()) {
      blocks.push({ id: id++, type: 'text', heading: '简介', content: section.trim() });
    }
  }

  for (const block of blocks) {
    block.persistKey = createBlockPersistKey(block);
  }

  return blocks;
}

function createBlockPersistKey(block) {
  const signature = crypto
    .createHash('sha1')
    .update([block.type, block.heading, block.content].join('\n\n'))
    .digest('hex')
    .slice(0, 16);
  return `${block.type}-${signature}`;
}

function legacyCacheKey(filePath) {
  return filePath.replace(/[/\\]/g, '__').replace(/\.md$/, '');
}

function analysisFilePath(fullPath) {
  const absolute = path.resolve(fullPath);
  const relative = path.relative(PROJECT_ROOT, absolute).replace(/\\/g, '/');
  const baseName = path.basename(absolute, path.extname(absolute)) || 'document';
  const readable = sanitizeFileSegment(`${relative || baseName}`.replace(/\//g, '__'), 'document');
  const hash = crypto.createHash('sha1').update(absolute.toLowerCase()).digest('hex').slice(0, 12);
  return path.join(ANALYSIS_DIR, `${readable}__${hash}.json`);
}

function legacyAnalysisFilePaths(filePath, fullPath) {
  const candidates = new Set();
  const normalizedRequestPath = normalizeRelativePath(filePath);
  if (normalizedRequestPath) candidates.add(legacyCacheKey(normalizedRequestPath));

  const relativePath = path.relative(PROJECT_ROOT, fullPath).replace(/\\/g, '/');
  const segments = relativePath.split('/').filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    const suffixPath = segments.slice(index).join('/');
    if (suffixPath) candidates.add(legacyCacheKey(suffixPath));
  }

  return [...candidates].map(key => path.join(LEGACY_RESULT_DIR, `${key}.json`));
}

function normalizeAnalysisStore(raw) {
  if (raw && typeof raw === 'object' && raw.version === 2 && raw.blocks && typeof raw.blocks === 'object') {
    const blocks = {};
    for (const [key, record] of Object.entries(raw.blocks)) {
      const text = String(record?.text || '').trim();
      if (!text) continue;
      blocks[key] = {
        text,
        heading: String(record?.heading || '').trim(),
        type: String(record?.type || '').trim(),
        updatedAt: record?.updatedAt || raw.updatedAt || new Date().toISOString(),
      };
    }
    return {
      version: 2,
      sourcePath: String(raw.sourcePath || '').trim(),
      updatedAt: raw.updatedAt || new Date().toISOString(),
      blocks,
    };
  }

  const legacyById = {};
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (!text) continue;
      legacyById[String(key)] = text;
    }
  }

  return {
    version: 2,
    sourcePath: '',
    updatedAt: new Date().toISOString(),
    blocks: {},
    legacyById,
  };
}

function readJsonFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function saveAnalysisStore(fullPath, store) {
  const filePath = analysisFilePath(fullPath);
  const payload = {
    version: 2,
    sourcePath: path.resolve(fullPath),
    updatedAt: store.updatedAt || new Date().toISOString(),
    blocks: store.blocks || {},
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function mapAnalysesToCurrentBlocks(store, blocks) {
  const analyses = {};
  for (const block of blocks) {
    const persisted = store.blocks?.[block.persistKey]?.text;
    if (persisted) {
      analyses[String(block.id)] = persisted;
      continue;
    }
    const legacy = store.legacyById?.[String(block.id)];
    if (legacy) analyses[String(block.id)] = legacy;
  }
  return analyses;
}

function loadAnalysisStore(filePath, fullPath, blocks = []) {
  const primaryPath = analysisFilePath(fullPath);
  const primaryRaw = readJsonFileIfExists(primaryPath);
  let store = normalizeAnalysisStore(primaryRaw);

  if (!primaryRaw) {
    for (const legacyPath of legacyAnalysisFilePaths(filePath, fullPath)) {
      const legacyRaw = readJsonFileIfExists(legacyPath);
      if (!legacyRaw) continue;
      store = normalizeAnalysisStore(legacyRaw);
      break;
    }
  }

  let dirty = false;
  for (const block of blocks) {
    const legacyText = store.legacyById?.[String(block.id)];
    if (!legacyText || store.blocks?.[block.persistKey]?.text) continue;
    store.blocks[block.persistKey] = {
      text: legacyText,
      heading: block.heading,
      type: block.type,
      updatedAt: new Date().toISOString(),
    };
    dirty = true;
  }

  if (dirty) {
    store.updatedAt = new Date().toISOString();
    delete store.legacyById;
    saveAnalysisStore(fullPath, store);
  }

  return store;
}

function safePath(filePath, roots) {
  const normalizedFilePath = normalizeRelativePath(filePath);
  if (!normalizedFilePath) throw new Error('Forbidden');

  const full = path.resolve(PROJECT_ROOT, normalizedFilePath);
  if (!isWithin(PROJECT_ROOT, full)) throw new Error('Forbidden');
  if (!roots.some(root => isWithin(root.abs, full))) throw new Error('Forbidden');

  return full;
}

function sanitizeFileSegment(value, fallback = 'item') {
  const cleaned = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || fallback;
}

function batchAskRunId(modelCount, createdAt = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  const stamp = [
    createdAt.getFullYear(),
    pad(createdAt.getMonth() + 1),
    pad(createdAt.getDate()),
    '-',
    pad(createdAt.getHours()),
    pad(createdAt.getMinutes()),
    pad(createdAt.getSeconds()),
  ].join('');
  return `${stamp}-${Number(modelCount) || 0}`;
}

function normalizeModelList(value) {
  const source = Array.isArray(value) ? value : [value];
  const models = [];
  const seen = new Set();

  for (const rawModel of source) {
    const model = String(rawModel || '').trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    models.push(model);
  }

  return models;
}

function extractChatCompletionMessageText(payload) {
  const rawContent = payload?.choices?.[0]?.message?.content;
  if (typeof rawContent === 'string') return rawContent.trim();
  if (Array.isArray(rawContent)) {
    return rawContent
      .map(part => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

function isTruthyValue(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function normalizeGatewayValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveOpenRouterTransport(input = {}) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY not configured');
  }

  const gatewayEnabled = isTruthyValue(input?.gatewayEnabled);
  const gatewayAccountId = normalizeGatewayValue(process.env.CF_AI_GATEWAY_ACCOUNT_ID);
  const gatewayName = normalizeGatewayValue(process.env.CF_AI_GATEWAY_NAME);
  const gatewayAuthToken = normalizeGatewayValue(process.env.CF_AI_GATEWAY_AUTH_TOKEN);
  const defaultHeaders = {
    'HTTP-Referer': `http://localhost:${PORT}`,
    'X-Title': 'Markdown Reader',
  };

  if (!gatewayEnabled) {
    return {
      enabled: false,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders,
      cacheKey: 'direct',
    };
  }

  if (!gatewayAccountId) {
    throw new Error('Cloudflare AI Gateway is enabled, but CF_AI_GATEWAY_ACCOUNT_ID is missing in .env');
  }
  if (!gatewayName) {
    throw new Error('Cloudflare AI Gateway is enabled, but CF_AI_GATEWAY_NAME is missing in .env');
  }
  if (/[/?#]/.test(gatewayAccountId)) {
    throw new Error('Invalid Cloudflare Gateway Account ID');
  }
  if (/[/?#]/.test(gatewayName)) {
    throw new Error('Invalid Cloudflare Gateway Name');
  }

  const gatewayHeaders = { ...defaultHeaders };
  if (gatewayAuthToken) {
    gatewayHeaders['cf-aig-authorization'] = `Bearer ${gatewayAuthToken}`;
  }

  const baseURL = `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(gatewayAccountId)}/${encodeURIComponent(gatewayName)}/openrouter`;
  return {
    enabled: true,
    baseURL,
    defaultHeaders: gatewayHeaders,
    cacheKey: `${baseURL}::${gatewayAuthToken}`,
  };
}

function getOpenRouterClient(input = {}) {
  const transport = resolveOpenRouterTransport(input);
  return new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: transport.baseURL,
    defaultHeaders: transport.defaultHeaders,
  });
}

function requestJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
      });
      res.on('end', () => {
        let payload = {};
        if (body.trim()) {
          try {
            payload = JSON.parse(body);
          } catch {
            reject(new Error('Invalid JSON response from upstream'));
            return;
          }
        }

        if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
          const message = payload?.error?.message
            || payload?.error
            || payload?.message
            || `Upstream request failed with status ${res.statusCode || 500}`;
          reject(new Error(message));
          return;
        }

        resolve(payload);
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function listOpenRouterModels(input = {}, forceRefresh = false) {
  const transport = resolveOpenRouterTransport(input);
  const cached = openRouterModelsCache.get(transport.cacheKey);
  if (!forceRefresh && cached?.expiresAt > Date.now() && Array.isArray(cached.models) && cached.models.length) {
    return {
      models: cached.models,
      cached: true,
      gatewayEnabled: transport.enabled,
    };
  }

  const payload = await requestJson(`${transport.baseURL}/models`, {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    ...transport.defaultHeaders,
  });

  const seen = new Set();
  const models = [];
  for (const item of Array.isArray(payload?.data) ? payload.data : []) {
    const id = String(item?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: String(item?.name || '').trim(),
      contextLength: Number(item?.context_length || 0) || 0,
    });
  }

  openRouterModelsCache.set(transport.cacheKey, {
    expiresAt: Date.now() + OPENROUTER_MODELS_CACHE_TTL_MS,
    models,
  });

  return {
    models,
    cached: false,
    gatewayEnabled: transport.enabled,
  };
}

async function askOpenRouter(model, question, input = {}) {
  const completion = await getOpenRouterClient(input).chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: [
          '你是一个用于对比回答的助手。',
          '始终使用中文回答。',
          '回答必须是纯 Markdown，不要输出代码围栏包裹整个回答，不要输出额外前言。',
          '回答开头必须先完整写出原始问题，再开始正式回答。',
          '结构尽量清晰，必要时使用标题、列表、表格。',
        ].join(' '),
      },
      {
        role: 'user',
        content: question,
      },
    ],
  });
  const content = extractChatCompletionMessageText(completion);
  if (!content) throw new Error('OpenRouter returned no text content');
  return content;
}

function createBatchAskMarkdown({ model, question, answer, createdAt, status, errorMessage }) {
  const parts = [
    `# ${model}`,
    '',
    `- 时间: ${createdAt}`,
    `- 状态: ${status === 'ok' ? 'success' : 'error'}`,
    '',
    '## 问题',
    '',
    question,
    '',
  ];

  if (status === 'ok') {
    parts.push('## 回答', '', answer.trim(), '');
  } else {
    parts.push('## 错误', '', String(errorMessage || '未知错误').trim(), '');
  }

  return parts.join('\n');
}

// ─── Routes ─────────────────────────────────────────────────────────────────

app.get('/api/skills', async (req, res) => {
  const roots = resolveRoots(req.query.roots);
  res.json(await scanRoots(roots));
});

app.get('/api/skill', (req, res) => {
  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).json({ error: 'Missing path' });
  try {
    const roots = resolveRoots(req.query.roots);
    const full = safePath(filePath, roots);
    const content = fs.readFileSync(full, 'utf-8');
    const blocks = parseMarkdownBlocks(content);
    const store = loadAnalysisStore(filePath, full, blocks);
    const analyses = mapAnalysesToCurrentBlocks(store, blocks);
    res.json({ blocks, analyses });
  } catch (err) {
    res.status(err.message === 'Forbidden' ? 403 : 500).json({ error: err.message });
  }
});

async function handleOpenRouterModelsRequest(input, res) {
  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(503).json({ error: 'OPENROUTER_API_KEY not configured' });
  }

  try {
    const forceRefresh = isTruthyValue(input?.refresh);
    const result = await listOpenRouterModels(input, forceRefresh);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /required|Invalid/i.test(message) ? 400 : 502;
    res.status(status).json({ error: message });
  }
}

app.get('/api/openrouter/models', async (req, res) => {
  await handleOpenRouterModelsRequest(req.query, res);
});

app.post('/api/openrouter/models', async (req, res) => {
  await handleOpenRouterModelsRequest(req.body, res);
});

app.get('/api/memos', (_req, res) => {
  const memos = ensureMemoSeed();
  res.json({
    memos: memos.map(memo => ({
      ...memoSummary(memo),
      entries: memo.entries,
    })),
  });
});

app.post('/api/memos', (req, res) => {
  const memo = createMemo(req.body?.name);
  res.status(201).json({
    memo: {
      ...memoSummary(memo),
      entries: memo.entries,
    },
    memos: listMemos().map(item => ({
      ...memoSummary(item),
      entries: item.entries,
    })),
  });
});

app.delete('/api/memos/:id', (req, res) => {
  try {
    fs.unlinkSync(memoFilePath(req.params.id));
    const memos = ensureMemoSeed();
    res.json({
      memos: memos.map(memo => ({
        ...memoSummary(memo),
        entries: memo.entries,
      })),
    });
  } catch (err) {
    res.status(err.message === 'Invalid memo id' ? 400 : 404).json({ error: err.message });
  }
});

app.post('/api/memos/:id/items', (req, res) => {
  const text = String(req.body?.text || '').trim();
  const sourcePath = String(req.body?.sourcePath || '').trim();
  if (!text || !sourcePath) {
    return res.status(400).json({ error: 'Missing memo item fields' });
  }

  try {
    const memo = readMemo(req.params.id);
    memo.entries.unshift({ text, sourcePath });
    memo.updatedAt = new Date().toISOString();
    const saved = writeMemo(memo);
    res.status(201).json({
      memo: {
        ...memoSummary(saved),
        entries: saved.entries,
      },
    });
  } catch (err) {
    res.status(err.message === 'Invalid memo id' ? 400 : 404).json({ error: err.message });
  }
});

app.delete('/api/memos/:id/items/:index', (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    return res.status(400).json({ error: 'Invalid memo item index' });
  }

  try {
    const memo = readMemo(req.params.id);
    if (index >= memo.entries.length) {
      return res.status(404).json({ error: 'Memo item not found' });
    }
    memo.entries.splice(index, 1);
    memo.updatedAt = new Date().toISOString();
    const saved = writeMemo(memo);
    res.json({
      memo: {
        ...memoSummary(saved),
        entries: saved.entries,
      },
    });
  } catch (err) {
    res.status(err.message === 'Invalid memo id' ? 400 : 404).json({ error: err.message });
  }
});

app.post('/api/analyze', async (req, res) => {
  const { filePath, blockId, persistKey, content, heading, skillName, extraPrompt, force, roots: rawRoots } = req.body;
  if (!filePath || blockId == null || !content) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Validate path
  const roots = resolveRoots(rawRoots);
  let full;
  try {
    full = safePath(filePath, roots);
  } catch {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const fileContent = fs.readFileSync(full, 'utf-8');
  const blocks = parseMarkdownBlocks(fileContent);
  const block = blocks.find(item => String(item.id) === String(blockId));
  const stableKey = String(persistKey || block?.persistKey || createBlockPersistKey({
    type: block?.type || 'text',
    heading,
    content,
  }));
  const store = loadAnalysisStore(filePath, full, blocks);
  const existing = store.blocks?.[stableKey]?.text;

  if (existing && !force) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ text: existing, cached: true })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true, cached: true })}\n\n`);
    return res.end();
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  let clientClosed = false;
  let fullText = '';
  try {
    // Set up SSE streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const extraSection = extraPrompt?.trim() ? `\n\n补充要求：${extraPrompt.trim()}` : '';

    const stream = anthropic.messages
      .stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: `你是AI Skill文档分析专家。请解读以下Skill文档片段，用中文输出：

**Skill名称**: ${skillName}
**段落标题**: ${heading}

**段落内容**:
${content}

请从三个角度简洁解读（每点1-2句）：
**核心作用** — 这段内容的主要目的
**重要性** — 为什么这部分不可或缺
**关键点** — 使用时需要注意的事项

用简洁的Markdown格式输出，不要冗长。${extraSection}`,
        }],
      })
      .on('text', text => {
        fullText += text;
        if (!clientClosed && !res.writableEnded) {
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
        }
      });

    const handleDisconnect = () => {
      // `req.close` also fires after the request body is fully read, which would
      // incorrectly abort normal streaming requests. Only abort when the request
      // was actually terminated early or the response socket closes mid-stream.
      if (res.writableEnded || stream.controller.signal.aborted) return;
      clientClosed = true;
      stream.controller.abort();
    };

    req.on('aborted', handleDisconnect);
    res.on('close', handleDisconnect);

    await stream.done();

    if (!fullText.trim()) {
      throw new Error('AI returned no text content');
    }

    store.blocks[stableKey] = {
      text: fullText,
      heading: block?.heading || heading,
      type: block?.type || 'text',
      updatedAt: new Date().toISOString(),
    };
    store.updatedAt = new Date().toISOString();
    saveAnalysisStore(full, store);

    if (!clientClosed && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    }
  } catch (err) {
    if (clientClosed || res.writableEnded) return;

    if (fullText.trim()) {
      store.blocks[stableKey] = {
        text: fullText,
        heading: block?.heading || heading,
        type: block?.type || 'text',
        updatedAt: new Date().toISOString(),
      };
      store.updatedAt = new Date().toISOString();
      saveAnalysisStore(full, store);
      res.write(`data: ${JSON.stringify({ done: true, partial: true })}\n\n`);
      res.end();
      return;
    }

    if (res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/batch-ask', async (req, res) => {
  const question = String(req.body?.question || '').trim();
  const models = normalizeModelList(req.body?.models);

  if (!question) {
    return res.status(400).json({ error: 'Missing question' });
  }
  if (!models.length) {
    return res.status(400).json({ error: 'Missing models' });
  }
  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(503).json({ error: 'OPENROUTER_API_KEY not configured' });
  }

  const createdAt = new Date();
  let runId = batchAskRunId(models.length, createdAt);
  let runDir = path.join(BATCH_ASK_DIR, runId);
  let suffix = 2;
  while (fs.existsSync(runDir)) {
    runId = `${batchAskRunId(models.length, createdAt)}-${suffix}`;
    runDir = path.join(BATCH_ASK_DIR, runId);
    suffix += 1;
  }
  fs.mkdirSync(runDir, { recursive: true });

  const relativeDir = path.relative(PROJECT_ROOT, runDir).replace(/\\/g, '/');
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({
    runId,
    question,
    models,
    createdAt: createdAt.toISOString(),
  }, null, 2));

  const settled = await Promise.all(models.map(async (model, index) => {
    const fileName = `${String(index + 1).padStart(2, '0')}-${sanitizeFileSegment(model, `model-${index + 1}`)}.md`;
    const filePath = path.join(runDir, fileName);
    const relativeFilePath = path.relative(PROJECT_ROOT, filePath).replace(/\\/g, '/');

    try {
      const answer = await askOpenRouter(model, question, req.body || {});
      const markdown = createBatchAskMarkdown({
        model,
        question,
        answer,
        createdAt: createdAt.toISOString(),
        status: 'ok',
      });
      fs.writeFileSync(filePath, markdown);
      return {
        model,
        status: 'ok',
        fileName,
        filePath: relativeFilePath,
        content: answer,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const markdown = createBatchAskMarkdown({
        model,
        question,
        createdAt: createdAt.toISOString(),
        status: 'error',
        errorMessage,
      });
      fs.writeFileSync(filePath, markdown);
      return {
        model,
        status: 'error',
        fileName,
        filePath: relativeFilePath,
        error: errorMessage,
        content: `## 调用失败\n\n${errorMessage}`,
      };
    }
  }));

  res.status(201).json({
    runId,
    directory: relativeDir,
    question,
    results: settled,
  });
});

app.listen(PORT, () => {
  console.log(`\n  Markdown Reader  →  http://localhost:${PORT}\n`);
});
