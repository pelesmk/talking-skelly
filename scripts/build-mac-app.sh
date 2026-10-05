#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h:h}"
icon_src="$project_dir/mac/TalkingSkellyIcon.png"
signing_identity="${SKELLY_CODESIGN_IDENTITY:--}"
export CLANG_MODULE_CACHE_PATH="$project_dir/.runtime/clang-module-cache"

mkdir -p "$project_dir/dist" "$CLANG_MODULE_CACHE_PATH"

icon_work_dir="$(mktemp -d "$project_dir/.runtime/icon-build.XXXXXX")"
iconset="$icon_work_dir/TalkingSkelly.iconset"
compiled_icon="$icon_work_dir/TalkingSkelly.icns"
mkdir -p "$iconset"
trap 'rm -rf "$icon_work_dir"' EXIT

for size in 16 32 128 256 512; do
  /usr/bin/sips -z "$size" "$size" "$icon_src" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  retina_size=$((size * 2))
  /usr/bin/sips -z "$retina_size" "$retina_size" "$icon_src" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done

/usr/bin/python3 "$project_dir/scripts/build-icns.py" "$iconset" "$compiled_icon"

sign_app() {
  local app_dir="$1"
  if [[ "$signing_identity" == "-" ]]; then
    /usr/bin/codesign --force --deep --sign - "$app_dir"
  else
    /usr/bin/codesign --force --deep --options runtime --timestamp --sign "$signing_identity" "$app_dir"
  fi
}

build_app() {
  local app_name="$1"
  local bundle_id="$2"
  local deployment_mode="$3"
  local server_port="$4"
  local app_dir="$project_dir/dist/$app_name.app"
  local contents="$app_dir/Contents"

  mkdir -p "$contents/MacOS" "$contents/Resources"
  cp "$project_dir/mac/Info.plist" "$contents/Info.plist"
  cp "$compiled_icon" "$contents/Resources/TalkingSkelly.icns"

  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $app_name" "$contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleName $app_name" "$contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $bundle_id" "$contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :SkellyProjectPath $project_dir" "$contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :SkellyDeploymentMode $deployment_mode" "$contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :SkellyServerPort $server_port" "$contents/Info.plist"

  /usr/bin/clang \
    -fobjc-arc \
    -fblocks \
    -O2 \
    -arch arm64 \
    -arch x86_64 \
    -framework Cocoa \
    -framework WebKit \
    "$project_dir/mac/TalkingSkellyApp.m" \
    -o "$contents/MacOS/TalkingSkelly"

  sign_app "$app_dir"
  echo "$app_dir"
}

build_remote_app() {
  local app_name="Talking Skelly Remote"
  local app_dir="$project_dir/dist/$app_name.app"
  local contents="$app_dir/Contents"

  mkdir -p "$contents/MacOS" "$contents/Resources"
  cp "$project_dir/mac/Info.plist" "$contents/Info.plist"
  cp "$compiled_icon" "$contents/Resources/TalkingSkelly.icns"

  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $app_name" "$contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleName $app_name" "$contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier local.talkingskelly.remote" "$contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleExecutable TalkingSkellyRemote" "$contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Delete :SkellyProjectPath" "$contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Delete :SkellyDeploymentMode" "$contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Delete :SkellyServerPort" "$contents/Info.plist"

  /usr/bin/clang \
    -fobjc-arc \
    -fblocks \
    -O2 \
    -arch arm64 \
    -arch x86_64 \
    -framework Cocoa \
    -framework AVFoundation \
    "$project_dir/mac/TalkingSkellyRemoteApp.m" \
    -o "$contents/MacOS/TalkingSkellyRemote"

  sign_app "$app_dir"
  echo "$app_dir"
}

build_app "Talking Skelly" "local.talkingskelly.app" "standalone" 4317
build_app "Talking Skelly Brain" "local.talkingskelly.brain" "pi" 4318
build_app "Talking Skelly Pi" "local.talkingskelly.pi" "pi" 4318
build_remote_app
