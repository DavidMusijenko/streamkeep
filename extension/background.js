// StreamKeep background script (Safari, Chrome, Firefox).
// Relays requests from the content script and popup to the local helper on
// 127.0.0.1. The YouTube page itself can't reach http://127.0.0.1 (browsers
// block mixed content), so the extension does it: with fetch, and in Safari,
// if that is blocked too, through the app's native handler
// (SafariWebExtensionHandler.swift).
globalThis.browser ??= globalThis.chrome;
const HELPER = "http://127.0.0.1:8765";
const ALLOWED =
  /^\/(?:(?:status|index|cancel|delete)\?v=[\w-]{11}|cache\?v=[\w-]{11}&q=\d+&c=[a-z0-9,]+&max=\d+|list|clear|open|ping|log\?m=[\w%.~!*'()-]{1,600}|config(?:\?days=\d+&maxgb=\d+)?|video\/[\w-]{11}\.mp4)$/;
let mode = null; // "fetch" | "native", learned on first success

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

async function viaFetch(path, range) {
  const r = await fetch(HELPER + path, { cache: "no-store", headers: range ? { Range: range } : {} });
  return { status: r.status, body: toBase64(await r.arrayBuffer()) };
}

async function viaNative(path, range) {
  if (!browser.runtime.sendNativeMessage) throw new Error("helper not running");
  const r = await browser.runtime.sendNativeMessage("com.streamkeep.app", { path, range: range || null });
  if (!r || r.error) throw new Error(r ? r.error : "no response from native handler");
  return r;
}

async function helper(path, range) {
  if (mode === "fetch") return viaFetch(path, range);
  if (mode === "native") return viaNative(path, range);
  try {
    const r = await viaFetch(path, range);
    mode = "fetch";
    return r;
  } catch (fetchErr) {
    const r = await viaNative(path, range);
    mode = "native";
    return r;
  }
}

// Is the internet reachable? Used before switching to the saved copy on a stall.
async function probe() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3000);
  try {
    await fetch("https://www.youtube.com/generate_204", { cache: "no-store", mode: "no-cors", signal: ctl.signal });
    return { online: true };
  } catch (_) {
    return { online: false };
  } finally {
    clearTimeout(timer);
  }
}

// Toolbar icon badge: save progress ("42%", "✓", "!"). Safari may ignore the
// per-tab badge, so the active tab's badge is also set globally and swapped
// when you switch tabs. Failures are written to the helper log.
const badges = new Map(); // tabId -> { text, color, title }
let activeTabId = null;

function log(m) {
  helper("/log?m=" + encodeURIComponent(String(m)).slice(0, 600)).catch(() => {});
}

async function tryCall(name, fn) {
  try {
    await fn();
  } catch (e) {
    log(`${name}: ${(e && e.message) || e}`);
  }
}

const ICONS = {
  red: { 16: "icon-16.png", 19: "icon-19.png", 32: "icon-32.png", 38: "icon-38.png" },
  green: { 16: "icon-green-16.png", 19: "icon-green-19.png", 32: "icon-green-32.png", 38: "icon-green-38.png" },
};

async function showBadge(b, tabId) {
  const a = browser.action || browser.browserAction;
  if (!a) return log("badge: no action API");
  const text = (b && b.text) || "";
  const opts = tabId == null ? {} : { tabId };
  await tryCall("setBadgeText", () => a.setBadgeText({ ...opts, text }));
  if (b && b.color && a.setBadgeBackgroundColor) {
    await tryCall("setBadgeBackgroundColor", () => a.setBadgeBackgroundColor({ ...opts, color: b.color }));
  }
  await tryCall("setTitle", () => a.setTitle({ ...opts, title: (b && b.title) || "StreamKeep" }));
  const icon = ICONS[(b && b.icon) || "red"] || ICONS.red;
  await tryCall("setIcon", () => a.setIcon({ ...opts, path: icon }));
}

async function setBadge(tabId, b, isActive) {
  badges.set(tabId, b);
  if (isActive) activeTabId = tabId;
  await showBadge(b, tabId);
  // Safari accepts per-tab badges but doesn't display them: mirror the
  // active tab's badge into the global one.
  if (isActive || tabId === activeTabId) await showBadge(b, null);
}

browser.tabs.onActivated.addListener(({ tabId }) => {
  activeTabId = tabId;
  showBadge(badges.get(tabId), null);
});
// Safari doesn't always fire onActivated (e.g. switching windows): re-check.
browser.windows?.onFocusChanged?.addListener(() => {
  browser.tabs
    .query({ active: true, currentWindow: true })
    .then(([t]) => {
      if (t && t.id !== activeTabId) {
        activeTabId = t.id;
        showBadge(badges.get(t.id), null);
      }
    })
    .catch(() => {});
});
browser.tabs.onRemoved.addListener((tabId) => badges.delete(tabId));
browser.tabs
  .query({ active: true, currentWindow: true })
  .then(([t]) => { if (t) activeTabId = t.id; })
  .catch(() => {});

function handle(msg, sender) {
  if (!msg) return undefined;
  if (msg.type === "badge" && sender.tab) {
    setBadge(sender.tab.id, { text: msg.text, color: msg.color, title: msg.title, icon: msg.icon }, !!sender.tab.active);
    return undefined;
  }
  if (msg.type === "probe") return probe();
  if (msg.type === "log") { log(msg.m); return undefined; }
  if (msg.type !== "get" || !ALLOWED.test(msg.path)) return undefined;
  if (msg.range && !/^bytes=\d+-\d+$/.test(msg.range)) return undefined;
  return helper(msg.path, msg.range).catch((e) => ({ error: String((e && e.message) || e) }));
}

// sendResponse + `return true` works in every browser (Chrome ignores a
// returned Promise).
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const r = handle(msg, sender);
  if (!r) return false;
  r.then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
  return true;
});
