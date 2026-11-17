// StreamKeep content script.
// 1. On every /watch page, asks the local helper to save the video (or only
//    when you click "Save" in the popup, if auto-save is off).
// 2. When the connection really drops (offline event, YouTube's error screen,
//    or a stall that a connectivity check confirms), lays the saved copy over
//    YouTube's player at the same timestamp.
// The saved copy is streamed fragment by fragment into a MediaSource, so it
// plays inside the YouTube page without any mixed-content loads.
// Status is shown on the toolbar icon; controls live in the popup.
globalThis.browser ??= globalThis.chrome;
(() => {
  // If a second copy of this extension is installed (e.g. a stray build), only
  // the first one to load acts on the page; two copies pause each other.
  const me = browser.runtime.getURL("");
  const owner = document.documentElement.getAttribute("data-streamkeep");
  if (owner && owner !== me) return;
  document.documentElement.setAttribute("data-streamkeep", me);

  const STALL_SECS = 4;
  const AHEAD_SECS = 60; // how far ahead of the playhead to keep buffered
  const BEHIND_SECS = 30; // how much already-played video to keep
  const DEFAULTS = { autoSave: true, autoSwitch: true, quality: 1440, codec: "auto", maxMinutes: 0 };

  let settings = { ...DEFAULTS };
  let vid = null;
  let st = { state: "none" };
  let pollTimer = null;
  let overlay = null; // { wrap, ov, mse }
  let stall = 0;
  let probing = false;
  let lastMainTime = 0;
  let cooldownUntil = 0;
  let hold = null; // video the user deleted/cancelled: don't auto-save it again

  const player = () => document.querySelector("#movie_player");
  const ytVideo = () => document.querySelector("#movie_player video.html5-main-video");

  function currentId() {
    if (location.pathname !== "/watch") return null;
    const v = new URLSearchParams(location.search).get("v");
    return v && /^[\w-]{11}$/.test(v) ? v : null;
  }

  // ---------- settings ----------
  browser.storage.local.get(DEFAULTS).then((s) => (settings = { ...DEFAULTS, ...s })).catch(() => {});
  browser.storage.onChanged.addListener((changes) => {
    for (const [k, c] of Object.entries(changes)) if (k in DEFAULTS) settings[k] = c.newValue;
  });

  // codecs this browser can play through MediaSource, best first
  function playableCodecs() {
    const MS = window.MediaSource || window.ManagedMediaSource;
    const ok = (c, kind = "video") => !!MS && MS.isTypeSupported(`${kind}/mp4; codecs="${c}"`);
    // audio: AAC everywhere it plays, else Opus (e.g. Chromium without AAC)
    const audio = ok("mp4a.40.2", "audio") || !ok("opus", "audio") ? "mp4a" : "opus";
    if (settings.codec === "h264") return ["avc1", audio];
    const list = [];
    if (ok("av01.0.08M.08")) list.push("av01");
    if (ok("vp09.00.40.08")) list.push("vp09");
    list.push("avc1", audio);
    return list;
  }

  // ---------- helper transport (via background.js) ----------
  function b64ToBytes(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  async function helperGet(path, range) {
    const r = await browser.runtime.sendMessage({ type: "get", path, range });
    if (!r || r.error) throw new Error(r ? r.error : "extension did not answer");
    return r;
  }

  async function helperJson(path) {
    const r = await helperGet(path);
    return JSON.parse(new TextDecoder().decode(b64ToBytes(r.body)));
  }

  async function ask(path, id) {
    try {
      return await helperJson(path);
    } catch (e) {
      return { id, state: "nohelper", error: String((e && e.message) || e) };
    }
  }

  const cachePath = (id) =>
    `/cache?v=${id}&q=${settings.quality || 0}&c=${playableCodecs().join(",")}&max=${settings.maxMinutes || 0}`;

  function el(tag, css, text) {
    const n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text) n.textContent = text;
    return n;
  }

  // ---------- MediaSource player for the saved copy ----------
  class MsePlayer {
    constructor(video, id, startTime, autoplay, onError) {
      Object.assign(this, { video, id, startTime, autoplay, onError });
      this.alive = true;
      this.next = 0;
      this.wake = null;
    }

    async start() {
      const idx = await helperJson(`/index?v=${this.id}`);
      if (idx.error) throw new Error(idx.error);
      const MS = window.MediaSource || window.ManagedMediaSource;
      if (!MS || !MS.isTypeSupported(idx.mime)) throw new Error(`This browser can't play ${idx.mime}`);
      this.idx = idx;
      this.ms = new MS();
      if (MS !== window.MediaSource) this.video.disableRemotePlayback = true;
      this.url = URL.createObjectURL(this.ms);
      this.video.src = this.url;
      await new Promise((res) => this.ms.addEventListener("sourceopen", res, { once: true }));
      if (!this.alive) return;
      this.ms.duration = idx.duration;
      this.sb = this.ms.addSourceBuffer(idx.mime);
      await this.append(await this.bytes(idx.init[0], idx.init[1]));
      this.next = this.fragAt(this.startTime);
      this.video.addEventListener("seeking", () => this.onSeek());
      this.video.currentTime = this.startTime;
      this.pump();
      if (this.autoplay) this.video.play().catch(() => {});
    }

    destroy() {
      this.alive = false;
      if (this.wake) this.wake();
      if (this.url) URL.revokeObjectURL(this.url);
    }

    fragAt(t) {
      const f = this.idx.frags;
      let lo = 0, hi = f.length - 1, ans = 0;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (f[m][0] <= t + 0.01) { ans = m; lo = m + 1; } else hi = m - 1;
      }
      return ans;
    }

    async bytes(s, e) {
      const r = await helperGet(`/video/${this.id}.mp4`, `bytes=${s}-${e - 1}`);
      return b64ToBytes(r.body);
    }

    sbOp(fn) {
      return new Promise((resolve, reject) => {
        const sb = this.sb;
        const done = () => { off(); resolve(); };
        const fail = () => { off(); reject(new Error("SourceBuffer error")); };
        const off = () => { sb.removeEventListener("updateend", done); sb.removeEventListener("error", fail); };
        sb.addEventListener("updateend", done);
        sb.addEventListener("error", fail);
        try { fn(sb); } catch (e) { off(); reject(e); }
      });
    }

    append(buf) { return this.sbOp((sb) => sb.appendBuffer(buf)); }
    remove(s, e) { return e - s > 0.5 ? this.sbOp((sb) => sb.remove(s, e)) : Promise.resolve(); }

    bufferedAhead() {
      const t = this.video.currentTime, b = this.sb.buffered;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && t < b.end(i)) return b.end(i) - t;
      return 0;
    }

    onSeek() {
      if (this.bufferedAhead() <= 0) {
        this.next = this.fragAt(this.video.currentTime);
        if (this.wake) this.wake();
      }
    }

    async pump() {
      const f = this.idx.frags;
      while (this.alive) {
        try {
          const t = this.video.currentTime;
          const b = this.sb.buffered;
          if (b.length && b.start(0) < t - BEHIND_SECS * 2) await this.remove(0, t - BEHIND_SECS);
          if (this.next < f.length && this.bufferedAhead() < AHEAD_SECS) {
            const n = this.next;
            const data = await this.bytes(f[n][1], f[n][2]);
            if (!this.alive) return;
            try {
              await this.append(data);
            } catch (e) {
              if (e && e.name === "QuotaExceededError") {
                const now = this.video.currentTime;
                await this.remove(0, Math.max(0, now - 5));
                await this.remove(now + AHEAD_SECS, this.idx.duration);
                continue;
              }
              throw e;
            }
            if (this.next === n) this.next = n + 1; // unless a seek moved it meanwhile
          } else {
            if (this.next >= f.length && this.ms.readyState === "open" && !this.sb.updating) {
              try { this.ms.endOfStream(); } catch (_) { /* ignore */ }
            }
            await new Promise((r) => { this.wake = r; setTimeout(r, 500); });
            this.wake = null;
          }
        } catch (e) {
          if (this.alive) this.onError(e);
          return;
        }
      }
    }
  }

  // ---------- toolbar icon ----------
  let lastIcon = "";
  function renderIcon() {
    const pct = Math.round(st.progress || 0);
    // saved video = green icon, no badge; downloading = red icon + percentage
    const [text, color, title, icon] = !vid
      ? ["", null, "StreamKeep: open a video"]
      : overlay
        ? ["", null, "StreamKeep: playing the saved copy", "green"]
        : {
            none: ["", null, settings.autoSave ? "StreamKeep: starting" : "StreamKeep: not saved (open to save)"],
            queued: ["…", "#555", "StreamKeep: queued"],
            downloading: [`${pct}%`, "#1565c0", `StreamKeep: saving ${pct}%`],
            done: ["", null, "StreamKeep: saved for offline", "green"],
            error: ["!", "#c62828", `StreamKeep: couldn't save. ${st.error || ""}`],
            skipped: ["–", "#555", `StreamKeep: not saved (${st.error || "skipped"})`],
            nohelper: ["!", "#c62828", "StreamKeep: helper not running"],
          }[st.state] || ["", null, "StreamKeep"];
    renderPlayerButton();
    const key = text + color + title + icon;
    if (key === lastIcon) return;
    lastIcon = key;
    browser.runtime.sendMessage({ type: "badge", text, color, title, icon: icon || "red" }).catch(() => {});
  }

  // ---------- button in YouTube's control bar ----------
  // Shown only when this video is saved; hides with YouTube's own controls.
  let pbtn = null;
  function renderPlayerButton() {
    if (!pbtn) {
      pbtn = document.createElement("button");
      pbtn.className = "ytp-button";
      pbtn.title = "Play saved offline copy";
      pbtn.setAttribute("aria-label", "Play saved offline copy");
      pbtn.style.cssText = "display:inline-flex;align-items:center;justify-content:center;";
      const NS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("viewBox", "0 0 36 36");
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      const path = document.createElementNS(NS, "path");
      // play triangle over a tray = "play the copy saved on this Mac"
      path.setAttribute("d", "M14 9.5v13l10.5-6.5zM10 25.5h16V28H10z");
      path.setAttribute("fill", "#fff");
      svg.append(path);
      pbtn.append(svg);
      pbtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const v = ytVideo();
        switchToOffline(v ? !v.paused : true);
      });
    }
    const rc =
      document.querySelector("#movie_player .ytp-right-controls-left") ||
      document.querySelector("#movie_player .ytp-right-controls");
    if (!rc) return;
    if (pbtn.parentNode !== rc) rc.insertBefore(pbtn, rc.firstChild);
    pbtn.style.display = vid && st.state === "done" && !overlay ? "inline-flex" : "none";
  }

  // ---------- saving ----------
  function update(s) {
    if (!s || (s.id && s.id !== vid)) return;
    st = s;
    renderIcon();
    clearTimeout(pollTimer);
    if (s.state === "queued" || s.state === "downloading") {
      pollTimer = setTimeout(() => ask(`/status?v=${vid}`, vid).then(update), 2000);
    } else if (s.state === "nohelper") {
      pollTimer = setTimeout(() => refresh(), 10000);
    } else if (s.state === "none" && settings.autoSave && hold !== vid) {
      // e.g. the helper restarted mid-download (yt-dlp resumes the partial file)
      pollTimer = setTimeout(() => refresh(), 3000);
    }
  }

  function refresh() {
    if (!vid) return Promise.resolve();
    const save = settings.autoSave && hold !== vid;
    return ask(save ? cachePath(vid) : `/status?v=${vid}`, vid).then(update);
  }

  function onVideoChange(id) {
    if (overlay) teardown();
    vid = id;
    st = { state: "none" };
    stall = 0;
    lastMainTime = 0;
    clearTimeout(pollTimer);
    renderIcon();
    if (id) refresh();
  }

  // ---------- offline overlay ----------
  const swallow = (e) => e.stopPropagation();

  function onKey(e) {
    if (!overlay) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const ov = overlay.ov;
    let handled = true;
    switch (e.key) {
      case " ":
      case "k":
        ov.paused ? ov.play() : ov.pause();
        break;
      case "j": ov.currentTime -= 10; break;
      case "l": ov.currentTime += 10; break;
      case "ArrowLeft": ov.currentTime -= 5; break;
      case "ArrowRight": ov.currentTime += 5; break;
      case "m": ov.muted = !ov.muted; break;
      case "f":
        toggleFullscreen();
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  function toggleFullscreen() {
    if (!overlay) return;
    const d = document;
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    } else {
      const w = overlay.wrap;
      (w.requestFullscreen || w.webkitRequestFullscreen).call(w);
    }
  }

  // YouTube may try to resume its own player (e.g. when the network returns).
  function onAnyPlay(e) {
    if (overlay && e.target !== overlay.ov && e.target.tagName === "VIDEO") e.target.pause();
  }

  function switchToOffline(autoplay) {
    const p = player();
    if (!p || overlay || !vid || st.state !== "done") return;
    const v = ytVideo();
    const t = lastMainTime || (v ? v.currentTime : 0);
    if (v) v.pause();

    const wrap = el(
      "div",
      "position:absolute;inset:0;z-index:2000;background:#000;color:#fff;user-select:none;" +
        "font:500 13px -apple-system,system-ui,sans-serif;"
    );
    const ov = el("video", "width:100%;height:100%;object-fit:contain;display:block;");
    ov.controls = false; // own control bar below (Safari's has a broken captions button and no fullscreen here)
    ov.playsInline = true;
    // Calling play() now, inside the click, lets Safari start it later once
    // data has arrived (otherwise autoplay with sound is blocked).
    if (autoplay) ov.play().catch(() => {});
    if (v) {
      ov.volume = v.volume;
      ov.muted = v.muted;
      ov.addEventListener("loadedmetadata", () => (ov.playbackRate = v.playbackRate || 1), { once: true });
    }

    // ----- YouTube-style control bar -----
    const NS = "http://www.w3.org/2000/svg";
    const P = {
      play: "M12 26V10l14 8z",
      pause: "M11 10h5v16h-5zM20 10h5v16h-5z",
      vol: "M8 15h4.5l5.5-5v16l-5.5-5H8zM21 12.3a7 7 0 0 1 0 11.4v-2.6a4.5 4.5 0 0 0 0-6.2z",
      mute: "M8 15h4.5l5.5-5v16l-5.5-5H8zM21.3 14.7l1.8-1.8 2.2 2.2 2.2-2.2 1.8 1.8-2.2 2.2 2.2 2.2-1.8 1.8-2.2-2.2-2.2 2.2-1.8-1.8 2.2-2.2z",
      fs: "M9 9h6v2.5h-3.5V15H9zM27 9v6h-2.5v-3.5H21V9zM9 27v-6h2.5v3.5H15V27zM27 27h-6v-2.5h3.5V21H27z",
      fsExit: "M15 15H9v-2.5h3.5V9H15zM21 15V9h2.5v3.5H27V15zM15 21v6h-2.5v-3.5H9V21zM21 21h6v2.5h-3.5V27H21z",
    };
    const iconBtn = (d, label) => {
      const b = el(
        "button",
        "width:40px;height:40px;padding:2px;border:0;background:none;cursor:pointer;" +
          "display:inline-flex;align-items:center;justify-content:center;opacity:.92;"
      );
      b.title = label;
      b.setAttribute("aria-label", label);
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("viewBox", "0 0 36 36");
      svg.setAttribute("width", "36");
      svg.setAttribute("height", "36");
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "#fff");
      svg.append(path);
      b.append(svg);
      b.setIcon = (d2) => path.setAttribute("d", d2);
      return b;
    };
    const fmt = (sec) => {
      sec = Math.max(0, Math.floor(sec || 0));
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = String(sec % 60).padStart(2, "0");
      return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`;
    };

    const bar = el(
      "div",
      "position:absolute;left:0;right:0;bottom:0;padding:24px 12px 2px;" +
        "background:linear-gradient(transparent,rgba(0,0,0,.75));transition:opacity .25s;"
    );
    // seek bar: grey = buffered, red = played
    const seek = el("div", "position:relative;height:16px;cursor:pointer;display:flex;align-items:center;");
    const track = el("div", "position:relative;width:100%;height:3px;background:rgba(255,255,255,.2);transition:height .1s;");
    const bufd = el("div", "position:absolute;left:0;top:0;bottom:0;width:0;background:rgba(255,255,255,.4);");
    const played = el("div", "position:absolute;left:0;top:0;bottom:0;width:0;background:#f00;");
    const knob = el(
      "div",
      "position:absolute;left:0;top:50%;width:13px;height:13px;margin:-6.5px 0 0 -6.5px;border-radius:50%;" +
        "background:#f00;transform:scale(0);transition:transform .1s;"
    );
    track.append(bufd, played, knob);
    seek.append(track);
    let dragging = false;
    const grow = (on) => {
      track.style.height = on ? "5px" : "3px";
      knob.style.transform = on ? "scale(1)" : "scale(0)";
    };
    const seekTo = (e) => {
      const r = track.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      if (ov.duration) {
        ov.currentTime = f * ov.duration;
        update();
      }
    };
    seek.addEventListener("mouseenter", () => grow(true));
    seek.addEventListener("mouseleave", () => { if (!dragging) grow(false); });
    seek.addEventListener("pointerdown", (e) => { dragging = true; seek.setPointerCapture(e.pointerId); seekTo(e); });
    seek.addEventListener("pointermove", (e) => { if (dragging) seekTo(e); });
    seek.addEventListener("pointerup", (e) => { dragging = false; seek.releasePointerCapture(e.pointerId); grow(false); });

    const row = el("div", "display:flex;align-items:center;height:42px;gap:2px;");
    const playB = iconBtn(P.play, "Play (k)");
    playB.addEventListener("click", () => (ov.paused ? ov.play().catch(() => {}) : ov.pause()));
    const volB = iconBtn(P.vol, "Mute (m)");
    volB.addEventListener("click", () => (ov.muted = !ov.muted));
    const vol = el("input", "width:64px;accent-color:#fff;cursor:pointer;");
    vol.type = "range";
    vol.min = "0";
    vol.max = "1";
    vol.step = "0.05";
    vol.addEventListener("input", () => {
      ov.volume = Number(vol.value);
      ov.muted = ov.volume === 0;
    });
    const time = el("span", "margin-left:10px;opacity:.92;font-variant-numeric:tabular-nums;");
    const back = el(
      "button",
      "height:28px;padding:0 12px;margin-right:4px;border:0;border-radius:14px;cursor:pointer;" +
        "background:rgba(255,255,255,.16);color:#fff;font:500 12px -apple-system,system-ui,sans-serif;",
      "Back to YouTube"
    );
    back.title = "Return to YouTube's player at this point";
    back.addEventListener("click", switchBack);
    const fsB = iconBtn(P.fs, "Fullscreen (f)");
    fsB.addEventListener("click", toggleFullscreen);
    row.append(playB, volB, vol, time, el("div", "flex:1;"), back, fsB);
    bar.append(seek, row);

    const msg = el(
      "div",
      "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:80%;padding:8px 14px;" +
        "border-radius:8px;background:rgba(0,0,0,.75);display:none;text-align:center;"
    );

    function update() {
      const d = ov.duration || 0, t = ov.currentTime || 0;
      const pct = d ? (t / d) * 100 : 0;
      played.style.width = pct + "%";
      knob.style.left = pct + "%";
      let end = t;
      for (let i = 0; i < ov.buffered.length; i++) {
        if (ov.buffered.start(i) <= t + 0.5 && t < ov.buffered.end(i)) end = ov.buffered.end(i);
      }
      bufd.style.width = (d ? (end / d) * 100 : 0) + "%";
      time.textContent = `${fmt(t)} / ${fmt(d)}`;
      playB.setIcon(ov.paused ? P.play : P.pause);
      playB.title = ov.paused ? "Play (k)" : "Pause (k)";
      volB.setIcon(ov.muted || ov.volume === 0 ? P.mute : P.vol);
      vol.value = String(ov.muted ? 0 : ov.volume);
    }
    for (const ev of ["timeupdate", "progress", "play", "pause", "volumechange", "durationchange", "seeking", "loadedmetadata"]) {
      ov.addEventListener(ev, update);
    }

    // click = play/pause, double-click = fullscreen (like YouTube)
    let clickTimer = null;
    ov.addEventListener("click", () => {
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => (ov.paused ? ov.play().catch(() => {}) : ov.pause()), 220);
    });
    ov.addEventListener("dblclick", (e) => {
      e.preventDefault();
      clearTimeout(clickTimer);
      toggleFullscreen();
    });
    const onFs = () => {
      const full = !!(document.fullscreenElement || document.webkitFullscreenElement);
      fsB.setIcon(full ? P.fsExit : P.fs);
      fsB.title = full ? "Exit fullscreen (f)" : "Fullscreen (f)";
    };
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs);

    // controls hide after 2.5 s of no mouse movement while playing
    let hideTimer = null;
    const showChrome = () => {
      bar.style.opacity = "1";
      wrap.style.cursor = "";
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (ov.paused || dragging) return;
        bar.style.opacity = "0";
        wrap.style.cursor = "none";
      }, 2500);
    };
    wrap.addEventListener("mousemove", showChrome);
    ov.addEventListener("pause", showChrome);
    ov.addEventListener("play", showChrome);
    showChrome();
    update();

    // keep YouTube's player from reacting to clicks aimed at our overlay
    for (const ev of ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "pointerup", "wheel", "contextmenu"]) {
      wrap.addEventListener(ev, swallow);
    }
    wrap.append(ov, msg, bar);
    p.appendChild(wrap);
    const cleanup = () => {
      clearTimeout(hideTimer);
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("webkitfullscreenchange", onFs);
    };

    const onError = (e) => {
      st = { ...st, error: `Offline copy failed: ${(e && e.message) || e}` };
      msg.textContent = "Couldn't play the saved copy: " + ((e && e.message) || e);
      msg.style.display = "block";
      renderIcon();
    };
    const mse = new MsePlayer(ov, vid, t, autoplay, onError);
    overlay = { wrap, ov, mse, cleanup };
    document.addEventListener("keydown", onKey, true);
    renderIcon();
    mse.start().catch(onError);
  }

  function teardown() {
    if (!overlay) return null;
    const { wrap, ov, mse, cleanup } = overlay;
    const state = { t: ov.currentTime, playing: !ov.paused };
    overlay = null;
    cleanup();
    if (document.fullscreenElement === wrap || document.webkitFullscreenElement === wrap) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    }
    mse.destroy();
    ov.pause();
    ov.removeAttribute("src");
    ov.load();
    wrap.remove();
    document.removeEventListener("keydown", onKey, true);
    renderIcon();
    return state;
  }

  function switchBack() {
    const s = teardown();
    if (!s) return;
    cooldownUntil = Date.now() + 15000;
    if (s.t > 0) lastMainTime = s.t;
    const v = ytVideo();
    if (v) {
      if (s.t > 0) v.currentTime = s.t;
      if (s.playing) v.play().catch(() => {});
    }
  }

  function toggle() {
    if (overlay) switchBack();
    else {
      const v = ytVideo();
      switchToOffline(v ? !v.paused : true);
    }
  }

  // ---------- watchdog ----------
  async function isOffline() {
    try {
      const r = await browser.runtime.sendMessage({ type: "probe" });
      return !(r && r.online);
    } catch (_) {
      return false;
    }
  }

  async function tick() {
    const id = currentId();
    if (id !== vid) onVideoChange(id);
    if (pbtn && !pbtn.isConnected) renderPlayerButton(); // YouTube rebuilt its controls
    if (!vid || overlay) return;

    const v = ytVideo();
    const p = player();
    if (!v || !p) return;
    const inAd = p.classList.contains("ad-showing");
    if (!inAd && v.currentTime > 0) lastMainTime = v.currentTime;

    if (!settings.autoSwitch || st.state !== "done" || Date.now() < cooldownUntil || probing) {
      stall = 0;
      return;
    }
    const err = p.querySelector(".ytp-error");
    const errorShown = !!(err && err.offsetParent !== null);
    const stalled = !v.paused && !v.ended && v.readyState < 3;
    stall = stalled ? stall + 1 : 0;

    if (!navigator.onLine || errorShown) {
      switchToOffline(true);
    } else if (stall >= STALL_SECS) {
      // YouTube also stalls on a slow connection or a quality switch:
      // only take over if the internet is really unreachable.
      probing = true;
      const offline = await isOffline();
      probing = false;
      if (offline && !overlay && vid === id) switchToOffline(true);
      else stall = -6; // check again in ~10 s if it is still stuck
    }
  }

  // ---------- popup commands ----------
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const r = onPopupMessage(msg);
    if (!r) return false;
    r.then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
    return true;
  });
  function onPopupMessage(msg) {
    if (!msg) return undefined;
    switch (msg.type) {
      case "info":
        return Promise.resolve({ vid, st, overlay: !!overlay, title: document.title.replace(/ - YouTube$/, "") });
      case "toggle":
        toggle();
        return Promise.resolve({ ok: true });
      case "save":
        if (!vid) return undefined;
        hold = null;
        return ask(cachePath(vid), vid).then((s) => { update(s); return s; });
      case "cancel":
      case "delete":
        if (!vid) return undefined;
        hold = vid;
        if (overlay) teardown();
        return ask(`/${msg.type}?v=${vid}`, vid).then((s) => { update(s); return s; });
      case "resave":
        if (!vid) return undefined;
        hold = null;
        if (overlay) teardown();
        return ask(`/delete?v=${vid}`, vid)
          .then(() => ask(cachePath(vid), vid))
          .then((s) => { update(s); return s; });
      case "refresh": // popup changed something via the helper directly
        if (msg.hold && msg.hold === vid) hold = vid;
        if (msg.save && msg.save === vid) hold = null;
        if (overlay && msg.hold === vid) teardown();
        refresh();
        return Promise.resolve({ ok: true });
      default:
        return undefined;
    }
  }

  // re-send the toolbar badge when this tab comes to the front
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      lastIcon = "";
      renderIcon();
    }
  });
  document.addEventListener("play", onAnyPlay, true);
  window.addEventListener("offline", tick);
  document.addEventListener("yt-navigate-finish", tick);
  setInterval(tick, 1000);
  tick();
})();
