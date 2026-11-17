#!/usr/bin/env python3
"""Builds the extension for each browser from the shared source in extension/.

  python3 build.py            -> dist/chrome, dist/firefox, dist/safari + zips
  python3 build.py chrome     -> only Chrome

extension/manifest.json is the base (Safari: service worker + native relay).
Chrome drops nativeMessaging; Firefox uses an event page and needs a gecko id.
"""
import json
import os
import shutil
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "extension")
DIST = os.path.join(ROOT, "dist")
GECKO_ID = "streamkeep@davidmusijenko.github.io"


def manifest(target):
    m = json.load(open(os.path.join(SRC, "manifest.json")))
    if target in ("chrome", "firefox"):
        m["permissions"] = [p for p in m["permissions"] if p != "nativeMessaging"]
    if target == "chrome":
        m["minimum_chrome_version"] = "116"
    if target == "firefox":
        m["background"] = {"scripts": ["background.js"]}
        m["browser_specific_settings"] = {
            "gecko": {
                "id": GECKO_ID,
                "strict_min_version": "128.0",
                "data_collection_permissions": {"required": ["none"]},
            }
        }
    return m


def build(target):
    out = os.path.join(DIST, target)
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(SRC, out, ignore=shutil.ignore_patterns("manifest.json", ".DS_Store"))
    m = manifest(target)
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump(m, f, indent=2)
        f.write("\n")
    if target != "safari":
        z = os.path.join(DIST, f"streamkeep-{target}-{m['version']}.zip")
        with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as zf:
            for name in sorted(os.listdir(out)):
                zf.write(os.path.join(out, name), name)
        print("built", os.path.relpath(out, ROOT), "+", os.path.relpath(z, ROOT))
    else:
        print("built", os.path.relpath(out, ROOT))


if __name__ == "__main__":
    for t in sys.argv[1:] or ["chrome", "firefox", "safari"]:
        build(t)
