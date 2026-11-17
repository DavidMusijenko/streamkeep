#!/usr/bin/env python3
"""StreamKeep helper.

Downloads YouTube videos with yt-dlp into a local cache and serves them on
127.0.0.1 so the browser extension (Safari, Chrome, Firefox) can play them on the YouTube page when the
internet drops.

Endpoints (all GET, JSON unless noted):
  /ping                          -> {"ok": true}
  /cache?v=<id>&q=<h>&c=<codecs>&max=<min>
                                 -> start caching <id> (q: max height, 0 = best;
                                    c: comma list of codecs the browser can play, e.g.
                                    av01,vp09,avc1,mp4a (audio: mp4a or opus); max: skip videos longer than N minutes)
  /status?v=<id>                 -> {"state": none|queued|downloading|done|error|skipped,
                                     "progress", "title", "size", "height", "vcodec"}
  /cancel?v=<id>                 -> stop a running download
  /delete?v=<id>                 -> delete a cached video
  /list                          -> {"videos": [...], "total", "free"}
  /clear                         -> delete everything in the cache
  /config[?days=<n>&maxgb=<n>]   -> read/update retention settings
  /open                          -> reveal the cache folder in Finder
  /log?m=<text>                  -> write an extension diagnostic line to helper.log
  /index?v=<id>                  -> {"mime", "duration", "init", "frags": [[t, start, end], ...]}
  /video/<id>.mp4                -> the cached file, fragmented MP4 (supports Range requests)

Files are stored as fragmented MP4 so the extension can feed them into a
MediaSource on the YouTube page (browsers block http://127.0.0.1 media on https pages).
"""
import glob
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(os.environ.get("STREAMKEEP_PORT", "8765"))
CACHE = os.path.expanduser(os.environ.get(
    "STREAMKEEP_CACHE", "~/Movies/StreamKeep" if sys.platform == "darwin" else "~/Videos/StreamKeep"))
MAX_PARALLEL = int(os.environ.get("STREAMKEEP_MAX_PARALLEL", "2"))
DL_DIR = os.path.join(CACHE, ".dl")
CONFIG_PATH = os.path.join(CACHE, ".config.json")
DEFAULT_CONFIG = {"days": 7, "maxgb": 30}

os.environ["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + os.environ.get("PATH", "/usr/bin:/bin")
YTDLP = shutil.which("yt-dlp") or "/opt/homebrew/bin/yt-dlp"
FFMPEG = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
FFPROBE = shutil.which("ffprobe") or "/opt/homebrew/bin/ffprobe"

ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
PCT_RE = re.compile(r"\[download\]\s+([\d.]+)%")
NFMT_RE = re.compile(r"Downloading (\d+) format\(s\)")
CODEC_RE = {"av01": "av01", "vp09": "vp0?9", "avc1": "avc1"}

jobs = {}   # id -> {"state", "progress", "error"}
procs = {}  # id -> running yt-dlp Popen
lock = threading.Lock()
slots = threading.Semaphore(MAX_PARALLEL)
wake_cleanup = threading.Event()


def final_path(vid):
    return os.path.join(CACHE, vid + ".mp4")


def index_path(vid):
    return os.path.join(CACHE, vid + ".json")


def title_path(vid):
    return os.path.join(CACHE, vid + ".title")


# ---------- config ----------
def load_config():
    try:
        with open(CONFIG_PATH) as f:
            return {**DEFAULT_CONFIG, **json.load(f)}
    except (OSError, ValueError):
        return dict(DEFAULT_CONFIG)


def save_config(cfg):
    with open(CONFIG_PATH + ".tmp", "w") as f:
        json.dump(cfg, f)
    os.replace(CONFIG_PATH + ".tmp", CONFIG_PATH)


# ---------- fragmented MP4 index ----------
def _boxes(buf, start, end):
    """Yield (type, payload_start, box_end) for boxes in buf[start:end]."""
    pos = start
    while pos + 8 <= end:
        size, typ = struct.unpack(">I4s", buf[pos:pos + 8])
        hl = 8
        if size == 1:
            size = struct.unpack(">Q", buf[pos + 8:pos + 16])[0]
            hl = 16
        elif size == 0:
            size = end - pos
        if size < hl:
            break
        yield typ, pos + hl, pos + size
        pos += size


def _child(buf, start, end, typ):
    for t, s, e in _boxes(buf, start, end):
        if t == typ:
            return s, e
    return None


def _video_codec(trak):
    """RFC 6381 codec string for the video sample entry in a trak box."""
    i = trak.find(b"avcC")
    if i >= 0:
        return "avc1.%02x%02x%02x" % tuple(trak[i + 5:i + 8])
    i = trak.find(b"vpcC")
    if i >= 0:  # version(1) flags(3) profile level bitDepth<<4|...
        return "vp09.%02d.%02d.%02d" % (trak[i + 8], trak[i + 9], trak[i + 10] >> 4)
    i = trak.find(b"av1C")
    if i >= 0:  # marker/version, profile<<5|level, tier<<7|high_bitdepth<<6|twelve_bit<<5
        b1, b2 = trak[i + 5], trak[i + 6]
        depth = 12 if b2 & 0x20 else 10 if b2 & 0x40 else 8
        return "av01.%d.%02d%s.%02d" % (b1 >> 5, b1 & 0x1F, "H" if b2 & 0x80 else "M", depth)
    if b"hvc1" in trak or b"hev1" in trak:
        return "hvc1"
    return "avc1.640028"


def _probe(path):
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=height,codec_name:format=duration", "-of", "json", path],
        capture_output=True, text=True,
    ).stdout
    try:
        d = json.loads(out)
        s = (d.get("streams") or [{}])[0]
        return {"height": s.get("height"), "vcodec": s.get("codec_name"),
                "duration": float(d.get("format", {}).get("duration") or 0)}
    except ValueError:
        return {"height": None, "vcodec": None, "duration": 0}


def build_index(path):
    total = os.path.getsize(path)
    tracks = {}  # track_id -> {"ts": timescale, "kind": b"vide"/b"soun"}
    codecs = []
    init_end, frags, video_tid = None, [], None
    with open(path, "rb") as f:
        pos = 0
        while pos < total:
            f.seek(pos)
            hdr = f.read(16)
            if len(hdr) < 8:
                break
            size, typ = struct.unpack(">I4s", hdr[:8])
            if size == 1:
                size = struct.unpack(">Q", hdr[8:16])[0]
            elif size == 0:
                size = total - pos
            if typ == b"moov":
                f.seek(pos)
                moov = f.read(size)
                for t, s, e in _boxes(moov, 8, len(moov)):
                    if t != b"trak":
                        continue
                    tkhd = _child(moov, s, e, b"tkhd")
                    v = moov[tkhd[0]]
                    tid = struct.unpack(">I", moov[tkhd[0] + (20 if v == 1 else 12):][:4])[0]
                    mdia = _child(moov, s, e, b"mdia")
                    mdhd = _child(moov, *mdia, b"mdhd")
                    v = moov[mdhd[0]]
                    ts = struct.unpack(">I", moov[mdhd[0] + (20 if v == 1 else 12):][:4])[0]
                    hdlr = _child(moov, *mdia, b"hdlr")
                    kind = moov[hdlr[0] + 8:hdlr[0] + 12]
                    tracks[tid] = {"ts": ts, "kind": kind}
                    if kind == b"vide":
                        video_tid = tid
                        codecs.insert(0, _video_codec(moov[s:e]))
                    elif kind == b"soun":
                        codecs.append("opus" if b"dOps" in moov[s:e] else "mp4a.40.2")
                init_end = pos + size
            elif typ == b"moof":
                f.seek(pos)
                moof = f.read(size)
                secs = {}
                for t, s, e in _boxes(moof, 8, len(moof)):
                    if t != b"traf":
                        continue
                    tfhd = _child(moof, s, e, b"tfhd")
                    tid = struct.unpack(">I", moof[tfhd[0] + 4:tfhd[0] + 8])[0]
                    tfdt = _child(moof, s, e, b"tfdt")
                    if not tfdt or tid not in tracks:
                        continue
                    v = moof[tfdt[0]]
                    bmdt = struct.unpack(">Q" if v == 1 else ">I", moof[tfdt[0] + 4:tfdt[0] + (12 if v == 1 else 8)])[0]
                    secs[tid] = bmdt / tracks[tid]["ts"]
                t_sec = secs.get(video_tid, min(secs.values()) if secs else 0.0)
                frags.append([round(t_sec, 3), pos, pos + size])
            elif typ == b"mdat" and frags:
                frags[-1][2] = pos + size
            pos += size
    if init_end is None or not frags:
        raise ValueError("not a fragmented mp4")
    info = _probe(path)
    return {
        "mime": 'video/mp4; codecs="%s"' % ", ".join(codecs),
        "duration": info["duration"] or frags[-1][0],
        "height": info["height"],
        "vcodec": info["vcodec"],
        "init": [0, init_end],
        "frags": frags,
    }


def get_index(vid):
    ip = index_path(vid)
    if os.path.exists(ip):
        with open(ip) as f:
            idx = json.load(f)
        if "height" in idx:
            return idx
    idx = build_index(final_path(vid))
    with open(ip + ".tmp", "w") as f:
        json.dump(idx, f)
    os.replace(ip + ".tmp", ip)
    return idx


# ---------- cache state ----------
def read_title(vid):
    try:
        with open(title_path(vid)) as f:
            return f.read().strip().splitlines()[-1]
    except (OSError, IndexError):
        return ""


def meta(vid):
    p = final_path(vid)
    m = {"id": vid, "size": os.path.getsize(p), "mtime": os.path.getmtime(p)}
    m["title"] = read_title(vid)
    try:
        idx = get_index(vid)
        m["height"], m["vcodec"], m["duration"] = idx.get("height"), idx.get("vcodec"), idx.get("duration")
    except Exception:  # noqa: BLE001
        pass
    return m


def status(vid):
    with lock:
        job = dict(jobs.get(vid, {}))
    if job.get("state") in ("queued", "downloading", "error", "skipped"):
        return {"id": vid, **job, "title": read_title(vid)}
    if os.path.exists(final_path(vid)):
        return {**meta(vid), "state": "done", "progress": 100}
    return {"id": vid, "state": "none", "progress": 0}


def set_job(vid, **kw):
    with lock:
        jobs.setdefault(vid, {"state": "queued", "progress": 0}).update(kw)


def format_spec(q, codecs):
    """yt-dlp -f for the best stream the browser can play. codecs holds video
    codecs (av01, vp09, avc1) plus one audio codec: mp4a (AAC) or opus, for
    browsers without AAC such as plain Chromium."""
    allowed = "|".join(CODEC_RE[c] for c in codecs if c in CODEC_RE) or "avc1"
    h = f"[height<={q}]" if q else ""
    v = f"bv*[vcodec~='^({allowed})']{h}"
    if "opus" in codecs and "mp4a" not in codecs:
        a = "ba[acodec=opus]"
        tail = ""
    else:
        a = "ba[ext=m4a]"
        tail = f"/b[ext=mp4]{h}/b[ext=mp4]"
    return (
        f"{v}[dynamic_range=SDR]+{a}"  # prefer SDR: HDR looks washed out on many screens
        f"/{v}+{a}"
        f"/bv*[vcodec^=avc1]{h}+{a}"
        f"{tail}"
    )


def run_download(vid, q, codecs, max_min):
    with slots:
        with lock:
            if jobs.get(vid, {}).get("state") != "queued":
                return  # cancelled while queued
        set_job(vid, state="downloading", progress=0)
        filt = "!is_live & !is_upcoming"
        if max_min:
            filt += f" & duration <? {int(max_min) * 60}"
        cmd = [
            YTDLP, "--newline", "--no-playlist", "--progress",
            "--match-filter", filt,
            "-f", format_spec(q, codecs),
            "-S", f"res:{q}" if q else "res",
            "--merge-output-format", "mp4",
            "--print-to-file", "%(title)s", os.path.join(CACHE, "%(id)s.title"),
            "-o", os.path.join(DL_DIR, "%(id)s.%(ext)s"),
            f"https://www.youtube.com/watch?v={vid}",
        ]
        raw = os.path.join(DL_DIR, vid + ".mp4")
        nfmt, part, last_pct, best, last_lines = 1, 0, 0.0, 0.0, []
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            with lock:
                procs[vid] = proc
            for line in proc.stdout:
                last_lines = (last_lines + [line.strip()])[-5:]
                m = NFMT_RE.search(line)
                if m:
                    nfmt = int(m.group(1))
                m = PCT_RE.search(line)
                if m:
                    pct = float(m.group(1))
                    if pct + 50 < last_pct:  # percentage reset: next format started
                        part += 1
                    last_pct = pct
                    # first format is the video (~90% of bytes), second the audio
                    prog = (pct * 0.9 if part == 0 else 90 + pct * 0.1) if nfmt > 1 else pct
                    best = max(best, min(prog, 99.5))
                    set_job(vid, progress=round(best, 1))
            proc.wait()
        except Exception as e:  # noqa: BLE001
            set_job(vid, state="error", error=str(e))
            return
        finally:
            with lock:
                procs.pop(vid, None)
        with lock:
            cancelled = jobs.get(vid, {}).get("state") == "cancelled"
        if cancelled:
            for p in glob.glob(os.path.join(DL_DIR, vid + ".*")):
                os.remove(p)
            with lock:
                jobs.pop(vid, None)
            return
        if proc.returncode == 0 and os.path.exists(raw):
            # remux to fragmented MP4 (one fragment per keyframe) for MediaSource playback
            tmp = final_path(vid) + ".part"
            r = subprocess.run(
                [FFMPEG, "-y", "-v", "error", "-i", raw, "-c", "copy",
                 "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", tmp],
                capture_output=True, text=True,
            )
            try:
                if r.returncode != 0:
                    raise RuntimeError(r.stderr.strip()[-300:])
                os.replace(tmp, final_path(vid))
                os.remove(raw)
                get_index(vid)
            except Exception as e:  # noqa: BLE001
                set_job(vid, state="error", error=f"remux failed: {e}")
                return
            with lock:
                jobs.pop(vid, None)
            wake_cleanup.set()  # enforce the size limit
        elif proc.returncode == 0:
            text = " ".join(last_lines)
            reason = "longer than your limit" if "duration" in text else "live stream"
            set_job(vid, state="skipped", error=reason)
        else:
            set_job(vid, state="error", error=" | ".join(last_lines))


def start_cache(vid, q, codecs, max_min):
    st = status(vid)
    if st["state"] in ("none", "error", "skipped"):
        set_job(vid, state="queued", progress=0, error="")
        threading.Thread(target=run_download, args=(vid, q, codecs, max_min), daemon=True).start()
        return status(vid)
    return st


def cancel(vid):
    with lock:
        if vid in jobs and jobs[vid].get("state") in ("queued", "downloading"):
            jobs[vid]["state"] = "cancelled"
        proc = procs.get(vid)
    if proc:
        proc.terminate()
    else:
        with lock:
            if jobs.get(vid, {}).get("state") == "cancelled":
                jobs.pop(vid, None)


def delete(vid):
    cancel(vid)
    for p in (final_path(vid), index_path(vid), title_path(vid), final_path(vid) + ".part"):
        if os.path.exists(p):
            os.remove(p)
    with lock:
        if jobs.get(vid, {}).get("state") in ("error", "skipped"):
            jobs.pop(vid, None)


def cached_ids():
    return [n[:-4] for n in os.listdir(CACHE) if n.endswith(".mp4") and ID_RE.match(n[:-4])]


def list_cache():
    vids = []
    for vid in cached_ids():
        try:
            vids.append(meta(vid))
        except OSError:
            pass
    vids.sort(key=lambda m: m["mtime"], reverse=True)
    with lock:
        active = [{"id": k, **{x: v[x] for x in ("state", "progress") if x in v}}
                  for k, v in jobs.items() if v.get("state") in ("queued", "downloading")]
    for a in active:
        a["title"] = read_title(a["id"])
    return {"videos": vids, "active": active, "total": sum(v["size"] for v in vids),
            "free": shutil.disk_usage(CACHE).free, "config": load_config()}


def clear_all():
    with lock:
        ids = list(jobs.keys())
    for vid in ids:
        cancel(vid)
    for vid in cached_ids():
        delete(vid)
    for d in (CACHE, DL_DIR):
        for name in os.listdir(d):
            p = os.path.join(d, name)
            if os.path.isfile(p) and name != ".config.json":
                os.remove(p)


def enforce_limits():
    cfg = load_config()
    now = time.time()
    vids = []
    for vid in cached_ids():
        try:
            vids.append((os.path.getmtime(final_path(vid)), os.path.getsize(final_path(vid)), vid))
        except OSError:
            pass
    keep = []
    for mtime, size, vid in vids:
        if cfg["days"] and mtime < now - cfg["days"] * 86400:
            delete(vid)
        else:
            keep.append((mtime, size, vid))
    if cfg["maxgb"]:
        limit = cfg["maxgb"] * 1024 ** 3
        keep.sort()  # oldest (least recently watched) first
        total = sum(s for _, s, _ in keep)
        while keep and total > limit:
            _, size, vid = keep.pop(0)
            delete(vid)
            total -= size
    # orphaned side files and stale partial downloads
    cached = set(cached_ids())
    with lock:
        busy = set(jobs.keys())
    for d in (CACHE, DL_DIR):
        for name in os.listdir(d):
            p = os.path.join(d, name)
            vid = name.split(".")[0]
            if not os.path.isfile(p) or name == ".config.json" or vid in busy or name.endswith(".mp4"):
                continue
            if (vid not in cached or d == DL_DIR) and os.path.getmtime(p) < now - 3600:
                os.remove(p)


def cleanup_loop():
    while True:
        try:
            enforce_limits()
        except OSError:
            pass
        wake_cleanup.wait(3600)
        wake_cleanup.clear()


class Handler(BaseHTTPRequestHandler):
    server_version = "StreamKeep/2.0"

    def log_message(self, fmt, *args):
        # log API calls (not every video byte-range request) so it's visible that the extension reaches us
        if not self.path.startswith(("/video/", "/status", "/list", "/log")):
            print(time.strftime("%H:%M:%S"), self.command, self.path, args[1] if len(args) > 1 else "", flush=True)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_HEAD(self):
        self.do_GET(head=True)

    def do_GET(self, head=False):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        arg = lambda k, d="": (q.get(k) or [d])[0]  # noqa: E731
        vid = arg("v")
        path = url.path
        if path == "/ping":
            return self._json({"ok": True})
        if path == "/log":
            print(time.strftime("%H:%M:%S"), "[ext]", arg("m")[:500], flush=True)
            return self._json({"ok": True})
        if path in ("/cache", "/status", "/cancel", "/delete", "/index") and not ID_RE.match(vid):
            return self._json({"error": "bad id"}, 400)
        if path == "/cache":
            height = int(arg("q", "0") or 0) if arg("q", "0").isdigit() else 0
            toks = arg("c", "avc1").split(",")
            codecs = [c for c in toks if c in CODEC_RE] or ["avc1"]
            codecs.append("opus" if "opus" in toks and "mp4a" not in toks else "mp4a")
            max_min = int(arg("max", "0")) if arg("max", "0").isdigit() else 0
            return self._json(start_cache(vid, height, codecs, max_min))
        if path == "/status":
            return self._json(status(vid))
        if path == "/cancel":
            cancel(vid)
            return self._json(status(vid))
        if path == "/delete":
            delete(vid)
            return self._json(status(vid))
        if path == "/list":
            return self._json(list_cache())
        if path == "/clear":
            clear_all()
            return self._json(list_cache())
        if path == "/open":
            opener = {"darwin": ["open"], "win32": ["explorer"]}.get(sys.platform, ["xdg-open"])
            subprocess.Popen(opener + [CACHE])
            return self._json({"ok": True})
        if path == "/config":
            cfg = load_config()
            for k in ("days", "maxgb"):
                if arg(k).isdigit():
                    cfg[k] = int(arg(k))
            save_config(cfg)
            wake_cleanup.set()
            return self._json(cfg)
        if path == "/index":
            if status(vid)["state"] != "done":
                return self._json({"error": "not cached"}, 404)
            try:
                return self._json(get_index(vid))
            except Exception as e:  # noqa: BLE001
                return self._json({"error": f"index failed: {e}"}, 500)
        m = re.match(r"^/video/([A-Za-z0-9_-]{11})\.mp4$", path)
        if m:
            return self._send_file(final_path(m.group(1)), head)
        return self._json({"error": "not found"}, 404)

    def _send_file(self, path, head):
        if not os.path.exists(path):
            return self._json({"error": "not cached"}, 404)
        size = os.path.getsize(path)
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        code = 200
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                    if m.group(2):
                        end = min(int(m.group(2)), size - 1)
                elif m.group(2):  # suffix range: last N bytes
                    start = max(0, size - int(m.group(2)))
                if start >= size or start > end:
                    self.send_response(416)
                    self._cors()
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.end_headers()
                    return
                code = 206
        try:
            os.utime(path)  # keep recently watched videos out of cleanup
        except OSError:
            pass
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if code == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if head:
            return
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            try:
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass


def main():
    os.makedirs(DL_DIR, exist_ok=True)
    threading.Thread(target=cleanup_loop, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    print(f"StreamKeep helper on http://127.0.0.1:{PORT}, cache: {CACHE}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
