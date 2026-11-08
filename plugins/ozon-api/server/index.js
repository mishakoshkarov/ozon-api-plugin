#!/usr/bin/env node
'use strict';
// MCP-сервер «Ozon API» для Claude Code. Работает локально на компьютере ученика:
// Claude запускает его сам, общается через stdin/stdout, а сервер ходит в Ozon по HTTPS.
// Без внешних зависимостей — нужен только Node.js 18+.
// Все инструменты ТОЛЬКО ЧИТАЮТ данные: цены, ставки и карточки этот сервер не меняет.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const ozon = require('./ozon.js');

const VERSION = '1.0.0';
const DATA_DIR = process.env.OZON_DATA_DIR || path.join(os.homedir(), 'ozon-data');

// ── вспомогательное ─────────────────────────────────────────────────────────
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const num = (v) => Number(String(v == null ? 0 : v).replace(/\s/g, '').replace(',', '.')) || 0;
const rub = (v) => Math.round(num(v)).toLocaleString('ru-RU');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkPeriod(from, to, maxDays) {
  if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) throw new Error('Даты в формате ГГГГ-ММ-ДД: date_from и date_to');
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  if (days < 1) throw new Error('date_from позже date_to');
  if (days > maxDays) throw new Error(`Период не длиннее ${maxDays} дней за один вызов — разбейте на части`);
  return days;
}

function mskDate(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? new Date(t + 3 * 3600000).toISOString().slice(0, 10) : '';
}

// Полный ответ сохраняем в файл, в чат отдаём сводку: сырые ответы Ozon съедают контекст.
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

// ── товары ──────────────────────────────────────────────────────────────────
async function productList(visibility = 'ALL') {
  const list = [];
  for (let lastId = '', i = 0; i < 100; i += 1) {
    const j = await ozon.seller('/v3/product/list', { filter: { visibility }, last_id: lastId, limit: 1000 });
    const items = j.result?.items || [];
    list.push(...items);
    lastId = j.result?.last_id || '';
    if (!items.length || !lastId) break;
  }
  return list;
}

async function productInfo(by, ids) {
  const out = [];
  for (const c of chunk(ids.map(String), 100)) {
    const j = await ozon.seller('/v3/product/info/list', { [by]: c });
    out.push(...(j.items || []));
  }
  return out;
}

function stockOfInfo(it) {
  let fbo = 0, fbs = 0;
  for (const s of it.stocks?.stocks || []) {
    const free = Math.max(0, num(s.present) - num(s.reserved));   // present включает резерв
    if (s.source === 'fbo') fbo += free; else fbs += free;
  }
  return { fbo, fbs };
}

async function toolProducts({ visibility = 'ALL', search = '', row_limit = 60 }) {
  const list = await productList(visibility);
  const info = await productInfo('product_id', list.map((p) => p.product_id));
  const q = String(search).toLowerCase().trim();
  const rows = info
    .filter((it) => !q || String(it.name).toLowerCase().includes(q) || String(it.offer_id).toLowerCase().includes(q))
    .map((it) => {
      const st = stockOfInfo(it);
      return [it.offer_id, it.id, it.sku || it.sources?.[0]?.sku || '', String(it.name || '').slice(0, 70),
        rub(it.price), st.fbo, st.fbs, it.statuses?.status_name || (it.is_archived ? 'архив' : '')];
    });
  const file = saveFull('products', info);
  return `Товаров: ${list.length} (видимость ${visibility})${q ? `, под фильтр «${search}»: ${rows.length}` : ''}.\n` +
    `Остаток — свободный (наличие минус резерв).\n\n` +
    table(['Артикул', 'product_id', 'SKU', 'Название', 'Цена ₽', 'FBO', 'FBS', 'Статус'], rows, row_limit) +
    `\n\nПолный ответ: ${file}`;
}

// ── остатки ─────────────────────────────────────────────────────────────────
async function toolStocks({ offer_ids = [], by_cluster = false, row_limit = 80 }) {
  const items = [];
  if (offer_ids.length) {
    for (const c of chunk(offer_ids.map(String), 100)) {
      const j = await ozon.seller('/v4/product/info/stocks', { filter: { offer_id: c, visibility: 'ALL' }, limit: 100, cursor: '' });
      items.push(...(j.items || []));
    }
  } else {
    for (let cursor = '', i = 0; i < 100; i += 1) {
      const j = await ozon.seller('/v4/product/info/stocks', { filter: { visibility: 'ALL' }, limit: 1000, cursor });
      const page = j.items || [];
      items.push(...page);
      cursor = j.cursor || '';
      if (!page.length || !cursor || page.length < 1000) break;
    }
  }
  const rows = [];
  const skus = new Set();
  for (const it of items) {
    const by = {};
    let sku = '';
    for (const s of it.stocks || []) {
      const t = s.type || 'other';
      by[t] = by[t] || { present: 0, reserved: 0 };
      by[t].present += num(s.present); by[t].reserved += num(s.reserved);
      if (s.sku) { sku = s.sku; skus.add(String(s.sku)); }
    }
    const free = (t) => (by[t] ? Math.max(0, by[t].present - by[t].reserved) : 0);
    const reserved = Object.values(by).reduce((a, b) => a + b.reserved, 0);
    const other = Object.keys(by).filter((t) => t !== 'fbo' && t !== 'fbs').map((t) => `${t}:${free(t)}`).join(' ');
    rows.push([it.offer_id, sku, free('fbo'), free('fbs'), other, reserved, free('fbo') + free('fbs')]);
  }
  rows.sort((a, b) => b[6] - a[6]);
  let text = `Позиций: ${items.length}. Свободный остаток = наличие минус резерв, по схемам отдельно.\n` +
    `Пустой FBO ещё не значит «товара нет»: смотрите FBS.\n\n` +
    table(['Артикул', 'SKU', 'FBO своб.', 'FBS своб.', 'Прочее', 'Резерв', 'Всего своб.'], rows, row_limit);
  const full = { summary: items };
  if (by_cluster) {
    const cl = [];
    for (const c of chunk([...skus], 100)) {
      const j = await ozon.seller('/v1/analytics/stocks', { skus: c });
      cl.push(...(j.items || []));
    }
    full.clusters = cl;
    // Строка ответа — склад, а ads_cluster/idc_cluster одинаковы у всех складов кластера:
    // доступное суммируем по складам, кластерные показатели берём один раз.
    const byCluster = new Map();
    for (const r of cl) {
      const key = r.offer_id + '|' + r.cluster_name;
      const g = byCluster.get(key) || { offer: r.offer_id, cluster: r.cluster_name, available: 0, warehouses: 0,
        ads: num(r.ads_cluster), idc: r.idc_cluster ?? '', grade: r.turnover_grade_cluster || '' };
      g.available += num(r.available_stock_count);
      if (num(r.available_stock_count) > 0) g.warehouses += 1;
      byCluster.set(key, g);
    }
    const crow = [...byCluster.values()].filter((g) => g.available > 0 || g.ads > 0)
      .sort((a, b) => a.offer.localeCompare(b.offer) || b.ads - a.ads)
      .map((g) => [g.offer, g.cluster, g.available, g.warehouses, g.ads.toFixed(2), g.idc, g.grade]);
    text += `\n\n### FBO по кластерам\n` +
      `Доступно — сумма по складам кластера. ads — средние продажи в день в кластере, idc — на сколько дней хватит запаса.\n\n` +
      table(['Артикул', 'Кластер', 'Доступно', 'Складов с товаром', 'ads/день', 'idc дней', 'Оборачиваемость'], crow, row_limit);
  }
  return text + `\n\nПолный ответ: ${saveFull('stocks', full)}`;
}

// ── заказы и продажи (отправления FBO + FBS) ────────────────────────────────
// Пагинация курсорная: offset эти методы молча игнорируют, конец — has_next === false.
const POSTING_ENDPOINTS = [['FBO', '/v3/posting/fbo/list'], ['FBS', '/v4/posting/fbs/list']];

function postingsOf(resp) {
  if (Array.isArray(resp?.postings)) return resp.postings;
  if (Array.isArray(resp?.result)) return resp.result;
  if (Array.isArray(resp?.result?.postings)) return resp.result.postings;
  return [];
}

async function fetchPostings(from, to) {
  const w = ozon.mskDayWindow(from, to);
  const out = [];
  for (const [scheme, endpoint] of POSTING_ENDPOINTS) {
    let cursor = null, offset = 0, lastCursor = null;
    for (let page = 1; page <= 500; page += 1) {
      const body = { dir: 'ASC', filter: { since: w.since, to: w.to }, limit: 100,
        translit: true, with: { analytics_data: false, financial_data: false } };
      if (cursor) body.cursor = cursor; else body.offset = offset;
      const r = await ozon.seller(endpoint, body);
      const list = postingsOf(r);
      for (const p of list) out.push({ ...p, _scheme: scheme });
      if (typeof r?.has_next === 'boolean') {
        if (!r.has_next || !r.cursor || r.cursor === lastCursor || !list.length) break;
        lastCursor = cursor = r.cursor;
      } else {
        if (list.length < 100) break;
        offset += list.length;
      }
    }
  }
  return out;
}

async function toolOrders({ date_from, date_to, group_by = 'day', row_limit = 60 }) {
  checkPeriod(date_from, date_to, 31);
  const postings = await fetchPostings(date_from, date_to);
  const seen = new Set();
  const groups = new Map();
  const tot = { orders: new Set(), postings: 0, units: 0, revenue: 0, cancelled: 0, FBO: 0, FBS: 0 };
  for (const p of postings) {
    const num_ = String(p.posting_number || '');
    if (!num_ || seen.has(num_)) continue;
    seen.add(num_);
    const cancelled = /cancel/i.test(p.status || '');
    const date = mskDate(p.in_process_at || p.created_at);
    tot.postings += 1; tot[p._scheme] += 1;
    if (cancelled) { tot.cancelled += 1; continue; }
    const orderNo = p.order_number || num_.split('-')[0];
    tot.orders.add(orderNo);
    for (const pr of p.products || []) {
      const key = group_by === 'offer' ? pr.offer_id : date;
      const g = groups.get(key) || { key, name: pr.name || '', orders: new Set(), units: 0, revenue: 0, FBO: 0, FBS: 0 };
      // Цена в отправлении приходит объектом {amount, currency}; старые версии отдавали строку.
      const price = typeof pr.price === 'object' && pr.price ? pr.price.amount : pr.price;
      const q = num(pr.quantity), sum = num(price) * q;
      g.orders.add(orderNo); g.units += q; g.revenue += sum; g[p._scheme] += q;
      groups.set(key, g);
      tot.units += q; tot.revenue += sum;
    }
  }
  const rows = [...groups.values()]
    .sort((a, b) => (group_by === 'offer' ? b.revenue - a.revenue : a.key.localeCompare(b.key)))
    .map((g) => [g.key, ...(group_by === 'offer' ? [String(g.name).slice(0, 50)] : []), g.orders.size, g.units, rub(g.revenue), g.FBO, g.FBS]);
  const head = group_by === 'offer' ? ['Артикул', 'Название', 'Заказы', 'Шт', 'Сумма ₽', 'Шт FBO', 'Шт FBS'] : ['Дата (МСК)', 'Заказы', 'Шт', 'Сумма ₽', 'Шт FBO', 'Шт FBS'];
  const file = saveFull('orders', postings);
  return `Период ${date_from} — ${date_to} (дни по Москве).\n` +
    `Отправлений: ${tot.postings} (FBO ${tot.FBO}, FBS ${tot.FBS}), из них отменено: ${tot.cancelled}.\n` +
    `Без отмен: заказов ${tot.orders.size}, штук ${tot.units}, сумма ${rub(tot.revenue)} ₽.\n` +
    `Сумма — цена товара в отправлении. Это ещё не выкуп и не деньги к выплате: возвраты и удержания Ozon сюда не входят.\n` +
    `Один заказ может состоять из нескольких отправлений, поэтому заказов меньше, чем отправлений.\n\n` +
    table(head, rows, row_limit) + `\n\nПолный ответ: ${file}`;
}

// ── воронка аналитики ───────────────────────────────────────────────────────
const FULL_FUNNEL = ['hits_view_search', 'hits_view_pdp', 'session_view_search', 'session_view_pdp',
  'hits_tocart_search', 'hits_tocart_pdp', 'conv_tocart_search', 'conv_tocart_pdp',
  'ordered_units', 'revenue', 'returns', 'cancellations', 'delivered_units'];

async function subscription() {
  const j = await ozon.seller('/v1/seller/info', {});
  const s = j.subscription || j.result?.subscription || {};
  return { premium: !!s.is_premium, type: String(s.type || 'NONE').toUpperCase(), raw: j };
}

async function toolFunnel({ date_from, date_to, dimension = 'day', metrics = [], row_limit = 60 }) {
  checkPeriod(date_from, date_to, 366);
  const sub = await subscription();
  const full = ['PREMIUM_PLUS', 'PREMIUM_PRO'].includes(sub.type);
  const allowed = full ? FULL_FUNNEL : ['revenue', 'ordered_units'];
  const asked = (metrics.length ? metrics : allowed).filter((m) => allowed.includes(m)).slice(0, 14);
  const dropped = metrics.filter((m) => !allowed.includes(m));
  const j = await ozon.seller('/v1/analytics/data', { date_from, date_to, metrics: asked,
    dimension: [dimension], filters: [], sort: [{ key: asked[0], order: 'DESC' }], limit: 1000, offset: 0 });
  const data = j.result?.data || [];
  const rows = data.map((r) => [r.dimensions?.[0]?.id || '', ...(dimension === 'sku' ? [String(r.dimensions?.[0]?.name || '').slice(0, 50)] : []),
    ...(r.metrics || []).map((v) => (Number.isInteger(v) ? v : Number(v).toFixed(2)))]);
  if (dimension === 'day') rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const head = [dimension === 'sku' ? 'SKU' : 'Дата', ...(dimension === 'sku' ? ['Название'] : []), ...asked];
  return `Подписка кабинета: ${sub.type}. ` +
    (full ? 'Доступна полная воронка.\n' : 'Без Premium Plus Ozon отдаёт только revenue и ordered_units.\n') +
    (dropped.length ? `Пропущены недоступные метрики: ${dropped.join(', ')}.\n` : '') +
    `ordered_units — это штуки, а не заказы. Сессии магазина не равны сумме сессий по SKU: в разрезе sku одна сессия попадает в несколько товаров.\n` +
    `Метод сильно лимитирован: не чаще раза в минуту, без подписки около 50 вызовов в сутки.\n\n` +
    table(head, rows, row_limit) + (j.result?.totals ? `\n\nИтого: ${asked.map((m, i) => `${m}=${j.result.totals[i]}`).join(', ')}` : '') +
    `\n\nПолный ответ: ${saveFull('funnel', j)}`;
}

// ── контент товара ──────────────────────────────────────────────────────────
async function toolContent({ offer_ids = [], with_description = true }) {
  if (!offer_ids.length) throw new Error('Укажите offer_ids — артикулы продавца (до 20 штук)');
  if (offer_ids.length > 20) throw new Error('Не больше 20 артикулов за вызов');
  const ids = offer_ids.map(String);
  const info = await productInfo('offer_id', ids);
  const aj = await ozon.seller('/v4/product/info/attributes', { filter: { offer_id: ids, visibility: 'ALL' }, limit: 100, last_id: '', sort_dir: 'ASC' });
  const attrs = new Map((aj.result || []).map((a) => [a.offer_id, a]));
  const dict = new Map();
  const out = [];
  for (const it of info) {
    const a = attrs.get(it.offer_id) || {};
    const key = `${a.description_category_id || it.description_category_id}|${a.type_id || it.type_id}`;
    if (!dict.has(key) && a.description_category_id) {
      try {
        const d = await ozon.seller('/v1/description-category/attribute',
          { description_category_id: a.description_category_id, type_id: a.type_id, language: 'DEFAULT' });
        dict.set(key, new Map((d.result || []).map((x) => [x.id, x])));
      } catch { dict.set(key, new Map()); }
    }
    const names = dict.get(key) || new Map();
    let description = '';
    if (with_description) {
      try { description = (await ozon.seller('/v1/product/info/description', { product_id: it.id })).result?.description || ''; }
      catch (e) { description = `(не получено: ${e.message.slice(0, 80)})`; }
    }
    out.push({
      offer_id: it.offer_id, product_id: it.id, sku: it.sku || it.sources?.[0]?.sku, name: it.name,
      status: it.statuses?.status_name, price: it.price, old_price: it.old_price,
      category_id: a.description_category_id, type_id: a.type_id,
      dimensions: a.height ? `${a.depth}×${a.width}×${a.height} ${a.dimension_unit}, ${a.weight} ${a.weight_unit}` : '',
      model: a.model_info ? `model_id ${a.model_info.model_id}, вариантов в склейке: ${a.model_info.count}` : '',
      images: a.images || it.images || [], primary_image: a.primary_image || it.primary_image,
      attributes: (a.attributes || []).map((x) => {
        const meta = names.get(x.id);
        return { id: x.id, name: meta?.name || `атрибут ${x.id}`, required: !!meta?.is_required,
          value: (x.values || []).map((v) => v.value).join('; ') };
      }),
      description,
    });
  }
  const text = out.map((p) => [
    `## ${p.offer_id} — ${p.name}`,
    `product_id ${p.product_id} · SKU ${p.sku} · ${p.status || ''} · цена ${rub(p.price)} ₽ (зачёркнутая ${rub(p.old_price)} ₽)`,
    p.dimensions && `Габариты: ${p.dimensions}`, p.model && `Склейка: ${p.model}`,
    `Фото: ${p.images.length}. Главное: ${p.primary_image || '—'}`,
    `Характеристики (${p.attributes.length}):`,
    ...p.attributes.map((x) => `- ${x.name}${x.required ? ' *' : ''}: ${String(x.value).slice(0, 200)}`),
    with_description && `Описание (${p.description.length} симв.):\n${p.description.slice(0, 1500)}${p.description.length > 1500 ? '…' : ''}`,
  ].filter(Boolean).join('\n')).join('\n\n');
  const missing = ids.filter((id) => !info.some((it) => it.offer_id === id));
  return (missing.length ? `Не найдены артикулы: ${missing.join(', ')}\n\n` : '') + text +
    `\n\n* — обязательная характеристика категории. Пустая характеристика ещё не дефект: часть полей Ozon заполняет сам (например, «Тип» задаётся type_id).` +
    `\n\nПолный ответ: ${saveFull('content', out)}`;
}

// ── реклама ─────────────────────────────────────────────────────────────────
async function toolAdsCampaigns({ only_running = false, row_limit = 80 }) {
  const j = await ozon.performance('/api/client/campaign');
  let list = j.list || [];
  if (only_running) list = list.filter((c) => /RUNNING/i.test(c.state || ''));
  const rows = list.map((c) => [c.id, String(c.title || '').slice(0, 50), c.state, c.advObjectType || '',
    c.PaymentType || c.paymentType || '', c.dailyBudget != null ? rub(num(c.dailyBudget) / 1e6) : '', c.weeklyBudget != null ? rub(num(c.weeklyBudget) / 1e6) : '']);
  return `Кампаний: ${list.length}.\nБюджеты в API хранятся в микрорублях, здесь переведены в рубли.\n\n` +
    table(['ID', 'Название', 'Статус', 'Тип', 'Оплата', 'Бюджет в день ₽', 'Бюджет в неделю ₽'], rows, row_limit) +
    `\n\nПолный ответ: ${saveFull('ads_campaigns', j)}`;
}

async function toolAdsStats({ date_from, date_to, group_by = 'campaign', row_limit = 80 }) {
  checkPeriod(date_from, date_to, 180);
  const windows = [];
  for (let cur = date_from; cur <= date_to;) {
    const end = new Date(Date.parse(cur) + 59 * 86400000).toISOString().slice(0, 10);
    const to = end < date_to ? end : date_to;
    windows.push([cur, to]);
    cur = new Date(Date.parse(to) + 86400000).toISOString().slice(0, 10);
  }
  const raw = [];
  for (const [f, t] of windows) {
    const j = await ozon.performance('/api/client/statistics/daily/json', { dateFrom: f, dateTo: t });
    raw.push(...(j?.rows || []));
  }
  const groups = new Map();
  const tot = { spend: 0, views: 0, clicks: 0, orders: 0, money: 0 };
  for (const r of raw) {
    const key = group_by === 'day' ? String(r.date || '').slice(0, 10) : String(r.id);
    const g = groups.get(key) || { key, title: r.title || '', spend: 0, views: 0, clicks: 0, orders: 0, money: 0 };
    g.spend += num(r.moneySpent); g.views += num(r.views); g.clicks += num(r.clicks);
    g.orders += num(r.orders); g.money += num(r.ordersMoney);
    groups.set(key, g);
    tot.spend += num(r.moneySpent); tot.views += num(r.views); tot.clicks += num(r.clicks);
    tot.orders += num(r.orders); tot.money += num(r.ordersMoney);
  }
  const rows = [...groups.values()]
    .sort((a, b) => (group_by === 'day' ? a.key.localeCompare(b.key) : b.spend - a.spend))
    .map((g) => [g.key, ...(group_by === 'day' ? [] : [String(g.title).slice(0, 45)]), rub(g.spend), g.views, g.clicks,
      g.views ? (g.clicks / g.views * 100).toFixed(2) + '%' : '—', g.orders, rub(g.money),
      g.money ? (g.spend / g.money * 100).toFixed(1) + '%' : '—']);
  const head = [group_by === 'day' ? 'Дата' : 'ID', ...(group_by === 'day' ? [] : ['Кампания']), 'Расход ₽', 'Показы', 'Клики', 'CTR', 'Заказы', 'Сумма заказов ₽', 'ДРР к рекл. заказам'];
  return `Реклама ${date_from} — ${date_to}: расход ${rub(tot.spend)} ₽, показы ${tot.views}, клики ${tot.clicks}, ` +
    `заказы ${tot.orders} на ${rub(tot.money)} ₽.\n` +
    `У кампаний «Оплата за заказ» этот отчёт показывает расход, но заказы и их сумма всегда нули: они живут в отдельном отчёте. ` +
    `Поэтому такие кампании здесь выглядят убыточными, хотя это не так.\n` +
    `ДРР здесь считается к рекламным заказам, а не ко всей выручке магазина.\n\n` +
    table(head, rows, row_limit) + `\n\nПолный ответ: ${saveFull('ads_stats', raw)}`;
}

// ── проверка подключения ────────────────────────────────────────────────────
async function toolCheck() {
  const k = ozon.keysStatus();
  const lines = [`Файл ключей: ${k.file} — ${k.fileExists ? 'найден' : 'НЕ НАЙДЕН'}`,
    `Seller API: Client-Id ${k.seller.clientId}, Api-Key ${k.seller.apiKey}`,
    `Performance API: client_id ${k.performance.clientId}, secret ${k.performance.secret}`, ''];
  try {
    const sub = await subscription();
    const name = sub.raw.company?.name || sub.raw.result?.company?.name || '';
    lines.push(`✅ Seller API отвечает${name ? ` — кабинет «${name}»` : ''}. Подписка: ${sub.type}.`);
  } catch (e) { lines.push(`❌ Seller API: ${e.message}`); }
  if (k.performance.secret === 'есть') {
    try {
      const j = await ozon.performance('/api/client/campaign');
      lines.push(`✅ Performance API отвечает — кампаний: ${(j.list || []).length}.`);
    } catch (e) { lines.push(`❌ Performance API: ${e.message}`); }
  } else lines.push('⬜ Performance API не настроен: без него не будет рекламы.');
  lines.push('', `Полные ответы инструменты сохраняют в ${DATA_DIR}`);
  return lines.join('\n');
}

// ── описание инструментов для Claude ────────────────────────────────────────
const period = {
  date_from: { type: 'string', description: 'Начало периода, ГГГГ-ММ-ДД (день по Москве)' },
  date_to: { type: 'string', description: 'Конец периода включительно, ГГГГ-ММ-ДД' },
};
const rowLimit = { row_limit: { type: 'integer', description: 'Сколько строк показать в чате (полный ответ всё равно сохраняется в файл)' } };

const TOOLS = [
  { name: 'ozon_check', handler: toolCheck,
    description: 'Проверить подключение к Ozon: найдены ли ключи, отвечают ли Seller API и Performance API, какая подписка у кабинета. Запускать первым.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'ozon_products', handler: toolProducts,
    description: 'Список товаров магазина: артикул, product_id, SKU, название, цена, свободный остаток FBO и FBS, статус.',
    inputSchema: { type: 'object', properties: {
      visibility: { type: 'string', enum: ['ALL', 'VISIBLE', 'INVISIBLE', 'ARCHIVED'], description: 'Какие товары брать, по умолчанию ALL' },
      search: { type: 'string', description: 'Фильтр по подстроке в названии или артикуле' }, ...rowLimit } } },
  { name: 'ozon_stocks', handler: toolStocks,
    description: 'Остатки FBO и FBS по товарам (свободно и в резерве). С by_cluster=true добавляет FBO по кластерам и складам: доступно к продаже, средние продажи в день, на сколько дней хватит.',
    inputSchema: { type: 'object', properties: {
      offer_ids: { type: 'array', items: { type: 'string' }, description: 'Артикулы продавца; пусто — весь магазин' },
      by_cluster: { type: 'boolean', description: 'Добавить разрез по кластерам и складам FBO' }, ...rowLimit } } },
  { name: 'ozon_orders', handler: toolOrders,
    description: 'Заказы и продажи по отправлениям FBO и FBS за период до 31 дня: заказы, штуки, сумма, отмены. Группировка по дням или по артикулам.',
    inputSchema: { type: 'object', required: ['date_from', 'date_to'], properties: { ...period,
      group_by: { type: 'string', enum: ['day', 'offer'], description: 'day — по дням, offer — по артикулам' }, ...rowLimit } } },
  { name: 'ozon_funnel', handler: toolFunnel,
    description: 'Воронка из аналитики Ozon (/v1/analytics/data): показы, сессии, корзины, заказанные штуки, выручка по дням или по SKU. Без подписки Premium Plus Ozon отдаёт только выручку и штуки. Метод вызывать не чаще раза в минуту.',
    inputSchema: { type: 'object', required: ['date_from', 'date_to'], properties: { ...period,
      dimension: { type: 'string', enum: ['day', 'sku'], description: 'Разрез: по дням или по товарам' },
      metrics: { type: 'array', items: { type: 'string', enum: FULL_FUNNEL }, description: 'Какие метрики; пусто — все доступные' }, ...rowLimit } } },
  { name: 'ozon_product_content', handler: toolContent,
    description: 'Контент карточек по артикулам (до 20): название, цена, статус, габариты, склейка, фото, все характеристики с названиями и пометкой обязательных, описание.',
    inputSchema: { type: 'object', required: ['offer_ids'], properties: {
      offer_ids: { type: 'array', items: { type: 'string' }, description: 'Артикулы продавца (offer_id)' },
      with_description: { type: 'boolean', description: 'Тянуть описание (по запросу на каждый товар), по умолчанию да' } } } },
  { name: 'ozon_ads_campaigns', handler: toolAdsCampaigns,
    description: 'Рекламные кампании (Performance API): id, название, статус, тип, модель оплаты, бюджеты.',
    inputSchema: { type: 'object', properties: {
      only_running: { type: 'boolean', description: 'Только активные' }, ...rowLimit } } },
  { name: 'ozon_ads_stats', handler: toolAdsStats,
    description: 'Статистика рекламы за период до 180 дней: расход, показы, клики, CTR, заказы, сумма заказов, ДРР. По кампаниям или по дням.',
    inputSchema: { type: 'object', required: ['date_from', 'date_to'], properties: { ...period,
      group_by: { type: 'string', enum: ['campaign', 'day'], description: 'campaign — по кампаниям, day — по дням' }, ...rowLimit } } },
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
      serverInfo: { name: 'ozon-api', version: VERSION },
      instructions: 'Инструменты только читают данные Ozon. Начинайте с ozon_check.',
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
  // уведомления (notifications/initialized и т. п.) ответа не требуют
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Некорректный JSON'); }
  handle(msg).catch((e) => fail(msg.id ?? null, -32603, String(e?.message || e)));
});
