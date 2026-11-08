'use strict';
// Клиент Wildberries API. Только чтение: методов записи здесь нет.
// Токен берётся из ~/.wb-plugin/keys.env (путь можно переопределить WB_ENV_FILE)
// или из переменной окружения WB_API_TOKEN — окружение важнее файла.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENV_FILE = process.env.WB_ENV_FILE || path.join(os.homedir(), '.wb-plugin', 'keys.env');
const BASES = {
  common: 'https://common-api.wildberries.ru',
  content: 'https://content-api.wildberries.ru',
  analytics: 'https://seller-analytics-api.wildberries.ru',
  statistics: 'https://statistics-api.wildberries.ru',
  advert: 'https://advert-api.wildberries.ru',
  finance: 'https://finance-api.wildberries.ru',
  prices: 'https://discounts-prices-api.wildberries.ru',
};

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

function token() {
  const t = process.env.WB_API_TOKEN || readEnvFile(ENV_FILE).WB_API_TOKEN || '';
  if (!t) {
    const e = new Error(`Нет токена WB. Заполните ${ENV_FILE} (см. команду /wb-api:wb-setup).`);
    e.final = true; throw e;
  }
  return t;
}

// Токен WB — это JWT: в нём видно категории доступа, «только чтение» и срок действия.
// s — битовая маска категорий; бит 30 — «Только на чтение».
const CATEGORIES = { 1: 'Контент', 2: 'Аналитика', 3: 'Цены и скидки', 4: 'Маркетплейс', 5: 'Статистика',
  6: 'Продвижение', 7: 'Вопросы и отзывы', 8: 'Рекомендации', 9: 'Чат с покупателями', 10: 'Поставки',
  11: 'Возвраты', 12: 'Документы', 13: 'Тарифы' };

function tokenInfo() {
  let t;
  try { t = token(); } catch (e) { return { file: ENV_FILE, fileExists: fs.existsSync(ENV_FILE), error: e.message }; }
  const info = { file: ENV_FILE, fileExists: fs.existsSync(ENV_FILE), categories: [], readOnly: false };
  try {
    const p = JSON.parse(Buffer.from(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    for (let i = 1; i <= 30; i += 1) {
      if (!(p.s & (1 << i))) continue;
      if (i === 30) info.readOnly = true; else info.categories.push(CATEGORIES[i] || 'бит ' + i);
    }
    if (p.exp) {
      info.expires = new Date(p.exp * 1000).toISOString().slice(0, 10);
      info.daysLeft = Math.floor((p.exp * 1000 - Date.now()) / 86400000);
    }
  } catch { info.error = 'Токен не похож на ключ WB (не JWT) — проверьте, что скопировали его целиком'; }
  return info;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Лимиты WB жёсткие и считаются на продавца. Минимальный зазор между запросами — по методам:
// статистика (заказы, продажи) и финотчёт — раз в минуту, остатки — раз в 20 с, реклама fullstats — раз в минуту.
const GAPS = [
  [/^statistics:/, 61000],
  [/^finance:/, 61000],
  [/^advert:\/adv\/v3\/fullstats/, 61000],
  [/^analytics:\/api\/analytics\/v1\/stocks-report/, 21000],
  [/^analytics:\/api\/v1\/warehouse_remains/, 6000],
  [/^analytics:\/api\/analytics\/v3\/sales-funnel/, 20000],
  [/^analytics:/, 3000],
];
const DEFAULT_GAP = 700;
const lastByKey = new Map();
let banUntil = 0;                       // WB наказал кабинет: до этого момента не ходим никуда
const MAX_INLINE_WAIT_MS = 75000;       // дольше ждать внутри одного вызова инструмента не будем

function gapFor(key) {
  for (const [re, ms] of GAPS) if (re.test(key)) return [re.source, ms];
  return ['default', DEFAULT_GAP];
}

async function pace(key) {
  const [group, gap] = gapFor(key);
  const now = Date.now();
  if (banUntil > now) {
    const left = banUntil - now;
    if (left > MAX_INLINE_WAIT_MS) {
      const e = new Error(`WB ограничил запросы кабинета: подождите ещё ${Math.ceil(left / 60000)} мин. Повторы сейчас только продлят ограничение.`);
      e.final = true; throw e;
    }
    await sleep(left);
  }
  const wait = (lastByKey.get(group) || 0) + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastByKey.set(group, Date.now());
}

async function wb(service, p, { method = 'GET', body = null, tries = 3, timeoutMs = 120000 } = {}) {
  const key = service + ':' + p;
  const t = token();
  for (let i = 1; i <= tries; i += 1) {
    await pace(key);
    let res;
    try {
      res = await fetch(BASES[service] + p, { method,
        headers: { Authorization: t, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (i === tries) throw new Error(`WB ${p} → сеть: ${e.name === 'TimeoutError' ? 'таймаут' : e.message}`);
      await sleep(5000 * i);
      continue;
    }
    if (res.status === 429) {
      // WB сам говорит, сколько ждать: X-Ratelimit-Retry, в секундах. Своя формула продлевает бан.
      const asked = Number(res.headers.get('x-ratelimit-retry') || res.headers.get('x-ratelimit-reset') || 0);
      const waitMs = (asked > 0 ? asked + 2 : 65) * 1000;
      banUntil = Math.max(banUntil, Date.now() + waitMs);
      if (waitMs > MAX_INLINE_WAIT_MS || i === tries) {
        const e = new Error(`WB ${p}: лимит запросов, WB просит подождать ${Math.ceil(waitMs / 60000)} мин. ` +
          'Повторы раньше этого срока только продлят ограничение.');
        e.final = true; throw e;
      }
      process.stderr.write(`[wb] 429 на ${p}, жду ${Math.round(waitMs / 1000)} с\n`);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      const hint = res.status === 401 ? ' (токен неверный или истёк)'
        : res.status === 403 ? ' (у токена нет нужной категории доступа)' : '';
      const e = new Error(`WB ${p} → HTTP ${res.status}${hint}: ${text.slice(0, 250)}`);
      e.status = res.status;
      if (res.status < 500 || i === tries) throw e;
      await sleep(5000 * i);
      continue;
    }
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  }
  return null;
}

module.exports = { ENV_FILE, tokenInfo, wb };
