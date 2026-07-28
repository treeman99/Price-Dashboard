#!/bin/bash
# Daily Price Dashboard — launchd LaunchAgent 설치
# 로그인 시 자동 기동 + 상시 유지(KeepAlive). 매일 09:00(기본) 자동 수집.
set -euo pipefail

LABEL="com.daegun.dailyprice"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
CODEX="$(command -v codex || true)"
TSX_CLI="$REPO/node_modules/tsx/dist/cli.mjs"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
TEMPLATE="$REPO/service/$LABEL.plist.template"

if [ -z "$NODE" ]; then
  echo "✖ node 를 찾을 수 없습니다. Node 18+ 설치 후 다시 실행하세요." >&2
  exit 1
fi
if [ -z "$CODEX" ]; then
  echo "⚠ codex CLI를 찾을 수 없습니다. Opus 5는 동작하지만 Codex 에이전트는 선택할 수 없습니다."
fi
if [ ! -f "$TSX_CLI" ]; then
  echo "✖ tsx 가 없습니다. 먼저 'npm install' 을 실행하세요. ($TSX_CLI)" >&2
  exit 1
fi
if [ ! -f "$REPO/.env" ]; then
  echo "⚠ .env 가 없습니다. .env.example 을 복사해 키를 채워주세요(수집/알림에 필요)."
fi

NODE_DIR="$(dirname "$NODE")"
CODEX_DIR="$(dirname "${CODEX:-$NODE}")"
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
    -e "s#__CODEX_DIR__#$CODEX_DIR#g" \
    "$TEMPLATE" > "$PLIST_DST"

UID_NUM="$(id -u)"
# 기존 것이 있으면 내린다.
# ⚠️ bootout 은 비동기다 — 곧바로 bootstrap 하면 아직 언로드 중이라
#    "Bootstrap failed: 5: Input/output error" 로 죽는다(실측 2026-07-28: 서비스가
#    내려간 채로 설치가 중단됨). 언로드 완료를 확인한 뒤 재시도까지 건다.
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || break
  sleep 1
done

bootstrapped=""
for attempt in 1 2 3 4 5; do
  if launchctl bootstrap "gui/$UID_NUM" "$PLIST_DST" 2>/tmp/dailyprice-bootstrap.err; then
    bootstrapped="yes"
    break
  fi
  echo "⚠ bootstrap 시도 $attempt 실패: $(cat /tmp/dailyprice-bootstrap.err)"
  sleep 3
done
if [ -z "$bootstrapped" ]; then
  echo "✖ launchd 등록 실패. 'launchctl bootout gui/$UID_NUM/$LABEL' 후 다시 실행하세요." >&2
  exit 1
fi

launchctl enable "gui/$UID_NUM/$LABEL"
launchctl kickstart -k "gui/$UID_NUM/$LABEL"

echo "✔ 설치 완료. 서비스가 백그라운드에서 상시 동작합니다."
echo "  대시보드:  http://localhost:7777"
echo "  로그:      $REPO/logs/stdout.log"
echo "  상태확인:  launchctl print gui/$UID_NUM/$LABEL | head"
echo "  제거:      $REPO/service/uninstall.sh"
