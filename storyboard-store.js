/* 分鏡卡片的資料層：圖片縮圖、本機儲存、與 private repo 的同步。
 *
 * 為什麼分鏡的圖不跟 notes.json 放一起：
 * 一份 40 格的分鏡換算成 base64 約 3–4MB，而 GitHub Contents API 沒有部分更新，
 * 每次存檔都要把整份重傳。混在 notes.json 裡的話，你在便條紙上改一個字
 * 就要重傳好幾 MB。所以卡片本身（notes.json）只存一個 id，圖片各自一個檔。
 *
 * 為什麼本機那層用 IndexedDB 而不是 localStorage：
 * localStorage 每個網域只有約 5MB，一份分鏡就塞爆了。IndexedDB 容量以 GB 計。
 */
(function (global) {
  "use strict";

  var PUSH_DEBOUNCE = 3000;
  var SHOT_WIDTH = 640;    // 與資料庫既有影格同規格，畫質做分析夠用、檔案不會爆
  var SHOT_QUALITY = 0.75;

  var docs = new Map();    // id -> doc（記憶體快取）
  var shas = new Map();    // id -> 遠端 sha
  var timers = new Map();  // id -> debounce timer
  var pulled = new Set();  // 這個 session 已經跟雲端對過的 id

  function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }
  function nowIso() { return new Date().toISOString(); }
  function status(text, kind) { if (global.SB.onStatus) global.SB.onStatus(text, kind); }

  // ── IndexedDB ────────────────────────────────────────────────────────────
  function openDb() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open("storyboards", 1);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function idbRun(mode, action) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var request = action(db.transaction("kv", mode).objectStore("kv"));
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
      });
    });
  }

  var idbGet = function (key) { return idbRun("readonly", function (s) { return s.get(key); }); };
  var idbSet = function (key, value) { return idbRun("readwrite", function (s) { return s.put(value, key); }); };
  var idbDel = function (key) { return idbRun("readwrite", function (s) { return s.delete(key); }); };

  // ── 圖片 ─────────────────────────────────────────────────────────────────
  /** 等比縮到指定寬度的 JPEG data URL（不裁切）。 */
  function downscale(source, maxWidth, quality) {
    return createImageBitmap(source).then(function (bitmap) {
      var scale = Math.min(1, maxWidth / bitmap.width);
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      return canvas.toDataURL("image/jpeg", quality);
    });
  }

  // ── 文件 ─────────────────────────────────────────────────────────────────
  function normalize(raw, id) {
    return {
      id: (raw && raw.id) || id,
      updatedAt: (raw && raw.updatedAt) || null,
      shots: ((raw && Array.isArray(raw.shots)) ? raw.shots : []).map(function (shot) {
        return {
          id: shot.id || uid(),
          img: typeof shot.img === "string" ? shot.img : "",
          len: typeof shot.len === "string" ? shot.len : "",
          note: typeof shot.note === "string" ? shot.note : "",
        };
      }).filter(function (shot) { return shot.img; }),
    };
  }

  function path(id) { return "storyboards/" + id + ".json"; }

  function create() {
    var id = uid();
    var doc = { id: id, updatedAt: nowIso(), shots: [] };
    docs.set(id, doc);
    idbSet("doc:" + id, doc);
    pulled.add(id); // 剛建立的，不需要再跟雲端對一次
    schedulePush(id);
    return id;
  }

  function cached(id) { return docs.get(id) || null; }

  /**
   * 讀一份分鏡：先給本機那份（快），再背景跟雲端對一次。
   * 雲端比較新時會用新的取代並呼叫 onRemote(doc)。
   */
  async function load(id, onRemote) {
    var doc = docs.get(id);
    if (!doc) {
      var local = await idbGet("doc:" + id).catch(function () { return null; });
      doc = normalize(local, id);
      docs.set(id, doc);
    }
    if (GH.token() && !pulled.has(id)) {
      pulled.add(id);
      pull(id, onRemote);
    }
    return doc;
  }

  async function pull(id, onRemote) {
    try {
      var result = await GH.getJson(GH.notesRepo(), path(id));
      shas.set(id, result.sha);
      if (!result.json) return;
      var remote = normalize(result.json, id);
      var local = docs.get(id);
      if ((remote.updatedAt || "") > ((local && local.updatedAt) || "")) {
        docs.set(id, remote);
        idbSet("doc:" + id, remote);
        if (onRemote) onRemote(remote);
      }
    } catch (error) {
      status("分鏡讀取失敗：" + error.message, "err");
    }
  }

  /** 任何改動後呼叫。本機立刻寫入，雲端 3 秒後才推。 */
  function save(id) {
    var doc = docs.get(id);
    if (!doc) return;
    doc.updatedAt = nowIso();
    idbSet("doc:" + id, doc);
    schedulePush(id);
  }

  function schedulePush(id) {
    if (!GH.token()) return;
    if (timers.has(id)) clearTimeout(timers.get(id));
    timers.set(id, setTimeout(function () { timers.delete(id); push(id); }, PUSH_DEBOUNCE));
  }

  async function push(id, options) {
    var doc = docs.get(id);
    if (!doc || !GH.token()) return;
    status("分鏡同步中…");
    try {
      shas.set(id, await GH.putJson(GH.notesRepo(), path(id), doc, "🎞 更新分鏡", shas.get(id) || null, options));
      status("分鏡已同步", "ok");
    } catch (error) {
      if (!error.conflict) { status("分鏡同步失敗：" + error.message, "err"); return; }
      // sha 對不上＝雲端有別台改過的版本。只有本機比較新才覆蓋，否則不動。
      try {
        var remote = await GH.getJson(GH.notesRepo(), path(id));
        shas.set(id, remote.sha);
        if (((remote.json && remote.json.updatedAt) || "") > (doc.updatedAt || "")) {
          status("雲端有更新版本的分鏡，這台沒覆蓋過去，請重新整理", "err");
          return;
        }
        shas.set(id, await GH.putJson(GH.notesRepo(), path(id), doc, "🎞 更新分鏡", remote.sha, options));
        status("分鏡已同步", "ok");
      } catch (retryError) {
        status("分鏡同步失敗：" + retryError.message, "err");
      }
    }
  }

  /** 關頁面前把還在 debounce 裡的都送出去。 */
  function flushAll() {
    timers.forEach(function (timer, id) {
      clearTimeout(timer);
      push(id, { keepalive: true });
    });
    timers.clear();
  }

  /* 刪卡片時只清本機。雲端那份 JSON 刻意留著：Contents API 刪檔要另外帶 sha，
     而且留著等於一份誤刪的救命備份（private repo，放著也不會怎樣）。 */
  function remove(id) {
    docs.delete(id);
    shas.delete(id);
    if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); }
    idbDel("doc:" + id);
  }

  /** 匯入一批圖：照檔名自然排序 → 縮圖 → append。 */
  var collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

  async function importFiles(id, list, onProgress) {
    var doc = docs.get(id);
    if (!doc) return 0;
    var files = Array.prototype.slice.call(list).filter(function (file) {
      return file && file.type && file.type.indexOf("image/") === 0;
    });
    if (!files.length) return 0;

    // 一次丟一整批時照檔名「自然排序」：截圖 2 會排在 截圖 10 前面
    files.sort(function (a, b) { return collator.compare(a.name || "", b.name || ""); });

    var added = 0;
    for (var i = 0; i < files.length; i += 1) {
      if (onProgress) onProgress(i + 1, files.length);
      try {
        var img = await downscale(files[i], SHOT_WIDTH, SHOT_QUALITY);
        doc.shots.push({ id: uid(), img: img, len: "", note: "" });
        added += 1;
      } catch (error) {
        status("有一張圖讀不進來，已略過", "err");
      }
    }
    if (added) save(id);
    return added;
  }

  global.SB = {
    create: create,
    load: load,
    cached: cached,
    save: save,
    remove: remove,
    importFiles: importFiles,
    flushAll: flushAll,
    onStatus: null,
    SHOT_WIDTH: SHOT_WIDTH,
  };
})(window);
