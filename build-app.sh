#!/bin/zsh
# 构建 "CLI Sessions.app"（需要 Xcode Command Line Tools；运行时需要 node）
set -e
cd "$(dirname "$0")"
APP="CLI Sessions.app"
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O app/main.swift -o "$APP/Contents/MacOS/CLISessions"
cp server.js index.html i18n.js "$APP/Contents/Resources/"
# 图标：icon/icon-1024.png（由 icon/make-icon.swift 生成）→ AppIcon.icns
IS=$(mktemp -d)/AppIcon.iconset; mkdir -p "$IS"
for sz in 16 32 128 256 512; do
  sips -z $sz $sz icon/icon-1024.png --out "$IS/icon_${sz}x${sz}.png" >/dev/null
  sips -z $((sz*2)) $((sz*2)) icon/icon-1024.png --out "$IS/icon_${sz}x${sz}@2x.png" >/dev/null
done
iconutil -c icns "$IS" -o "$APP/Contents/Resources/AppIcon.icns"
cat > "$APP/Contents/Info.plist" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleName</key><string>CLI Sessions</string>
<key>CFBundleDisplayName</key><string>CLI Sessions</string>
<key>CFBundleIdentifier</key><string>local.cli-sessions</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundleExecutable</key><string>CLISessions</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppleEventsUsageDescription</key><string>Used to resume sessions in Terminal / iTerm and to move files to the Trash.</string>
</dict></plist>
P
# 本地化的权限说明（InfoPlist.strings）；英文为默认值
mkdir -p "$APP/Contents/Resources/en.lproj" "$APP/Contents/Resources/zh-Hans.lproj"
printf '"NSAppleEventsUsageDescription" = "%s";\n' "Used to resume sessions in Terminal / iTerm and to move files to the Trash." > "$APP/Contents/Resources/en.lproj/InfoPlist.strings"
printf '"NSAppleEventsUsageDescription" = "%s";\n' "用于在 Terminal / iTerm 中恢复 session，以及把文件移到废纸篓。" > "$APP/Contents/Resources/zh-Hans.lproj/InfoPlist.strings"
codesign --force --deep -s - "$APP" 2>/dev/null || true
echo "built: $PWD/$APP"
