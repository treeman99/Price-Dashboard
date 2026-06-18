#!/bin/bash
# Daily Price Dashboard — launchd LaunchAgent 설치
# 로그인 시 자동 기동 + 상시 유지(KeepAlive). 매일 09:00(기본) 자동 수집.
set -euo pipefail

LABEL="com.daegun.dailyprice"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
TSX_CLI="$REPO/node_modules/tsx/dist/cli.mjs"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
TEMPLATE="$REPO/service/$LABEL.plist.template"

if [ -z "$NODE" ]; then
  echo "✖ node 를 찾을 수 없습니다. Node 18+ 설치 후 다시 실행하세요." >&2
  exit 1
fi
if [ ! -f "$TSX_CLI" ]; then
  echo "✖ tsx 가 없습니다. 먼저 'npm install' 을 실행하세요. ($TSX_CLI)" >&2
  exit 1
fi
if [ ! -f "$REPO/.env" ]; then
  echo "⚠ .env 가 없습니다. .env.example 을 복사해 키를 채워주세요(수집/알림에 필요)."
fi

NODE_DIR="$(dirname "$NODE")"
mkdir -p "$REPO/logs" "$HOME/Library/LaunchAgents"

# 프론트 빌드물 없으면 빌드
if [ ! -f "$REPO/web/dist/index.html" ]; then
  echo "▸ 프론트 빌드물이 없어 빌드합니다…"
  (cd "$REPO" && npm run web:build)
fi

echo "▸ plist 생성: $PLIST_DST"
sed -e "s#__NODE__#$NODE#g" \
    -e "s#__TSX_CLI__#$TSX_CLI#g" \
    -e "s#__REPO__#$REPO#g" \
    -e "s#__NODE_DIR__#$NODE_DIR#g" \
    "$TEMPLATE" > "$PLIST_DST"

UID_NUM="$(id -u)"
# 기존 것이 있으면 내린다
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST_DST"
launchctl enable "gui/$UID_NUM/$LABEL"
launchctl kickstart -k "gui/$UID_NUM/$LABEL"

echo "✔ 설치 완료. 서비스가 백그라운드에서 상시 동작합니다."
echo "  대시보드:  http://localhost:7777"
echo "  로그:      $REPO/logs/stdout.log"
echo "  상태확인:  launchctl print gui/$UID_NUM/$LABEL | head"
echo "  제거:      $REPO/service/uninstall.sh"
