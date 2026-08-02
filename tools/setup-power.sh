#!/bin/bash
#
# setup-power.sh — 수집 스케줄에 맞춰 macOS 기상 예약(과 배터리 유휴 슬립 타이머)을 조정한다.
#
# ─────────────────────────────────────────────────────────────────────────────
# 이 스크립트는 sudo 가 필요하므로 **사용자가 직접** 실행한다. 앱이나 에이전트가 부르지 않는다.
#
#   실행:   bash tools/setup-power.sh
#   되돌리기: 스크립트가 끝에 출력해 주는 복구 명령을 그대로 붙여넣는다.
#            (수동 복구는 아래 "되돌리기" 절 참고)
#
# ─────────────────────────────────────────────────────────────────────────────
# ★ 되돌리기 (기억할 것이 이 세 줄뿐이다)
#
#   sudo pmset repeat cancel                       # 반복 기상 예약 전부 취소
#   sudo pmset repeat wake MTWRFSU 07:55:00        # 원래 있던 "매일 7:55AM 기상" 복원
#   sudo pmset -b sleep 1                          # 원래 배터리 유휴 슬립(1분) 복원
#
# ─────────────────────────────────────────────────────────────────────────────
# ★ 먼저 알아야 할 한계 — 이 스크립트는 2026-08-02 사고를 "혼자서는" 못 막는다
#
# 사고 당시 이미 "wake at 7:55AM every day" 반복 기상이 걸려 있었고, 실제로 **정상 발화했다**:
#     2026-08-02 07:55:01  DarkWake from Deep Idle [CDNP] : due to ... rtc/ Using BATT (Charge:58%) 12 secs
#     2026-08-02 07:55:13  Entering Sleep state due to 'Maintenance Sleep'
# 그런데 덮개가 닫혀 있어 FullWake 가 아니라 **DarkWake 12초**로 전달됐고, 곧장 다시 잠들었다.
# 즉 실패 지점은 "안 깨어났다"가 아니라 "깨어났지만 아무것도 못 하고 다시 잠들었다"다.
#
# 따라서 이 스크립트의 역할은 "덮개가 열려 있을 때 08:00 배치가 확실히 살아 있게" 만드는 것까지다.
# 덮개를 닫은 채 배터리로 두는 상황의 해법은 (1) AC 연결 (2) 코드의 슬립 내성이며,
# 전체 그림은 docs/sleep-resilience.md 를 읽을 것.
#
# ─────────────────────────────────────────────────────────────────────────────
# ★ 하지 않는 것: pmset disablesleep 1
#
# `sudo pmset -a disablesleep 1` 은 덮개를 닫아도 잠들지 않게 만든다(클램셸 슬립 무력화).
# 이번 문제를 "직접" 해결하는 유일한 pmset 옵션이지만 **기본 동작에 절대 넣지 않는다**:
#   - 덮개를 닫은 채 계속 풀가동하면 배출구가 막혀 과열된다. 가방에 넣으면 더 심하다.
#   - 배터리로 두면 몇 시간 만에 방전되고, 그 상태로 방치하면 배터리 수명이 상한다.
#   - 되돌리는 걸 잊기 쉽고, 잊으면 노트북이 영구히 안 자는 상태로 남는다.
# 감수하고 쓰겠다면 AC 연결 + 덮개 열림 + 짧은 기간에만. 자세한 논의는 docs/sleep-resilience.md.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── 바꿀 값 ──
# 수집 스케줄: 뉴스·증시 08:00 / 유튜브 09:00·19:00 / 이벤트 10:00 / 증시 17:00
#
# ★ pmset 제약: `man pmset` SCHEDULED EVENT ARGUMENTS 절 원문 —
#     "Note that you may only have one pair of repeating events scheduled
#      - a 'power on' event and a 'power off' event."
#   즉 **반복 기상은 시각 하나만** 걸 수 있다(요일은 부분집합 지정 가능하지만 시각은 1개).
#   08:00 / 09:00 / 10:00 / 17:00 / 19:00 을 각각 예약하는 건 pmset repeat 으로 불가능하다.
#   → 가장 중요한 아침 배치(08:00 뉴스·증시 결산) 하나를 고른다.
WAKE_TIME="07:58:00"
WAKE_DAYS="MTWRFSU"   # man pmset: weekdays 는 MTWRFSU 의 부분집합. 전체 = 매일.
WAKE_TYPE="wakeorpoweron"  # 자고 있으면 깨우고, 꺼져 있으면 켠다. 순수 wake 보다 회복력이 높다.

# 07:58 인 이유 — 08:00 배치 2분 전.
# 기존 07:55 보다 늦춘 게 아니라 "기상 → 배치" 사이 공백을 줄이려는 것이다.
# 배터리 유휴 슬립이 1분이라 07:55 에 깨면 07:56 에 도로 잠들어 08:00 배치를 놓친다.
# 공백을 2분으로 줄이고, 아래 [2단계]에서 유휴 슬립 자체를 늘려 이 창을 확실히 덮는다.

BATT_SLEEP_NEW=10     # 배터리 유휴 시스템 슬립(분). 현재 1분은 기상 예약을 무의미하게 만든다.

# ── 사전 점검 ──
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "✖ macOS 전용 스크립트다 (현재: $(uname -s))" >&2
  exit 1
fi

echo "════════════════════════════════════════════════════════════════"
echo " 현재 전원 설정 (변경 전)"
echo "════════════════════════════════════════════════════════════════"
echo
echo "── pmset -g sched ──"
pmset -g sched
echo
echo "── pmset -g custom ──"
pmset -g custom
echo

# 되돌리기용으로 현재 배터리 유휴 슬립 값을 실측해 둔다(주석에 적힌 1분을 맹신하지 않는다).
BATT_SLEEP_OLD="$(pmset -g custom | awk '/^Battery Power:/{f=1} /^AC Power:/{f=0} f && $1=="sleep"{print $2; exit}')"
BATT_SLEEP_OLD="${BATT_SLEEP_OLD:-1}"

# 기존 반복 기상을 그대로 복원할 수 있게 문자열로 남긴다.
EXISTING_REPEAT="$(pmset -g sched | sed -n '/Repeating power events:/,/Scheduled power events:/p' | sed '1d;$d' | sed 's/^ *//')"

echo "════════════════════════════════════════════════════════════════"
echo " 바꿀 내용"
echo "════════════════════════════════════════════════════════════════"
echo
echo " [1단계] 반복 기상 예약"
echo "     이전:  ${EXISTING_REPEAT:-(없음)}"
echo "     이후:  ${WAKE_TYPE} ${WAKE_DAYS} ${WAKE_TIME}  (매일 07:58 기상 — 08:00 배치 2분 전)"
echo "     명령:  sudo pmset repeat ${WAKE_TYPE} ${WAKE_DAYS} ${WAKE_TIME}"
echo
echo " [2단계] 배터리 유휴 시스템 슬립"
echo "     이전:  ${BATT_SLEEP_OLD} 분"
echo "     이후:  ${BATT_SLEEP_NEW} 분"
echo "     명령:  sudo pmset -b sleep ${BATT_SLEEP_NEW}"
echo "     이유:  ${BATT_SLEEP_OLD}분이면 07:58 에 깨어나도 08:00 배치 전에 도로 잠든다."
echo "            [1단계]만 하면 아무 효과가 없고, 이 값을 늘려야 비로소 의미가 생긴다."
echo "     대가:  덮개를 연 채 배터리로 방치하면 잠들기까지 ${BATT_SLEEP_NEW}분 걸린다(그만큼 더 소모)."
echo
echo " 바꾸지 않는 것: AC 설정(이미 sleep 0), disablesleep(과열·방전 위험), launchd plist"
echo
echo "────────────────────────────────────────────────────────────────"
echo " ⚠ 이것만으로 '덮개 닫고 배터리' 사고는 막히지 않는다."
echo "   그 상황에서 기상 예약은 DarkWake 12초로만 전달된다(2026-08-02 실측)."
echo "   → docs/sleep-resilience.md 참고. 확실한 해법은 AC 연결 + 코드 슬립 내성."
echo "────────────────────────────────────────────────────────────────"
echo

read -r -p "적용할까? sudo 암호를 묻는다. [y/N] " REPLY
case "$REPLY" in
  y|Y|yes|YES) ;;
  *) echo "취소했다. 아무것도 바꾸지 않았다."; exit 0 ;;
esac

echo
echo "▶ [1단계] 반복 기상 예약…"
sudo pmset repeat "${WAKE_TYPE}" "${WAKE_DAYS}" "${WAKE_TIME}"

echo "▶ [2단계] 배터리 유휴 슬립 ${BATT_SLEEP_OLD}분 → ${BATT_SLEEP_NEW}분…"
sudo pmset -b sleep "${BATT_SLEEP_NEW}"

echo
echo "════════════════════════════════════════════════════════════════"
echo " 적용 결과 (검증)"
echo "════════════════════════════════════════════════════════════════"
pmset -g sched
echo
pmset -g custom | sed -n '/^Battery Power:/,/^AC Power:/p' | grep -E "^(Battery Power:| sleep )"
echo
echo "════════════════════════════════════════════════════════════════"
echo " 되돌리려면 아래를 그대로 실행"
echo "════════════════════════════════════════════════════════════════"
echo "  sudo pmset repeat cancel"
if [[ -n "${EXISTING_REPEAT}" ]]; then
  echo "  sudo pmset repeat wake MTWRFSU 07:55:00      # 원래 있던 '매일 7:55AM 기상'"
fi
echo "  sudo pmset -b sleep ${BATT_SLEEP_OLD}"
echo
echo "다음 발화가 예약대로 왔는지 확인하는 법(다음 날 아침):"
echo "  pmset -g log | grep -E 'rtc/ |Clamshell Sleep' | tail -20"
echo "  → 'DarkWake ... rtc/ ... N secs' 의 N 이 한 자릿수면 여전히 못 붙잡은 것이다."
