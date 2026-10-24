# UI 디자인 가이드 — "조간 브리핑"

대시보드 전 탭이 따르는 화면 규칙이다. 2026-10-24 리디자인에서 정했다.
토대 코드는 `web/src/index.css`, `web/tailwind.config.js`, `web/src/components/ui/page.tsx`, `web/src/App.tsx`(헤더) 에 있다.

## 0. 이번 리디자인의 계약

- **기능은 그대로 둔다.** API 호출, state, effect, 폴링, 핸들러, `confirm()` 문구, 조건부 렌더링 조건, 안내 문구의 의미는 바꾸지 않는다.
  바꾸는 건 마크업 구조와 className, 그리고 정보 배치뿐이다. 표시되던 정보는 하나도 빠뜨리지 않는다.
  보이던 버튼과 링크는 모두 그대로 눌러져야 한다.
- 의미 있는 주석(왜 이렇게 하는지)은 유지한다. 지운 마크업에만 달려 있던 주석은 새 마크업 위치로 옮기거나, 맞지 않으면 고친다.
- 새 npm 의존성은 추가하지 않는다. lucide 아이콘, recharts, 기존 ui 부품만 쓴다.

## 1. 방향

종이(paper) 바탕에 잉크(ink)로 찍은 아침 신문처럼 만든다. 정보 밀도는 높이고 장식은 줄인다.

| 하지 말 것 (AI 템플릿 티)                                            | 대신                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------ |
| 항목마다 `Card` 상자 + 그림자 + hover 그림자                        | 헤어라인으로 나눈 **행(row)**, 표(`.dtable`), 신문 다단       |
| 카드 왼쪽 컬러 굵은 테두리(`border-l-4` + 색)                        | 색은 섹션 제목 앞 작은 사각형(accent) 하나로                 |
| `grid-cols-[repeat(auto-fill,minmax(300px,1fr))]` 카드 그리드       | 표·목록을 화면 폭 끝까지, 짧은 목록은 다단으로 배치          |
| 1~3개짜리 줄이 5칸 그리드에 놓여 오른쪽이 텅 빈 화면               | 카테고리 블록 자체를 다단에 흘려 넣어 빈칸을 없앤다          |
| 고정 높이 카드 안의 내부 스크롤(`h-[20rem] overflow-y-auto`)         | 내용 높이 그대로, 필요하면 `line-clamp`                      |
| 제목 앞 이모지(📊 ⭐ 💼 🏛 🎱 🧩)                                     | 지운다. 사용자가 입력한 데이터(카테고리 emoji 등)는 유지     |
| 색을 채운 알약 배지(초록·빨강·파랑 bg)                              | `StatusTag`(색 글씨 + 얇은 테두리)                          |
| `bg-amber-50 border-amber-300` 류 상자 안내                         | `Notice`(왼쪽 3px 선 + 옅은 바탕, 글씨는 잉크색)            |
| 링크 색 하드코딩(`text-[#4361ee]`, `text-[#1a7f37]`)                 | `TextLink`(회색 → hover 잉크+밑줄)                          |
| `text-slate-500`, `bg-blue-50` 같은 팔레트 직접 지정                | 토큰(`text-muted-foreground`, `bg-muted`, `tone-*`)         |

## 2. 토큰

- 바탕 `bg-background`(종이 #F6F4EE). 떠 있는 면(다이얼로그·팝오버)만 `bg-card`.
- 글씨 `text-foreground`(잉크), 보조 `text-muted-foreground`.
- 선: 헤어라인 `border`(기본 border 색). 굵은 괘선 `border-foreground`.
- 옅은 바탕(hover·눌린 상태·코드 칩) `bg-muted`, `bg-muted/60`.
- 톤: `tone-error` / `tone-warn` / `tone-info` / `tone-success`. 투명도는 `bg-tone-warn/10`처럼 붙일 수 있다.
- 탭 고유색: `text-tab` / `bg-tab` / `border-tab`. CSS 변수라서 `/50` 같은 투명도는 붙지 않는다.
- 증시: 상승 `text-up`, 하락 `text-stock-down`. 한국 관례대로 빨강↑ 파랑↓.
- 글꼴
  - `font-sans`(IBM Plex Sans KR)는 기본이라 따로 쓸 필요 없다.
  - `font-serif`(Hahmlet)는 **섹션 제목·큰 숫자 헤드라인에만** 쓴다.
  - `font-mono`(IBM Plex Mono)는 종목코드, 시각, 순위, 회차 번호에 쓴다.
  - 숫자 열에는 `.num`(tabular-nums)을 붙인다.
- 크기: 본문 14~15px, 행 제목 15px `font-medium`~`font-semibold`, 메타 12~13px. 11px 미만은 쓰지 않는다.
- 모서리: `rounded-md`(4px) 이하만 쓴다. `rounded-full`은 숫자 공(로또)·점·아바타에만 쓴다.

## 3. 공통 부품 — `@/components/ui/page`

```tsx
import {
  PageToolbar, Meta, MetaDot, Notice, SectionHeader, SubHeader,
  StatusTag, TextLink, IconAction, EmptyState, EmptyLine, LoadingState,
} from "@/components/ui/page";
```

### 탭 상단 한 줄

```tsx
<PageToolbar
  actions={<>
    <Button variant="outline" onClick={...}><Plus /> 카테고리 추가</Button>
    <Button variant="outline" onClick={refresh} disabled={collecting}>…지금 갱신</Button>
  </>}
>
  <ScheduleControl kind="news" />
  <MetaDot /><Meta>최근 24시간 뉴스</Meta>
  <MetaDot /><Meta>최종 갱신 <strong>{updated}</strong></Meta>
</PageToolbar>
```

### 안내 띠 — 기존 상자형 안내는 전부 이것으로 바꾼다

```tsx
{err && <Notice tone="error">{err}</Notice>}
{busyMsg && <Notice tone="warn">{busyMsg}</Notice>}
{collecting && <Notice tone="info" progress>뉴스를 수집하는 중입니다… 완료되면 자동으로 반영됩니다.</Notice>}
<Notice tone="muted" icon={null}>회색 참고 안내</Notice>
<Notice tone="warn" title="제목 줄" action={<Button size="sm" variant="outline">확인했어요</Button>}>본문</Notice>
```

`Notice`는 기본 `mb-4`를 갖는다. 다이얼로그 안에서는 `className="mb-0"`처럼 덮어쓴다.

### 섹션

```tsx
<SectionHeader
  title="팝업스토어"
  count={popups.length}
  accent={def.color}
  note="경기 등 서울 외"
  actions={<IconAction label="위로" onClick={...}><ChevronUp /></IconAction>}
/>
<SubHeader count={`${items.length}건`} accent="#7C3AED">서울</SubHeader>
```

`SectionHeader`는 위쪽 2px 잉크 괘선을 그린다. 섹션을 상자로 감싸지 말고 이 괘선 하나로만 구분한다.
같은 부모의 첫 섹션은 위 여백이 자동으로 0이 된다.

### 행 동작과 상태

```tsx
<StatusTag tone="urgent">종료임박</StatusTag>   // new | urgent | soon | neutral | info | warn | success | error
<TextLink href={href} icon={<LinkIcon />}>원문</TextLink>
<IconAction label="삭제" danger onClick={...}><Trash2 /></IconAction>
<IconAction label="고정" active={pinned} onClick={...}><Pin /></IconAction>
```

`IconAction`에는 즉시 뜨는 라벨 툴팁이 들어 있다. 같은 버튼에 `title`을 또 달지 않는다.

## 4. 레이아웃 패턴 — 화면 폭을 쓰는 법

`main`은 최대 2400px까지 전체 폭을 쓴다. 기준 화면은 1680×1050(맥북)이고, 1280px에서도 깨지지 않아야 한다.

### A. 데이터 표 `.dtable`

같은 속성을 가진 항목들(팝업 목록, 보유 종목, 스킬 랭킹, 포지션)은 표로 만든다.

```tsx
<div className="overflow-x-auto">
  <table className="dtable">
    <thead><tr><th>이름</th><th className="text-right">가격</th>…</tr></thead>
    <tbody><tr><td>…</td><td className="num text-right">…</td></tr></tbody>
  </table>
</div>
```

- 숫자 열은 오른쪽 정렬과 `.num`을 쓴다.
- 행 동작(수정·삭제)은 마지막 열에 `IconAction`으로 둔다. 평소 `opacity-40`, 행 hover나 포커스 때 100%로 올린다:
  `<tr className="group">` + `<div className="opacity-40 transition-opacity group-hover:opacity-100 focus-within:opacity-100">`.
- 긴 설명은 제목 아래 회색 한 줄(`text-[13px] text-muted-foreground line-clamp-1` 또는 `-2`)로 넣는다.

### B. 신문 다단 — 짧은 목록이 여러 개일 때(뉴스 카테고리 등)

```tsx
<div className="col-rule columns-1 gap-10 lg:columns-2 2xl:columns-3 min-[2200px]:columns-4">
  {groups.map((g) => (
    <section key={g.key} className="mb-8 break-inside-avoid">
      <SectionHeader … className="mt-0" />
      <ul className="divide-y">{…행…}</ul>
    </section>
  ))}
</div>
```

- 카테고리 블록이 세로로 흐르며 칸을 채우므로 1건짜리 카테고리도 빈칸을 만들지 않는다.
- 블록 안의 행은 `divide-y` 헤어라인으로 나눈다. 행 제목은 15px semibold, 메타는 12.5px 회색, 요약은 14px `text-foreground/80`이다.

### C. 행 목록 — 미디어나 긴 요약이 있을 때(유튜브 등)

```tsx
<ul className="grid gap-x-10 [grid-template-columns:repeat(auto-fill,minmax(min(100%,520px),1fr))]">
  <li className="flex gap-4 border-b py-3">썸네일(고정폭) + 본문</li>
</ul>
```

카드 상자가 없는 가로형 행을 여러 열로 깐다. 행 구분은 아래 헤어라인으로만 한다.

### D. 가로 띠(band) — 항목 하나에 차트와 수치와 글이 함께 있을 때(증시 종목)

항목 하나가 전체 폭 한 줄을 차지한다. 왼쪽에 이름·가격·수치, 가운데에 차트, 오른쪽에 요약 글을 둔다.
띠 사이는 헤어라인으로 나눈다. 좁은 화면에서는 세로로 쌓는다(`grid lg:grid-cols-[…]`).

### 공통

- 빈 섹션은 `EmptyLine`(한 줄 회색), 탭 전체가 비면 `EmptyState`, 로딩은 `LoadingState`를 쓴다.
- 행 hover 시 `bg-muted/60` 정도만 준다. 크기·그림자가 변하는 효과는 쓰지 않는다.
- 썸네일·차트를 제외한 상자 테두리는 쓰지 않는다. 꼭 영역을 묶어야 하면 `bg-muted/50` 바탕만 깐다(테두리·그림자 없이).

## 5. 다이얼로그

`DialogContent`, `DialogTitle`(명조)은 토대에서 이미 다시 꾸며 두었다. 각 다이얼로그 안에서는 다음만 정리한다.

- 안쪽의 색 상자 안내는 `Notice`(`className="mb-0"`)로 바꾼다.
- 선택형 버튼 묶음은 테두리 버튼 한 줄로 두되, 선택된 것은 `border-foreground bg-foreground text-background`로 표시한다.
- 목록 행은 `divide-y`로 나누고 행마다 `rounded-md border` 상자를 두지 않는다.

## 6. 검증

- 타입체크: `cd web && npx tsc --noEmit -p .`. 여러 사람이 동시에 고치는 중이면 자기 파일 오류만 본다.
- 화면: 배정받은 포트로 `cd web && npx vite --port <PORT> --strictPort`를 띄운다(`/api`는 7777로 프록시된다).
  1680×1050과 1280×800에서 스크린샷을 찍어 확인한다.
- 수정 전 화면은 `.playwright-mcp/before-<tab>.png`에 있다.
- 기능 회귀 점검: 해당 탭의 모든 버튼, 링크, 다이얼로그 열기·닫기가 그대로 동작하는지 확인한다.
  저장·삭제처럼 데이터를 바꾸는 동작은 실제로 누르지 말고, 핸들러 연결이 그대로인지 코드로 확인한다.
