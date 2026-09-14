#!/usr/bin/env bash
set -euo pipefail
PROJ="$(cd "$(dirname "$0")/../.." && pwd)"
MANIFEST="$PROJ/android/AndroidManifest.xml"
ACTIVITY="$PROJ/android/src/com/zdy/game357/MainActivity.java"

grep -q 'package="com.zdy.game357"' "$MANIFEST"
grep -q 'android:versionCode="1"' "$MANIFEST"
grep -q 'android:label="357"' "$MANIFEST"
grep -q 'file:///android_asset/index.html' "$ACTIVITY"
grep -q 'setJavaScriptEnabled(true)' "$ACTIVITY"
test -f "$PROJ/index.html"
test -f "$PROJ/css/style.css"
test -f "$PROJ/js/game.js"
test -f "$PROJ/js/ai.js"
test -f "$PROJ/js/ui.js"
echo "Android wrapper host tests passed"
