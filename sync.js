// Cloudflare Worker `tonic-sync-api` client.
// Adjust the paths in this file if the worker contract changes.
//   GET  /health                         -> { ok: true, service: "tonic-sync-api" }  (no PIN)
//   GET  /crm/records                    -> { ok: true, records: [...] }
//   PUT  /crm/records/:inquiryId         -> { ok: true, record }
//   POST /crm/bulk   { records: [...] }  -> { ok: true, upserted: n, records }
// Every route except GET /health sends X-App-Pin.
// Errors are { ok: false, error } with HTTP 401, 403, 400, or 502.
// Read updatedAt is the Notion last-edited time. A dead record may include
// stage 詢價 / 報價 / 成交 / 回購. The PIN is never written to logs.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TalosSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const STORE_KEY = "talos_crm_v2";
  const OUTBOX_KEY = "talos_crm_outbox";
  const SETTINGS_KEY = "talos_crm_sync";
  const STORE_VERSION = 2;
  const SERVICE_NAME = "tonic-sync-api";
  const STAGES = ["詢價", "報價", "成交", "回購"];
  const logs = [];

  function cleanPin(pin) {
    return String(pin ?? "").replace(/[\r\n]/g, "").trim();
  }

  function normalizeBaseUrl(url) {
    return String(url ?? "").trim().replace(/\/+$/, "");
  }

  function isConfigured(settings) {
    const baseUrl = normalizeBaseUrl(settings && settings.baseUrl);
    const pin = cleanPin(settings && settings.pin);
    return /^https?:\/\//i.test(baseUrl) && pin.length > 0;
  }

  function joinUrl(baseUrl, path) {
    return normalizeBaseUrl(baseUrl) + path;
  }

  function timestamp(value) {
    const n = Date.parse(value || "");
    return Number.isFinite(n) ? n : 0;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function redact(text, pin) {
    let out = String(text ?? "");
    const token = cleanPin(pin);
    if (token) {
      out = out.split(token).join("[redacted]");
      const encoded = encodeURIComponent(token);
      if (encoded && encoded !== token) out = out.split(encoded).join("[redacted]");
    }
    return out.replace(/X-App-Pin\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi, "X-App-Pin=[redacted]");
  }

  function emitLog(level, message, pin, options) {
    const entry = { level: level, message: redact(message, pin), at: new Date().toISOString() };
    logs.push(entry);
    if (logs.length > 100) logs.shift();
    if (options && typeof options.log === "function") {
      try { options.log({ level: entry.level, message: entry.message }); }
      catch { /* a broken logger must not break sync */ }
    }
    return entry;
  }

  function readLogs() {
    return logs.map(entry => ({ level: entry.level, message: entry.message, at: entry.at }));
  }

  function clearLogs() {
    logs.length = 0;
  }

  function codeForStatus(status) {
    if (status === 401) return "UNAUTHORIZED";
    if (status === 403) return "FORBIDDEN";
    if (status === 400) return "BAD_REQUEST";
    if (status === 502) return "UPSTREAM";
    return "HTTP";
  }

  function statusFromError(err) {
    if (err && err.code === "UNAUTHORIZED") return "unauthorized";
    if (err && err.code === "FORBIDDEN") return "forbidden";
    if (err && err.code === "BAD_REQUEST") return "rejected";
    if (err && err.code === "NOT_CONFIGURED") return "unconfigured";
    return "unreachable";
  }

  function safeMessage(err) {
    if (err && err.code === "UNAUTHORIZED") return "PIN 不正確";
    if (err && err.code === "FORBIDDEN") return "來源未被允許";
    if (err && err.code === "BAD_REQUEST") return "雲端拒絕了這筆資料";
    if (err && err.code === "UPSTREAM") return "雲端暫時無法寫入";
    if (err && err.code === "NOT_CONFIGURED") return "尚未設定雲端同步";
    return "雲端暫時無法連線";
  }

  function hooks(options) {
    return {
      fetch: options && options.fetch,
      log: options && options.log
    };
  }

  function parseRecordsResponse(body) {
    if (body && body.ok !== false && Array.isArray(body.records)) return body.records;
    return [];
  }

  function toRequestRecord(record) {
    const payload = clone(record);
    if (!payload || payload.status !== "dead" || STAGES.indexOf(payload.stage) === -1) {
      if (payload) delete payload.stage;
    }
    return payload;
  }

  function applyServerTimestamps(localRecords, serverRecords) {
    const times = new Map();
    for (const record of serverRecords || []) {
      if (record && record.inquiryId && record.updatedAt) times.set(record.inquiryId, record.updatedAt);
    }
    return (Array.isArray(localRecords) ? localRecords : []).map(local => {
      if (!local || !local.inquiryId) return local;
      const serverTime = times.get(local.inquiryId);
      if (!serverTime || timestamp(serverTime) < timestamp(local.updatedAt)) return local;
      return Object.assign({}, local, { updatedAt: serverTime });
    });
  }

  async function apiRequest(settings, path, options) {
    const method = (options && options.method) || "GET";
    const fetchImpl = (options && options.fetch) || globalThis.fetch;
    const pin = cleanPin(settings && settings.pin);
    const baseUrl = normalizeBaseUrl(settings && settings.baseUrl);
    if (!isConfigured({ baseUrl: baseUrl, pin: pin })) {
      const error = new Error("not configured");
      error.code = "NOT_CONFIGURED";
      throw error;
    }
    if (typeof fetchImpl !== "function") {
      emitLog("error", method + " " + path + " unavailable", pin, options);
      const error = new Error("unreachable");
      error.code = "UNREACHABLE";
      throw error;
    }
    let response;
    try {
      const headers = { "Accept": "application/json" };
      if (path !== "/health") headers["X-App-Pin"] = pin;
      const init = { method: method, headers: headers, cache: "no-store", credentials: "omit" };
      if (options && options.body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(options.body);
      }
      response = await fetchImpl(joinUrl(baseUrl, path), init);
    } catch (err) {
      emitLog("error", method + " " + path + " failed: " + (err && err.message ? err.message : "network"), pin, options);
      const error = new Error("unreachable");
      error.code = "UNREACHABLE";
      throw error;
    }
    let payload = null;
    try { payload = await response.json(); }
    catch { payload = null; }
    const status = response && response.status ? response.status : 0;
    if (!response || !response.ok || (payload && payload.ok === false)) {
      const serverText = payload && payload.error ? String(payload.error) : "";
      emitLog("error", method + " " + path + " -> " + status + " " + serverText, pin, options);
      const error = new Error("http");
      error.code = codeForStatus(status);
      error.status = status;
      throw error;
    }
    return payload || {};
  }

  function readRecords(storage) {
    try {
      const raw = storage.getItem(STORE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return parsed && Array.isArray(parsed.records) ? parsed.records : [];
    } catch {
      return [];
    }
  }

  function saveLocal(storage, records) {
    storage.setItem(STORE_KEY, JSON.stringify({
      version: STORE_VERSION,
      savedAt: new Date().toISOString(),
      records: Array.isArray(records) ? records : []
    }));
  }

  function readOutbox(storage) {
    try {
      const raw = storage.getItem(OUTBOX_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeOutbox(storage, outbox) {
    storage.setItem(OUTBOX_KEY, JSON.stringify(Array.isArray(outbox) ? outbox : []));
  }

  function readSettings(storage) {
    try {
      const raw = storage.getItem(SETTINGS_KEY);
      if (!raw) return { baseUrl: "", pin: "" };
      const parsed = JSON.parse(raw);
      return {
        baseUrl: parsed && parsed.baseUrl ? String(parsed.baseUrl) : "",
        pin: parsed && parsed.pin ? String(parsed.pin) : ""
      };
    } catch {
      return { baseUrl: "", pin: "" };
    }
  }

  function writeSettings(storage, settings) {
    const stored = {
      baseUrl: normalizeBaseUrl(settings && settings.baseUrl),
      pin: cleanPin(settings && settings.pin)
    };
    storage.setItem(SETTINGS_KEY, JSON.stringify(stored));
    return stored;
  }

  function mergeRecords(localRecords, remoteRecords) {
    const local = Array.isArray(localRecords) ? localRecords : [];
    const remote = Array.isArray(remoteRecords) ? remoteRecords : [];
    const merged = [];
    const indexById = new Map();
    for (const record of local) {
      if (!record || !record.inquiryId) continue;
      indexById.set(record.inquiryId, merged.length);
      merged.push(record);
    }
    for (const record of remote) {
      if (!record || !record.inquiryId) continue;
      const index = indexById.get(record.inquiryId);
      if (index === undefined) {
        indexById.set(record.inquiryId, merged.length);
        merged.push(record);
        continue;
      }
      if (timestamp(record.updatedAt) > timestamp(merged[index].updatedAt)) merged[index] = record;
    }
    return merged;
  }

  function enqueueOutbox(outbox, record) {
    if (!record || !record.inquiryId) return Array.isArray(outbox) ? outbox.slice() : [];
    const queue = (Array.isArray(outbox) ? outbox : []).filter(item => item && item.inquiryId !== record.inquiryId);
    queue.push({
      inquiryId: record.inquiryId,
      record: clone(record),
      queuedAt: new Date().toISOString()
    });
    return queue;
  }

  function planRetry(localRecords, remoteRecords, outbox) {
    const merged = mergeRecords(localRecords, remoteRecords);
    const remoteById = new Map();
    for (const record of remoteRecords || []) {
      if (record && record.inquiryId) remoteById.set(record.inquiryId, record);
    }
    const mergedById = new Map(merged.map(record => [record.inquiryId, record]));
    const toPush = [];
    for (const item of outbox || []) {
      const id = item && item.inquiryId;
      if (!id) continue;
      const current = mergedById.get(id);
      if (!current) continue;
      const remote = remoteById.get(id);
      if (!remote || timestamp(current.updatedAt) > timestamp(remote.updatedAt)) toPush.push(current);
    }
    return { merged: merged, toPush: toPush };
  }

  async function pushRecord(settings, record, outbox, options) {
    const queue = Array.isArray(outbox) ? outbox.slice() : [];
    if (!record || !record.inquiryId) {
      return { ok: false, skipped: true, status: "invalid", outbox: queue };
    }
    if (!isConfigured(settings)) {
      return { ok: false, skipped: true, status: "unconfigured", outbox: queue };
    }
    try {
      const body = await apiRequest(settings, "/crm/records/" + encodeURIComponent(record.inquiryId), {
        method: "PUT",
        body: toRequestRecord(record),
        fetch: hooks(options).fetch,
        log: hooks(options).log
      });
      return {
        ok: true,
        skipped: false,
        status: "online",
        record: body && body.record ? body.record : record,
        outbox: queue.filter(item => item && item.inquiryId !== record.inquiryId)
      };
    } catch (err) {
      return {
        ok: false,
        skipped: false,
        status: statusFromError(err),
        error: safeMessage(err),
        outbox: enqueueOutbox(queue, record)
      };
    }
  }

  async function retryOutbox(settings, outbox, options) {
    const queue = Array.isArray(outbox) ? outbox : [];
    if (!isConfigured(settings)) {
      return { ok: false, skipped: true, status: "unconfigured", outbox: queue.slice(), flushed: 0 };
    }
    const remaining = [];
    const saved = [];
    let flushed = 0;
    let failure = null;
    for (const item of queue) {
      if (!item || !item.record || !item.record.inquiryId) continue;
      try {
        const body = await apiRequest(settings, "/crm/records/" + encodeURIComponent(item.record.inquiryId), {
          method: "PUT",
          body: toRequestRecord(item.record),
          fetch: hooks(options).fetch,
          log: hooks(options).log
        });
        saved.push(body && body.record ? body.record : item.record);
        flushed += 1;
      } catch (err) {
        failure = err;
        remaining.push(item);
      }
    }
    return {
      ok: remaining.length === 0,
      skipped: false,
      status: remaining.length === 0 ? "online" : statusFromError(failure),
      outbox: remaining,
      flushed: flushed,
      records: saved
    };
  }

  async function syncOnLoad(settings, localRecords, outbox, options) {
    const local = Array.isArray(localRecords) ? localRecords : [];
    const queue = Array.isArray(outbox) ? outbox : [];
    if (!isConfigured(settings)) {
      return { ok: false, skipped: true, status: "unconfigured", records: local, outbox: queue };
    }
    let remoteRecords;
    try {
      const body = await apiRequest(settings, "/crm/records", {
        method: "GET",
        fetch: hooks(options).fetch,
        log: hooks(options).log
      });
      remoteRecords = parseRecordsResponse(body);
    } catch (err) {
      return {
        ok: false,
        skipped: false,
        status: statusFromError(err),
        error: safeMessage(err),
        records: local,
        outbox: queue
      };
    }
    const plan = planRetry(local, remoteRecords, queue);
    if (!plan.toPush.length) {
      return { ok: true, skipped: false, status: "online", records: plan.merged, outbox: [], flushed: 0 };
    }
    const retry = await retryOutbox(settings, plan.toPush.map(record => ({
      inquiryId: record.inquiryId,
      record: record,
      queuedAt: new Date().toISOString()
    })), options);
    return {
      ok: retry.ok,
      skipped: false,
      status: retry.flushed > 0 && retry.outbox.length ? "online" : retry.status,
      records: applyServerTimestamps(plan.merged, retry.records),
      outbox: retry.outbox,
      flushed: retry.flushed
    };
  }

  function buildBulkPayload(records) {
    const list = Array.isArray(records) ? records : [];
    return { records: list.map(toRequestRecord) };
  }

  async function bulkUpload(settings, records, options) {
    const payload = buildBulkPayload(records);
    if (!isConfigured(settings)) {
      return { ok: false, skipped: true, status: "unconfigured", upserted: 0, payload: payload };
    }
    try {
      const body = await apiRequest(settings, "/crm/bulk", {
        method: "POST",
        body: payload,
        fetch: hooks(options).fetch,
        log: hooks(options).log
      });
      const upserted = body && Number.isFinite(Number(body.upserted)) ? Number(body.upserted) : payload.records.length;
      const saved = body && Array.isArray(body.records) ? body.records : [];
      return { ok: true, skipped: false, status: "online", upserted: upserted, records: saved, payload: payload };
    } catch (err) {
      return {
        ok: false,
        skipped: false,
        status: statusFromError(err),
        error: safeMessage(err),
        upserted: 0,
        payload: payload
      };
    }
  }

  async function saveAndPush(storage, settings, records, record, options) {
    saveLocal(storage, records);
    if (!record || !record.inquiryId) {
      return { ok: false, skipped: true, status: "invalid", outbox: readOutbox(storage) };
    }
    const result = await pushRecord(settings, record, readOutbox(storage), options);
    if (!result.skipped) writeOutbox(storage, result.outbox || []);
    return result;
  }

  async function checkHealth(settings, options) {
    if (!isConfigured(settings)) return { ok: false, status: "unconfigured" };
    try {
      const body = await apiRequest(settings, "/health", {
        method: "GET",
        fetch: hooks(options).fetch,
        log: hooks(options).log
      });
      if (body && body.ok === true && (!body.service || body.service === SERVICE_NAME)) {
        return { ok: true, status: "online" };
      }
      return { ok: false, status: "unreachable" };
    } catch (err) {
      return { ok: false, status: statusFromError(err), error: safeMessage(err) };
    }
  }

  return {
    STORE_KEY: STORE_KEY,
    OUTBOX_KEY: OUTBOX_KEY,
    SETTINGS_KEY: SETTINGS_KEY,
    isConfigured: isConfigured,
    normalizeBaseUrl: normalizeBaseUrl,
    redact: redact,
    readLogs: readLogs,
    clearLogs: clearLogs,
    readRecords: readRecords,
    saveLocal: saveLocal,
    readOutbox: readOutbox,
    writeOutbox: writeOutbox,
    readSettings: readSettings,
    writeSettings: writeSettings,
    mergeRecords: mergeRecords,
    enqueueOutbox: enqueueOutbox,
    planRetry: planRetry,
    pushRecord: pushRecord,
    retryOutbox: retryOutbox,
    syncOnLoad: syncOnLoad,
    STAGES: STAGES,
    toRequestRecord: toRequestRecord,
    applyServerTimestamps: applyServerTimestamps,
    buildBulkPayload: buildBulkPayload,
    bulkUpload: bulkUpload,
    saveAndPush: saveAndPush,
    checkHealth: checkHealth
  };
});
