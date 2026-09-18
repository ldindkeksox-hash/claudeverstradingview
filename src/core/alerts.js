/**
 * Core alert logic.
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

// Condition names accepted by the tool -> condition types accepted by the
// pricealerts REST API. Every mapping below was verified live against the API.
const CONDITION_MAP = {
  crossing: 'cross',
  cross: 'cross',
  crossing_up: 'cross_up',
  cross_up: 'cross_up',
  crossing_down: 'cross_down',
  cross_down: 'cross_down',
  greater_than: 'greater',
  greater: 'greater',
  above: 'greater',
  less_than: 'less',
  less: 'less',
  below: 'less',
};

export async function create({ condition, price, message, symbol, resolution, expiration_days }) {
  const key = String(condition == null ? 'crossing' : condition).toLowerCase();
  const type = CONDITION_MAP[key];
  if (!type) {
    throw new Error('Unknown condition "' + condition + '". Supported: ' + Object.keys(CONDITION_MAP).join(', '));
  }

  const value = Number(price);
  if (!Number.isFinite(value)) throw new Error('price must be a finite number');

  // The API wants a symbol descriptor, not a bare ticker. Reuse the chart's own
  // descriptor when we are alerting on the symbol it already has loaded.
  const chart = await evaluate(`
    (function() {
      try {
        var w = window.TradingViewApi._activeChartWidgetWV.value();
        var si = w._chartWidget.model().mainSeries().symbolInfo() || {};
        return { symbol: w.symbol(), currency_id: si.currency_id || null };
      } catch (e) { return null; }
    })()
  `);

  const target = symbol || (chart && chart.symbol);
  if (!target) throw new Error('No symbol given and none could be read from the chart');

  const descriptor = { session: 'regular', symbol: target };
  if (chart && chart.symbol === target && chart.currency_id) {
    descriptor['currency-id'] = chart.currency_id;
  }

  const res = String(resolution || '1');
  const days = Number(expiration_days) > 0 ? Number(expiration_days) : 30;
  const text = message || (target + ' ' + type + ' ' + value);

  const body = {
    payload: {
      conditions: [{
        type,
        frequency: 'on_first_fire',
        series: [{ type: 'barset' }, { type: 'value', value }],
        resolution: res,
      }],
      symbol: '=' + JSON.stringify(descriptor),
      resolution: res,
      message: text,
      sound_file: null,
      sound_duration: 0,
      popup: true,
      auto_deactivate: true,
      email: false,
      sms_over_email: false,
      mobile_push: true,
      web_hook: null,
      name: null,
      expiration: new Date(Date.now() + days * 86400000).toISOString(),
      active: true,
      ignore_warnings: true,
    },
  };

  const raw = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/create_alert', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: ${JSON.stringify(JSON.stringify(body))}
    }).then(function(r) { return r.text(); })
  `);

  let data = null;
  try { data = JSON.parse(raw); } catch (e) { /* non-JSON response */ }

  if (!data || data.s !== 'ok') {
    const reason = (data && (data.errmsg || (data.err && data.err.code))) || String(raw).slice(0, 200);
    return { success: false, error: 'create_alert refused: ' + reason, symbol: target, condition: type, price: value };
  }

  const id = (data.r && data.r.alert_id) || null;

  // An alert whose condition is ALREADY true fires at once and, with
  // auto_deactivate, is spent before it is ever useful. Re-read it and say so
  // rather than reporting a healthy alert that is in fact dead.
  let firedImmediately = false;
  if (id) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const back = await list();
      const mine = (back.alerts || []).find(a => a.alert_id === id);
      if (mine && (mine.active === false || mine.last_fired)) firedImmediately = true;
    } catch (e) { /* verification is best-effort */ }
  }

  return {
    success: true,
    fired_immediately: firedImmediately,
    warning: firedImmediately
      ? 'Condition was already true: the alert fired at once and is now inactive. Pick a level the price has not reached yet.'
      : undefined,
    alert_id: id,
    symbol: target,
    condition: type,
    price: value,
    message: text,
    resolution: res,
    expiration: (data.r && data.r.expiration) || null,
    source: 'rest_api',
  };
}

export async function list() {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [], error: result?.error };
}

export async function deleteAlerts({ delete_all, alert_id, alert_ids }) {
  let ids = [];

  if (Array.isArray(alert_ids) && alert_ids.length) {
    ids = alert_ids.map(Number).filter(Number.isFinite);
  } else if (alert_id != null) {
    ids = [Number(alert_id)].filter(Number.isFinite);
  } else if (delete_all) {
    const listed = await list();
    ids = (listed.alerts || []).map(a => a.alert_id).filter(Number.isFinite);
  } else {
    throw new Error('Provide alert_id, alert_ids, or delete_all: true');
  }

  if (!ids.length) return { success: true, deleted: 0, note: 'No alerts to delete', source: 'rest_api' };

  const raw = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/delete_alerts', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: ${JSON.stringify(JSON.stringify({ payload: { alert_ids: ids } }))}
    }).then(function(r) { return r.text(); })
  `);

  let data = null;
  try { data = JSON.parse(raw); } catch (e) { /* non-JSON response */ }

  if (!data || data.s !== 'ok') {
    const reason = (data && (data.errmsg || (data.err && data.err.code))) || String(raw).slice(0, 200);
    return { success: false, error: 'delete_alerts refused: ' + reason, requested: ids };
  }

  return { success: true, deleted: ids.length, alert_ids: ids, source: 'rest_api' };
}
