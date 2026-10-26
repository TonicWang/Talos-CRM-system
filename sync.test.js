const { describe, test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const sync = require("./sync.js");

function memoryStorage(initial) {
  const data = Object.assign({}, initial);
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
    removeItem(key) {
      delete data[key];
    }
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    async json() { return body; }
  };
}

function record(id, name, updatedAt, extra) {
  return Object.assign({
    inquiryId: id,
    customerName: name,
    phone: "555-0100",
    lineId: "@example",
    productType: "測試桶",
    quantity: 1,
    quotePrice: 1000,
    status: "quoted",
    followUpDate: "",
    owner: "",
    notes: "",
    lastContactDate: "2026-01-01",
    deletedAt: "",
    history: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: updatedAt
  }, extra || {});
}

describe("talos sync", { concurrency: false }, () => {
  beforeEach(() => sync.clearLogs());

  test("mergeRecords keeps the newer updatedAt and does not drop the other side", () => {
    const localNewer = record("INQ_local", "本機較新", "2026-04-02T00:00:00.000Z");
    const remoteOlder = record("INQ_local", "雲端較舊", "2026-04-01T00:00:00.000Z", { notes: "舊" });
    const localOlder = record("INQ_remote", "本機較舊", "2026-03-01T00:00:00.000Z");
    const remoteNewer = record("INQ_remote", "雲端較新", "2026-05-01T00:00:00.000Z", {
      deletedAt: "2026-05-01T00:00:00.000Z",
      status: "dead"
    });
    const localOnly = record("INQ_only_local", "只在本機", "2026-02-01T00:00:00.000Z");
    const remoteOnly = record("INQ_only_remote", "只在雲端", "2026-02-02T00:00:00.000Z");
    const tieLocal = record("INQ_tie", "平手留本機", "2026-01-01T00:00:00.000Z");
    const tieRemote = record("INQ_tie", "平手的雲端", "2026-01-01T00:00:00.000Z");
    const local = [localNewer, localOlder, localOnly, tieLocal, { customerName: "沒有編號" }];
    const remote = [remoteOlder, remoteNewer, remoteOnly, tieRemote, null];
    const localSnapshot = JSON.parse(JSON.stringify(local));

    const merged = sync.mergeRecords(local, remote);

    assert.deepEqual(local, localSnapshot);
    assert.deepEqual(merged.map(item => item.inquiryId), ["INQ_local", "INQ_remote", "INQ_only_local", "INQ_tie", "INQ_only_remote"]);
    assert.equal(merged[0].customerName, "本機較新");
    assert.equal(merged[1].customerName, "雲端較新");
    assert.equal(merged[1].deletedAt, "2026-05-01T00:00:00.000Z");
    assert.equal(merged[2].customerName, "只在本機");
    assert.equal(merged[3].customerName, "平手留本機");
    assert.equal(merged[4].customerName, "只在雲端");
    assert.deepEqual(sync.mergeRecords(localOnly ? [localOnly] : [], []), [localOnly]);
  });

  test("failed push is written locally first, queued, then retried", async () => {
    const settings = { baseUrl: "https://sync.example/api/", pin: "retry-pin" };
    const deleted = record("INQ_q", "排隊", "2026-06-01T00:00:00.000Z", {
      deletedAt: "2026-06-01T01:00:00.000Z"
    });
    const storage = memoryStorage();
    let online = false;
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url: url, method: init.method, body: init.body, pin: init.headers["X-App-Pin"] });
      const stored = JSON.parse(storage.getItem(sync.STORE_KEY));
      assert.equal(stored.records[0].inquiryId, "INQ_q");
      assert.equal(stored.records[0].deletedAt, deleted.deletedAt);
      if (!online) throw new Error("offline");
      return jsonResponse(200, { record: JSON.parse(init.body) });
    };

    const first = await sync.saveAndPush(storage, settings, [deleted], deleted, { fetch: fetchImpl });
    assert.equal(first.ok, false);
    assert.equal(first.status, "unreachable");
    const queued = JSON.parse(storage.getItem(sync.OUTBOX_KEY));
    assert.equal(queued.length, 1);
    assert.equal(queued[0].record.deletedAt, deleted.deletedAt);

    online = true;
    const second = await sync.retryOutbox(settings, sync.readOutbox(storage), { fetch: fetchImpl });
    assert.equal(second.ok, true);
    assert.equal(second.flushed, 1);
    assert.deepEqual(second.outbox, []);
    const put = calls.find(call => call.method === "PUT");
    assert.equal(put.url, "https://sync.example/api/crm/records/INQ_q");
    assert.equal(put.pin, "retry-pin");
    assert.equal(JSON.parse(put.body).deletedAt, deleted.deletedAt);
  });

  test("load merges by updatedAt and retries only the still-newer outbox records", async () => {
    const local = record("INQ_local", "本機刪除", "2026-04-02T00:00:00.000Z", {
      deletedAt: "2026-04-02T00:00:00.000Z"
    });
    const stale = record("INQ_remote", "舊本機", "2026-04-01T00:00:00.000Z");
    const remote = record("INQ_remote", "雲端較新", "2026-05-02T00:00:00.000Z");
    const calls = [];
    const result = await sync.syncOnLoad(
      { baseUrl: "https://sync.example", pin: "retry-pin" },
      [local, stale],
      [
        { inquiryId: local.inquiryId, record: local, queuedAt: "2026-04-02T00:00:01.000Z" },
        { inquiryId: stale.inquiryId, record: stale, queuedAt: "2026-04-01T00:00:01.000Z" }
      ],
      {
        fetch: async (url, init) => {
          calls.push({ url: url, method: init.method, body: init.body });
          if ((init.method || "GET") === "GET") {
            return jsonResponse(200, {
              records: [
                remote,
                record("INQ_local", "雲端舊", "2026-04-01T00:00:00.000Z")
              ]
            });
          }
          return jsonResponse(200, { record: JSON.parse(init.body) });
        }
      }
    );

    assert.equal(result.records.find(item => item.inquiryId === "INQ_remote").customerName, "雲端較新");
    assert.equal(result.records.find(item => item.inquiryId === "INQ_local").deletedAt, local.deletedAt);
    const puts = calls.filter(call => call.method === "PUT");
    assert.equal(puts.length, 1);
    assert.equal(puts[0].url, "https://sync.example/crm/records/INQ_local");
    assert.equal(JSON.parse(puts[0].body).deletedAt, local.deletedAt);
    assert.deepEqual(result.outbox, []);
  });

  test("unreachable load keeps the cache and the outbox", async () => {
    const local = [record("INQ_k", "保留", "2026-01-01T00:00:00.000Z")];
    const outbox = [{ inquiryId: "INQ_k", record: local[0], queuedAt: "2026-01-01T00:00:01.000Z" }];
    const result = await sync.syncOnLoad(
      { baseUrl: "https://sync.example", pin: "retry-pin" },
      local,
      outbox,
      { fetch: async () => { throw new Error("offline"); } }
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, "unreachable");
    assert.deepEqual(result.records, local);
    assert.equal(result.outbox.length, 1);
    assert.equal(result.outbox[0].record.customerName, "保留");
  });

  test("unconfigured sync does not call the network or drop local data", async () => {
    assert.equal(sync.isConfigured({ baseUrl: "", pin: "" }), false);
    assert.equal(sync.isConfigured({ baseUrl: "not a url", pin: "abc" }), false);
    assert.equal(sync.isConfigured({ baseUrl: "https://sync.example", pin: "   " }), false);
    assert.equal(sync.isConfigured({ baseUrl: "https://sync.example/", pin: "abc" }), true);

    let called = false;
    const storage = memoryStorage();
    const kept = record("INQ_u", "只在本機", "2026-01-01T00:00:00.000Z");
    const result = await sync.saveAndPush(storage, { baseUrl: "", pin: "" }, [kept], kept, {
      fetch: async () => {
        called = true;
        throw new Error("should not be called");
      }
    });
    assert.equal(called, false);
    assert.equal(result.skipped, true);
    assert.equal(result.status, "unconfigured");
    assert.equal(JSON.parse(storage.getItem(sync.STORE_KEY)).records[0].customerName, "只在本機");
    assert.equal(storage.getItem(sync.OUTBOX_KEY), null);

    const loaded = await sync.syncOnLoad({ baseUrl: "", pin: "" }, [kept], [], {
      fetch: async () => { called = true; throw new Error("should not be called"); }
    });
    assert.equal(called, false);
    assert.equal(loaded.skipped, true);
    assert.equal(loaded.records[0].inquiryId, "INQ_u");
  });

  test("bulk payload is {records} posted to /crm/bulk", async () => {
    const pin = "pin-ZZ9-keep-out";
    const records = [
      record("INQ_b", "批次", "2026-07-01T00:00:00.000Z", { deletedAt: "2026-07-02T00:00:00.000Z" }),
      record("INQ_c", "第二筆", "2026-07-03T00:00:00.000Z")
    ];
    const payload = sync.buildBulkPayload(records);
    assert.deepEqual(payload, { records: records });
    let seen;
    const result = await sync.bulkUpload(
      { baseUrl: "https://sync.example/api/", pin: pin },
      records,
      {
        fetch: async (url, init) => {
          seen = { url: url, init: init };
          return jsonResponse(200, { upserted: records.length });
        }
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.upserted, 2);
    assert.equal(seen.url, "https://sync.example/api/crm/bulk");
    assert.equal(seen.url.includes(pin), false);
    assert.equal(seen.init.method, "POST");
    assert.equal(seen.init.headers["X-App-Pin"], pin);
    assert.equal(seen.init.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(seen.init.body), payload);
    assert.equal(seen.init.body.includes(pin), false);
    assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(seen.init.body), "pin"), false);
    assert.equal(JSON.parse(seen.init.body).records[0].deletedAt, "2026-07-02T00:00:00.000Z");
    assert.equal(JSON.stringify(sync.readLogs()).includes(pin), false);
  });

  test("follows the tonic-sync-api contract", async () => {
    const pin = "pin-ZZ9-keep-out";
    const settings = { baseUrl: "https://sync.example", pin: pin };
    const health = await sync.checkHealth(settings, {
      fetch: async (url, init) => {
        assert.equal(url, "https://sync.example/health");
        assert.equal(init.headers["X-App-Pin"], undefined);
        return jsonResponse(200, { ok: true, service: "tonic-sync-api" });
      }
    });
    assert.equal(health.ok, true);
    assert.equal(health.status, "online");

    const wrongService = await sync.checkHealth(settings, {
      fetch: async () => jsonResponse(200, { ok: true, service: "something-else" })
    });
    assert.equal(wrongService.ok, false);

    const forbidden = await sync.pushRecord(
      settings,
      record("INQ_origin", "來源", "2026-08-01T00:00:00.000Z"),
      [],
      { fetch: async () => jsonResponse(403, { ok: false, error: "origin not allowed " + pin }) }
    );
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.status, "forbidden");
    assert.equal(JSON.stringify(forbidden).includes(pin), false);
    assert.equal(JSON.stringify(sync.readLogs()).includes(pin), false);
    assert.match(JSON.stringify(sync.readLogs()), /\[redacted\]/);

    const dead = record("INQ_dead", "取消", "2026-08-02T00:00:00.000Z", { status: "dead", stage: "回購" });
    const quoted = record("INQ_quoted", "報價", "2026-08-03T00:00:00.000Z", { status: "quoted", stage: "回購" });
    const invalid = record("INQ_bad", "壞階段", "2026-08-04T00:00:00.000Z", { status: "dead", stage: "其他" });
    assert.equal(sync.toRequestRecord(dead).stage, "回購");
    assert.equal(Object.prototype.hasOwnProperty.call(sync.toRequestRecord(quoted), "stage"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(sync.toRequestRecord(invalid), "stage"), false);

    let putBody;
    const pushed = await sync.pushRecord(settings, dead, [], {
      fetch: async (url, init) => {
        putBody = JSON.parse(init.body);
        assert.equal(init.headers["X-App-Pin"], pin);
        return jsonResponse(200, {
          ok: true,
          record: Object.assign({}, putBody, { updatedAt: "2026-08-02T00:00:05.000Z" })
        });
      }
    });
    assert.equal(putBody.stage, "回購");
    assert.equal(pushed.record.updatedAt, "2026-08-02T00:00:05.000Z");
    const stamped = sync.applyServerTimestamps([dead], [pushed.record]);
    assert.equal(stamped[0].customerName, "取消");
    assert.equal(stamped[0].updatedAt, "2026-08-02T00:00:05.000Z");
    assert.equal(sync.applyServerTimestamps(
      [record("INQ_keep", "較新本機", "2026-09-01T00:00:00.000Z")],
      [record("INQ_keep", "較舊雲端", "2026-01-01T00:00:00.000Z")]
    )[0].customerName, "較新本機");

    const bulk = await sync.bulkUpload(settings, [dead, quoted], {
      fetch: async (url, init) => {
        const body = JSON.parse(init.body);
        assert.equal(url, "https://sync.example/crm/bulk");
        assert.equal(body.records[0].stage, "回購");
        assert.equal(Object.prototype.hasOwnProperty.call(body.records[1], "stage"), false);
        return jsonResponse(200, { ok: true, upserted: 2, records: body.records });
      }
    });
    assert.equal(bulk.ok, true);
    assert.equal(bulk.upserted, 2);
    assert.equal(bulk.records.length, 2);

    const rejected = await sync.syncOnLoad(settings, [quoted], [], {
      fetch: async () => jsonResponse(200, { ok: false, error: "notion request failed" })
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.status, "unreachable");
    assert.equal(rejected.records[0].customerName, "報價");
  });

  test("logs never include the PIN", async () => {
    const pin = "pin-ZZ9-keep-out";
    const storage = memoryStorage();
    sync.writeSettings(storage, { baseUrl: " https://sync.example/ ", pin: "\n" + pin + "\n" });
    const stored = sync.readSettings(storage);
    assert.equal(stored.pin, pin);
    assert.equal(stored.baseUrl, "https://sync.example");

    const logs = [];
    const consoleCalls = [];
    const methods = ["log", "info", "warn", "error", "debug"];
    const originals = {};
    for (const name of methods) {
      originals[name] = console[name];
      console[name] = (...args) => consoleCalls.push(args.map(String).join(" "));
    }
    try {
      const rejected = await sync.pushRecord(stored, record("INQ_log", "日誌", "2026-01-01T00:00:00.000Z"), [], {
        log: entry => logs.push(entry),
        fetch: async () => jsonResponse(401, { error: "rejected " + pin })
      });
      const thrown = await sync.pushRecord(stored, record("INQ_log", "日誌", "2026-01-01T00:00:00.000Z"), [], {
        log: entry => logs.push(entry),
        fetch: async () => { throw new Error("down " + pin + " X-App-Pin: " + pin); }
      });
      for (const result of [rejected, thrown]) {
        assert.equal(result.ok, false);
        assert.equal(JSON.stringify(result).includes(pin), false);
      }
      assert.equal(rejected.status, "unauthorized");
      assert.equal(thrown.status, "unreachable");
      const dumped = JSON.stringify(logs) + JSON.stringify(sync.readLogs()) + consoleCalls.join("\n");
      assert.equal(dumped.includes(pin), false);
      assert.match(dumped, /\[redacted\]/);
      assert.ok(logs.length >= 2);
    } finally {
      for (const name of methods) console[name] = originals[name];
    }
  });
});
