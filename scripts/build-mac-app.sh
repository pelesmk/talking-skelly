#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h:h}"
app_dir="$project_dir/dist/Talking Skelly.app"
contents="$app_dir/Contents"
export CLANG_MODULE_CACHE_PATH="$project_dir/.runtime/clang-module-cache"

mkdir -p "$contents/MacOS" "$contents/Resources" "$CLANG_MODULE_CACHE_PATH"
cp "$project_dir/mac/Info.plist" "$contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :SkellyProjectPath $project_dir" "$contents/Info.plist"

/usr/bin/clang \
  -fobjc-arc \
  -fblocks \
  -O2 \
  -framework Cocoa \
  -framework WebKit \
  "$project_dir/mac/TalkingSkellyApp.m" \
  -o "$contents/MacOS/TalkingSkelly"

/usr/bin/codesign --force --deep --sign - "$app_dir"
echo "$app_dir"
