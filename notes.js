/* 靈感筆記板 —— 階段 1：核心畫布（便條紙／文字方塊／待辦清單）
 *
 * 資料流：任何改動 → 記憶體 state → localStorage（400ms debounce，永遠是即時可靠的那一份）
 *                              → private repo 的 notes.json（3s debounce，跨裝置用）
 *
 * 刻意不做的事：
 * - 不自動合併衝突。兩台裝置各改各的時，讓使用者自己挑一邊，不要猜。
 * - 不在每次改動就打 GitHub API。每次 PUT 都是一個 commit，打太兇會撞到 5000/hr 上限。
 */
(function () {
  "use strict";

  // ── 常數 ────────────────────────────────────────────────────────────────
  var CANVAS_W = 4000;
  var CANVAS_H = 3000;
  var SNAP_THRESHOLD = 8;
  var MIN_W = 120;
  var MIN_H = 80;

  var NOTES_PATH = "notes.json";
  var LS_STATE = "nbState";
  var LOCAL_DEBOUNCE = 400;
  var REMOTE_DEBOUNCE = 3000;

  var TYPE_DEFAULTS = {
    sticky: { w: 220, h: 220, color: "#FEF9C3" },
    text: { w: 300, h: 160, color: "#FFFFFF" },
    todo: { w: 260, h: 260, color: "#FFFFFF" },
    mindmap: { w: 520, h: 360, color: "#F8FAFC" },
    board: { w: 150, h: 190, color: "#E4D39C" },
  };

  // 心智圖節點的固定尺寸
  var MM_W = 120;
  var MM_H = 32;

  // 繪圖層
  var DRAWING_KINDS = ["path", "line", "rect", "ellipse"];
  var DRAWING_COLORS = ["#374151", "#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ffffff"];
  var DRAWING_WIDTHS = [2, 4, 7];
  var SVG_NS = "http://www.w3.org/2000/svg";
  var HISTORY_LIMIT = 50;

  var COLOR_PALETTE = [
    { hex: "#FFFFFF", label: "白色" },
    { hex: "#FEF9C3", label: "黃色" },
    { hex: "#FCE7F3", label: "粉紅" },
    { hex: "#DBEAFE", label: "藍色" },
    { hex: "#D1FAE5", label: "綠色" },
    { hex: "#FED7AA", label: "橙色" },
    { hex: "#EDE9FE", label: "紫色" },
  ];

  var FONT_SIZE_PX = { sm: 11, md: 13, lg: 16 };
  var FONT_SIZE_LABELS = { sm: "小", md: "中", lg: "大" };

  var PLACEHOLDERS = { sticky: "寫點什麼…", text: "輸入文字…", todo: "" };

  // ── 狀態 ────────────────────────────────────────────────────────────────
  var state = null; // { version, updatedAt, boards, items }
  var currentBoardId = "root";
  var remoteSha = null;
  var els = new Map(); // itemId -> card element
  var localTimer = null;
  var remoteTimer = null;
  var syncing = false;
  var pushQueued = false;
  var ctxItemId = null;

  // 繪圖層狀態
  var drawTool = "select";
  var drawColor = "#374151";
  var drawWidth = 4;
  var eraserSize = 24;
  var selectedDrawingId = null;
  var draftDrawing = null;
  var undoStack = [];
  var redoStack = [];
  var erasingIds = null;
  var svgEl = null;
  var svgMain = null;
  var svgDraft = null;

  // ── DOM ─────────────────────────────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  var scrollEl, canvasEl, statusEl, bannerEl, bannerTextEl, bannerActionEl, ctxEl;

  // ── 小工具 ───────────────────────────────────────────────────────────────
  function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function clock() {
    var d = new Date();
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function emptyState() {
    return {
      version: 1,
      updatedAt: null,
      boards: { root: { id: "root", name: "主畫布", parentId: null } },
      items: [],
      drawings: [],
    };
  }

  /** 把讀進來的資料補齊成目前的格式，舊檔或手改壞的檔才不會讓整頁掛掉。 */
  function normalize(raw) {
    var base = emptyState();
    if (!raw || typeof raw !== "object") return base;
    if (raw.boards && typeof raw.boards === "object" && raw.boards.root) base.boards = raw.boards;
    base.updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : null;
    base.items = (Array.isArray(raw.items) ? raw.items : []).map(function (item, index) {
      var def = TYPE_DEFAULTS[item.type] || TYPE_DEFAULTS.text;
      return {
        id: item.id || uid(),
        boardId: item.boardId || "root",
        type: TYPE_DEFAULTS[item.type] ? item.type : "text",
        x: Number.isFinite(item.x) ? item.x : 40,
        y: Number.isFinite(item.y) ? item.y : 40,
        w: Number.isFinite(item.w) ? item.w : def.w,
        h: Number.isFinite(item.h) ? item.h : def.h,
        title: typeof item.title === "string" ? item.title : "",
        content: typeof item.content === "string" ? item.content : "",
        color: typeof item.color === "string" ? item.color : def.color,
        fontSize: FONT_SIZE_PX[item.fontSize] ? item.fontSize : "md",
        zIndex: Number.isFinite(item.zIndex) ? item.zIndex : index + 1,
      };
    });
    base.drawings = (Array.isArray(raw.drawings) ? raw.drawings : [])
      .filter(function (d) { return d && DRAWING_KINDS.indexOf(d.kind) !== -1; })
      .map(function (d, index) {
        return {
          id: d.id || uid(),
          boardId: d.boardId || "root",
          kind: d.kind,
          points: Array.isArray(d.points) ? d.points.filter(function (pt) {
            return pt && Number.isFinite(pt.x) && Number.isFinite(pt.y);
          }) : [],
          x1: Number.isFinite(d.x1) ? d.x1 : 0,
          y1: Number.isFinite(d.y1) ? d.y1 : 0,
          x2: Number.isFinite(d.x2) ? d.x2 : 0,
          y2: Number.isFinite(d.y2) ? d.y2 : 0,
          strokeColor: typeof d.strokeColor === "string" ? d.strokeColor : "#374151",
          strokeWidth: Number.isFinite(d.strokeWidth) ? d.strokeWidth : 4,
          zIndex: Number.isFinite(d.zIndex) ? d.zIndex : index + 1,
        };
      });

    // 所屬 Board 已經不存在的項目收回主畫布，免得永遠看不到又刪不掉
    Object.keys(base.boards).forEach(function (id) { base.boards[id].id = id; });
    base.drawings.forEach(function (drawing) {
      if (!base.boards[drawing.boardId]) drawing.boardId = "root";
    });
    base.items.forEach(function (item) {
      if (!base.boards[item.boardId]) item.boardId = "root";
      if (item.type === "board") {
        item.w = TYPE_DEFAULTS.board.w;
        item.h = TYPE_DEFAULTS.board.h;
      }
    });
    return base;
  }

  function boardItems() {
    return state.items.filter(function (item) { return item.boardId === currentBoardId; });
  }

  function childCount(boardId) {
    return state.items.filter(function (item) { return item.boardId === boardId; }).length;
  }

  /** 從主畫布一路到目前這層的路徑，供麵包屑用。 */
  function breadcrumbTrail(boardId) {
    var trail = [];
    var cursor = boardId;
    var guard = 0;
    while (cursor && state.boards[cursor] && guard < 50) {
      trail.unshift(state.boards[cursor]);
      cursor = state.boards[cursor].parentId;
      guard += 1;
    }
    return trail;
  }

  function renderBreadcrumbs() {
    var nav = $("crumbs");
    nav.textContent = "";
    breadcrumbTrail(currentBoardId).forEach(function (board, index, all) {
      if (index > 0) {
        var caret = document.createElement("span");
        caret.className = "nb-crumb-caret";
        caret.textContent = "›";
        nav.appendChild(caret);
      }
      var button = document.createElement("button");
      button.type = "button";
      button.className = "nb-crumb" + (index === all.length - 1 ? " nb-crumb--current" : "");
      button.textContent = (index === 0 ? "🏠 " : "") + board.name;
      button.title = board.name;
      button.addEventListener("click", function () { openBoard(board.id); });
      nav.appendChild(button);
    });
  }

  function openBoard(boardId) {
    if (!state.boards[boardId]) return;
    currentBoardId = boardId;
    // 歷史紀錄是綁在單一畫布上的，換畫布就重來，免得復原跳到別張畫布去改東西
    selectedDrawingId = null;
    undoStack.length = 0;
    redoStack.length = 0;
    closeContextMenu();
    renderAll();
    scrollToContent();
  }

  /** 一個 Board 與其所有子孫 Board 的 id，刪除時要整串帶走。 */
  function boardSubtree(boardId) {
    var ids = [boardId];
    for (var index = 0; index < ids.length; index += 1) {
      var current = ids[index];
      Object.keys(state.boards).forEach(function (id) {
        if (state.boards[id].parentId === current && ids.indexOf(id) === -1) ids.push(id);
      });
    }
    return ids;
  }

  function findItem(id) {
    for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i];
    return null;
  }

  // ── 對齊吸附 ─────────────────────────────────────────────────────────────
  /* 與探索系統的 computeNoteItemSnap 同一套演算法：比對移動中卡片的
     左／中／右（上／中／下）對其他卡片的同三個位置，取最近的一組吸附。 */
  function computeSnap(rawX, rawY, width, height, items, excludeId) {
    var movingX = [rawX, rawX + width / 2, rawX + width];
    var movingY = [rawY, rawY + height / 2, rawY + height];
    var offsetsX = [0, width / 2, width];
    var offsetsY = [0, height / 2, height];
    var closestX = SNAP_THRESHOLD + 1;
    var closestY = SNAP_THRESHOLD + 1;
    var snappedX = rawX;
    var snappedY = rawY;

    items.forEach(function (item) {
      if (item.id === excludeId) return;
      var targetX = [item.x, item.x + item.w / 2, item.x + item.w];
      var targetY = [item.y, item.y + item.h / 2, item.y + item.h];
      movingX.forEach(function (value, index) {
        targetX.forEach(function (target) {
          var distance = Math.abs(value - target);
          if (distance < closestX) { closestX = distance; snappedX = target - offsetsX[index]; }
        });
      });
      movingY.forEach(function (value, index) {
        targetY.forEach(function (target) {
          var distance = Math.abs(value - target);
          if (distance < closestY) { closestY = distance; snappedY = target - offsetsY[index]; }
        });
      });
    });

    if (closestX > SNAP_THRESHOLD) snappedX = rawX;
    if (closestY > SNAP_THRESHOLD) snappedY = rawY;
    snappedX = clamp(snappedX, 0, CANVAS_W - width);
    snappedY = clamp(snappedY, 0, CANVAS_H - height);

    var alignedX = [snappedX, snappedX + width / 2, snappedX + width];
    var alignedY = [snappedY, snappedY + height / 2, snappedY + height];
    var vertical = [];
    var horizontal = [];
    items.forEach(function (item) {
      if (item.id === excludeId) return;
      var targetX = [item.x, item.x + item.w / 2, item.x + item.w];
      var targetY = [item.y, item.y + item.h / 2, item.y + item.h];
      if (closestX <= SNAP_THRESHOLD) {
        alignedX.forEach(function (value) {
          if (targetX.some(function (t) { return Math.abs(value - t) < 0.5; })) vertical.push(value);
        });
      }
      if (closestY <= SNAP_THRESHOLD) {
        alignedY.forEach(function (value) {
          if (targetY.some(function (t) { return Math.abs(value - t) < 0.5; })) horizontal.push(value);
        });
      }
    });

    return {
      x: snappedX,
      y: snappedY,
      guides: {
        vertical: vertical.filter(function (v, i, a) { return a.indexOf(v) === i; }),
        horizontal: horizontal.filter(function (v, i, a) { return a.indexOf(v) === i; }),
      },
    };
  }

  function drawGuides(guides) {
    Array.prototype.slice.call(canvasEl.querySelectorAll(".nb-guide")).forEach(function (node) {
      node.remove();
    });
    if (!guides) return;
    guides.vertical.forEach(function (x) {
      var line = document.createElement("div");
      line.className = "nb-guide nb-guide--v";
      line.style.left = x + "px";
      canvasEl.appendChild(line);
    });
    guides.horizontal.forEach(function (y) {
      var line = document.createElement("div");
      line.className = "nb-guide nb-guide--h";
      line.style.top = y + "px";
      canvasEl.appendChild(line);
    });
  }

  // ── 存檔 ─────────────────────────────────────────────────────────────────
  function saveLocal() {
    try {
      localStorage.setItem(LS_STATE, JSON.stringify(state));
    } catch (e) {
      setStatus("本機儲存空間已滿", "err");
    }
  }

  function loadLocal() {
    try {
      var raw = localStorage.getItem(LS_STATE);
      return raw ? normalize(JSON.parse(raw)) : null;
    } catch (e) {
      return null;
    }
  }

  /** 所有會改到資料的動作，最後都要呼叫這支。 */
  function markDirty() {
    state.updatedAt = nowIso();
    if (localTimer) clearTimeout(localTimer);
    localTimer = setTimeout(function () { localTimer = null; saveLocal(); }, LOCAL_DEBOUNCE);
    schedulePush();
  }

  function schedulePush() {
    if (!GH.token()) { setStatus("僅存這台裝置（未設定 Token）"); return; }
    setStatus("有未同步的變更…");
    if (remoteTimer) clearTimeout(remoteTimer);
    remoteTimer = setTimeout(function () { remoteTimer = null; pushNow(); }, REMOTE_DEBOUNCE);
  }

  async function pushNow(options) {
    if (!GH.token()) return;
    if (syncing) { pushQueued = true; return; }
    syncing = true;
    setStatus("同步中…");
    try {
      remoteSha = await GH.putJson(GH.notesRepo(), NOTES_PATH, state, "📝 更新靈感筆記", remoteSha, options);
      setStatus("已同步 " + clock(), "ok");
    } catch (error) {
      if (error.conflict) openConflictDialog();
      else setStatus(error.message + "（點此重試）", "err");
    } finally {
      syncing = false;
      if (pushQueued) { pushQueued = false; schedulePush(); }
    }
  }

  /** 關頁面或切到背景時，把還在 debounce 裡的東西立刻送出去。 */
  function flush() {
    if (localTimer) { clearTimeout(localTimer); localTimer = null; }
    saveLocal();
    if (remoteTimer) {
      clearTimeout(remoteTimer);
      remoteTimer = null;
      pushNow({ keepalive: true });
    }
  }

  async function pullRemote() {
    if (!GH.token()) {
      showBanner("尚未設定 GitHub Token，筆記目前只存在這台裝置。", "去設定", openSettings);
      setStatus("僅存這台裝置（未設定 Token）");
      return;
    }
    hideBanner();
    setStatus("讀取雲端…");
    try {
      var result = await GH.getJson(GH.notesRepo(), NOTES_PATH);
      remoteSha = result.sha;
      if (!result.json) {
        setStatus("雲端還沒有筆記檔，第一次存檔時自動建立");
        if (state.items.length) schedulePush();
        return;
      }
      var remote = normalize(result.json);
      var localAt = state.updatedAt || "";
      var remoteAt = remote.updatedAt || "";
      if (remoteAt > localAt) {
        state = remote;
        saveLocal();
        renderAll();
        setStatus("已從雲端載入 " + clock(), "ok");
      } else if (localAt > remoteAt) {
        setStatus("這台比較新，準備同步…");
        schedulePush();
      } else {
        setStatus("已同步", "ok");
      }
    } catch (error) {
      setStatus(error.message + "（點此重試）", "err");
      showBanner(error.message, "重新連線", pullRemote);
    }
  }

  // ── 衝突處理（不自動合併） ────────────────────────────────────────────────
  async function openConflictDialog() {
    var remote = null;
    try {
      remote = await GH.getJson(GH.notesRepo(), NOTES_PATH);
    } catch (error) {
      setStatus("同步衝突且重讀失敗：" + error.message, "err");
      return;
    }
    remoteSha = remote.sha;
    var remoteState = normalize(remote.json);
    var describe = function (value) {
      return value.updatedAt ? new Date(value.updatedAt).toLocaleString("zh-TW") : "（未知時間）";
    };
    $("conflictText").textContent =
      "雲端版本最後更新於 " + describe(remoteState) + "（" + remoteState.items.length + " 張卡片），" +
      "這台裝置是 " + describe(state) + "（" + state.items.length + " 張卡片）。" +
      "自動合併很容易把東西弄丟，請自己挑一邊保留。";

    $("conflictKeepRemote").onclick = function () {
      state = remoteState;
      saveLocal();
      renderAll();
      closeConflictDialog();
      setStatus("已改用雲端版本", "ok");
    };
    $("conflictKeepLocal").onclick = function () {
      closeConflictDialog();
      pushNow(); // remoteSha 已更新成最新，這次 PUT 就會覆蓋過去
    };
    $("conflictOverlay").classList.add("nb-overlay--open");
  }

  function closeConflictDialog() {
    $("conflictOverlay").classList.remove("nb-overlay--open");
  }

  // ── 狀態列與提示條 ────────────────────────────────────────────────────────
  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = "nb-status" + (kind ? " nb-status--" + kind : "");
  }

  function showBanner(text, actionLabel, onAction) {
    bannerTextEl.textContent = text;
    bannerActionEl.textContent = actionLabel;
    bannerActionEl.onclick = onAction;
    bannerEl.classList.add("nb-banner--open");
  }

  function hideBanner() {
    bannerEl.classList.remove("nb-banner--open");
  }

  // ── 待辦清單 ─────────────────────────────────────────────────────────────
  function parseTodos(content) {
    try {
      var parsed = JSON.parse(content);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function renderTodos(body, item) {
    body.textContent = "";
    var todos = parseTodos(item.content);
    var list = document.createElement("div");
    list.className = "nb-todos";

    var commit = function () {
      item.content = JSON.stringify(todos);
      markDirty();
    };

    todos.forEach(function (todo, index) {
      var row = document.createElement("div");
      row.className = "nb-todo" + (todo.done ? " nb-todo--done" : "");

      var checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = !!todo.done;
      checkbox.addEventListener("change", function () {
        todo.done = checkbox.checked;
        row.classList.toggle("nb-todo--done", todo.done);
        commit();
      });

      var text = document.createElement("input");
      text.type = "text";
      text.className = "nb-todo-text";
      text.value = todo.text || "";
      text.placeholder = "待辦事項";
      text.style.fontSize = FONT_SIZE_PX[item.fontSize] + "px";
      text.addEventListener("input", function () { todo.text = text.value; commit(); });
      text.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          event.preventDefault();
          todos.splice(index + 1, 0, { id: uid(), done: false, text: "" });
          commit();
          renderTodos(body, item);
          focusTodo(body, index + 1);
        } else if (event.key === "Backspace" && text.value === "" && todos.length > 1) {
          event.preventDefault();
          todos.splice(index, 1);
          commit();
          renderTodos(body, item);
          focusTodo(body, Math.max(0, index - 1), true);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          focusTodo(body, Math.min(todos.length - 1, index + 1));
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          focusTodo(body, Math.max(0, index - 1));
        }
      });

      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "nb-todo-del";
      remove.textContent = "✕";
      remove.title = "刪除這一項";
      remove.addEventListener("click", function () {
        todos.splice(index, 1);
        commit();
        renderTodos(body, item);
      });

      row.appendChild(checkbox);
      row.appendChild(text);
      row.appendChild(remove);
      list.appendChild(row);
    });

    var add = document.createElement("button");
    add.type = "button";
    add.className = "nb-todo-add";
    add.textContent = "＋ 新增一項";
    add.addEventListener("click", function () {
      todos.push({ id: uid(), done: false, text: "" });
      commit();
      renderTodos(body, item);
      focusTodo(body, todos.length - 1);
    });

    body.appendChild(list);
    body.appendChild(add);
  }

  function focusTodo(body, index, toEnd) {
    var inputs = body.querySelectorAll(".nb-todo-text");
    var target = inputs[index];
    if (!target) return;
    target.focus();
    if (toEnd) target.setSelectionRange(target.value.length, target.value.length);
  }

  // ── 繪圖層：幾何工具 ─────────────────────────────────────────────────────
  /* 這四支是從探索系統的 note-drawings.ts 原樣搬過來的純函式，只是拿掉型別標註。
     改動時兩邊要一起改，不然同一份 notes.json 在兩邊畫出來會不一樣。 */

  function drawingPath(points) {
    if (!points.length) return "";
    if (points.length === 1) return "M " + points[0].x + " " + points[0].y + " l 0.01 0";
    var path = "M " + points[0].x + " " + points[0].y;
    for (var index = 1; index < points.length - 1; index += 1) {
      var point = points[index];
      var next = points[index + 1];
      path += " Q " + point.x + " " + point.y + " " + (point.x + next.x) / 2 + " " + (point.y + next.y) / 2;
    }
    var last = points[points.length - 1];
    path += " L " + last.x + " " + last.y;
    return path;
  }

  /** 手繪點太密會讓 notes.json 爆掉，放開時抽稀一次再存。 */
  function simplifyPoints(points, minDistance) {
    var gap = minDistance || 2.5;
    if (points.length <= 2) return points;
    var result = [points[0]];
    for (var index = 1; index < points.length - 1; index += 1) {
      var previous = result[result.length - 1];
      var point = points[index];
      if (Math.hypot(point.x - previous.x, point.y - previous.y) >= gap) result.push(point);
    }
    result.push(points[points.length - 1]);
    return result;
  }

  /** 橡皮擦掃過手繪線時，把被擦掉的點切開，剩下的段落各自成為獨立筆畫。 */
  function erasePathSegments(points, center, radius) {
    var segments = [];
    var current = [];
    points.forEach(function (point) {
      if (Math.hypot(point.x - center.x, point.y - center.y) <= radius) {
        if (current.length >= 2) segments.push(current);
        current = [];
      } else {
        current.push(point);
      }
    });
    if (current.length >= 2) segments.push(current);
    return segments;
  }

  function distanceToSegment(point, start, end) {
    var dx = end.x - start.x;
    var dy = end.y - start.y;
    if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
    var ratio = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy), 0, 1);
    return Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy));
  }

  function hitTestDrawing(element, point, padding) {
    var tolerance = (padding || 8) + element.strokeWidth / 2;
    if (element.kind === "path") {
      for (var index = 1; index < element.points.length; index += 1) {
        if (distanceToSegment(point, element.points[index - 1], element.points[index]) <= tolerance) return true;
      }
      return element.points.length === 1 &&
        distanceToSegment(point, element.points[0], element.points[0]) <= tolerance;
    }
    if (element.kind === "line") {
      return distanceToSegment(point, { x: element.x1, y: element.y1 }, { x: element.x2, y: element.y2 }) <= tolerance;
    }

    var left = Math.min(element.x1, element.x2);
    var right = Math.max(element.x1, element.x2);
    var top = Math.min(element.y1, element.y2);
    var bottom = Math.max(element.y1, element.y2);
    if (element.kind === "rect") {
      var nearHorizontal = point.x >= left - tolerance && point.x <= right + tolerance &&
        (Math.abs(point.y - top) <= tolerance || Math.abs(point.y - bottom) <= tolerance);
      var nearVertical = point.y >= top - tolerance && point.y <= bottom + tolerance &&
        (Math.abs(point.x - left) <= tolerance || Math.abs(point.x - right) <= tolerance);
      return nearHorizontal || nearVertical;
    }

    var rx = Math.max((right - left) / 2, 0.5);
    var ry = Math.max((bottom - top) / 2, 0.5);
    var cx = left + rx;
    var cy = top + ry;
    var normalized = Math.sqrt(Math.pow((point.x - cx) / rx, 2) + Math.pow((point.y - cy) / ry, 2));
    return Math.abs(normalized - 1) <= tolerance / Math.max(rx, ry);
  }

  function moveDrawing(element, dx, dy) {
    return Object.assign({}, element, {
      points: element.points.map(function (point) { return { x: point.x + dx, y: point.y + dy }; }),
      x1: element.x1 + dx,
      y1: element.y1 + dy,
      x2: element.x2 + dx,
      y2: element.y2 + dy,
    });
  }

  function cloneDrawing(element) {
    return Object.assign({}, element, {
      points: element.points.map(function (point) { return { x: point.x, y: point.y }; }),
    });
  }

  function boardDrawings() {
    return state.drawings.filter(function (d) { return d.boardId === currentBoardId; });
  }

  // ── 繪圖層：畫面 ─────────────────────────────────────────────────────────
  function shapeNode(element, selected) {
    var group = document.createElementNS(SVG_NS, "g");
    var node;
    var left = Math.min(element.x1, element.x2);
    var top = Math.min(element.y1, element.y2);
    var width = Math.abs(element.x2 - element.x1);
    var height = Math.abs(element.y2 - element.y1);

    if (element.kind === "path") {
      node = document.createElementNS(SVG_NS, "path");
      node.setAttribute("d", drawingPath(element.points));
    } else if (element.kind === "line") {
      node = document.createElementNS(SVG_NS, "line");
      node.setAttribute("x1", element.x1);
      node.setAttribute("y1", element.y1);
      node.setAttribute("x2", element.x2);
      node.setAttribute("y2", element.y2);
    } else if (element.kind === "rect") {
      node = document.createElementNS(SVG_NS, "rect");
      node.setAttribute("x", left);
      node.setAttribute("y", top);
      node.setAttribute("width", width);
      node.setAttribute("height", height);
    } else {
      node = document.createElementNS(SVG_NS, "ellipse");
      node.setAttribute("cx", left + width / 2);
      node.setAttribute("cy", top + height / 2);
      node.setAttribute("rx", width / 2);
      node.setAttribute("ry", height / 2);
    }

    node.setAttribute("fill", "none");
    node.setAttribute("stroke", element.strokeColor);
    node.setAttribute("stroke-width", element.strokeWidth);
    node.setAttribute("stroke-linecap", "round");
    node.setAttribute("stroke-linejoin", "round");
    node.setAttribute("pointer-events", "none");
    group.appendChild(node);

    if (selected) {
      var box = document.createElementNS(SVG_NS, "rect");
      box.setAttribute("x", left - 6);
      box.setAttribute("y", top - 6);
      box.setAttribute("width", width + 12);
      box.setAttribute("height", height + 12);
      box.setAttribute("fill", "none");
      box.setAttribute("stroke", "#6366f1");
      box.setAttribute("stroke-width", "1.5");
      box.setAttribute("stroke-dasharray", "5 4");
      box.setAttribute("pointer-events", "none");
      group.appendChild(box);
    }
    return group;
  }

  function paintDrawings() {
    svgMain.textContent = "";
    boardDrawings()
      .slice()
      .sort(function (a, b) { return a.zIndex - b.zIndex; })
      .forEach(function (element) {
        svgMain.appendChild(shapeNode(element, element.id === selectedDrawingId));
      });
  }

  function paintDraft() {
    svgDraft.textContent = "";
    if (draftDrawing) svgDraft.appendChild(shapeNode(draftDrawing, false));
  }

  // ── 繪圖層：歷史紀錄 ─────────────────────────────────────────────────────
  /* 每一步都存 { before, after } 兩份快照：before 為 null 代表新增，
     after 為 null 代表刪除，兩者都有就是修改。復原與重做共用同一套套用邏輯。 */
  function recordHistory(before, after) {
    undoStack.push({ before: before, after: after });
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
    syncDrawToolbar();
  }

  function applySnapshot(target, opposite) {
    if (!target && opposite) {
      state.drawings = state.drawings.filter(function (d) { return d.id !== opposite.id; });
      if (selectedDrawingId === opposite.id) selectedDrawingId = null;
    } else if (target && !opposite) {
      state.drawings = state.drawings.filter(function (d) { return d.id !== target.id; }).concat([target]);
    } else if (target) {
      state.drawings = state.drawings.map(function (d) { return d.id === target.id ? target : d; });
    }
    markDirty();
    paintDrawings();
    syncDrawToolbar();
  }

  function undoDrawing() {
    var command = undoStack.pop();
    if (!command) return;
    redoStack.push(command);
    applySnapshot(command.before, command.after);
  }

  function redoDrawing() {
    var command = redoStack.pop();
    if (!command) return;
    undoStack.push(command);
    applySnapshot(command.after, command.before);
  }

  function deleteDrawing(element) {
    state.drawings = state.drawings.filter(function (d) { return d.id !== element.id; });
    if (selectedDrawingId === element.id) selectedDrawingId = null;
    recordHistory(element, null);
    markDirty();
    paintDrawings();
  }

  function clearBoardDrawings() {
    var doomed = boardDrawings();
    if (!doomed.length) return;
    state.drawings = state.drawings.filter(function (d) { return d.boardId !== currentBoardId; });
    selectedDrawingId = null;
    // 一鍵清除故意不進 undo 堆疊（跟原版一致），清掉就是清掉
    undoStack.length = 0;
    redoStack.length = 0;
    markDirty();
    paintDrawings();
    syncDrawToolbar();
  }

  // ── 繪圖層：滑鼠互動 ─────────────────────────────────────────────────────
  function svgPoint(event) {
    var rect = svgEl.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /** 按住 Shift 畫方形／圓形時鎖成正方形、正圓。 */
  function constrainedPoint(start, current, shiftKey) {
    if (!shiftKey) return current;
    var size = Math.max(Math.abs(current.x - start.x), Math.abs(current.y - start.y));
    return {
      x: start.x + Math.sign(current.x - start.x || 1) * size,
      y: start.y + Math.sign(current.y - start.y || 1) * size,
    };
  }

  function eraseAt(point) {
    var hit = null;
    var candidates = boardDrawings();
    for (var index = candidates.length - 1; index >= 0; index -= 1) {
      if (!erasingIds.has(candidates[index].id) && hitTestDrawing(candidates[index], point, 10)) {
        hit = candidates[index];
        break;
      }
    }
    if (!hit) return;
    erasingIds.add(hit.id);

    // 直線／方形／圓形沒有「擦一半」的概念，碰到就整個刪掉
    if (hit.kind !== "path") { deleteDrawing(hit); return; }

    var segments = erasePathSegments(hit.points, point, eraserSize / 2 + hit.strokeWidth / 2)
      .map(function (points) {
        var xs = points.map(function (item) { return item.x; });
        var ys = points.map(function (item) { return item.y; });
        return Object.assign({}, hit, {
          id: uid(),
          points: points,
          x1: Math.min.apply(null, xs),
          y1: Math.min.apply(null, ys),
          x2: Math.max.apply(null, xs),
          y2: Math.max.apply(null, ys),
        });
      });

    state.drawings = state.drawings.reduce(function (all, element) {
      return element.id === hit.id ? all.concat(segments) : all.concat([element]);
    }, []);
    recordHistory(hit, null);
    segments.forEach(function (segment) { recordHistory(null, segment); });
    markDirty();
    paintDrawings();
  }

  function startDrawingMove(element, event) {
    var start = svgPoint(event);
    var original = cloneDrawing(element);
    var latest = original;

    function onMove(moveEvent) {
      var point = svgPoint(moveEvent);
      latest = moveDrawing(original, point.x - start.x, point.y - start.y);
      state.drawings = state.drawings.map(function (d) { return d.id === element.id ? latest : d; });
      paintDrawings();
    }
    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      if (latest.x1 === original.x1 && latest.y1 === original.y1) return;
      recordHistory(original, latest);
      markDirty();
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  function startPan(event) {
    var startX = event.clientX;
    var startY = event.clientY;
    var startLeft = scrollEl.scrollLeft;
    var startTop = scrollEl.scrollTop;
    function onMove(moveEvent) {
      scrollEl.scrollLeft = startLeft - (moveEvent.clientX - startX);
      scrollEl.scrollTop = startTop - (moveEvent.clientY - startY);
    }
    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  function onSvgPointerDown(event) {
    if (event.button !== 0) return;
    var point = svgPoint(event);

    if (drawTool === "hand") { event.preventDefault(); startPan(event); return; }

    if (drawTool === "select") {
      var candidates = boardDrawings();
      var hit = null;
      for (var index = candidates.length - 1; index >= 0; index -= 1) {
        if (hitTestDrawing(candidates[index], point, 8)) { hit = candidates[index]; break; }
      }
      selectedDrawingId = hit ? hit.id : null;
      paintDrawings();
      syncDrawToolbar();
      if (hit) { event.preventDefault(); startDrawingMove(hit, event); }
      return;
    }

    if (drawTool === "eraser") {
      event.preventDefault();
      erasingIds = new Set();
      eraseAt(point);
      svgEl.setPointerCapture(event.pointerId);
      return;
    }

    event.preventDefault();
    selectedDrawingId = null;
    paintDrawings();
    var maxZ = state.drawings.reduce(function (max, d) { return Math.max(max, d.zIndex); }, 0);
    draftDrawing = {
      id: "draft",
      boardId: currentBoardId,
      kind: drawTool === "brush" ? "path" : drawTool,
      points: drawTool === "brush" ? [point] : [],
      x1: point.x, y1: point.y, x2: point.x, y2: point.y,
      strokeColor: drawColor,
      strokeWidth: drawWidth,
      zIndex: maxZ + 1,
    };
    paintDraft();
    svgEl.setPointerCapture(event.pointerId);
  }

  function onSvgPointerMove(event) {
    var point = svgPoint(event);
    if (drawTool === "eraser" && svgEl.hasPointerCapture(event.pointerId)) { eraseAt(point); return; }
    if (!draftDrawing) return;

    if (draftDrawing.kind === "path") {
      var last = draftDrawing.points[draftDrawing.points.length - 1];
      if (last && Math.hypot(point.x - last.x, point.y - last.y) < 1.5) return;
      draftDrawing.points.push(point);
      draftDrawing.x2 = point.x;
      draftDrawing.y2 = point.y;
    } else {
      var end = constrainedPoint({ x: draftDrawing.x1, y: draftDrawing.y1 }, point, event.shiftKey);
      draftDrawing.x2 = end.x;
      draftDrawing.y2 = end.y;
    }
    paintDraft();
  }

  function onSvgPointerUp(event) {
    if (svgEl.hasPointerCapture(event.pointerId)) svgEl.releasePointerCapture(event.pointerId);
    if (drawTool === "eraser") { if (erasingIds) erasingIds.clear(); return; }

    var current = draftDrawing;
    draftDrawing = null;
    paintDraft();
    if (!current) return;

    var points = current.kind === "path" ? simplifyPoints(current.points) : current.points;
    var tooSmall = current.kind === "path"
      ? points.length < 2
      : Math.hypot(current.x2 - current.x1, current.y2 - current.y1) < 4;
    if (tooSmall) return; // 只是點一下，不留下東西

    var xs = points.map(function (point) { return point.x; });
    var ys = points.map(function (point) { return point.y; });
    var created = Object.assign({}, current, {
      id: uid(),
      points: points,
      x1: current.kind === "path" ? Math.min.apply(null, xs) : current.x1,
      y1: current.kind === "path" ? Math.min.apply(null, ys) : current.y1,
      x2: current.kind === "path" ? Math.max.apply(null, xs) : current.x2,
      y2: current.kind === "path" ? Math.max.apply(null, ys) : current.y2,
    });
    state.drawings.push(created);
    recordHistory(null, created);
    markDirty();
    paintDrawings();
  }

  // ── 繪圖層：工具列與游標 ─────────────────────────────────────────────────
  var DRAW_TOOLS = [
    { tool: "select", glyph: "↖", label: "選取（V）" },
    { tool: "hand", glyph: "✋", label: "移動畫布（H）" },
    { sep: true },
    { tool: "brush", glyph: "✏️", label: "畫筆（B）· 右鍵可調粗細顏色" },
    { tool: "eraser", glyph: "🧽", label: "橡皮擦（E）· 右鍵可調大小" },
    { tool: "line", glyph: "╱", label: "直線（L）" },
    { tool: "rect", glyph: "▭", label: "方形（R）" },
    { tool: "ellipse", glyph: "◯", label: "圓形（O）" },
  ];

  function brushCursor(color, strokeWidth) {
    var radius = Math.max(3, strokeWidth / 2 + 1);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
      '<circle cx="12" cy="12" r="' + radius + '" fill="' + color + '" stroke="white" stroke-width="1.5"/></svg>';
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '") 12 12, crosshair';
  }

  function eraserCursor(size) {
    var side = clamp(size / 2, 8, 20);
    var offset = (24 - side) / 2;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
      '<rect x="' + offset + '" y="' + offset + '" width="' + side + '" height="' + side +
      '" rx="2" fill="white" stroke="#475569" stroke-width="2"/></svg>';
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '") 12 12, cell';
  }

  function setDrawTool(next) {
    drawTool = next;
    if (next !== "select") { selectedDrawingId = null; paintDrawings(); }
    syncDrawToolbar();
  }

  /** 工具列的 active 狀態、可否復原、游標、以及「畫圖時卡片不擋路」的旗標。 */
  function syncDrawToolbar() {
    document.querySelectorAll("[data-draw-tool]").forEach(function (button) {
      button.classList.toggle("nb-draw-btn--active", button.dataset.drawTool === drawTool);
    });
    var undoBtn = $("drawUndo");
    var redoBtn = $("drawRedo");
    var clearBtn = $("drawClear");
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
    if (clearBtn) clearBtn.disabled = boardDrawings().length === 0;
    var dot = $("drawColorDot");
    if (dot) dot.style.background = drawColor;

    svgEl.style.cursor = drawTool === "hand" ? "grab"
      : drawTool === "eraser" ? eraserCursor(eraserSize)
      : drawTool === "brush" ? brushCursor(drawColor, drawWidth)
      : drawTool === "select" ? "default" : "crosshair";
    svgEl.style.touchAction = drawTool === "select" ? "pan-x pan-y" : "none";

    /* 只要不是「選取」，就讓卡片不吃滑鼠事件，這樣筆畫才畫得過卡片上方。
       原版沒有這層，畫到卡片上會變成拖卡片。 */
    canvasEl.classList.toggle("nb-canvas--draw", drawTool !== "select");
  }

  function applyDrawStyle(nextColor, nextWidth) {
    drawColor = nextColor;
    drawWidth = nextWidth;
    var selected = state.drawings.filter(function (d) { return d.id === selectedDrawingId; })[0];
    if (selected) {
      var updated = Object.assign(cloneDrawing(selected), { strokeColor: nextColor, strokeWidth: nextWidth });
      state.drawings = state.drawings.map(function (d) { return d.id === selected.id ? updated : d; });
      recordHistory(cloneDrawing(selected), updated);
      markDirty();
      paintDrawings();
    }
    renderStylePanel();
    syncDrawToolbar();
  }

  function swatchRow(container, onPick) {
    DRAWING_COLORS.forEach(function (hex) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "nb-draw-swatch" + (hex === drawColor ? " nb-draw-swatch--active" : "");
      button.style.background = hex;
      button.title = hex;
      button.addEventListener("click", function () { onPick(hex); });
      container.appendChild(button);
    });
  }

  function renderStylePanel() {
    var panel = $("drawStyle");
    if (!panel.classList.contains("nb-draw-pop--open")) return;
    panel.textContent = "";

    var colorLabel = document.createElement("div");
    colorLabel.className = "nb-draw-pop-label";
    colorLabel.textContent = "線條顏色";
    var colors = document.createElement("div");
    colors.className = "nb-draw-swatches";
    swatchRow(colors, function (hex) { applyDrawStyle(hex, drawWidth); });

    var widthLabel = document.createElement("div");
    widthLabel.className = "nb-draw-pop-label";
    widthLabel.textContent = "線條粗細";
    var widths = document.createElement("div");
    widths.className = "nb-draw-widths";
    DRAWING_WIDTHS.forEach(function (width) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "nb-draw-width" + (width === drawWidth ? " nb-draw-width--active" : "");
      var bar = document.createElement("span");
      bar.style.height = width + "px";
      button.appendChild(bar);
      button.addEventListener("click", function () { applyDrawStyle(drawColor, width); });
      widths.appendChild(button);
    });

    panel.appendChild(colorLabel);
    panel.appendChild(colors);
    panel.appendChild(widthLabel);
    panel.appendChild(widths);

    if (selectedDrawingId) {
      var note = document.createElement("div");
      note.className = "nb-draw-pop-note";
      note.textContent = "已套用至選取的圖形";
      panel.appendChild(note);
    }
  }

  /** 畫筆／橡皮擦按右鍵跳出的快速設定（粗細或大小）。 */
  function openToolMenu(which, event) {
    event.preventDefault();
    event.stopPropagation();
    setDrawTool(which);
    $("drawStyle").classList.remove("nb-draw-pop--open");

    var menu = $("drawToolMenu");
    menu.textContent = "";

    var head = document.createElement("div");
    head.className = "nb-draw-pop-head";
    var title = document.createElement("span");
    title.className = "nb-draw-pop-label";
    title.textContent = which === "brush" ? "畫筆粗細" : "橡皮擦大小";
    var value = document.createElement("span");
    value.className = "nb-draw-pop-value";
    value.textContent = (which === "brush" ? drawWidth : eraserSize) + "px";
    head.appendChild(title);
    head.appendChild(value);

    var slider = document.createElement("input");
    slider.type = "range";
    slider.className = "nb-draw-range";
    slider.min = which === "brush" ? 1 : 8;
    slider.max = which === "brush" ? 16 : 48;
    slider.step = 1;
    slider.value = which === "brush" ? drawWidth : eraserSize;
    slider.addEventListener("input", function () {
      var next = Number(slider.value);
      value.textContent = next + "px";
      if (which === "brush") applyDrawStyle(drawColor, next);
      else { eraserSize = next; syncDrawToolbar(); }
    });

    menu.appendChild(head);
    menu.appendChild(slider);

    if (which === "brush") {
      var colorLabel = document.createElement("div");
      colorLabel.className = "nb-draw-pop-label";
      colorLabel.style.marginTop = "12px";
      colorLabel.textContent = "畫筆顏色";
      var colors = document.createElement("div");
      colors.className = "nb-draw-swatches";
      swatchRow(colors, function (hex) {
        applyDrawStyle(hex, drawWidth);
        // 就地更新選中圈，不要整個選單重開（會閃一下又要重算位置）
        colors.querySelectorAll(".nb-draw-swatch").forEach(function (node) {
          node.classList.toggle("nb-draw-swatch--active", node.title === hex);
        });
      });
      menu.appendChild(colorLabel);
      menu.appendChild(colors);
    }

    var hint = document.createElement("div");
    hint.className = "nb-draw-pop-note";
    hint.textContent = "點擊外側即可關閉";
    menu.appendChild(hint);

    menu.classList.add("nb-draw-pop--open");
    var rect = menu.getBoundingClientRect();
    menu.style.left = clamp(event.clientX + 12, 8, window.innerWidth - rect.width - 8) + "px";
    menu.style.top = clamp(event.clientY - rect.height / 2, 8, window.innerHeight - rect.height - 8) + "px";
  }

  function buildDrawToolbar() {
    var bar = $("drawToolbar");
    bar.textContent = "";

    DRAW_TOOLS.forEach(function (entry) {
      if (entry.sep) {
        var line = document.createElement("span");
        line.className = "nb-draw-sep";
        bar.appendChild(line);
        return;
      }
      var button = document.createElement("button");
      button.type = "button";
      button.className = "nb-draw-btn";
      button.dataset.drawTool = entry.tool;
      button.textContent = entry.glyph;
      button.title = entry.label;
      button.addEventListener("click", function () { setDrawTool(entry.tool); });
      if (entry.tool === "brush" || entry.tool === "eraser") {
        button.addEventListener("contextmenu", function (event) { openToolMenu(entry.tool, event); });
      }
      bar.appendChild(button);
    });

    var sep = document.createElement("span");
    sep.className = "nb-draw-sep";
    bar.appendChild(sep);

    var palette = document.createElement("button");
    palette.type = "button";
    palette.className = "nb-draw-btn";
    palette.id = "drawPalette";
    palette.title = "顏色與粗細";
    palette.textContent = "🎨";
    var dot = document.createElement("span");
    dot.className = "nb-draw-dot";
    dot.id = "drawColorDot";
    palette.appendChild(dot);
    palette.addEventListener("click", function (event) {
      event.stopPropagation();
      var panel = $("drawStyle");
      panel.classList.toggle("nb-draw-pop--open");
      $("drawToolMenu").classList.remove("nb-draw-pop--open");
      renderStylePanel();
    });
    bar.appendChild(palette);

    [
      { id: "drawClear", glyph: "🗑", label: "清除本畫布所有筆跡", onClick: clearBoardDrawings, danger: true },
      { id: "drawUndo", glyph: "↶", label: "復原（⌘Z）", onClick: undoDrawing },
      { id: "drawRedo", glyph: "↷", label: "重做（⇧⌘Z）", onClick: redoDrawing },
    ].forEach(function (entry) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "nb-draw-btn" + (entry.danger ? " nb-draw-btn--danger" : "");
      button.id = entry.id;
      button.textContent = entry.glyph;
      button.title = entry.label;
      button.addEventListener("click", entry.onClick);
      bar.appendChild(button);
    });
  }

  // ── 心智圖 ───────────────────────────────────────────────────────────────
  function parseMindMap(content) {
    try {
      var parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (e) { /* 壞掉就重來一顆 root */ }
    return [{ id: "root", text: "主題", x: 30, y: 140, parentId: null }];
  }

  function mindMapDescendants(nodes, id) {
    var ids = [id];
    for (var index = 0; index < ids.length; index += 1) {
      var current = ids[index];
      nodes.forEach(function (node) {
        if (node.parentId === current && ids.indexOf(node.id) === -1) ids.push(node.id);
      });
    }
    return ids;
  }

  function renderMindMap(body, item) {
    body.textContent = "";
    var nodes = parseMindMap(item.content);
    var fontPx = FONT_SIZE_PX[item.fontSize];

    var surface = document.createElement("div");
    surface.className = "nb-mm";

    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "nb-mm-edges");
    surface.appendChild(svg);

    function persist() {
      item.content = JSON.stringify(nodes);
      markDirty();
    }

    /* 連線是父節點右緣 → 子節點左緣的貝茲曲線，節點一移動就要重畫。 */
    function paintEdges() {
      svg.textContent = "";
      nodes.forEach(function (node) {
        if (node.parentId === null) return;
        var parent = nodes.filter(function (candidate) { return candidate.id === node.parentId; })[0];
        if (!parent) return;
        var x1 = parent.x + MM_W;
        var y1 = parent.y + MM_H / 2;
        var x2 = node.x;
        var y2 = node.y + MM_H / 2;
        var mid = (x1 + x2) / 2;
        var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", "M " + x1 + " " + y1 + " C " + mid + " " + y1 + ", " + mid + " " + y2 + ", " + x2 + " " + y2);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "#cbd5e1");
        path.setAttribute("stroke-width", "1.5");
        svg.appendChild(path);
      });
    }

    function bounds() {
      return { w: surface.clientWidth || item.w, h: surface.clientHeight || item.h };
    }

    function addChild(parentId) {
      var parent = nodes.filter(function (node) { return node.id === parentId; })[0];
      if (!parent) return;
      var box = bounds();
      var siblings = nodes.filter(function (node) { return node.parentId === parentId; }).length;
      var child = {
        id: uid(),
        text: "節點",
        x: Math.min(parent.x + MM_W + 60, Math.max(0, box.w - MM_W - 30)),
        y: clamp(parent.y + siblings * (MM_H + 14), 8, Math.max(8, box.h - MM_H - 10)),
        parentId: parentId,
      };
      nodes.push(child);
      persist();
      renderMindMap(body, item); // 整塊重畫，這裡的 surface 已經失效，要從 body 重查
      var fresh = body.querySelector('[data-node-id="' + child.id + '"]');
      if (fresh) fresh.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }

    function removeNode(id) {
      if (id === "root") return; // 根節點刪掉整張圖就沒有錨點了
      var doomed = mindMapDescendants(nodes, id);
      nodes = nodes.filter(function (node) { return doomed.indexOf(node.id) === -1; });
      persist();
      renderMindMap(body, item);
    }

    nodes.forEach(function (node) {
      var isRoot = node.id === "root";
      var el = document.createElement("div");
      el.className = "nb-mm-node" + (isRoot ? " nb-mm-node--root" : "");
      el.dataset.nodeId = node.id;
      el.style.left = node.x + "px";
      el.style.top = node.y + "px";

      var text = document.createElement("span");
      text.className = "nb-mm-text";
      text.style.fontSize = fontPx + "px";
      text.textContent = node.text;
      el.appendChild(text);

      var add = document.createElement("button");
      add.type = "button";
      add.className = "nb-mm-btn nb-mm-btn--add";
      add.textContent = "+";
      add.title = "新增子節點";
      add.addEventListener("pointerdown", function (event) {
        event.stopPropagation();
        event.preventDefault();
        addChild(node.id);
      });
      el.appendChild(add);

      if (!isRoot) {
        var kill = document.createElement("button");
        kill.type = "button";
        kill.className = "nb-mm-btn nb-mm-btn--del";
        kill.textContent = "×";
        kill.title = "刪除節點與其子節點";
        kill.addEventListener("pointerdown", function (event) {
          event.stopPropagation();
          event.preventDefault();
          removeNode(node.id);
        });
        el.appendChild(kill);
      }

      el.addEventListener("dblclick", function (event) {
        event.stopPropagation();
        var input = document.createElement("input");
        input.type = "text";
        input.className = "nb-mm-input";
        input.value = node.text;
        input.style.fontSize = fontPx + "px";
        input.addEventListener("pointerdown", function (inner) { inner.stopPropagation(); });

        var settled = false;
        function commit(value) {
          if (settled) return;
          settled = true;
          node.text = value.trim() || "節點";
          text.textContent = node.text;
          persist();
          input.replaceWith(text);
        }
        input.addEventListener("keydown", function (inner) {
          inner.stopPropagation();
          if (inner.key === "Enter" && !inner.isComposing) { inner.preventDefault(); commit(input.value); }
          else if (inner.key === "Escape") { inner.preventDefault(); commit(node.text); }
        });
        input.addEventListener("blur", function () { commit(input.value); });

        text.replaceWith(input);
        input.focus();
        input.select();
      });

      el.addEventListener("pointerdown", function (event) {
        if (event.button !== 0) return;
        event.stopPropagation(); // 別讓卡片本身跟著動
        event.preventDefault();
        var startX = event.clientX;
        var startY = event.clientY;
        var originX = node.x;
        var originY = node.y;
        var moved = false;
        var box = bounds();

        function onMove(moveEvent) {
          var dx = moveEvent.clientX - startX;
          var dy = moveEvent.clientY - startY;
          if (!moved && Math.hypot(dx, dy) < 4) return;
          moved = true;
          node.x = clamp(originX + dx, 0, Math.max(0, box.w - MM_W - 28));
          node.y = clamp(originY + dy, 8, Math.max(8, box.h - MM_H - 10));
          el.style.left = node.x + "px";
          el.style.top = node.y + "px";
          paintEdges();
        }

        function onUp() {
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onUp);
          if (moved) persist();
        }

        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
      });

      surface.appendChild(el);
    });

    body.appendChild(surface);
    paintEdges();
  }

  // ── 卡片 ─────────────────────────────────────────────────────────────────
  function applyGeometry(el, item) {
    el.style.left = item.x + "px";
    el.style.top = item.y + "px";
    el.style.width = item.w + "px";
    el.style.height = item.h + "px";
    el.style.zIndex = String(item.zIndex);
    el.style.background = item.color;
  }

  function createCard(item) {
    if (item.type === "board") return createBoardCard(item);

    var card = document.createElement("div");
    card.className = "nb-card";
    card.dataset.id = item.id;
    applyGeometry(card, item);

    // ── header：拖曳把手 + 標題 + 刪除 ──
    var header = document.createElement("div");
    header.className = "nb-hd";

    /* 標題平常是純文字、要按鉛筆才變輸入框。這不是裝飾：輸入框會吃掉
       pointerdown，整條 header 就拖不動了（header 正是唯一的拖曳把手）。 */
    var titleText = document.createElement("span");
    titleText.className = "nb-title-text";

    function paintTitle() {
      titleText.textContent = item.title || "標題";
      titleText.classList.toggle("nb-title-text--empty", !item.title);
    }
    paintTitle();

    function editTitle() {
      var input = document.createElement("input");
      input.type = "text";
      input.className = "nb-title";
      input.value = item.title;
      input.placeholder = "標題";
      input.addEventListener("pointerdown", function (event) { event.stopPropagation(); });

      var settled = false;
      function commit(nextValue) {
        if (settled) return; // Enter 之後還會補一次 blur，擋掉重複提交
        settled = true;
        item.title = nextValue;
        markDirty();
        paintTitle();
        input.replaceWith(titleText);
      }
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") { event.preventDefault(); commit(input.value); }
        else if (event.key === "Escape") { event.preventDefault(); commit(item.title); }
      });
      input.addEventListener("blur", function () { commit(input.value); });

      titleText.replaceWith(input);
      input.focus();
      input.select();
    }

    var rename = document.createElement("button");
    rename.type = "button";
    rename.className = "nb-hd-btn";
    rename.textContent = "✎";
    rename.title = "改標題";
    rename.addEventListener("pointerdown", function (event) { event.stopPropagation(); });
    rename.addEventListener("click", editTitle);

    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "nb-hd-btn nb-hd-btn--del";
    remove.textContent = "✕";
    remove.title = "刪除";
    remove.addEventListener("pointerdown", function (event) { event.stopPropagation(); });
    remove.addEventListener("click", function () { showDeleteConfirm(card, header, item); });

    header.appendChild(titleText);
    header.appendChild(rename);
    header.appendChild(remove);
    header.addEventListener("pointerdown", function (event) { startDrag(event, item); });
    header.addEventListener("dblclick", editTitle);

    // ── body ──
    var body = document.createElement("div");
    body.className = "nb-body";
    body.style.fontSize = FONT_SIZE_PX[item.fontSize] + "px";

    if (item.type === "todo") {
      renderTodos(body, item);
    } else if (item.type === "mindmap") {
      body.classList.add("nb-body--mm");
      renderMindMap(body, item);
    } else {
      var textarea = document.createElement("textarea");
      textarea.className = "nb-ta";
      textarea.value = item.content;
      textarea.placeholder = PLACEHOLDERS[item.type] || "";
      textarea.style.fontSize = FONT_SIZE_PX[item.fontSize] + "px";
      textarea.addEventListener("input", function () { item.content = textarea.value; markDirty(); });
      body.appendChild(textarea);
    }

    // ── 縮放把手 ──
    var resize = document.createElement("div");
    resize.className = "nb-rz";
    resize.title = "調整大小";
    resize.addEventListener("pointerdown", function (event) { startResize(event, item); });

    card.appendChild(header);
    card.appendChild(body);
    card.appendChild(resize);

    card.addEventListener("pointerdown", function () { bringToFront(item); });
    card.addEventListener("contextmenu", function (event) {
      event.preventDefault();
      openContextMenu(event, item);
    });

    canvasEl.appendChild(card);
    els.set(item.id, card);
    return card;
  }

  /* Board 卡片跟其他卡片長得不一樣：固定尺寸、不可縮放，點一下進去、
     拖曳則是移動位置（靠 startDrag 的 onTap 區分）。 */
  function createBoardCard(item) {
    var card = document.createElement("div");
    card.className = "nb-card nb-board";
    card.dataset.id = item.id;
    card.style.left = item.x + "px";
    card.style.top = item.y + "px";
    card.style.width = TYPE_DEFAULTS.board.w + "px";
    card.style.height = TYPE_DEFAULTS.board.h + "px";
    card.style.zIndex = String(item.zIndex);

    var tile = document.createElement("div");
    tile.className = "nb-board-tile";
    tile.style.background = item.color;
    tile.title = "點一下進入，拖曳可移動";

    var icon = document.createElement("div");
    icon.className = "nb-board-icon";
    icon.textContent = "🗂";
    tile.appendChild(icon);

    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "nb-board-del";
    remove.textContent = "✕";
    remove.title = "刪除這個 Board";
    remove.addEventListener("pointerdown", function (event) { event.stopPropagation(); });
    remove.addEventListener("click", function (event) {
      event.stopPropagation();
      showBoardDeleteConfirm(tile, remove, item);
    });
    tile.appendChild(remove);

    tile.addEventListener("pointerdown", function (event) {
      startDrag(event, item, function () { openBoard(item.content); });
    });

    var label = document.createElement("div");
    label.className = "nb-board-label";

    var name = document.createElement("div");
    name.className = "nb-board-name";
    name.textContent = item.title || "未命名 Board";
    name.title = "雙擊改名";

    var count = document.createElement("div");
    count.className = "nb-board-count";
    count.textContent = childCount(item.content) + " 個項目";

    name.addEventListener("dblclick", function () {
      var input = document.createElement("input");
      input.type = "text";
      input.className = "nb-board-rename";
      input.value = item.title;
      input.placeholder = "Board 名稱";
      input.addEventListener("pointerdown", function (event) { event.stopPropagation(); });

      var settled = false;
      function commit(value) {
        if (settled) return;
        settled = true;
        item.title = value.trim();
        // Board 名稱是同一件事的兩份紀錄（卡片標題與 Board 本身），要一起改
        if (state.boards[item.content]) state.boards[item.content].name = item.title || "未命名 Board";
        markDirty();
        name.textContent = item.title || "未命名 Board";
        input.replaceWith(name);
        renderBreadcrumbs();
      }
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") { event.preventDefault(); commit(input.value); }
        else if (event.key === "Escape") { event.preventDefault(); commit(item.title); }
      });
      input.addEventListener("blur", function () { commit(input.value); });

      name.replaceWith(input);
      input.focus();
      input.select();
    });

    label.appendChild(name);
    label.appendChild(count);
    card.appendChild(tile);
    card.appendChild(label);

    card.addEventListener("pointerdown", function () { bringToFront(item); });
    card.addEventListener("contextmenu", function (event) {
      event.preventDefault();
      openContextMenu(event, item);
    });

    canvasEl.appendChild(card);
    els.set(item.id, card);
    return card;
  }

  function showBoardDeleteConfirm(tile, removeBtn, item) {
    removeBtn.style.display = "none";
    var overlay = document.createElement("div");
    overlay.className = "nb-board-confirm";
    overlay.addEventListener("pointerdown", function (event) { event.stopPropagation(); });

    var text = document.createElement("span");
    text.className = "nb-board-confirm-text";
    text.textContent = "連同裡面的東西一起刪除？";

    var actions = document.createElement("div");
    actions.className = "nb-board-confirm-actions";

    var yes = document.createElement("button");
    yes.type = "button";
    yes.className = "nb-confirm-btn nb-confirm-btn--yes";
    yes.textContent = "刪除";
    yes.addEventListener("click", function () { deleteItem(item); });

    var no = document.createElement("button");
    no.type = "button";
    no.className = "nb-confirm-btn nb-confirm-btn--no";
    no.textContent = "取消";
    no.addEventListener("click", function () {
      overlay.remove();
      removeBtn.style.display = "";
    });

    actions.appendChild(yes);
    actions.appendChild(no);
    overlay.appendChild(text);
    overlay.appendChild(actions);
    tile.appendChild(overlay);
  }

  function showDeleteConfirm(card, header, item) {
    var original = Array.prototype.slice.call(header.childNodes);
    header.textContent = "";
    header.classList.add("nb-hd--confirm");

    var label = document.createElement("span");
    label.className = "nb-confirm-text";
    label.textContent = "確定刪除？";

    var yes = document.createElement("button");
    yes.type = "button";
    yes.className = "nb-confirm-btn nb-confirm-btn--yes";
    yes.textContent = "刪除";
    yes.addEventListener("pointerdown", function (event) { event.stopPropagation(); });
    yes.addEventListener("click", function () { deleteItem(item); });

    var no = document.createElement("button");
    no.type = "button";
    no.className = "nb-confirm-btn nb-confirm-btn--no";
    no.textContent = "取消";
    no.addEventListener("pointerdown", function (event) { event.stopPropagation(); });
    no.addEventListener("click", function () {
      header.textContent = "";
      header.classList.remove("nb-hd--confirm");
      original.forEach(function (node) { header.appendChild(node); });
    });

    header.appendChild(label);
    header.appendChild(yes);
    header.appendChild(no);
  }

  function bringToFront(item) {
    var maxZ = state.items.reduce(function (max, entry) { return Math.max(max, entry.zIndex); }, 0);
    if (item.zIndex === maxZ) return;
    item.zIndex = maxZ + 1;
    var el = els.get(item.id);
    if (el) el.style.zIndex = String(item.zIndex);
    markDirty();
  }

  // ── 拖曳與縮放 ────────────────────────────────────────────────────────────
  function startDrag(event, item, onTap) {
    if (event.button !== 0) return;
    event.preventDefault();
    var card = els.get(item.id);
    bringToFront(item);
    card.classList.add("nb-card--dragging");

    var startX = event.clientX;
    var startY = event.clientY;
    var originX = item.x;
    var originY = item.y;
    var peers = boardItems();
    var moved = false;

    function onMove(moveEvent) {
      if (!moved && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 4) return;
      moved = true;
      var snapped = computeSnap(
        originX + (moveEvent.clientX - startX),
        originY + (moveEvent.clientY - startY),
        item.w, item.h, peers, item.id
      );
      item.x = snapped.x;
      item.y = snapped.y;
      card.style.left = item.x + "px";
      card.style.top = item.y + "px";
      drawGuides(snapped.guides);
    }

    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      card.classList.remove("nb-card--dragging");
      drawGuides(null);
      if (moved) markDirty();
      else if (onTap) onTap();
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  function startResize(event, item) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    var card = els.get(item.id);
    var startX = event.clientX;
    var startY = event.clientY;
    var originW = item.w;
    var originH = item.h;

    function onMove(moveEvent) {
      item.w = clamp(originW + (moveEvent.clientX - startX), MIN_W, CANVAS_W - item.x);
      item.h = clamp(originH + (moveEvent.clientY - startY), MIN_H, CANVAS_H - item.y);
      card.style.width = item.w + "px";
      card.style.height = item.h + "px";
    }

    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      markDirty();
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  // ── 右鍵選單：換色與字級 ──────────────────────────────────────────────────
  function buildContextMenu() {
    var swatches = $("ctxSwatches");
    COLOR_PALETTE.forEach(function (entry) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "nb-swatch";
      button.dataset.hex = entry.hex;
      button.style.background = entry.hex;
      button.title = entry.label;
      button.addEventListener("click", function () {
        var item = findItem(ctxItemId);
        if (!item) return;
        item.color = entry.hex;
        var el = els.get(item.id);
        // Board 卡片的底色在裡面那塊磁磚上，外層是透明的
        var painted = el && (item.type === "board" ? el.querySelector(".nb-board-tile") : el);
        if (painted) painted.style.background = entry.hex;
        markDirty();
        syncContextMenuActive(item);
      });
      swatches.appendChild(button);
    });

    var sizes = $("ctxSizes");
    Object.keys(FONT_SIZE_PX).forEach(function (key) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "nb-size";
      button.dataset.size = key;
      button.textContent = FONT_SIZE_LABELS[key];
      button.addEventListener("click", function () {
        var item = findItem(ctxItemId);
        if (!item) return;
        item.fontSize = key;
        markDirty();
        rebuildCard(item);
        syncContextMenuActive(item);
      });
      sizes.appendChild(button);
    });
  }

  function syncContextMenuActive(item) {
    ctxEl.querySelectorAll(".nb-swatch").forEach(function (node) {
      node.classList.toggle("nb-swatch--active", node.dataset.hex.toLowerCase() === item.color.toLowerCase());
    });
    ctxEl.querySelectorAll(".nb-size").forEach(function (node) {
      node.classList.toggle("nb-size--active", node.dataset.size === item.fontSize);
    });
  }

  function openContextMenu(event, item) {
    ctxItemId = item.id;
    syncContextMenuActive(item);
    ctxEl.classList.add("nb-ctx--open");
    // 先顯示才量得到尺寸，然後夾住不要超出視窗
    var rect = ctxEl.getBoundingClientRect();
    ctxEl.style.left = clamp(event.clientX, 8, window.innerWidth - rect.width - 8) + "px";
    ctxEl.style.top = clamp(event.clientY, 8, window.innerHeight - rect.height - 8) + "px";
  }

  function closeContextMenu() {
    ctxEl.classList.remove("nb-ctx--open");
    ctxItemId = null;
  }

  /** 字級改變時 textarea / todo 都要重畫，直接把整張卡片重建最單純。 */
  function rebuildCard(item) {
    var old = els.get(item.id);
    if (old) old.remove();
    els.delete(item.id);
    createCard(item);
  }

  // ── 新增與刪除 ────────────────────────────────────────────────────────────
  function initialContent(type) {
    if (type === "todo") return JSON.stringify([{ id: uid(), done: false, text: "" }]);
    if (type === "mindmap") return JSON.stringify([{ id: "root", text: "主題", x: 30, y: 140, parentId: null }]);
    return "";
  }

  function createItem(type, x, y) {
    var def = TYPE_DEFAULTS[type];
    var maxZ = state.items.reduce(function (max, entry) { return Math.max(max, entry.zIndex); }, 0);
    var content = initialContent(type);
    var title = "";

    if (type === "board") {
      // Board 卡片的 content 存的是子 Board 的 id，兩者一起建立
      var boardId = uid();
      state.boards[boardId] = { id: boardId, name: "新 Board", parentId: currentBoardId };
      content = boardId;
      title = "新 Board";
    }

    var item = {
      id: uid(),
      boardId: currentBoardId,
      type: type,
      x: clamp(Math.round(x), 0, CANVAS_W - def.w),
      y: clamp(Math.round(y), 0, CANVAS_H - def.h),
      w: def.w,
      h: def.h,
      title: title,
      content: content,
      color: def.color,
      fontSize: "md",
      zIndex: maxZ + 1,
    };
    state.items.push(item);
    var card = createCard(item);
    markDirty();
    var focusTarget = card.querySelector(".nb-ta") || card.querySelector(".nb-todo-text");
    if (focusTarget) focusTarget.focus();
  }

  function createItemAtViewportCenter(type) {
    var def = TYPE_DEFAULTS[type];
    createItem(
      type,
      scrollEl.scrollLeft + scrollEl.clientWidth / 2 - def.w / 2,
      scrollEl.scrollTop + scrollEl.clientHeight / 2 - def.h / 2
    );
  }

  function deleteItem(item) {
    if (item.type === "board") {
      var doomed = boardSubtree(item.content);
      state.items = state.items.filter(function (entry) { return doomed.indexOf(entry.boardId) === -1; });
      doomed.forEach(function (id) { delete state.boards[id]; });
    }
    state.items = state.items.filter(function (entry) { return entry.id !== item.id; });
    var el = els.get(item.id);
    if (el) el.remove();
    els.delete(item.id);
    if (ctxItemId === item.id) closeContextMenu();
    markDirty();
  }

  // ── 工具列拖放新增 ────────────────────────────────────────────────────────
  function onToolPointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    var type = event.currentTarget.dataset.type;
    var def = TYPE_DEFAULTS[type];
    var startX = event.clientX;
    var startY = event.clientY;
    var dragged = false;
    var ghost = null;

    function onMove(moveEvent) {
      if (!dragged && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 6) {
        dragged = true;
        ghost = document.createElement("div");
        ghost.className = "nb-ghost";
        ghost.style.width = def.w + "px";
        ghost.style.height = def.h + "px";
        document.body.appendChild(ghost);
      }
      if (ghost) {
        ghost.style.left = moveEvent.clientX - def.w / 2 + "px";
        ghost.style.top = moveEvent.clientY - def.h / 2 + "px";
      }
    }

    function onUp(upEvent) {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      if (ghost) ghost.remove();

      if (!dragged) { createItemAtViewportCenter(type); return; }

      var rect = scrollEl.getBoundingClientRect();
      var inside = upEvent.clientX >= rect.left && upEvent.clientX <= rect.right &&
        upEvent.clientY >= rect.top && upEvent.clientY <= rect.bottom;
      if (!inside) return; // 拖到畫布外就是取消
      createItem(
        type,
        upEvent.clientX - rect.left + scrollEl.scrollLeft - def.w / 2,
        upEvent.clientY - rect.top + scrollEl.scrollTop - def.h / 2
      );
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  // ── 設定面板 ──────────────────────────────────────────────────────────────
  function openSettings() {
    var panel = $("settingsPanel");
    panel.classList.add("nb-settings--open");
    $("tokenInput").value = "";
    $("tokenInput").placeholder = GH.token() ? "已設定，留白代表不更動" : "ghp_…";
    $("repoInput").value = GH.notesRepo();
    $("settingsStatus").textContent = "";
  }

  function closeSettings() {
    $("settingsPanel").classList.remove("nb-settings--open");
  }

  function saveSettings() {
    var token = $("tokenInput").value.trim();
    var repo = $("repoInput").value.trim();
    if (token) GH.setToken(token);
    GH.setNotesRepo(repo);
    var status = $("settingsStatus");
    status.textContent = "✓ 已儲存，重新連線中…";
    status.style.color = "#34c759";
    setTimeout(function () { closeSettings(); pullRemote(); }, 700);
  }

  // ── 畫面 ─────────────────────────────────────────────────────────────────
  function renderAll() {
    renderBreadcrumbs();
    // 只清卡片與輔助線，繪圖層的 <svg> 是常駐的，清掉就要整個重建
    canvasEl.querySelectorAll(".nb-card, .nb-guide").forEach(function (node) { node.remove(); });
    els.clear();
    paintDrawings();
    syncDrawToolbar();
    boardItems()
      .slice()
      .sort(function (a, b) { return a.zIndex - b.zIndex; })
      .forEach(createCard);
  }

  /** 有卡片時，把捲軸挪到最靠左上那張附近，不然一開啟只會看到一片空白。 */
  function scrollToContent() {
    var items = boardItems();
    if (!items.length) return;
    var minX = Math.min.apply(null, items.map(function (item) { return item.x; }));
    var minY = Math.min.apply(null, items.map(function (item) { return item.y; }));
    scrollEl.scrollLeft = Math.max(0, minX - 60);
    scrollEl.scrollTop = Math.max(0, minY - 60);
  }

  // ── 啟動 ─────────────────────────────────────────────────────────────────
  function init() {
    scrollEl = $("scroll");
    canvasEl = $("canvas");
    statusEl = $("statusText");
    bannerEl = $("banner");
    bannerTextEl = $("bannerText");
    bannerActionEl = $("bannerAction");
    ctxEl = $("ctxMenu");

    canvasEl.style.width = CANVAS_W + "px";
    canvasEl.style.height = CANVAS_H + "px";

    svgEl = document.createElementNS(SVG_NS, "svg");
    svgEl.setAttribute("class", "nb-draw-layer");
    svgEl.setAttribute("width", CANVAS_W);
    svgEl.setAttribute("height", CANVAS_H);
    svgMain = document.createElementNS(SVG_NS, "g");
    svgDraft = document.createElementNS(SVG_NS, "g");
    svgEl.appendChild(svgMain);
    svgEl.appendChild(svgDraft);
    svgEl.addEventListener("pointerdown", onSvgPointerDown);
    svgEl.addEventListener("pointermove", onSvgPointerMove);
    svgEl.addEventListener("pointerup", onSvgPointerUp);
    svgEl.addEventListener("pointercancel", onSvgPointerUp);
    canvasEl.appendChild(svgEl);

    buildDrawToolbar();
    buildContextMenu();

    state = loadLocal() || emptyState();
    renderAll();
    scrollToContent();

    document.querySelectorAll(".nb-tool").forEach(function (button) {
      button.addEventListener("pointerdown", onToolPointerDown);
    });

    $("settingsBtn").addEventListener("click", function (event) {
      event.stopPropagation();
      var panel = $("settingsPanel");
      if (panel.classList.contains("nb-settings--open")) closeSettings();
      else openSettings();
    });
    $("settingsSave").addEventListener("click", saveSettings);
    $("settingsPanel").addEventListener("click", function (event) { event.stopPropagation(); });

    statusEl.addEventListener("click", function () {
      if (statusEl.classList.contains("nb-status--err")) pullRemote();
    });

    document.addEventListener("pointerdown", function (event) {
      if (!ctxEl.contains(event.target)) closeContextMenu();
      if (!$("settingsPanel").contains(event.target) && event.target !== $("settingsBtn")) closeSettings();
      if (!$("drawToolMenu").contains(event.target)) $("drawToolMenu").classList.remove("nb-draw-pop--open");
      if (!$("drawStyle").contains(event.target) && !event.target.closest("#drawPalette")) {
        $("drawStyle").classList.remove("nb-draw-pop--open");
      }
    });

    var TOOL_KEYS = { v: "select", h: "hand", b: "brush", p: "brush", e: "eraser", l: "line", r: "rect", o: "ellipse" };
    document.addEventListener("keydown", function (event) {
      // 在輸入框裡打字時，單鍵快捷鍵一律不作用，否則打個「b」就切成畫筆
      var target = event.target;
      var typing = target && target.matches && target.matches("input, textarea, select, [contenteditable='true']");

      if (event.key === "Escape") {
        closeContextMenu();
        closeSettings();
        closeConflictDialog();
        $("drawToolMenu").classList.remove("nb-draw-pop--open");
        $("drawStyle").classList.remove("nb-draw-pop--open");
        if (!typing) setDrawTool("select");
        return;
      }
      if (typing) return;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redoDrawing(); else undoDrawing();
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedDrawingId) {
        var selected = state.drawings.filter(function (d) { return d.id === selectedDrawingId; })[0];
        if (selected) { event.preventDefault(); deleteDrawing(selected); }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      var next = TOOL_KEYS[event.key.toLowerCase()];
      if (next) setDrawTool(next);
    });

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") flush();
    });
    window.addEventListener("pagehide", flush);

    pullRemote();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
