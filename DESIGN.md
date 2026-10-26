---
name: Daily Dashboard
description: 신문지 위에 윤전 잉크로 찍은 조간 브리핑 — 단정·정확·건조한 개인 정보 게시판
colors:
  press-ink: "hsl(45 8% 10%)"
  newsprint: "hsl(45 29% 95%)"
  sheet: "hsl(48 33% 99%)"
  sunken: "hsl(43 22% 91%)"
  ink-muted: "hsl(40 6% 40%)"
  hairline: "hsl(43 18% 84%)"
  field-stroke: "hsl(43 14% 76%)"
  tab-news: "#d97706"
  tab-youtube: "#dc2626"
  tab-skills: "#2563eb"
  tab-stock: "#059669"
  tab-events: "#db2777"
  tab-holdings: "#0d9488"
  tab-lotto: "#7c3aed"
  tone-error: "hsl(4 76% 40%)"
  tone-warn: "hsl(28 92% 36%)"
  tone-info: "hsl(216 78% 45%)"
  tone-success: "hsl(158 89% 24%)"
  market-up: "#c23224"
  market-down: "#1f5fd6"
typography:
  display:
    fontFamily: "Hahmlet, 'Apple Myungjo', serif"
    fontSize: "2rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
    fontFeature: "'tnum'"
  headline:
    fontFamily: "Hahmlet, 'Apple Myungjo', serif"
    fontSize: "1.3rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  title:
    fontFamily: "'IBM Plex Sans KR', -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.55
  body:
    fontFamily: "'IBM Plex Sans KR', -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  body-sm:
    fontFamily: "'IBM Plex Sans KR', -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  meta:
    fontFamily: "'IBM Plex Sans KR', -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', sans-serif"
    fontSize: "13px"
    fontWeight: 400
  label:
    fontFamily: "'IBM Plex Sans KR', -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', sans-serif"
    fontSize: "12px"
    fontWeight: 500
  mono:
    fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace"
    fontSize: "13px"
    fontWeight: 400
    fontFeature: "'tnum'"
rounded:
  sm: "2px"
  xs: "3px"
  md: "4px"
  lg: "6px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "20px"
  xl: "32px"
  section: "40px"
components:
  button-solid:
    backgroundColor: "{colors.press-ink}"
    textColor: "hsl(45 29% 97%)"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-solid-hover:
    backgroundColor: "hsl(45 8% 10% / 0.9)"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.press-ink}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-outline-hover:
    backgroundColor: "{colors.sunken}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-ghost-hover:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.press-ink}"
  button-destructive:
    backgroundColor: "{colors.tone-error}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  icon-action:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.md}"
    size: "28px"
  icon-action-hover:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.press-ink}"
  segmented-option:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.xs}"
    padding: "0 12px"
    height: "28px"
  segmented-option-selected:
    backgroundColor: "{colors.press-ink}"
    textColor: "{colors.newsprint}"
    rounded: "{rounded.xs}"
    padding: "0 12px"
    height: "28px"
  status-tag:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.xs}"
    padding: "0 6px"
    height: "18px"
  input:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.press-ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "36px"
  notice:
    backgroundColor: "hsl(216 78% 45% / 0.06)"
    textColor: "{colors.press-ink}"
    typography: "{typography.body-sm}"
    padding: "10px 14px"
  table-head:
    textColor: "{colors.ink-muted}"
    typography: "{typography.label}"
    padding: "4px 12px 8px"
  table-cell:
    textColor: "{colors.press-ink}"
    typography: "{typography.body-sm}"
    padding: "10px 12px"
  section-header:
    textColor: "{colors.press-ink}"
    typography: "{typography.headline}"
    padding: "10px 0 0"
  nav-tab:
    textColor: "{colors.ink-muted}"
    typography: "{typography.title}"
    padding: "12px"
  nav-tab-selected:
    textColor: "{colors.press-ink}"
  lotto-ball:
    backgroundColor: "transparent"
    textColor: "{colors.tab-lotto}"
    typography: "{typography.mono}"
    rounded: "{rounded.full}"
    size: "26px"
  lotto-ball-hit:
    backgroundColor: "{colors.tab-lotto}"
    textColor: "#ffffff"
  dialog:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.press-ink}"
    rounded: "{rounded.lg}"
    padding: "24px"
    width: "min(calc(100% - 2rem), 32rem)"
---

# Design System: Daily Dashboard

## Overview

**Creative North Star: "조간 브리핑"**

이 화면은 아침 신문 한 면이다. 신문지 바탕에 윤전 잉크로 글씨와 괘선을 찍고, 정보는 상자에 담지 않고 괘선과 헤어라인으로 나눈다. 분위기는 **단정·정확·건조**하다. 사실을 먼저 전하고 감정 톤은 뺀다. 강조는 크기나 장식이 아니라 잉크의 농도(굵기, 회색 대 잉크색)로 한다. 색은 의미가 있을 때만 쓴다.

밀도는 높다. 하루 중 수시로 들여다보는 화면이므로 한눈에 훑을 수 있어야 한다. 표, 행 목록, 다단 배치로 화면 폭(최대 2400px)을 끝까지 쓰고, 빈 칸이나 내부 스크롤 상자로 정보를 숨기지 않는다. 섹션은 위쪽 2px 잉크 괘선과 명조 제목 하나로 시작한다. 그 밖의 구분은 모두 1px 헤어라인이다.

부품은 **조용하고 정확하게** 움직인다. 평소에는 회색 글씨와 얇은 선으로 물러나 있다가, 손이 닿으면(hover·focus) 잉크색으로 또렷해진다. 크기나 그림자가 바뀌는 효과는 없다.

이 방향은 2026-10-24 리디자인에서 '기본 AI 템플릿 느낌'을 걷어 내며 확정했다. 그 리디자인이 명시적으로 버린 것은 다음과 같다. 항목마다 그림자 카드를 씌우는 것, 카드 왼쪽의 굵은 컬러 테두리, auto-fill 카드 그리드, 고정 높이 카드 안의 내부 스크롤, 제목 앞 이모지, 색을 채운 알약 배지, 색 상자 안내문, 하드코딩된 링크 색. 이 시스템은 **라이트 전용**이다.

**Key Characteristics:**
- 신문지 바탕 + 윤전 잉크 글씨. 지면 위에는 그림자 없이 괘선과 헤어라인만 쓴다.
- 섹션 머리는 2px 잉크 괘선과 명조(Hahmlet) 제목이다.
- 본문은 IBM Plex Sans KR, 기계적인 값은 IBM Plex Mono와 tabular 숫자로 쓴다.
- 색은 탭 고유색, 신호색(오류·경고·정보·성공), 증시 상승·하락 세 가지 용도로만 쓴다.
- 모서리는 4px 이하로 각지게 한다. 동그라미는 로또 공과 점에만 쓴다.
- 행 동작은 평소 흐리게 있다가 hover·focus 때 또렷해진다.

## Colors

따뜻한 미색 지면 위에 거의 검은 잉크를 쓰고, 색은 지면의 몇 퍼센트도 안 되는 작은 표지로만 등장하는 팔레트다.

### Primary
- **윤전 잉크** (`press-ink`, CSS `--foreground`·`--primary`·`--ring`): 본문 글씨, 섹션 괘선, 선택된 Segmented 칸, 단색 버튼, 포커스 링, 차트 선, '맨 위로' 버튼에 쓴다. 순수한 검정이 아니라 신문지와 같은 노란 기운이 도는 잉크다. 투명도로 변형해서 쓴다: 표 머리 괘선은 80%, 다이얼로그·헤더 테두리는 15%, 중립 태그 테두리는 20%, 차트 커서는 25%, 선택 영역은 12%.

### Secondary
- **탭 고유색** (`tab-news` 주황 · `tab-youtube` 빨강 · `tab-skills` 파랑 · `tab-stock` 초록 · `tab-events` 분홍 · `tab-holdings` 청록 · `tab-lotto` 보라, 그리고 Overview는 섹션 색 없이 윤전 잉크): 지금 어느 지면을 보고 있는지 알려 주는 표지다. App이 활성 탭의 색을 문서 루트의 CSS 변수 `--tab`에 넣어 주므로, 부품은 `text-tab`/`bg-tab`/`border-tab`으로 쓴다(다이얼로그 포털에서도 같은 색이 나온다).

### Tertiary
- **신호색** (`tone-error` 붉은 벽돌 · `tone-warn` 짙은 호박 · `tone-info` 남청 · `tone-success` 짙은 녹색): Notice 띠의 왼쪽 선·아이콘·옅은 바탕(6~7%)과 StatusTag의 글씨·테두리(40~45%)에 쓴다. 문단 글씨 자체를 신호색으로 칠하지 않는다.
- **증시 상승·하락** (`market-up` 빨강, `market-down` 파랑): 한국 증시 관례대로 상승은 빨강, 하락은 파랑이다. 등락률 글씨와 차트 끝점에만 쓴다.

### Neutral
- **신문지** (`newsprint`, `--background`): 페이지 전체의 바탕이다. 헤더는 95% 불투명도와 약한 블러로 같은 지면을 이어 간다.
- **낱장** (`sheet`, `--card`): 지면 위에 떠 있는 면(다이얼로그, 팝오버, 토스트, 툴팁 위 썸)과 입력창 안쪽에만 쓴다.
- **눌린 바탕** (`sunken`, `--muted`·`--secondary`): 행 hover(60%), 회색 안내 바탕, 눌린 상태, 코드 칩, 꺼진 스위치에 쓴다. 영역을 꼭 묶어야 할 때도 테두리 없이 이 바탕(50%)만 깐다.
- **흐린 잉크** (`ink-muted`, `--muted-foreground`): 메타, 표 머리, 보조 링크, 꺼진 탭, 축 눈금, 빈 상태 문구에 쓴다.
- **헤어라인** (`hairline`, `--border`): 행 구분선, 툴바 아래 선, 다단 사이 세로 괘선, 차트 격자에 쓴다.
- **입력 테두리** (`field-stroke`, `--input`): 입력창·textarea·outline 버튼 테두리에 쓴다. 헤어라인보다 한 단계 진하다.

### Named Rules
**The Meaningful Color Rule.** 색은 탭 고유색, 신호색, 증시 상승·하락 세 가지 용도로만 쓴다. 장식용 색 배경, 팔레트 직접 지정(`text-slate-500`, `bg-blue-50`), 하드코딩된 링크 색은 쓰지 않는다.

**The Tab Color Footprint Rule.** 탭 고유색은 작은 면적에만 칠한다: 헤더 맨 위 3px 띠, 활성 탭 2px 밑줄, 탭·섹션 앞 2px 모서리 사각형, 켜진 스위치, 로또 공, '맨 위로' 버튼 아래 3px 띠. 넓은 바탕을 칠하지 않는다. `--tab`은 hex 변수라 `/50` 같은 투명도 수식어가 붙지 않는다.

**The Light Only Rule.** 이 시스템은 신문지 바탕 하나로 정의한다. `index.css`에 `.dark` 토큰이 남아 있지만 켜지는 곳이 없고 시스템의 일부가 아니다. 다크 변형이나 `dark:` 유틸리티를 만들지 않는다.

## Typography

**Display Font:** Hahmlet (대체: Apple Myungjo, serif)
**Body Font:** IBM Plex Sans KR (대체: -apple-system, Apple SD Gothic Neo, sans-serif)
**Label/Mono Font:** IBM Plex Mono (대체: ui-monospace, SFMono-Regular, monospace)

**Character:** 신문 제호와 표제에 쓰는 명조(Hahmlet)와 기사 본문처럼 담백한 고딕(Plex Sans KR)을 짝지었다. 종목코드·시각·순위·회차처럼 기계적인 값은 Plex Mono로 따로 세운다. 세 글꼴 모두 Google Fonts에서 읽는다(Hahmlet 500/600/700, Plex Mono 400/500/600, Plex Sans KR 400/500/600/700). 본문은 `word-break: keep-all`로 한국어 어절을 끊지 않는다.

### Hierarchy
- **Display** (Hahmlet 600, 2rem / 1.75rem, 1.25, -0.01em, tabular): 지수·종가 같은 큰 숫자 헤드라인. 증시 탭에서만 쓴다.
- **Headline** (Hahmlet 600, 1.3rem, 1.25, -0.01em): 섹션 제목. 같은 계열로 제호 "Daily Dashboard"(1.35rem 700, -0.02em, 행간 1)와 다이얼로그 제목(18px 600)이 있다.
- **Title** (Plex Sans KR 500~600, 15px, 1.55): 행 제목, 탭 이름. 뉴스·유튜브 행 제목은 semibold, 탭은 선택 시 semibold·평소 medium이다.
- **Body** (Plex Sans KR 400, 15px, 1.55): 페이지 기본 글씨. 표 셀·안내 띠·요약은 14px(body-sm)로 한 단계 낮추고, 요약 글은 잉크 80%로 쓴다.
- **Meta** (Plex Sans KR 400, 12.5~13px, 흐린 잉크): 출처·날짜·건수·툴바 메타. 툴바의 값은 `strong`으로 감싸 잉크색 medium으로 올린다.
- **Label** (Plex Sans KR 500, 12px, 흐린 잉크): 표 머리, 소그룹 라벨(13px 600, 0.02em). StatusTag는 11px 600으로, 이 시스템의 최소 크기다.
- **Mono** (Plex Mono 400~500, 11~13px, tabular): 종목코드, 시각, 순위, 회차 번호, 세트 번호, 섹션 건수, 차트 축 눈금(11px).

### Named Rules
**The Serif Is For Headlines Rule.** 명조는 제호, 섹션 제목, 다이얼로그 제목, 큰 숫자 헤드라인에만 쓴다. 본문·버튼·표에는 쓰지 않는다.

**The Tabular Numbers Rule.** 숫자가 세로로 줄을 서는 곳(가격, 건수, 날짜, 표의 숫자 열)에는 `.num`(tabular-nums)을 붙이고 오른쪽 정렬한다.

**The 11px Floor Rule.** 11px 미만의 글씨는 쓰지 않는다.

## Layout

기준 화면은 1680×1050(맥북)이고, 1280px에서도 깨지지 않아야 한다. `main`은 가운데 정렬로 최대 2400px까지 넓어지며, 좌우 여백은 20px이고 `lg` 이상에서 32px이다. 위 여백 20px, 아래 64px.

**지면의 위에서 아래 순서:** sticky 헤더(3px 탭 색 띠 → 제호·날짜 | 탭 줄 | 전역 컨트롤) → 전역 안내 띠 → 탭 툴바(왼쪽 메타, 오른쪽 동작 버튼, 아래 헤어라인, 아래 여백 20px) → 섹션들. 섹션 사이는 40px이고, 같은 부모의 첫 섹션은 위 여백이 0이다. 헤더의 탭 줄은 1480px 이상에서 제호 옆 한 줄에 놓이고, 그보다 좁으면 아래 줄로 내려가 스크롤바 없이 가로로 스크롤된다.

**내용 배치 네 가지:**
- **데이터 표**: 같은 속성을 가진 항목(팝업 목록, 보유 종목, 스킬 랭킹, 포지션)을 화면 폭 끝까지 편다. 좁으면 가로 스크롤 래퍼에 넣는다.
- **신문 다단**: 짧은 목록이 여러 개일 때 1 → 2(lg) → 3(2xl) → 4(2200px)단으로 흘리고, 단 사이에 1px 세로 괘선을 긋는다. 전체 길이가 늘 짧을 때만 쓴다. 한 단이 화면 한 장을 넘으면 읽기가 무너지므로 **최대 분량 데이터로 높이를 재 보고** 고른다. 뉴스 탭은 이 이유로 가로 줄 그리드(1 → 2 → 3열, 위 정렬)와 카테고리당 4건 + 'N건 더 보기'로 바꿨다.
- **행 목록**: 썸네일이나 긴 요약이 있을 때(유튜브) 카드 없는 가로형 행을 `minmax(min(100%, 520px), 1fr)` 열로 깔고, 열 간격 40px, 행 구분은 아래 헤어라인으로 한다.
- **가로 띠**: 항목 하나에 수치·차트·글이 함께 있을 때(증시 종목) 한 항목이 전체 폭 한 줄을 차지한다. 왼쪽 이름·가격·수치, 가운데 차트, 오른쪽 요약이며, 좁으면 세로로 쌓는다.

**간격 리듬:** 4px(아이콘과 글씨 사이) → 8px(부품 사이 기본) → 12px(표 셀 좌우, 행 위아래 10~12px) → 20px(툴바 아래·페이지 여백) → 32px(넓은 여백·다단 간격) → 40px(섹션 사이). 좁은 화면(375px)에서는 툴바 메타 칸이 최소 16rem을 지키고, 동작 버튼이 아래 줄로 내려가 오른쪽에 붙는다.

## Elevation & Depth

지면은 평평하다. 깊이는 그림자가 아니라 괘선의 굵기(2px 잉크 괘선 > 1px 80% 잉크 > 1px 헤어라인)와 바탕 농도(신문지 → 눌린 바탕)로 나타낸다. 그림자는 지면 **위에 떠 있는** 면에만 있다.

### Shadow Vocabulary
- **떠 있는 낱장** (`box-shadow: 0 24px 60px -20px rgba(27,26,23,0.35)`): 다이얼로그. 뒤에는 잉크 40% 덮개와 1px 블러를 깐다.
- **바닥 토스트** (`box-shadow: 0 12px 32px -12px rgba(27,26,23,0.35)`): 화면 아래 가운데에 잠깐 뜨는 알림(유튜브 '본영상' 되돌리기).
- **메뉴** (Tailwind `shadow-lg`): 버튼에서 펼쳐지는 작은 선택 목록.
- **툴팁** (Tailwind `shadow-md`): 아이콘 동작의 즉시 라벨.
- **스위치 썸** (Tailwind `shadow-sm`): 토글 손잡이.

### Named Rules
**The Flat Paper Rule.** 지면 위의 요소(행, 섹션, 표, 버튼)에는 그림자가 없다. hover는 눌린 바탕(60%)을 까는 것으로만 표시하고, 크기·그림자·위치를 바꾸지 않는다.

## Shapes

각진 인쇄물의 형태다. 모서리는 대부분 4px(`md`)이고, 2px은 탭·섹션 앞 색 사각형과 툴팁, 3px은 StatusTag와 Segmented 안쪽 칸에 쓴다. 6px(`lg`)은 다이얼로그에만 쓴다. 완전한 원은 로또 번호 공, 소그룹 라벨 앞 점, 아바타에만 쓴다. 스위치도 알약 모양이 아니라 4px 각진 토글이다.

선의 문법은 다음과 같다:
- 섹션 머리 위 2px 잉크 괘선
- 표 머리 아래 1px 잉크(80%)
- 행 사이 1px 헤어라인
- 안내 띠 왼쪽 3px 신호색 선
- 헤더 맨 위 3px 탭 색 띠
- 빈 상태 위아래 점선

썸네일과 차트를 빼면 상자 테두리로 영역을 두르지 않는다.

### Named Rules
**The Square Corners Rule.** 모서리는 4px 이하로 둔다(다이얼로그만 6px). `rounded-full`은 숫자 공·점·아바타 전용이다.

**The Rule, Not Box Rule.** 영역 구분은 괘선과 헤어라인으로 한다. 섹션이나 행을 테두리 상자로 감싸지 않는다.

## Components

모든 탭 화면은 `@/components/ui/page`의 공통 어휘(PageToolbar, Notice, SectionHeader, SubHeader, Segmented, StatusTag, TextLink, IconAction, EmptyState·EmptyLine·LoadingState)만 조합해 같은 문법으로 보이게 한다.

### Buttons
조용하고 정확한 사각 버튼이다.
- **Shape:** 각진 모서리(4px). 높이 32px(기본), 28px(sm), 40px(lg). 글씨 14px medium, 아이콘과 글씨 사이 6px.
- **Solid:** 윤전 잉크 바탕에 신문지색 글씨. hover 때 잉크 90%.
- **Outline:** 탭 툴바 동작('지금 갱신', '카테고리 추가')의 기본형. 투명 바탕에 입력 테두리 1px. hover 때 테두리가 잉크 40%로 진해지고 눌린 바탕이 깔린다.
- **Ghost:** 흐린 잉크 글씨, hover 때 눌린 바탕 + 잉크 글씨. 헤더의 '서비스 제거'는 hover 때 오류 톤(바탕 10%, 글씨)으로 바뀐다.
- **Destructive:** 오류 톤 바탕 + 흰 글씨.
- **Focus:** 2px 잉크 링 + 신문지색 1px 간격. 비활성은 투명도 50%.

### Segmented (보기 전환)
- **Style:** 잉크 20% 테두리의 4px 틀 안에 3px 모서리 칸들이 2px 간격으로 놓인다. 칸 높이 28px, 13px medium.
- **State:** 선택된 칸만 잉크로 채우고 글씨는 신문지색이다. 나머지는 흐린 잉크이고 hover 때 눌린 바탕이 깔린다. 탭 안의 보기 전환(한국장/미국장, star 총합/이번 주 급상승, 지역 필터)은 전부 이 부품으로 한다.

### StatusTag
- **Style:** 색을 채우지 않는다. 신호색 글씨 + 같은 색 40~45% 얇은 테두리, 높이 18px, 3px 모서리, 11px semibold. 톤은 new·success(녹색), urgent·error(붉은 벽돌), soon·info(남청), warn(호박), neutral(흐린 잉크 + 잉크 20% 테두리)이다.
- **행사 종료:** 오늘 끝나는 행사만 urgent '오늘 종료'로 쓰고, 7일 안에 끝나는 나머지는 warn '종료임박'으로 한 단계 낮춘다. 빨강이 목록 대부분을 덮으면 아무것도 급해 보이지 않는다.
- **증시 전망·주목 강도:** 서버 값은 이모지(📈·🔥강 …)지만 화면과 메일 모두 neutral 글씨 태그('상승 전망', '주목 강')로 단다. 이모지를 아이콘 대신 쓰지 않는다(iMessage 텍스트만 이모지를 그대로 쓴다).

### Inputs / Fields
- **Style:** 낱장 바탕, 입력 테두리 1px, 4px 모서리, 높이 36px, 14px. textarea는 기본 약 3줄(4.5rem)에서 최대 16rem까지 세로로 늘어난다.
- **Focus:** 2px 잉크 링. placeholder는 흐린 잉크.
- **Disabled:** 투명도 50%, 금지 커서.
- **Switch:** 36×20px 각진 토글. 켜지면 탭 고유색 바탕, 꺼지면 눌린 바탕 + 입력 테두리. 썸은 14px 낱장색 사각형이다.

### Navigation
- **키보드:** 탭 줄은 WAI-ARIA tabs 패턴이다. Tab 키는 선택된 탭에만 들르고, ←→·Home·End로 옮기면 그 탭이 바로 열린다. 포커스는 2px 잉크 링(안쪽).
- **제호:** "Daily Dashboard"를 Hahmlet 1.35rem bold로 쓰고 옆에 오늘 날짜(13px 흐린 잉크, tabular)를 둔다.
- **탭:** 15px. 평소에는 흐린 잉크 medium에 앞의 2px 모서리 색 사각형이 40% 투명도로 흐리다. 선택되면 잉크 semibold가 되고, 사각형이 100%로 켜지며, 아래에 2px 탭 색 밑줄이 생긴다. 헤더 맨 위 3px 띠가 활성 탭 색으로 300ms 동안 바뀐다.
- **수집 실패 점:** 오늘 수집이 실패한 탭 이름 오른쪽 위에 6px 원형 점(짙은 호박)을 단다. 그 탭을 열면 경고 띠가 뜨는 경우와 같은 조건이고, 스크린리더에는 "(오늘 수집 실패)"로 읽힌다. 평소에는 없다.
- **헤더 면:** 신문지 95% + 약한 블러, 아래 잉크 15% 선, sticky.

### Overview (1면)
지난번 본 뒤 각 지면에 새로 들어온 것만 추리는 첫 지면이다. 주소에 탭이 없으면(북마크) 여기로 연다.
- **순서:** 툴바(새 소식 N건) → 증시 한 줄(지수·등락·휴장/종가 기준일·다음 브리핑, 테두리 없음) → 새 소식이 있는 지면의 머리기사 → 새 소식이 없는 지면은 '그 밖의 지면'(전부 없으면 '새 소식 없음') 아래 회색 한 줄씩.
- **머리기사:** 지면마다 SectionHeader(탭 색 사각형) 아래 최대 3건. 제목 15px semibold가 곧 원문 링크이고 아래 12.5px 메타. 끝에 'N건 더 보기 →'(탭 전환, 새 창 아님).
- **배치:** 1680px 3단, 1280px 2단, 좁으면 1단. 위 정렬.

### 신규 표시
- 뉴스·유튜브 행 제목 앞, 팝업·전시 상태 열에 `StatusTag tone="new"` "신규". 지난번 그 탭을 본 뒤 들어온 항목에만 붙고, 그 탭을 다시 열 때까지 남는다(규칙은 `web/src/lib/seen.ts`). 팝업·전시는 서버의 '약 일주일 만의 신규'와 한 배지로 합친다.

### PageToolbar
- 왼쪽 메타는 상태만 적는다: 스케줄 요약(정각이 6개 이상이면 '매시 정각(00~06·08~16시)'으로 묶음), 알림 채널(벨 아이콘 + 채널 이름, 언제 나가는지는 툴팁), 최종 갱신('오늘 21:19' — `formatWhen`), 건수. 사용 설명 문장은 툴팁이나 다이얼로그로 보낸다.
- 오른쪽 동작 버튼은 좁은 화면에서 줄 전체를 차지하고 안에서 줄바꿈된다(페이지 가로 스크롤 금지).
- 동작 버튼은 라벨을 단다. 아이콘만 있는 버튼은 행 동작(IconAction)에만 쓴다.

### Notice (안내 띠)
지면에 끼워 넣는 정정 기사 같은 띠다. 상자형 안내를 쓰지 않고 이것으로 통일한다.
- **Style:** 왼쪽 3px 신호색 선 + 같은 색 6~7% 바탕 + 16px 신호색 아이콘, 패딩 10px 14px, 14px. 글씨는 잉크색 그대로다(색 글씨 문단은 읽히지 않는다).
- **Variants:** error(role=alert)·warn·info·success·muted(잉크 20% 선 + 눌린 바탕). `progress`이면 아이콘 자리에 회전 스피너가 들어간다. 제목 줄(semibold)과 오른쪽 끝 동작 버튼 자리를 둘 수 있다. 기본 아래 여백은 16px이고, 다이얼로그 안에서는 0이다.

### SectionHeader (섹션 머리)
이 시스템의 서명이다.
- **Style:** 위 2px 잉크 괘선, 괘선 아래 10px, Hahmlet 1.3rem 600 제목, 그 옆에 Mono 13px 건수와 13px 회색 메모. 오른쪽 끝에 IconAction 자리가 있다.
- **Accent:** 제목 앞 10px 2px-모서리 색 사각형(카테고리·탭 고유색). 제목 글씨는 잉크색 그대로 둔다.
- **SubHeader:** 섹션 안 소그룹 라벨. 13px semibold + Mono 12px 건수, 아래 헤어라인, 앞에 8px 원형 색 점.

### Data Table (`.dtable`)
- **Head:** 12px medium 흐린 잉크, 아래 1px 잉크(80%) 괘선, 패딩 4px 12px 8px.
- **Rows:** 14px, 패딩 10px 12px, 위 정렬, 아래 헤어라인. hover 때 눌린 바탕 60%.
- **Numbers:** tabular + 오른쪽 정렬.
- **Row actions:** 마지막 열에 IconAction을 둔다. 평소 투명도 40%, 행 hover·focus-within 때 100%. 표가 아닌 행 목록(유튜브)의 보조 아이콘 동작도 같은 규칙이고, 주 동작(영상 보기·본영상 체크)은 늘 또렷하다.
- **Empty column:** 한 표에서만 값이 있는 열은 만들지 않는다. 팝업의 '분류'처럼 일부에만 있는 값은 이름 옆 12.5px 흐린 잉크로 붙여, 여러 표의 열 정렬을 지킨다.
- **Total row:** 같은 통화 묶음이 2행 이상이면 맨 아래 합계 행을 둔다. 위 1px 잉크(40%) 괘선, 합계에 쓸 수 없는 열은 비운다. 값을 모르는 행을 빼면 그 수를 같은 줄에 적는다.
- **Scroll wrapper:** 가로 스크롤 래퍼는 `relative overflow-x-auto`. `relative`가 없으면 표 안의 sr-only 라벨(absolute)이 래퍼 밖으로 빠져 좁은 화면의 페이지 폭을 늘린다.

### IconAction + Tip
- **Style:** 28px 정사각, 4px 모서리, 흐린 잉크 70%, 16px 아이콘. hover 때 눌린 바탕 + 잉크. `danger`이면 hover 때 오류 톤, `active`이면 잉크.
- **Tip:** hover·focus 즉시(150ms) 버튼 아래에 뜨는 라벨. 잉크 바탕, 신문지색 12px 글씨, 2px 모서리. 같은 버튼에 네이티브 `title`을 겹쳐 달지 않는다.

### TextLink
행 안의 보조 링크('원문 보기'). 12.5px 흐린 잉크 + 14px 아이콘이며, hover 때 잉크 + 3px 띄운 밑줄이 생긴다.

### Dialog
- **Style:** 낱장 바탕, 잉크 15% 테두리, 6px 모서리, 패딩 24px, 폭 최대 32rem, 높이 최대 90vh(넘치면 내부 스크롤). 제목은 Hahmlet 18px 600. 오른쪽 위 닫기 X는 흐린 잉크이고 hover 때 눌린 바탕이 깔린다.
- **Inside:** 목록 행은 헤어라인으로 나누고 행마다 상자를 두르지 않는다. 선택형 버튼 묶음은 outline 버튼 한 줄로 두고, 선택된 것만 잉크로 채운다.

### Stock Chart
- **Line:** 잉크 1선. 가로 격자는 헤어라인, 세로 격자는 없다. 축 눈금은 Mono 11px 흐린 잉크.
- **Accents:** 마지막 점 3px 원 하나만 상승·하락 색으로 칠한다. hover 점은 잉크 + 신문지색 테두리.
- **Headline number:** Display(Hahmlet) 숫자 옆에 등락률을 상승·하락 색 semibold로 둔다.

### Lotto Ball
- **Style:** Mono tabular 숫자가 든 원(26px, 크게 28px).
- **States:** 추천은 탭 색 테두리 + 탭 색 글씨, 적중은 탭 색으로 채우고 흰 글씨, 빗나감은 잉크 15% 테두리 + 흐린 잉크, 추첨 번호는 1.5px 잉크 테두리, 보너스는 1.5px 호박 테두리 + 호박 10% 바탕.

### Empty · Loading
- **EmptyState:** 위아래 점선 사이 56px 여백, 가운데 정렬 14px 흐린 잉크, 28px 흐린 아이콘.
- **EmptyLine:** 섹션 안 한 줄 회색 문구.
- **LoadingState:** 스피너 + '불러오는 중…'.

### 맨 위로 버튼
화면 오른쪽 아래 40px 잉크 정사각 버튼(4px 모서리)이며, 아래에 3px 탭 색 띠가 있다. 스크롤하면 12px 아래에서 떠오르며 나타난다(200ms).

## Do's and Don'ts

### Do:
- **Do** 섹션을 SectionHeader의 2px 잉크 괘선 하나로 시작하고, 그 안의 행은 1px 헤어라인(`divide-y`)으로 나눈다.
- **Do** 같은 속성을 가진 항목은 `.dtable` 표로 만들고, 숫자 열에 `.num` + 오른쪽 정렬을 붙인다.
- **Do** 색은 토큰으로만 쓴다: `text-muted-foreground`, `bg-muted`, `tone-*`, `text-tab`, `text-up`/`text-stock-down`.
- **Do** 안내는 Notice, 짧은 상태는 StatusTag, 보조 링크는 TextLink, 아이콘 동작은 IconAction, 보기 전환은 Segmented로 쓴다.
- **Do** 행 동작은 평소 투명도 40%로 두고, 행 hover·focus-within 때 100%로 올린다.
- **Do** 다단 배치를 고르기 전에 최대 분량 데이터로 한 단의 높이를 재 본다.
- **Do** 1680×1050과 1280×800 두 크기에서 렌더링을 확인한다.

### Don't:
- **Don't** 항목마다 카드 상자 + 그림자 + hover 그림자를 씌우지 않는다. `ui/card.tsx`는 남아 있지만 이 시스템에서 쓰지 않는다.
- **Don't** 카드 왼쪽에 굵은 컬러 테두리(`border-l-4` + 색)를 두지 않는다. 색은 제목 앞 작은 사각형 하나로만 쓴다.
- **Don't** `repeat(auto-fill, minmax(300px, 1fr))` 카드 그리드로 짧은 목록을 펼쳐 오른쪽을 텅 비게 두지 않는다.
- **Don't** 고정 높이 상자 안에 내부 스크롤(`h-[20rem] overflow-y-auto`)을 만들지 않는다. 내용 높이 그대로 두고 필요하면 `line-clamp`를 쓴다.
- **Don't** 제목 앞에 이모지를 붙이지 않는다. 사용자가 입력한 데이터(카테고리 emoji 등)는 그대로 둔다.
- **Don't** 색을 채운 알약 배지(초록·빨강·파랑 바탕)나 `bg-amber-50 border-amber-300` 류 색 상자 안내를 쓰지 않는다.
- **Don't** 링크 색(`text-[#4361ee]`)이나 팔레트 값(`text-slate-500`, `bg-blue-50`)을 직접 쓰지 않는다.
- **Don't** 4px보다 둥근 모서리를 쓰지 않는다(다이얼로그 6px 예외). `rounded-full`은 숫자 공·점·아바타에만 쓴다.
- **Don't** hover 때 크기·그림자·위치를 바꾸지 않는다.
- **Don't** 11px 미만 글씨를 쓰지 않고, 본문·버튼에 명조를 쓰지 않는다.
- **Don't** 다크 변형이나 `dark:` 유틸리티를 만들지 않는다.
