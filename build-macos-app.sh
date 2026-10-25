#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
for APP in "$ROOT/outputs/AliceGemini.app" "$ROOT/outputs/AliceGemini 2.app"; do
  RES="$APP/Contents/Resources"
  mkdir -p "$RES/app" "$APP/Contents/MacOS"
  cp "$ROOT/server.mjs" "$RES/app/server.mjs"
  cp "$ROOT/index.html" "$RES/app/index.html"
  cp "$ROOT/package.json" "$RES/app/package.json"
  /usr/bin/clang -O2 -Wall -Wextra -Werror -target arm64-apple-macos12 "$ROOT/launcher.c" -o "$APP/Contents/MacOS/AliceGemini"
  /usr/libexec/PlistBuddy -c 'Set :CFBundleExecutable AliceGemini' "$APP/Contents/Info.plist"
  /usr/bin/codesign --force --deep --sign - "$APP"
done
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$ROOT/outputs/AliceGemini.app" "$ROOT/outputs/AliceGemini-macOS-Apple-Silicon.zip"
