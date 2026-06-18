#!/bin/bash
# Daily Price Dashboard — launchd LaunchAgent 제거
set -euo pipefail

LABEL="com.daegun.dailyprice"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
rm -f "$PLIST_DST"
echo "✔ 서비스 제거 완료. (DB/로그 파일은 보존됩니다)"
