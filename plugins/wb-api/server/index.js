#!/usr/bin/env node
'use strict';
// MCP-сервер «WB API» для Claude Code. Работает локально на компьютере ученика:
// Claude запускает его сам, общается через stdin/stdout, а сервер ходит в Wildberries по HTTPS.
// Без внешних зависимостей — нужен только Node.js 18+.
// Все инструменты ТОЛЬКО ЧИТАЮТ данные: цены, ставки и карточки этот сервер не меняет.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { tokenInfo, wb } = require('./wb.js');

const VERSION = '1.0.0';
const DATA_DIR = process.env.WB_DATA_DIR || path.join(os.homedir(), 'wb-data');

// ── вспомогательное ─────────────────────────────────────────────────────────
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const num = (v) => Number(String(v == null ? 0 : v).replace(/\s/g, '').replace(',', '.')) || 0;
const rub = (v) => Math.round(num(v)).toLocaleString('ru-RU');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function checkPeriod(from, to, maxDays) {
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) throw new Error('Даты в формате ГГГГ-ММ-ДД: date_from и date_to');
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  if (days < 1) throw new Error('date_from позже date_to');
  if (days > maxDays) throw new Error(`Период не длиннее ${maxDays} дней за один вызов — разбейте на части`);
  return days;
}

// Полный ответ сохраняем в файл, в чат отдаём сводку: сырые ответы WB съедают контекст.
function saveFull(name, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(DATA_DIR, `${name}_${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
  return file;
}

function table(headers, rows, limit) {
  const shown = rows.slice(0, limit);
  const esc = (v) => String(v ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
  const lines = ['| ' + headers.join(' | ') + ' |', '|' + headers.map(() => '---').join('|') + '|'];
  for (const r of shown) lines.push('| ' + r.map(esc).join(' | ') + ' |');
  if (rows.length > shown.length) lines.push(`\n…показано ${shown.length} из ${rows.length}; полный список — в файле`);
  return lines.join('\n');
}

const wanted = (codes) => {
  const set = new Set((codes || []).map((x) => String(x).trim()));
  return (vendorCode, nmId) => !set.size || set.has(String(vendorCode)) || set.has(String(nmId));
};

// ── карточки и цены ─────────────────────────────────────────────────────────
let cardsCache = { at: 0, list: [] };
async function allCards() {
  if (Date.now() - cardsCache.at < 10 * 60000) return cardsCache.list;
  const all = [];
  let cursor = { limit: 100 };
  for (let page = 0; page < 500; page += 1) {
    const r = await wb('content', '/content/v2/get/cards/list', { method: 'POST',
      body: { settings: { cursor, filter: { withPhoto: -1 } } } });
    const cards = r?.cards || [];
    all.push(...cards);
    if (cards.length < 100 || !r?.cursor?.nmID) break;
    cursor = { limit: 100, updatedAt: r.cursor.updatedAt, nmID: r.cursor.nmID };
  }
  cardsCache = { at: Date.now(), list: all };
  return all;
}

async function allPrices() {
  const out = [];
  for (let offset = 0, i = 0; i < 100; i += 1) {
    const r = await wb('prices', `/api/v2/list/goods/filter?limit=1000&offset=${offset}`);
    const goods = r?.data?.listGoods || [];
    out.push(...goods);
    if (goods.length < 1000) break;
    offset += goods.length;
  }
  return out;
}

async function toolProducts({ search = '', row_limit = 60 }) {
  const cards = await allCards();
  const prices = new Map((await allPrices()).map((g) => [g.nmID, g]));
  const q = String(search).toLowerCase().trim();
  const rows = cards
    .filter((c) => !q || [c.vendorCode, c.title, c.subjectName, c.nmID].some((v) => String(v).toLowerCase().includes(q)))
    .map((c) => {
      const p = prices.get(c.nmID);
      const s = p?.sizes?.[0] || {};
      return [c.vendorCode, c.nmID, c.imtID, c.subjectName, String(c.title || '').slice(0, 50),
        s.price != null ? rub(s.price) : '', p ? p.discount + '%' : '', s.discountedPrice != null ? rub(s.discountedPrice) : ''];
    });
  const file = saveFull('products', { cards, prices: [...prices.values()] });
  return `Карточек: ${cards.length}${q ? `, под фильтр «${search}»: ${rows.length}` : ''}.\n` +
    `imtID — номер склейки: у товаров одной склейки он одинаковый.\n` +
    `Цена со скидкой — цена продавца. Покупатель часто платит меньше: сверху действует скидка WB (СПП), её задаёт WB.\n\n` +
    table(['Артикул', 'nmID', 'imtID', 'Предмет', 'Название', 'Цена ₽', 'Скидка', 'Цена со скидкой ₽'], rows, row_limit) +
    `\n\nПолный ответ: ${file}`;
}

async function toolContent({ vendor_codes = [] }) {
  if (!vendor_codes.length) throw new Error('Укажите vendor_codes — артикулы продавца или nmID (до 20 штук)');
  if (vendor_codes.length > 20) throw new Error('Не больше 20 артикулов за вызов');
  const ok = wanted(vendor_codes);
  const cards = (await allCards()).filter((c) => ok(c.vendorCode, c.nmID));
  const sameGlue = (imt) => cardsCache.list.filter((c) => c.imtID === imt).length;
  const text = cards.map((c) => [
    `## ${c.vendorCode} — ${c.title}`,
    `nmID ${c.nmID} · склейка imtID ${c.imtID} (карточек в склейке: ${sameGlue(c.imtID)}) · ${c.subjectName} · бренд ${c.brand || '—'}`,
    c.dimensions ? `Габариты упаковки: ${c.dimensions.length}×${c.dimensions.width}×${c.dimensions.height} см, ${c.dimensions.weightBrutto} кг` : '',
    `Фото: ${(c.photos || []).length}${c.video ? ' + видео' : ''}. Первое: ${c.photos?.[0]?.big || '—'}`,
    `Размеры: ${(c.sizes || []).map((s) => `${s.techSize || '—'} (${(s.skus || []).join(', ')})`).join('; ')}`,
    `Характеристики (${(c.characteristics || []).length}):`,
    ...(c.characteristics || []).map((x) => `- ${x.name}: ${Array.isArray(x.value) ? x.value.join('; ') : x.value}`),
    `Описание (${String(c.description || '').length} симв.):\n${String(c.description || '').slice(0, 1500)}${String(c.description || '').length > 1500 ? '…' : ''}`,
  ].filter(Boolean).join('\n')).join('\n\n');
  const found = new Set(cards.flatMap((c) => [String(c.vendorCode), String(c.nmID)]));
  const missing = vendor_codes.filter((v) => !found.has(String(v)));
  return (missing.length ? `Не найдены: ${missing.join(', ')}\n\n` : '') + text +
    `\n\nНа WB прочерк или перечисление через запятую в характеристике может отнимать баллы рейтинга карточки — «заполнить всё подряд» там не всегда полезно.` +
    `\n\nПолный ответ: ${saveFull('content', cards)}`;
}

// ── воронка ─────────────────────────────────────────────────────────────────
async function funnelProducts(from, to) {
  const all = [];
  let firstId = null;
  for (let page = 1; page <= 100; page += 1) {
    const r = await wb('analytics', '/api/analytics/v3/sales-funnel/products', { method: 'POST',
      body: { selectedPeriod: { start: from, end: to }, page } });
    const rows = r?.data?.products || [];
    if (!rows.length || rows[0]?.product?.nmId === firstId) break;   // предохранитель от зацикленной страницы
    firstId = rows[0]?.product?.nmId;
    all.push(...rows);
  }
  return all;
}

function pct(a, b) { return b ? (a / b * 100).toFixed(1) + '%' : '—'; }

async function toolFunnel({ date_from, date_to, vendor_codes = [], row_limit = 60 }) {
  checkPeriod(date_from, date_to, 365);
  const ok = wanted(vendor_codes);
  const all = (await funnelProducts(date_from, date_to)).filter((p) => ok(p.product?.vendorCode, p.product?.nmId));
  const t = { open: 0, cart: 0, orders: 0, orderSum: 0, buyouts: 0, buyoutSum: 0, cancel: 0 };
  const rows = all.map((p) => {
    const s = p.statistic?.selected || {}, past = p.statistic?.past || {};
    t.open += num(s.openCount); t.cart += num(s.cartCount); t.orders += num(s.orderCount);
    t.orderSum += num(s.orderSum); t.buyouts += num(s.buyoutCount); t.buyoutSum += num(s.buyoutSum); t.cancel += num(s.cancelCount);
    const delta = past.orderCount ? ((s.orderCount - past.orderCount) / past.orderCount * 100).toFixed(0) + '%' : '—';
    return [p.product?.vendorCode, p.product?.nmId, s.openCount, s.cartCount, pct(s.cartCount, s.openCount), s.orderCount,
      pct(s.orderCount, s.cartCount), rub(s.orderSum), s.buyoutCount, s.conversions?.buyoutPercent != null ? s.conversions.buyoutPercent + '%' : '—',
      delta, p.product?.stocks?.wb ?? '', p.product?.stocks?.mp ?? ''];
  }).sort((a, b) => b[5] - a[5]);
  return `Воронка WB ${date_from} — ${date_to}, товаров: ${all.length}.\n` +
    `Итого: переходы в карточку ${t.open} → корзины ${t.cart} (${pct(t.cart, t.open)}) → заказы ${t.orders} (${pct(t.orders, t.cart)}) ` +
    `на ${rub(t.orderSum)} ₽ → выкупы ${t.buyouts} на ${rub(t.buyoutSum)} ₽, отмены ${t.cancel}.\n` +
    `Выкупы за период относятся к заказам разных дней: заказ, сделанный в конце периода, выкупается уже после него. ` +
    `Процент выкупа на коротком или свежем окне занижен.\n` +
    `«К прошлому» — изменение заказов против предыдущего периода такой же длины.\n\n` +
    table(['Артикул', 'nmID', 'Переходы', 'Корзины', 'CR в корзину', 'Заказы', 'CR в заказ', 'Сумма заказов ₽', 'Выкупы', '% выкупа', 'К прошлому', 'Склад WB', 'Склад продавца'], rows, row_limit) +
    `\n\nПолный ответ: ${saveFull('funnel', all)}`;
}

// ── остатки ─────────────────────────────────────────────────────────────────
async function warehouseRemains() {
  const created = await wb('analytics', '/api/v1/warehouse_remains?groupBySa=true&groupByNm=true&groupByBrand=false'
    + '&groupBySubject=false&groupByBarcode=false&groupBySize=false');
  const taskId = created?.data?.taskId;
  if (!taskId) throw new Error('WB не создал отчёт по складам (warehouse_remains)');
  for (let i = 0; i < 30; i += 1) {
    await sleep(6000);
    const st = await wb('analytics', `/api/v1/warehouse_remains/tasks/${taskId}/status`);
    if (st?.data?.status === 'done') break;
    if (i === 29) throw new Error('Отчёт по складам не готов за 3 минуты — попробуйте позже');
  }
  const data = await wb('analytics', `/api/v1/warehouse_remains/tasks/${taskId}/download`);
  return Array.isArray(data) ? data : (data?.data || []);
}

async function toolStocks({ vendor_codes = [], by_warehouse = false, row_limit = 80 }) {
  const ok = wanted(vendor_codes);
  const cards = await allCards();
  const vendorOf = new Map(cards.map((c) => [c.nmID, c.vendorCode]));
  const r = await wb('analytics', '/api/analytics/v1/stocks-report/wb-warehouses', { method: 'POST',
    body: { currentPeriod: { start: null, end: null }, limit: 250000, offset: 0 } });
  const items = r?.data?.items || r?.items || [];
  const by = new Map();
  for (const it of items) {
    const nm = it.nmId ?? it.nmID;
    const g = by.get(nm) || { nm, vendor: it.vendorCode || vendorOf.get(nm) || '', qty: 0, toClient: 0, fromClient: 0 };
    const rows = Array.isArray(it.warehouses) && it.warehouses.length ? it.warehouses : [it];
    for (const w of rows) { g.qty += num(w.quantity); g.toClient += num(w.inWayToClient); g.fromClient += num(w.inWayFromClient); }
    by.set(nm, g);
  }
  // Остаток на складах продавца (FBS) этот отчёт не показывает — берём его из воронки за вчера.
  const y = new Date(Date.now() + 3 * 3600000 - 86400000).toISOString().slice(0, 10);
  let fbs = new Map(), fbsNote = '';
  try {
    fbs = new Map((await funnelProducts(y, y)).map((p) => [p.product?.nmId, num(p.product?.stocks?.mp)]));
  } catch (e) { fbsNote = `Остаток на складах продавца не получен: ${e.message.slice(0, 120)}\n`; }
  for (const c of cards) if (!by.has(c.nmID) && fbs.get(c.nmID)) by.set(c.nmID, { nm: c.nmID, vendor: c.vendorCode, qty: 0, toClient: 0, fromClient: 0 });
  const rows = [...by.values()].filter((g) => ok(g.vendor, g.nm))
    .map((g) => [g.vendor, g.nm, g.qty, fbs.has(g.nm) ? fbs.get(g.nm) : '—', g.toClient, g.fromClient])
    .sort((a, b) => b[2] - a[2]);
  let text = `Позиций: ${rows.length}.\n${fbsNote}` +
    `Наличие = склады WB + склад продавца (FBS). Пусто на складах WB ещё не значит «товара нет».\n` +
    `«В пути к покупателю» и «возвраты в пути» — это не остаток, к наличию их не прибавлять.\n\n` +
    table(['Артикул', 'nmID', 'Склады WB', 'Склад продавца', 'В пути к покупателю', 'Возвраты в пути'], rows, row_limit);
  const full = { summary: items, fbs: Object.fromEntries(fbs) };
  if (by_warehouse) {
    const wr = await warehouseRemains();
    full.warehouses = wr;
    const wrow = [];
    for (const it of wr) {
      if (!ok(it.vendorCode, it.nmId)) continue;
      for (const w of it.warehouses || []) {
        const name = String(w.warehouseName || '');
        if (name.startsWith('В пути') || name.startsWith('Всего') || !num(w.quantity)) continue;
        wrow.push([it.vendorCode, name, num(w.quantity)]);
      }
    }
    wrow.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || b[2] - a[2]);
    text += `\n\n### Склады WB\n\n` + table(['Артикул', 'Склад', 'Остаток'], wrow, row_limit);
  }
  return text + `\n\nПолный ответ: ${saveFull('stocks', full)}`;
}

// ── заказы и продажи (статистика) ───────────────────────────────────────────
// Метод отдаёт строки, изменённые начиная с dateFrom; страница до 80 000 строк, следующая —
// от lastChangeDate последней строки. Лимит — запрос в минуту, поэтому страницы идут с паузой.
async function statisticsRows(kind, from, to) {
  const out = [];
  const seen = new Set();
  let cursor = from + 'T00:00:00';
  let complete = false;
  for (let page = 1; page <= 4; page += 1) {
    const rows = await wb('statistics', `/api/v1/supplier/${kind}?dateFrom=${encodeURIComponent(cursor)}&flag=0`);
    if (!Array.isArray(rows)) throw new Error(`WB не отдал ${kind}: пустой или непонятный ответ`);
    for (const r of rows) {
      const k = r.srid || r.saleID || `${r.gNumber}|${r.lastChangeDate}|${r.nmId}`;
      if (seen.has(k + (r.saleID || ''))) continue;
      seen.add(k + (r.saleID || ''));
      out.push(r);
    }
    if (rows.length < 80000) { complete = true; break; }
    const next = rows.at(-1).lastChangeDate;
    if (!next || next === cursor) { complete = true; break; }
    cursor = next;
  }
  const inPeriod = out.filter((r) => String(r.date).slice(0, 10) >= from && String(r.date).slice(0, 10) <= to);
  return { rows: inPeriod, complete };
}

async function toolOrders({ date_from, date_to, group_by = 'day', row_limit = 60 }) {
  checkPeriod(date_from, date_to, 31);
  const { rows: all, complete } = await statisticsRows('orders', date_from, date_to);
  const groups = new Map();
  const t = { units: 0, cancelled: 0, seller: 0, buyer: 0, orders: new Set() };
  for (const r of all) {
    if (r.isCancel) { t.cancelled += 1; continue; }
    const key = group_by === 'offer' ? r.supplierArticle : String(r.date).slice(0, 10);
    const g = groups.get(key) || { key, units: 0, seller: 0, buyer: 0 };
    g.units += 1; g.seller += num(r.priceWithDisc); g.buyer += num(r.finishedPrice);
    groups.set(key, g);
    t.units += 1; t.seller += num(r.priceWithDisc); t.buyer += num(r.finishedPrice); t.orders.add(r.gNumber);
  }
  const rows = [...groups.values()]
    .sort((a, b) => (group_by === 'offer' ? b.seller - a.seller : a.key.localeCompare(b.key)))
    .map((g) => [g.key, g.units, rub(g.seller), rub(g.buyer)]);
  return `Заказы WB ${date_from} — ${date_to}${complete ? '' : ' (⚠️ выгрузка неполная: слишком много строк, сократите период)'}.\n` +
    `Без отмен: ${t.units} шт в ${t.orders.size} корзинах покупателей, по цене продавца ${rub(t.seller)} ₽, ` +
    `покупатели заплатили ${rub(t.buyer)} ₽. Отменено: ${t.cancelled} шт.\n` +
    `Одна строка WB — одна штука. Заказ ещё не продажа: часть заказов не будет выкуплена.\n` +
    `Цена продавца — после его скидки; покупатель платит меньше на скидку WB (СПП), её WB компенсирует сам.\n\n` +
    table([group_by === 'offer' ? 'Артикул' : 'Дата', 'Шт', 'По цене продавца ₽', 'Заплатили покупатели ₽'], rows, row_limit) +
    `\n\nПолный ответ: ${saveFull('orders', all)}`;
}

async function toolSales({ date_from, date_to, group_by = 'day', row_limit = 60 }) {
  checkPeriod(date_from, date_to, 31);
  const { rows: all, complete } = await statisticsRows('sales', date_from, date_to);
  const groups = new Map();
  const t = { sold: 0, returned: 0, forPay: 0, seller: 0 };
  for (const r of all) {
    const ret = String(r.saleID || '').startsWith('R');
    const key = group_by === 'offer' ? r.supplierArticle : String(r.date).slice(0, 10);
    const g = groups.get(key) || { key, sold: 0, returned: 0, forPay: 0, seller: 0 };
    const sign = ret ? -1 : 1;
    if (ret) { g.returned += 1; t.returned += 1; } else { g.sold += 1; t.sold += 1; }
    // Знак суммы у возврата задаём сами по типу строки: так итог не зависит от того, как WB его подписал.
    const forPay = sign * Math.abs(num(r.forPay)), seller = sign * Math.abs(num(r.priceWithDisc));
    g.forPay += forPay; g.seller += seller;
    t.forPay += forPay; t.seller += seller;
    groups.set(key, g);
  }
  const rows = [...groups.values()]
    .sort((a, b) => (group_by === 'offer' ? b.forPay - a.forPay : a.key.localeCompare(b.key)))
    .map((g) => [g.key, g.sold, g.returned, rub(g.seller), rub(g.forPay)]);
  return `Продажи (выкупы) WB ${date_from} — ${date_to}${complete ? '' : ' (⚠️ выгрузка неполная, сократите период)'}.\n` +
    `Выкуплено ${t.sold} шт, возвратов ${t.returned}. По цене продавца ${rub(t.seller)} ₽, к перечислению ${rub(t.forPay)} ₽.\n` +
    `«К перечислению» здесь — после комиссии WB, но ДО логистики, хранения, штрафов и удержаний. ` +
    `Сколько реально придёт на счёт, показывает финансовый отчёт (инструмент wb_finance).\n\n` +
    table([group_by === 'offer' ? 'Артикул' : 'Дата', 'Выкуплено шт', 'Возвраты шт', 'По цене продавца ₽', 'К перечислению ₽'], rows, row_limit) +
    `\n\nПолный ответ: ${saveFull('sales', all)}`;
}

// ── реклама ─────────────────────────────────────────────────────────────────
const ADV_STATUS = { 4: 'готова', 7: 'завершена', 8: 'отказ', 9: 'идёт', 11: 'пауза' };

async function toolAds({ date_from, date_to, row_limit = 60 }) {
  checkPeriod(date_from, date_to, 31);
  const upd = await wb('advert', `/adv/v1/upd?from=${date_from}&to=${date_to}`);
  const spent = new Map();
  for (const u of Array.isArray(upd) ? upd : []) {
    const g = spent.get(u.advertId) || { id: u.advertId, name: u.campName || '', status: u.advertStatus, type: u.advertType, upd: 0 };
    g.upd += num(u.updSum);
    spent.set(u.advertId, g);
  }
  const ids = [...spent.keys()];
  const stats = [];
  let statsNote = '';
  try {
    for (const c of chunk(ids, 50)) {
      const r = await wb('advert', `/adv/v3/fullstats?ids=${c.join(',')}&beginDate=${date_from}&endDate=${date_to}`);
      if (Array.isArray(r)) stats.push(...r);
    }
  } catch (e) { statsNote = `⚠️ Показы, клики и заказы получены не по всем кампаниям: ${e.message.slice(0, 150)}\n`; }
  const st = new Map(stats.map((s) => [s.advertId, s]));
  const t = { upd: 0, views: 0, clicks: 0, orders: 0, sumPrice: 0 };
  const rows = [...spent.values()].sort((a, b) => b.upd - a.upd).map((g) => {
    const s = st.get(g.id) || {};
    t.upd += g.upd; t.views += num(s.views); t.clicks += num(s.clicks); t.orders += num(s.orders); t.sumPrice += num(s.sum_price);
    return [g.id, String(g.name).slice(0, 40), ADV_STATUS[g.status] || g.status, rub(g.upd), s.views ?? '—', s.clicks ?? '—',
      s.ctr != null ? s.ctr + '%' : '—', s.cpc != null ? rub(s.cpc) : '—', s.atbs ?? '—', s.orders ?? '—', s.sum_price != null ? rub(s.sum_price) : '—',
      s.sum_price ? (g.upd / s.sum_price * 100).toFixed(1) + '%' : '—'];
  });
  return `Реклама WB ${date_from} — ${date_to}: списано ${rub(t.upd)} ₽ по ${ids.length} кампаниям; показы ${t.views}, клики ${t.clicks}, ` +
    `заказы ${t.orders} на ${rub(t.sumPrice)} ₽.\n${statsNote}` +
    `«Списано» — фактические списания с рекламного баланса (/adv/v1/upd). Статистика (/adv/v3/fullstats) считает расход по-своему, суммы могут немного расходиться.\n` +
    `Заказы здесь — рекламная атрибуция WB, не все заказы товара. ДРР — к сумме этих заказов, а не ко всей выручке.\n` +
    `Статистика рекламы лимитирована: около запроса в минуту, по 50 кампаний за запрос.\n\n` +
    table(['ID', 'Кампания', 'Статус', 'Списано ₽', 'Показы', 'Клики', 'CTR', 'CPC ₽', 'Корзины', 'Заказы', 'Сумма заказов ₽', 'ДРР'], rows, row_limit) +
    `\n\nПолный ответ: ${saveFull('ads', { upd, stats })}`;
}

// ── финансовый отчёт (реализация) ───────────────────────────────────────────
async function toolFinance({ date_from, date_to, group_by = 'operation', row_limit = 60 }) {
  checkPeriod(date_from, date_to, 92);
  const all = [];
  let rrdId = 0, complete = false;
  for (let page = 0; page < 10; page += 1) {
    const rows = await wb('finance', '/api/finance/v1/sales-reports/detailed', { method: 'POST',
      body: { dateFrom: date_from, dateTo: date_to, limit: 100000, period: 'weekly', rrdId } });
    if (!Array.isArray(rows) || !rows.length) { complete = true; break; }
    all.push(...rows);
    const next = Number(rows.at(-1).rrdId);
    if (rows.length < 100000 || !next || next === rrdId) { complete = true; break; }
    rrdId = next;
  }
  const F = ['forPay', 'deliveryService', 'penalty', 'paidStorage', 'deduction', 'paidAcceptance', 'additionalPayment'];
  const groups = new Map();
  const t = { sales: 0, returns: 0, other: 0 };
  for (const F_ of F) t[F_] = 0;
  for (const r of all) {
    const op = r.sellerOperName || '—';
    const sign = op === 'Возврат' ? -1 : 1;
    const key = group_by === 'offer' ? (r.vendorCode || '(без артикула)') : op;
    const g = groups.get(key) || { key, qty: 0, retail: 0, ...Object.fromEntries(F.map((f) => [f, 0])) };
    if (op === 'Продажа' || op === 'Возврат') {
      g.qty += sign * Math.abs(num(r.quantity)); g.retail += sign * Math.abs(num(r.retailPriceWithDisc));
      g.forPay += sign * Math.abs(num(r.forPay)); t.forPay += sign * Math.abs(num(r.forPay));
    }
    for (const f of F.slice(1)) { g[f] += num(r[f]); t[f] += num(r[f]); }
    groups.set(key, g);
  }
  const payout = t.forPay - t.deliveryService - t.penalty - t.paidStorage - t.deduction - t.paidAcceptance + t.additionalPayment;
  const rows = [...groups.values()].sort((a, b) => Math.abs(b.forPay) + b.deliveryService - (Math.abs(a.forPay) + a.deliveryService))
    .map((g) => [g.key, g.qty || '', rub(g.retail), rub(g.forPay), rub(g.deliveryService), rub(g.paidStorage), rub(g.penalty), rub(g.deduction), rub(g.paidAcceptance)]);
  const reports = [...new Set(all.map((r) => `${r.reportId} (${r.dateFrom}–${r.dateTo})`))];
  return `Финансовый отчёт WB за ${date_from} — ${date_to}${complete ? '' : ' (⚠️ выгрузка неполная)'}: строк ${all.length}, ` +
    `еженедельных отчётов ${reports.length}.\n` +
    `К перечислению за товар (продажи минус возвраты): ${rub(t.forPay)} ₽.\n` +
    `Минус логистика ${rub(t.deliveryService)} ₽, хранение ${rub(t.paidStorage)} ₽, штрафы ${rub(t.penalty)} ₽, ` +
    `удержания ${rub(t.deduction)} ₽, платная приёмка ${rub(t.paidAcceptance)} ₽, плюс доплаты ${rub(t.additionalPayment)} ₽.\n` +
    `**Итого к выплате по отчёту ≈ ${rub(payout)} ₽** (оценка по этим статьям; себестоимость и налоги не вычтены).\n` +
    `⚠️ В «Удержаниях» WB может списывать оплату рекламы. Прежде чем вычитать рекламу из wb_ads, проверьте, не сидит ли она уже здесь — иначе она посчитается дважды.\n` +
    `Отчёты WB еженедельные: в период попадают недели, которые с ним пересекаются, поэтому границы могут сдвигаться на несколько дней.\n\n` +
    table([group_by === 'offer' ? 'Артикул' : 'Операция', 'Шт', 'Продажи по цене продавца ₽', 'К перечислению ₽', 'Логистика ₽', 'Хранение ₽', 'Штрафы ₽', 'Удержания ₽', 'Приёмка ₽'], rows, row_limit) +
    `\n\nОтчёты: ${reports.slice(0, 8).join(', ')}${reports.length > 8 ? '…' : ''}` +
    `\n\nПолный ответ: ${saveFull('finance', all)}`;
}

// ── проверка подключения ────────────────────────────────────────────────────
async function toolCheck() {
  const k = tokenInfo();
  const lines = [`Файл токена: ${k.file} — ${k.fileExists ? 'найден' : 'НЕ НАЙДЕН'}`];
  if (k.error) { lines.push(`❌ ${k.error}`); return lines.join('\n'); }
  lines.push(`Категории токена: ${k.categories.join(', ') || '—'}`,
    `Только чтение: ${k.readOnly ? 'да' : 'нет — для работы с плагином лучше выпустить токен «только на чтение»'}`,
    k.expires ? `Действует до ${k.expires} (осталось ${k.daysLeft} дн.)` : '', '');
  const need = { 'Контент': 'карточки и контент', 'Аналитика': 'воронка и остатки', 'Цены и скидки': 'цены',
    'Статистика': 'заказы, продажи и финотчёт', 'Продвижение': 'реклама' };
  const lack = Object.keys(need).filter((c) => !k.categories.includes(c));
  if (lack.length) lines.push(`⚠️ Нет категорий: ${lack.map((c) => `${c} (${need[c]})`).join(', ')}. Эти инструменты будут отвечать 403.`);
  try {
    const s = await wb('common', '/api/v1/seller-info');
    lines.push(`✅ WB отвечает — продавец «${s?.name || '?'}»${s?.tradeMark ? `, бренд ${s.tradeMark}` : ''}.`);
  } catch (e) { lines.push(`❌ WB: ${e.message}`); }
  try {
    const cards = await allCards();
    lines.push(`✅ Карточек: ${cards.length}.`);
  } catch (e) { lines.push(`❌ Карточки: ${e.message}`); }
  lines.push('', `Полные ответы инструменты сохраняют в ${DATA_DIR}`);
  return lines.filter((x) => x !== null).join('\n');
}

// ── описание инструментов для Claude ────────────────────────────────────────
const period = {
  date_from: { type: 'string', description: 'Начало периода, ГГГГ-ММ-ДД' },
  date_to: { type: 'string', description: 'Конец периода включительно, ГГГГ-ММ-ДД' },
};
const rowLimit = { row_limit: { type: 'integer', description: 'Сколько строк показать в чате (полный ответ всё равно сохраняется в файл)' } };
const codes = { vendor_codes: { type: 'array', items: { type: 'string' }, description: 'Артикулы продавца или nmID; пусто — все товары' } };

const TOOLS = [
  { name: 'wb_check', handler: toolCheck,
    description: 'Проверить подключение к Wildberries: найден ли токен, какие у него категории доступа, срок действия, отвечает ли WB. Запускать первым.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'wb_products', handler: toolProducts,
    description: 'Список карточек WB: артикул, nmID, склейка (imtID), предмет, название, цена, скидка продавца, цена со скидкой.',
    inputSchema: { type: 'object', properties: { search: { type: 'string', description: 'Фильтр по подстроке в артикуле, названии или предмете' }, ...rowLimit } } },
  { name: 'wb_product_content', handler: toolContent,
    description: 'Контент карточек WB (до 20): название, описание, все характеристики, фото и видео, размеры и баркоды, габариты, склейка.',
    inputSchema: { type: 'object', required: ['vendor_codes'], properties: { ...codes } } },
  { name: 'wb_stocks', handler: toolStocks,
    description: 'Остатки: на складах WB, на складе продавца (FBS), в пути к покупателю и возвраты в пути. С by_warehouse=true — разбивка по складам WB (отчёт готовится до 3 минут).',
    inputSchema: { type: 'object', properties: { ...codes, by_warehouse: { type: 'boolean', description: 'Добавить разбивку по складам WB' }, ...rowLimit } } },
  { name: 'wb_orders', handler: toolOrders,
    description: 'Заказы WB за период до 31 дня (данные хранятся около 90 дней): штуки, суммы по цене продавца и что заплатили покупатели, отмены. По дням или по артикулам. Метод лимитирован: запрос в минуту.',
    inputSchema: { type: 'object', required: ['date_from', 'date_to'], properties: { ...period,
      group_by: { type: 'string', enum: ['day', 'offer'], description: 'day — по дням, offer — по артикулам' }, ...rowLimit } } },
  { name: 'wb_sales', handler: toolSales,
    description: 'Продажи (выкупы) и возвраты WB за период до 31 дня: штуки, суммы, к перечислению до логистики. По дням или по артикулам. Метод лимитирован: запрос в минуту.',
    inputSchema: { type: 'object', required: ['date_from', 'date_to'], properties: { ...period,
      group_by: { type: 'string', enum: ['day', 'offer'], description: 'day — по дням, offer — по артикулам' }, ...rowLimit } } },
  { name: 'wb_funnel', handler: toolFunnel,
    description: 'Воронка WB по товарам за период: переходы в карточку, корзины, заказы, выкупы, отмены, конверсии, изменение к прошлому периоду, остатки.',
    inputSchema: { type: 'object', required: ['date_from', 'date_to'], properties: { ...period, ...codes, ...rowLimit } } },
  { name: 'wb_ads', handler: toolAds,
    description: 'Реклама WB за период до 31 дня: списания по кампаниям, показы, клики, CTR, CPC, корзины, заказы, ДРР к рекламным заказам.',
    inputSchema: { type: 'object', required: ['date_from', 'date_to'], properties: { ...period, ...rowLimit } } },
  { name: 'wb_finance', handler: toolFinance,
    description: 'Финансовый отчёт WB (реализация) за период до 92 дней: к перечислению, логистика, хранение, штрафы, удержания, приёмка и итог к выплате. По операциям или по артикулам. Метод лимитирован: запрос в минуту.',
    inputSchema: { type: 'object', required: ['date_from', 'date_to'], properties: { ...period,
      group_by: { type: 'string', enum: ['operation', 'offer'], description: 'operation — по типам операций, offer — по артикулам' }, ...rowLimit } } },
];
for (const t of TOOLS) t.annotations = { readOnlyHint: true, openWorldHint: true };

// ── протокол MCP (JSON-RPC 2.0 построчно через stdin/stdout) ─────────────────
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'wb-api', version: VERSION },
      instructions: 'Инструменты только читают данные Wildberries. Начинайте с wb_check. Лимиты WB жёсткие: не вызывайте один метод подряд без нужды.',
    });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') {
    return reply(id, { tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return fail(id, -32602, 'Неизвестный инструмент: ' + params?.name);
    try {
      const text = await tool.handler(params.arguments || {});
      return reply(id, { content: [{ type: 'text', text }] });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: 'Ошибка: ' + (e?.message || e) }], isError: true });
    }
  }
  if (id !== undefined && id !== null) return fail(id, -32601, 'Метод не поддерживается: ' + method);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Некорректный JSON'); }
  handle(msg).catch((e) => fail(msg.id ?? null, -32603, String(e?.message || e)));
});
