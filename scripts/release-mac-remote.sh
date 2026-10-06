#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h:h}"
notary_profile="${SKELLY_NOTARY_PROFILE:-agentstore-notary}"
signing_identity="${SKELLY_CODESIGN_IDENTITY:-}"

cd "$project_dir"

if [[ -z "$signing_identity" ]]; then
  signing_identity="$(/usr/bin/security find-identity -v -p codesigning | /usr/bin/awk '/"Developer ID Application:/{print $2; exit}')"
fi

if [[ -z "$signing_identity" ]]; then
  echo "No usable Developer ID Application identity was found in Keychain." >&2
  exit 1
fi

version="$(node -p "JSON.parse(require('fs').readFileSync('package.json', 'utf8')).version")"
app_path="$project_dir/dist/Talking Skelly Remote.app"
submission_zip="$project_dir/dist/Talking-Skelly-Remote-v${version}-notary.zip"
release_zip="$project_dir/dist/Talking-Skelly-Remote-v${version}-macOS.zip"

echo "Building a universal Developer ID-signed app…"
SKELLY_CODESIGN_IDENTITY="$signing_identity" /bin/zsh "$project_dir/scripts/build-mac-app.sh"

/usr/bin/codesign --verify --deep --strict --verbose=2 "$app_path"

rm -f "$submission_zip" "$release_zip"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$app_path" "$submission_zip"

echo "Submitting Talking Skelly Remote to Apple for notarization…"
notary_result="$(/usr/bin/xcrun notarytool submit "$submission_zip" \
  --keychain-profile "$notary_profile" \
  --wait \
  --output-format json)"
echo "$notary_result"

notary_status="$(echo "$notary_result" | node -e 'let value=""; process.stdin.on("data", chunk => value += chunk).on("end", () => console.log(JSON.parse(value).status || ""));')"
if [[ "$notary_status" != "Accepted" ]]; then
  echo "Apple did not accept the notarization submission." >&2
  exit 1
fi

/usr/bin/xcrun stapler staple "$app_path"
/usr/bin/xcrun stapler validate "$app_path"
/usr/sbin/spctl --assess --type execute --verbose=4 "$app_path"

/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$app_path" "$release_zip"
/usr/bin/unzip -tq "$release_zip"

echo "Shareable notarized app:"
echo "$release_zip"
