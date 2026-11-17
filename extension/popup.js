globalThis.browser ??= globalThis.chrome;
// StreamKeep popup: status of the current tab's video, settings, saved videos.
const DEFAULTS = { autoSave: true, autoSwitch: true, quality: 1440, codec: "auto", maxMinutes: 0 };
const $ = (id) => document.getElementById(id);
let tabId = null;
let tabVid = null; // video id from the active tab's URL

function fromB64Json(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function helper(path) {
  const r = await browser.runtime.sendMessage({ type: "get", path });
  if (!r || r.error) throw new Error(r ? r.error : "no answer");
  return fromB64Json(r.body);
}

async function tabMsg(msg) {
  if (tabId == null) return null;
  try {
    return await browser.tabs.sendMessage(tabId, msg);
  } catch (e) {
    browser.runtime.sendMessage({ type: "log", m: `popup tabs.sendMessage ${msg.type}: ${(e && e.message) || e}` }).catch(() => {});
    return null; // not a YouTube tab, or the page hasn't loaded the extension yet
  }
}

const gb = (b) => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + " GB" : Math.round(b / 1024 ** 2) + " MB");
const codecName = (c) => ({ vp9: "VP9", av1: "AV1", h264: "H.264" }[c] || c || "");
const quality = (m) => [m.height ? m.height + "p" : "", codecName(m.vcodec)].filter(Boolean).join(" ");

function show(id, on) {
  $(id).hidden = !on;
}

// ---------- this video ----------
function playableCodecs(codec) {
  const MS = window.MediaSource || window.ManagedMediaSource;
  const ok = (c, kind = "video") => !!MS && MS.isTypeSupported(`${kind}/mp4; codecs="${c}"`);
  const audio = ok("mp4a.40.2", "audio") || !ok("opus", "audio") ? "mp4a" : "opus";
  if (codec === "h264") return ["avc1", audio];
  return [...(ok("av01.0.08M.08") ? ["av01"] : []), ...(ok("vp09.00.40.08") ? ["vp09"] : []), "avc1", audio];
}

async function cachePath(vid) {
  const s = { ...DEFAULTS, ...(await browser.storage.local.get(DEFAULTS)) };
  return `/cache?v=${vid}&q=${s.quality || 0}&c=${playableCodecs(s.codec).join(",")}&max=${s.maxMinutes || 0}`;
}

async function renderVideo() {
  if (!tabVid) {
    show("noVideo", true);
    show("video", false);
    return;
  }
  show("noVideo", false);
  show("video", true);
  const info = (await tabMsg({ type: "info" })) || {};
  let st;
  try {
    st = await helper(`/status?v=${tabVid}`);
  } catch (e) {
    st = { state: "nohelper" };
  }
  $("vTitle").textContent = st.title || info.title || tabVid;
  const pct = Math.round(st.progress || 0);
  const text = {
    none: "Not saved",
    queued: "Waiting to download…",
    downloading: `Saving… ${pct}%`,
    done: `Saved · ${quality(st)}${st.size ? " · " + gb(st.size) : ""}`,
    error: `Couldn't save: ${st.error || "unknown error"}`,
    skipped: `Not saved: ${st.error || "skipped"}`,
    nohelper: "Helper not running",
  }[st.state] || st.state;
  $("vStatus").textContent = info.overlay ? "Playing the saved copy · " + quality(st) : text;
  const busy = st.state === "queued" || st.state === "downloading";
  show("vBarWrap", busy);
  $("vBar").style.width = pct + "%";
  show("bPlay", st.state === "done" && !info.overlay);
  show("bBack", !!info.overlay);
  show("bSave", ["none", "error", "skipped"].includes(st.state));
  show("bCancel", busy);
  show("bResave", st.state === "done");
  show("bDelete", st.state === "done");
}

// Talks to the helper directly, then tells the page to resync.
async function act(type) {
  const v = tabVid;
  try {
    if (type === "toggle") {
      const r = await tabMsg({ type: "toggle" });
      if (!r) {
        $("vStatus").textContent = "Reload the YouTube tab (⌘R), then try again.";
        return;
      }
      window.close();
      return;
    }
    if (type === "save") {
      await helper(await cachePath(v));
      await tabMsg({ type: "refresh", save: v });
    } else if (type === "cancel" || type === "delete") {
      await helper(`/${type}?v=${v}`);
      await tabMsg({ type: "refresh", hold: v });
    } else if (type === "resave") {
      await tabMsg({ type: "refresh", hold: v }); // close the offline copy first
      await helper(`/delete?v=${v}`);
      await helper(await cachePath(v));
      await tabMsg({ type: "refresh", save: v });
    }
  } catch (e) {
    $("vStatus").textContent = "Error: " + ((e && e.message) || e);
  }
  await Promise.all([renderVideo(), renderCache()]);
}

$("bPlay").onclick = () => act("toggle");
$("bBack").onclick = () => act("toggle");
$("bSave").onclick = () => act("save");
$("bCancel").onclick = () => act("cancel");
$("bResave").onclick = () => act("resave");
$("bDelete").onclick = () => act("delete");

// ---------- settings ----------
async function loadSettings() {
  const s = { ...DEFAULTS, ...(await browser.storage.local.get(DEFAULTS)) };
  for (const k of Object.keys(DEFAULTS)) $(k).value = String(s[k]);
  for (const k of Object.keys(DEFAULTS)) {
    $(k).onchange = () => {
      const raw = $(k).value;
      const v = raw === "true" ? true : raw === "false" ? false : /^\d+$/.test(raw) ? Number(raw) : raw;
      browser.storage.local.set({ [k]: v });
    };
  }
}

async function saveConfig() {
  try {
    await helper(`/config?days=${$("days").value}&maxgb=${$("maxgb").value}`);
    renderCache();
  } catch (_) { /* helper down: shown in header */ }
}
$("days").onchange = saveConfig;
$("maxgb").onchange = saveConfig;

// ---------- saved videos ----------
let clearArmed = false;
async function renderCache() {
  let data;
  try {
    data = await helper("/list");
    $("dot").className = "dot ok";
    $("helperText").textContent = "helper running";
    show("setup", false);
  } catch (e) {
    $("dot").className = "dot bad";
    $("helperText").textContent = "helper not running";
    $("cacheSummary").textContent = "";
    show("setup", true);
    return;
  }
  $("days").value = String(data.config.days);
  $("maxgb").value = String(data.config.maxgb);
  const n = data.videos.length;
  $("cacheSummary").textContent =
    `${n} saved · ${gb(data.total)}` +
    ` · ${gb(data.free)} free on disk`;
  const list = $("list");
  list.textContent = "";
  for (const a of data.active) {
    const row = document.createElement("div");
    row.className = "item";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = a.title || a.id;
    name.title = a.title || a.id;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = a.state === "queued" ? "waiting…" : `saving ${Math.round(a.progress || 0)}%`;
    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = "Cancel";
    del.onclick = async () => {
      await helper(`/cancel?v=${a.id}`);
      if (a.id === tabVid) await tabMsg({ type: "refresh", hold: a.id });
      await Promise.all([renderCache(), renderVideo()]);
    };
    row.append(name, meta, del);
    list.append(row);
  }
  for (const v of data.videos) {
    const row = document.createElement("div");
    row.className = "item";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = v.title || v.id;
    name.title = v.title || v.id;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${quality(v)} · ${gb(v.size)}`;
    const del = document.createElement("button");
    del.textContent = "✕";
    del.title = "Delete";
    del.onclick = async () => {
      await helper(`/delete?v=${v.id}`);
      if (v.id === tabVid) await tabMsg({ type: "refresh", hold: v.id });
      await Promise.all([renderCache(), renderVideo()]);
    };
    row.append(name, meta, del);
    list.append(row);
  }
  $("bClear").disabled = n === 0 && !data.active.length;
}

$("bOpen").onclick = () => helper("/open").catch(() => {});
$("bClear").onclick = async () => {
  if (!clearArmed) {
    clearArmed = true;
    $("bClear").textContent = "Click again to delete all";
    setTimeout(() => {
      clearArmed = false;
      $("bClear").textContent = "Clear all";
    }, 3000);
    return;
  }
  clearArmed = false;
  $("bClear").textContent = "Clear all";
  await helper("/clear");
  if (tabVid) await tabMsg({ type: "refresh", hold: tabVid }); // don't re-save right away
  await Promise.all([renderCache(), renderVideo()]);
};

// ---------- permissions (Firefox asks for host access separately) ----------
const ORIGINS = ["https://www.youtube.com/*", "https://m.youtube.com/*", "http://127.0.0.1/*"];
async function checkPermissions() {
  if (!browser.permissions || !browser.permissions.contains) return;
  try {
    show("perm", !(await browser.permissions.contains({ origins: ORIGINS })));
  } catch (_) { /* not supported: assume granted */ }
}
$("bPerm").onclick = async () => {
  try {
    if (await browser.permissions.request({ origins: ORIGINS })) show("perm", false);
  } catch (_) { /* dismissed */ }
};

// ---------- start ----------
(async () => {
  checkPermissions();
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  try {
    const u = new URL((tab && tab.url) || "");
    const v = u.searchParams.get("v");
    if (/(^|\.)youtube\.com$/.test(u.hostname) && u.pathname === "/watch" && /^[\w-]{11}$/.test(v || "")) tabVid = v;
  } catch (_) { /* no url */ }
  if (!tabVid && tabId != null) {
    const info = await tabMsg({ type: "info" });
    if (info && info.vid) tabVid = info.vid;
  }
  await loadSettings();
  await Promise.all([renderVideo(), renderCache()]);
  setInterval(renderVideo, 1500);
  setInterval(renderCache, 2000);
})();
