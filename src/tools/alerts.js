import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/alerts.js';

export function registerAlertTools(server) {
  server.tool('alert_create', 'Create a price alert (TradingView pricealerts REST API)', {
    condition: z.string().describe('crossing | crossing_up | crossing_down | greater_than | less_than'),
    price: z.coerce.number().describe('Price level for the alert'),
    message: z.string().optional().describe('Alert message (defaults to "<symbol> <condition> <price>")'),
    symbol: z.string().optional().describe('Symbol, e.g. "BINANCE:BTCUSDT". Defaults to the chart symbol.'),
    resolution: z.string().optional().describe('Check resolution, e.g. "1", "60", "D". Default "1".'),
    expiration_days: z.coerce.number().optional().describe('Days until the alert expires. Default 30.'),
  }, async ({ condition, price, message, symbol, resolution, expiration_days }) => {
    try { return jsonResult(await core.create({ condition, price, message, symbol, resolution, expiration_days })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_list', 'List active alerts', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('alert_delete', 'Delete one alert, several alerts, or all of them', {
    alert_id: z.coerce.number().optional().describe('Single alert id to delete (from alert_list)'),
    alert_ids: z.array(z.coerce.number()).optional().describe('Several alert ids to delete'),
    delete_all: z.coerce.boolean().optional().describe('Delete every alert on the account'),
  }, async ({ alert_id, alert_ids, delete_all }) => {
    try { return jsonResult(await core.deleteAlerts({ alert_id, alert_ids, delete_all })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
