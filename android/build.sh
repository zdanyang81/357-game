#!/usr/bin/env bash
set -euo pipefail

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/android-sdk}}"
BT="${ANDROID_BUILD_TOOLS_DIR:-$(find "$SDK/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)}"
ANDROID_JAR="${ANDROID_JAR:-$(find "$SDK/platforms" -mindepth 2 -maxdepth 2 -name android.jar | sort -V | tail -n 1)}"
PROJ="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$PROJ/.." && pwd)"
BUILD="$PROJ/build"

if [[ -z "${JAVA_HOME:-}" && -d /usr/lib/jvm/java-21-openjdk-amd64 ]]; then
    export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
fi
if [[ -n "${JAVA_HOME:-}" ]]; then
    export PATH="$JAVA_HOME/bin:$PATH"
fi

for required in "$BT/aapt2" "$BT/d8" "$BT/zipalign" "$BT/apksigner" "$ANDROID_JAR"; do
    if [[ ! -e "$required" ]]; then
        echo "missing Android build input: $required" >&2
        exit 2
    fi
done

rm -rf "$BUILD"
mkdir -p "$BUILD/compiled" "$BUILD/gen" "$BUILD/classes" "$BUILD/dex" "$BUILD/web-assets/css" "$BUILD/web-assets/js" "$BUILD/web-assets/assets"
cp "$ROOT/index.html" "$BUILD/web-assets/"
cp "$ROOT/css/style.css" "$BUILD/web-assets/css/"
cp "$ROOT/js/"*.js "$BUILD/web-assets/js/"
cp -R "$ROOT/assets/." "$BUILD/web-assets/assets/"

"$BT/aapt2" compile --dir "$PROJ/res" -o "$BUILD/compiled/res.zip"
"$BT/aapt2" link -o "$BUILD/app-unsigned.apk" \
    --manifest "$PROJ/AndroidManifest.xml" \
    -I "$ANDROID_JAR" \
    --java "$BUILD/gen" \
    --min-sdk-version 23 \
    --target-sdk-version 34 \
    -A "$BUILD/web-assets" \
    "$BUILD/compiled/res.zip"

mapfile -d '' SRC_FILES < <(find "$BUILD/gen" "$PROJ/src" -name '*.java' -print0)
javac -source 8 -target 8 -encoding UTF-8 \
    -bootclasspath "$ANDROID_JAR" \
    -d "$BUILD/classes" \
    "${SRC_FILES[@]}"

find "$BUILD/classes" -name '*.class' > "$BUILD/classes.txt"
"$BT/d8" --min-api 23 --lib "$ANDROID_JAR" --output "$BUILD/dex" @"$BUILD/classes.txt"
cp "$BUILD/app-unsigned.apk" "$BUILD/app-dex.apk"
(cd "$BUILD/dex" && zip -q -u "$BUILD/app-dex.apk" classes.dex)
"$BT/zipalign" -f 4 "$BUILD/app-dex.apk" "$BUILD/app-aligned.apk"

SIGNING_DIR="${GAME357_SIGNING_DIR:-$HOME/android-apps/357-game}"
SIGNING_ENV="${GAME357_SIGNING_ENV:-$SIGNING_DIR/signing.env}"
KEYSTORE="${GAME357_KEYSTORE:-$SIGNING_DIR/357-game.keystore}"
mkdir -p "$SIGNING_DIR"
chmod 700 "$SIGNING_DIR"
if [[ ! -f "$SIGNING_ENV" ]]; then
    umask 077
    password="$(openssl rand -hex 24)"
    printf 'GAME357_KEYSTORE_PASSWORD=%q\n' "$password" > "$SIGNING_ENV"
fi
# shellcheck disable=SC1090
source "$SIGNING_ENV"
if [[ -z "${GAME357_KEYSTORE_PASSWORD:-}" ]]; then
    echo "missing GAME357_KEYSTORE_PASSWORD in $SIGNING_ENV" >&2
    exit 2
fi
if [[ ! -f "$KEYSTORE" ]]; then
    keytool -genkeypair -keystore "$KEYSTORE" \
        -alias game357 -keyalg RSA -keysize 2048 -validity 10950 \
        -storepass "$GAME357_KEYSTORE_PASSWORD" -keypass "$GAME357_KEYSTORE_PASSWORD" \
        -dname "CN=357 Game, OU=Apps, O=zdy, L=Changsha, ST=Hunan, C=CN" >/dev/null
fi

"$BT/apksigner" sign --ks "$KEYSTORE" \
    --ks-pass "pass:$GAME357_KEYSTORE_PASSWORD" \
    --key-pass "pass:$GAME357_KEYSTORE_PASSWORD" \
    --out "$BUILD/357-v1.0.1.apk" "$BUILD/app-aligned.apk"
"$BT/apksigner" verify --verbose --print-certs "$BUILD/357-v1.0.1.apk"
sha256sum "$BUILD/357-v1.0.1.apk"
echo "BUILD OK: $BUILD/357-v1.0.1.apk"
