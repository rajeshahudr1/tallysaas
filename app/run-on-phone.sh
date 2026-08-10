#!/usr/bin/env bash
# Install and launch the app on a real phone over Wi-Fi.
#
#   bash run-on-phone.sh                 # a phone already visible to adb
#   bash run-on-phone.sh 192.168.4.57    # connect to that phone first
#
# The APK is built against this PC's LAN address, so the phone talks to the dev
# API directly over Wi-Fi. `adb reverse` is ALSO set up as a fallback: if the
# Windows firewall blocks the LAN route, the tunnel still carries the traffic.
set -u

ADB="D:/Other/shadi indore/image/Photos/1/quikjob/31012026/dev/android-sdk/platform-tools/adb.exe"
PC_IP="192.168.4.19"
APK="build/app/outputs/flutter-apk/app-release.apk"
PKG="$(grep -oP 'applicationId\s*=?\s*"\K[^"]+' android/app/build.gradle* 2>/dev/null | head -1)"
PKG="${PKG:-com.example.tallysaas_app}"

if [ $# -ge 1 ]; then
  echo "→ connecting to $1"
  "$ADB" connect "$1:5555" || true
fi

DEV=$("$ADB" devices | awk 'NR>1 && $2=="device" {print $1; exit}')
if [ -z "$DEV" ]; then
  echo "No phone visible to adb."
  echo "On the phone: Settings → Developer options → Wireless debugging (or plug in USB)."
  exit 1
fi
echo "→ device: $DEV"

# Tunnel the dev servers to the phone's own localhost. Harmless when the LAN
# route already works, and the whole story when the firewall blocks it.
"$ADB" -s "$DEV" reverse tcp:4500 tcp:4500 >/dev/null 2>&1 && echo "→ reverse 4500 ok"
"$ADB" -s "$DEV" reverse tcp:4600 tcp:4600 >/dev/null 2>&1 && echo "→ reverse 4600 ok"

echo "→ installing $APK"
"$ADB" -s "$DEV" install -r "$APK" || exit 1

echo "→ launching $PKG"
"$ADB" -s "$DEV" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1

echo
echo "→ can the phone reach the API?"
"$ADB" -s "$DEV" shell "curl -s -m 5 http://$PC_IP:4500/api/v1/ping || echo '(LAN blocked — the app will need adb reverse + a 127.0.0.1 build)'" 2>/dev/null
echo
echo "Done. Live logs:  \"$ADB\" -s $DEV logcat -s flutter"
