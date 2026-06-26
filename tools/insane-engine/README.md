# insane-engine (vendored)

봇 차단(Akamai 등)이나 WebFetch 차단이 강한 사이트를 **curl_cffi TLS 임퍼소네이션** 기반의
적응형 fetch 체인으로 읽기 위한 Python 엔진. 팝업/전시 큐레이션(`src/events/curate.ts`)이
실제 행사 페이지의 날짜를 검증할 때 이 엔진을 호출한다.

## 출처 / 라이선스
- 원본: [fivetaku/insane-search](https://github.com/fivetaku/insane-search) 의 `skills/insane-search/engine`
- 라이선스: MIT (`LICENSE.insane-search` 참고)
- 헤드리스 cron 안정성을 위해 레포에 **vendoring**(고정 복사)했다. 원본 플러그인 설치 여부와 무관하게 동작한다.
- Playwright fallback 템플릿은 사용하지 않는다(수집기는 항상 `--no-playwright`, curl 전용).

## 준비 (최초 1회)
```bash
bash tools/insane-engine/setup.sh
```
→ `tools/insane-engine/.venv` 생성 + `curl_cffi`, `PyYAML` 설치. `.venv` 는 git 에 포함하지 않는다.

## 직접 호출 (디버깅용)
```bash
cd tools/insane-engine
.venv/bin/python3 -m engine "<행사 페이지 URL>" --no-playwright
# 본문(HTML)은 stdout, 상태는 stderr. exit 0=성공, 1=차단/실패.
```

## 연동
- `INSANE_PYTHON` (기본 `tools/insane-engine/.venv/bin/python3`)
- `INSANE_ENGINE_DIR` (기본 `tools/insane-engine`)
- `EVENTS_VERIFY_DATES=false` 로 날짜 검증 비활성화 가능.
