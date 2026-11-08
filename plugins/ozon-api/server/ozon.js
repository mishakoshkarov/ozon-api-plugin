'use strict';
// Клиент Ozon Seller API и Performance API. Только чтение: ни одного метода записи здесь нет.
// Ключи берутся из файла ~/.ozon-plugin/keys.env (путь можно переопределить OZON_ENV_FILE)
// или из переменных окружения — окружение важнее файла.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENV_FILE = process.env.OZON_ENV_FILE || path.join(os.homedir(), '.ozon-plugin', 'keys.env');
const KEYS = ['OZON_CLIENT_ID', 'OZON_API_KEY', 'OZON_PERF_CLIENT_ID', 'OZON_PERF_CLIENT_SECRET'];

function readEnvFile(file) {
  const e = {};
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return e; }
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim(); if (!s || s[0] === '#') continue;
    const i = s.indexOf('='); if (i > 0) e[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return e;
}

function credentials() {
  const file = readEnvFile(ENV_FILE);
  const c = {};
  for (const k of KEYS) c[k] = process.env[k] || file[k] || '';
  return c;
}

function keysStatus() {
  const c = credentials();
  const mask = (v) => (v ? v.slice(0, 4) + '…' + v.slice(-2) : 'нет');
  return { file: ENV_FILE, fileExists: fs.existsSync(ENV_FILE),
    seller: { clientId: mask(c.OZON_CLIENT_ID), apiKey: c.OZON_API_KEY ? 'есть' : 'нет' },
    performance: { clientId: mask(c.OZON_PERF_CLIENT_ID), secret: c.OZON_PERF_CLIENT_SECRET ? 'есть' : 'нет' } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ozon фильтрует по UTC, а день магазина считается по Москве: день D = (D−1)T21:00Z … DT20:59Z.
function mskDayWindow(from, to) {
  const d = new Date(from + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return { since: d.toISOString().slice(0, 10) + 'T21:00:00.000Z', to: to + 'T20:59:59.999Z' };
}

// Сколько просит подождать сервер при 429 (заголовок Retry-After), мс.
function retryAfterMs(res) {
  const v = res?.headers?.get?.('retry-after');
  if (!v) return null;
  const sec = Number(v);
  if (Number.isFinite(sec)) return Math.max(0, sec * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

// Общая очередь: не чаще одного запроса в 600 мс — с запасом к лимиту Seller API.
// Для /v1/analytics/data отдельная пауза: метод лимитирован намного жёстче остальных.
const MIN_GAP_MS = 600;
const METHOD_GAP_MS = { '/v1/analytics/data': 60000 };
const lastByMethod = new Map();
let lastCall = 0;
let queue = Promise.resolve();
function throttle(endpoint) {
  queue = queue.then(async () => {
    const methodGap = METHOD_GAP_MS[endpoint] || 0;
    const wait = Math.max(0, lastCall + MIN_GAP_MS - Date.now(),
      methodGap ? (lastByMethod.get(endpoint) || 0) + methodGap - Date.now() : 0);
    if (wait) await sleep(wait);
    lastCall = Date.now();
    lastByMethod.set(endpoint, lastCall);
  });
  return queue;
}

const REQUEST_TIMEOUT_MS = 60000;   // у fetch нет таймаута по умолчанию: без него запрос может висеть вечно
const MAX_WAIT_MS = 5 * 60000;      // Retry-After длиннее — это суточный лимит, ждать бесполезно

// Повторы: 429 и обрывы сети повторяем, 401/403 — нет (ключ неверный или без прав).
async function withRetry(endpoint, fn, tries = 6) {
  let last;
  for (let i = 1; i <= tries; i += 1) {
    try {
      await throttle(endpoint);
      return await fn();
    } catch (e) {
      last = e;
      if (e.status === 401 || e.status === 403 || e.status === 400 || e.status === 404 || e.final) throw e;
      if (i < tries) {
        const wait = e.status === 429 ? Math.max(3000 * i, e.retryAfterMs || 0) : Math.max(1500 * i, e.network ? 5000 : 0);
        process.stderr.write(`[ozon] повтор ${i}/${tries - 1} через ${Math.round(wait / 1000)} с: ${String(e.message).slice(0, 80)}\n`);
        await sleep(wait);
      }
    }
  }
  throw last;
}

function httpError(endpoint, status, text, res) {
  const e = new Error(`${endpoint} → HTTP ${status}: ${String(text).slice(0, 300)}`);
  e.status = status;
  if (status === 429) {
    e.retryAfterMs = retryAfterMs(res);
    if (e.retryAfterMs != null && e.retryAfterMs > MAX_WAIT_MS) {
      e.final = true;
      e.message = `${endpoint}: суточный лимит исчерпан, Ozon просит подождать ${Math.round(e.retryAfterMs / 60000)} мин`;
    }
  }
  return e;
}

function networkError(endpoint, e) {
  const err = new Error(`${endpoint} → сеть: ${e?.message || e}`);
  err.network = true;
  return err;
}

async function seller(endpoint, body = {}) {
  const c = credentials();
  if (!c.OZON_CLIENT_ID || !c.OZON_API_KEY) {
    const e = new Error(`Нет ключей Seller API. Заполните ${ENV_FILE} (см. команду /ozon-api:ozon-setup).`);
    e.final = true; throw e;
  }
  return withRetry(endpoint, async () => {
    let res;
    try {
      res = await fetch('https://api-seller.ozon.ru' + endpoint, {
        method: 'POST',
        headers: { 'Client-Id': c.OZON_CLIENT_ID, 'Api-Key': c.OZON_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) { throw networkError(endpoint, e); }
    if (!res.ok) throw httpError(endpoint, res.status, await res.text(), res);
    return res.json();
  });
}

// Performance API: отдельный хост и OAuth — client_id/client_secret меняются на токен на 30 минут.
let perfToken = { value: null, until: 0 };

async function performanceToken() {
  const c = credentials();
  if (!c.OZON_PERF_CLIENT_ID || !c.OZON_PERF_CLIENT_SECRET) {
    const e = new Error(`Нет ключей Performance API (реклама). Заполните ${ENV_FILE}.`);
    e.final = true; throw e;
  }
  if (perfToken.value && Date.now() < perfToken.until) return perfToken.value;
  let res;
  try {
    res = await fetch('https://api-performance.ozon.ru/api/client/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: c.OZON_PERF_CLIENT_ID, client_secret: c.OZON_PERF_CLIENT_SECRET, grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) { throw networkError('/api/client/token', e); }
  if (!res.ok) throw httpError('/api/client/token', res.status, await res.text(), res);
  const j = await res.json();
  perfToken = { value: j.access_token, until: Date.now() + (j.expires_in || 1800) * 1000 - 60000 };
  return perfToken.value;
}

async function performance(p, query = null) {
  const url = 'https://api-performance.ozon.ru' + p + (query ? '?' + new URLSearchParams(query) : '');
  return withRetry(p, async () => {
    const token = await performanceToken();
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (e) { throw networkError(p, e); }
    if (!res.ok) throw httpError(p, res.status, await res.text(), res);
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  });
}

module.exports = { ENV_FILE, credentials, keysStatus, mskDayWindow, seller, performance };
