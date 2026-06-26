#!/usr/bin/env bash
# insane-engine 부트스트랩 — 격리 venv 생성 + 의존성 설치 (멱등).
# 쿠팡 등 봇 차단 사이트를 curl_cffi TLS 임퍼소네이션으로 수집하는 Python 엔진 준비.
#
# 사용:  bash tools/insane-engine/setup.sh
# 결과:  tools/insane-engine/.venv (collector 가 INSANE_PYTHON 으로 사용)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HERE/.venv"

PYBIN="${PYTHON_BIN:-python3}"
command -v "$PYBIN" >/dev/null 2>&1 || { echo "[insane-engine] python3 를 찾을 수 없습니다 ($PYBIN)"; exit 1; }

if [ ! -d "$VENV" ]; then
  echo "[insane-engine] venv 생성: $VENV"
  "$PYBIN" -m venv "$VENV"
fi

# shellcheck disable=SC1091
. "$VENV/bin/activate"
python -m pip install --quiet --upgrade pip
python -m pip install --quiet -r "$HERE/requirements.txt"

echo "[insane-engine] 준비 완료. 스모크 테스트:"
python -c "import curl_cffi, yaml; print('  curl_cffi', curl_cffi.__version__, '| PyYAML', yaml.__version__)"
echo "  엔진 호출 예: (cd '$HERE' && '$VENV/bin/python3' -m engine 'https://example.com/' --no-playwright)"
