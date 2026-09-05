/* GitHub API 小工具 —— 目前只有 notes.html 使用。
 *
 * ⚠️ index.html 內另有一份功能重疊的 inline 版本（ghUser / ghRepo / ghToken /
 * _ghUpdateDb），刻意「沒有」改成引用這支檔案：那頁的更換封面、編輯筆記、
 * 垃圾桶還原與永久刪除全都依賴那幾個函式，改成外部檔案等於平白多一個
 * 「gh.js 沒載到 → 整個資料庫頁的寫入功能一起壞掉」的失敗點。
 *
 * 兩邊唯一必須保持一致的是 localStorage 的 key 名稱 'ghToken'。同網域共用
 * 同一把 token，所以在 index.html 的 ⚙️ 設定過，notes.html 就直接讀得到。
 * 改這個字串前，記得 index.html 那邊也要一起改。
 */
(function (global) {
  "use strict";

  var TOKEN_KEY = "ghToken"; // ⚠️ 必須與 index.html 一致
  var NOTES_REPO_KEY = "notesRepo";
  var DEFAULT_NOTES_REPO = "video-notes";

  /** GitHub Pages 網址形如 {user}.github.io/{repo}/，使用者與 repo 都由網址推導。 */
  function user() {
    return global.location.hostname.split(".")[0];
  }

  function repo() {
    return global.location.pathname.split("/").filter(Boolean)[0] || "video-db";
  }

  function token() {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch (e) {
      return "";
    }
  }

  function setToken(value) {
    localStorage.setItem(TOKEN_KEY, value);
  }

  /** 筆記存在另一個「私有」repo，才不會跟公開的資料庫 repo 一起被看光。 */
  function notesRepo() {
    try {
      return localStorage.getItem(NOTES_REPO_KEY) || DEFAULT_NOTES_REPO;
    } catch (e) {
      return DEFAULT_NOTES_REPO;
    }
  }

  function setNotesRepo(value) {
    localStorage.setItem(NOTES_REPO_KEY, value || DEFAULT_NOTES_REPO);
  }

  function headers() {
    return {
      Authorization: "token " + token(),
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  function contentsUrl(repoName, path) {
    return "https://api.github.com/repos/" + user() + "/" + repoName + "/contents/" + path;
  }

  /* base64 ⇄ UTF-8。沿用 index.html 既有的 escape/unescape 寫法，
   * 確保兩頁對中文的處理完全一致。 */
  function encodeUtf8Base64(text) {
    return btoa(unescape(encodeURIComponent(text)));
  }

  function decodeUtf8Base64(base64) {
    return decodeURIComponent(escape(atob(base64.replace(/\n/g, ""))));
  }

  /**
   * 讀一份 JSON。
   * 回傳 { json, sha }；檔案還不存在時回傳 { json: null, sha: null }。
   * repo 不存在、token 無權限等情況一律 throw。
   */
  async function getJson(repoName, path) {
    if (!token()) throw new Error("尚未設定 GitHub Token");
    var response = await fetch(contentsUrl(repoName, path) + "?t=" + Date.now(), {
      headers: headers(),
      cache: "no-store",
    });
    if (response.status === 404) {
      // 檔案不存在跟 repo 不存在都會回 404，靠 repo meta 再問一次分辨。
      var repoCheck = await fetch("https://api.github.com/repos/" + user() + "/" + repoName, {
        headers: headers(),
      });
      if (repoCheck.status === 404) {
        throw new Error("找不到 repo「" + repoName + "」，或這把 token 沒有它的權限");
      }
      return { json: null, sha: null };
    }
    if (response.status === 401) throw new Error("Token 無效或已過期");
    if (!response.ok) throw new Error("讀取失敗（HTTP " + response.status + "）");
    var payload = await response.json();
    return { json: JSON.parse(decodeUtf8Base64(payload.content)), sha: payload.sha };
  }

  /**
   * 寫一份 JSON。sha 為 null 代表新建檔案。
   * 回傳新的 sha；sha 不符（別台裝置改過）時 throw 一個 conflict 標記的錯誤。
   */
  async function putJson(repoName, path, value, message, sha, options) {
    if (!token()) throw new Error("尚未設定 GitHub Token");
    var body = {
      message: message,
      content: encodeUtf8Base64(JSON.stringify(value, null, 2)),
    };
    if (sha) body.sha = sha;

    var response = await fetch(contentsUrl(repoName, path), {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify(body),
      keepalive: !!(options && options.keepalive),
    });

    if (response.status === 409 || response.status === 422) {
      var conflict = new Error("遠端版本比較新，需要先確認要保留哪一份");
      conflict.conflict = true;
      throw conflict;
    }
    if (response.status === 401) throw new Error("Token 無效或已過期");
    if (response.status === 404) {
      throw new Error("找不到 repo「" + repoName + "」，或這把 token 沒有寫入權限");
    }
    if (!response.ok) throw new Error("寫入失敗（HTTP " + response.status + "）");
    var result = await response.json();
    return result.content.sha;
  }

  global.GH = {
    user: user,
    repo: repo,
    token: token,
    setToken: setToken,
    notesRepo: notesRepo,
    setNotesRepo: setNotesRepo,
    getJson: getJson,
    putJson: putJson,
    DEFAULT_NOTES_REPO: DEFAULT_NOTES_REPO,
  };
})(window);
