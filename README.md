# YT Offline (Safari)

Open a YouTube video in Safari and it gets saved in the background. If the
internet drops, the saved copy keeps playing **on the same YouTube page**, from
the same second.

## Pieces

- `helper/yto_helper.py`: local service on `http://127.0.0.1:8765`. It downloads
  each opened video with `yt-dlp` (quality and format set in the popup), remuxes it to fragmented MP4,
  and serves fragments plus an index. Cache: `~/Movies/YT Offline Cache`. Files
  unwatched longer than the retention setting (default 7 days) or over the
  size limit (default 30 GB, oldest first) are deleted.
- `extension/`: the web extension source.
  - `content.js` saves each opened video (VP9/AV1 when Safari can play them,
    else H.264). When the connection drops or YouTube shows its error screen,
    it overlays the saved copy. A 4 s stall only switches if a connectivity
    check fails. The copy is streamed into a
    MediaSource, so it plays in-page (Safari blocks `http://127.0.0.1` media on
    https pages). Keys: space/k, j/l, ←/→, m, f. "Back to YouTube" returns to
    the normal player.
  - `popup.html/js` (toolbar button): current video status (play offline,
    save, cancel, re-save, delete), settings (quality, format, auto-save,
    auto-switch, length limit, retention, cache size), saved-video list,
    open folder, clear all. The toolbar badge shows progress (42%, ✓).
  - `background.js` relays requests to the helper, with fetch first and the
    native handler as a fallback.
- `safari/YT Offline/`: the Xcode project made by `safari-web-extension-converter`.
  `SafariWebExtensionHandler.swift` is the native relay.

## Install

```bash
brew install yt-dlp ffmpeg
./helper/install.sh            # helper as a LaunchAgent, starts at login
./install-app.sh               # build, install to /Applications, drop the build copy
```

Then in Safari: Settings → Extensions → tick **YT Offline**. On youtube.com,
allow it ("Always Allow on This Website").

`install-app.sh` copies `extension/` into the Xcode project, builds, installs,
and unregisters the build-folder copy (otherwise Safari shows the extension twice).

Uninstall the helper with `./helper/install.sh --uninstall`.
