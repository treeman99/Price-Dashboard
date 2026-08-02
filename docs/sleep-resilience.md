# 맥이 자면 대시보드가 멈춘다 — 원인·대응층·진단

2026-08-02 사고 기록과 재발 대응 정리. 모든 수치는 `pmset -g log` / `logs/stdout.log` / `ps` 실측이다.

> **한 줄 요약**
> 덮개를 닫고 배터리로 두면 맥은 하루 종일 DarkWake(수 초)만 반복한다. 이 앱은 그 몇 초를 얻어 쓰며
> 벽시계로는 몇 시간이 흐른다. **`caffeinate` 로는 못 막는다.** 확실한 건 AC + 덮개 열기이고,
> 나머지는 코드의 슬립 내성으로 버티는 수밖에 없다.

---

## 1. 무슨 일이 있었나

### 1.1 타임라인

| 시각 (KST) | 사건 | 근거 |
|---|---|---|
| 00:29:10 | 덮개 닫힘 → `Clamshell Sleep` 진입 (배터리, 80%) | `pmset -g log` |
| 00:29:12 | 기상 예약 큐에 **이 앱이 없음** — dasd / mDNSResponder / powerd 뿐 | `Wake Requests` 줄 |
| 07:55:01 | 예약 기상 발화. 그러나 **DarkWake 12초** | `... rtc/ Using BATT (Charge:58%) 12 secs` |
| 07:55:13 | 곧장 `Maintenance Sleep` 재진입 | `pmset -g log` |
| 08:35:08 | 뉴스 catch-up 시작 (Codex 큐레이션) | `logs/stdout.log` |
| 09:36:09 | 뉴스 완료 — **61분 걸려 0건** | `뉴스 수집 완료 [catchup] (총 0건, source=empty)` |
| 11:14:35 | 덮개 열림 → 사고 구간 최초의 `Wake` | `due to ... lid ... HID Activity` |
| 11:18~11:44 | 밀려 있던 이벤트·유튜브·뉴스가 **한꺼번에** 완료 | `logs/stdout.log` |

**00:29:10 → 11:14:35, 10시간 45분 25초 동안 FullWake 0회.**

### 1.2 근거 수치

- **가동률 0.05%** — 수집 프로세스 `ELAPSED 16:58:02` 대비 `CPU TIME 0:31.64`.
- **뉴스 61분 구간의 실제 가동 = 50초** — 08:35:08~09:36:09(벽시계 3661초) 사이 DarkWake는
  8회·합계 50초뿐. 가동률 **1.37%**. 같은 작업이 깨어 있을 때는 **133초** 만에 끝났다(11:38~11:41).
- **사고 구간 DarkWake 68회 / 합계 432초** — 평균 6초, 중앙값 7초, 최대 20초.
  10시간 45분 중 실제로 CPU가 돈 시간은 **7분 12초**.

### 1.3 결정적 증거: 하트비트가 DarkWake 위에만 찍힌다

앱 로그의 "진행 중 — N분 경과" 하트비트 시각과 `pmset` DarkWake 시각이 **초 단위로 1:1 일치**한다
(앱 로그는 UTC, +9 하면 KST):

```
앱 00:07:04Z → 09:07:04 KST   ←→   DarkWake 09:07:04
앱 00:15:08Z → 09:15:08 KST   ←→   DarkWake 09:15:08
앱 00:31:36Z → 09:31:36 KST   ←→   DarkWake 09:31:36
앱 01:15:16Z → 10:15:16 KST   ←→   DarkWake 10:15:17
앱 01:37:08Z → 10:37:08 KST   ←→   DarkWake 10:37:09
앱 01:54:33Z → 10:54:33 KST   ←→   DarkWake 10:54:34
```

우연이 아니다. node 의 `setTimeout`/`setInterval` 은 **잠든 동안 흐르지 않고 깨어난 순간 한꺼번에 발화한다.**
그래서 하트비트는 DarkWake 순간에만 찍히고, 그 사이 몇십 분은 앱 입장에서 존재하지 않는 시간이다.

### 1.4 인과 사슬

```
덮개 닫힘 + 배터리
  → Clamshell Sleep (유휴 슬립이 아니라 별도 경로)
  → 풀 웨이크 없이 DarkWake(2~20초)만 반복
  → CPU 기아: 61분 구간에서 실제 가동 50초
  → 그런데 타임아웃·재시도는 벽시계(Date.now) 기준
  → 아무 일도 못 한 채 타임아웃 만료 → 0건 수집
```

핵심은 **"안 깨어났다"가 아니라 "깨어났지만 아무것도 못 하고 다시 잠들었다"** 는 것이다.
이걸 헷갈리면 엉뚱한 데를 고치게 된다.

### 1.5 구조적 원인 — 아무도 이 앱을 위해 깨워달라고 하지 않았다

`Wake Requests` 큐(00:29:12)에 있던 것은 전부 시스템 데몬이다.

```
[process=dasd        request=SleepService  wakeAt=00:45:25  info="com.apple.filevault.healthanalytics"]
[process=mDNSResponder request=Maintenance wakeAt=01:46:32  info="DHCP lease renewal"]
[process=powerd      request=TCPKATurnOff  wakeAt=08-05 16:30:10]
[process=powerd      request=UserWake      wakeAt=01:02:06  info="...calaccessd.travelEngine..."]
```

이 앱의 요청은 **한 줄도 없다.** 이유는 두 가지다.

1. **launchd plist 에 `StartCalendarInterval` 이 없다.** `KeepAlive` 만 있는데, 이건 *죽은 프로세스를
   되살리는* 장치일 뿐 *자는 맥을 깨우는* 장치가 아니다. 살아 있는 프로세스에게 `KeepAlive` 는 무의미하다.
2. **스케줄링을 프로세스 내부의 `node-cron`(= `setTimeout`)이 담당한다.** 이건 애초에 시스템을 깨울
   능력이 없는 API 다. 잠들면 같이 멈춘다.

즉 기상 예약 큐에 등록되려면 **커널이 아는 방법**(launchd `StartCalendarInterval`, `pmset schedule`,
`IOPMSchedulePowerEvent`)을 써야 하는데, 셋 중 아무것도 쓰고 있지 않았다.

---

## 2. 세 가지 대응층과 각각의 한계

### 층 1 — 안 재우기

| 수단 | 효과 | 한계 |
|---|---|---|
| **AC 연결 + 덮개 열기** | ✅ 확실 | AC 설정이 `sleep 0`(유휴 슬립 없음)이라 아예 안 잔다. **유일하게 실측 검증된 조합** |
| `caffeinate -i` (코드) | △ 부분 | 덮개 열린 상태의 유휴 슬립만 막는다. **클램셸 슬립은 못 막는다** |
| `caffeinate -s` | △ AC 전용 | `man caffeinate`: *"valid only when system is running on AC power"* |
| `pmset disablesleep 1` | ⚠ 비권장 | 아래 별도 항목 |

**★ `caffeinate` 가 이번 사고를 막지 못하는 이유 (반드시 이해할 것)**

덮개를 닫으면 macOS 는 유휴 슬립이 아니라 `Clamshell Sleep` 이라는 **별도 경로**로 잠든다.
`caffeinate -i` 가 만드는 `PreventUserIdleSystemSleep` 어서션은 *유휴* 슬립을 겨냥하므로 여기에 걸리지 않는다.

그리고 **AC 를 꽂아도 마찬가지다.** 실측:

```
2026-07-29 18:46:04  Entering Sleep state due to 'Clamshell Sleep':... Using AC (Charge:80%)
```

유휴가 아닌 슬립까지 겨냥하는 어서션은 `PreventSystemSleep`(`caffeinate -s`) 하나뿐인데,
man 이 AC 전용이라고 못박았다. **배터리 + 덮개 닫힘 조합에서는 사용자 공간에서 걸 수 있는 어서션이 사실상 없다.**

> 미검증 항목: `caffeinate -s` 가 **AC 상태에서** 클램셸 슬립까지 붙잡아 주는지는 이 맥에서 확인하지 않았다.
> 확인하려면 AC 연결 → `caffeinate -s -t 600` 실행 → 덮개 닫고 10분 뒤
> `pmset -g log | grep "Clamshell Sleep"` 에 새 줄이 생겼는지 보면 된다. 검증 전에는 된다고 가정하지 말 것.

**⚠ `pmset disablesleep 1` 을 기본값에 넣지 않는 이유**

`sudo pmset -a disablesleep 1` 은 덮개를 닫아도 잠들지 않게 만든다 — 이 문제를 *직접* 해결하는 유일한
pmset 옵션이다. 그럼에도 `tools/setup-power.sh` 는 이걸 하지 않는다.

- **과열.** 덮개를 닫은 채 풀가동하면 배출이 막힌다. 가방에 넣으면 위험 수준이 된다.
- **급방전.** 배터리로 두면 몇 시간 만에 바닥나고, 방전 방치는 배터리 수명을 깎는다.
- **되돌리기를 잊는다.** 잊으면 노트북이 영구히 안 자는 상태로 남는다.

굳이 쓴다면 **AC 연결 + 덮개 열림 + 짧은 기간**에만. 해제는 `sudo pmset -a disablesleep 0`.

### 층 2 — 깨우게 하기

**★ 제약: `pmset repeat` 은 반복 기상을 하나만 걸 수 있다.**
`man pmset` SCHEDULED EVENT ARGUMENTS 원문:

> *"Note that you may only have one pair of repeating events scheduled — a 'power on' event and a 'power off' event."*

즉 **반복 기상은 시각 1개**뿐이다(요일은 `MTWRFSU` 부분집합 지정 가능하지만 시각은 하나).
수집 스케줄이 08:00 / 09:00 / 10:00 / 17:00 / 19:00 다섯 개인데 이걸 전부 예약할 방법이 `repeat` 에는 없다.
→ 가장 중요한 아침 배치(08:00) 하나를 고르는 수밖에 없다. `tools/setup-power.sh` 가 그렇게 한다.

**★ 그런데 기존 07:55 반복 기상은 왜 사고를 못 막았나 — 발화했는데도 소용없었다**

먼저, 예약은 **정상 등록되어 있었고 채택까지 됐다.** 07:51:57 `Wake Requests` 줄:

```
[*process=powerd request=UserWake deltaSecs=182 wakeAt=2026-08-02 07:55:00]
```

`*` 는 가장 이른 기상 = 실제 채택된 항목이라는 표시다. 그리고 실제로 발화했다:

```
07:55:01  DarkWake from Deep Idle [CDNP] : due to ... rtc/ Using BATT (Charge:58%) 12 secs
07:55:13  Entering Sleep state due to 'Maintenance Sleep'
```

(`rtc/` 뒤 소유자 문자열이 비어 있는 것이 pmset 예약 기상의 표식이다. 다른 rtc 기상은
`rtc/SleepService`, `rtc/Maintenance` 처럼 소유자가 붙는다.)

**실패한 이유 두 가지:**

1. **FullWake 가 아니라 DarkWake 로 전달됐다.** 덮개가 닫혀 있으면 macOS 는 예약 기상을 다크웨이크로만
   준다. 화면도 없고 사용자도 없으니 풀 웨이크를 할 이유가 없다고 보는 것이다.
2. **12초 만에 도로 잠들었다.** 아무도 어서션을 잡지 않았으므로 유지보수 용무가 끝나자 즉시
   `Maintenance Sleep` 로 복귀했다. 08:00 배치까지 5분을 버텨야 하는데 12초를 버텼다.

여기에 하나 더: **배터리 유휴 슬립이 `sleep 1`(1분)** 이다. 설령 FullWake 를 받았더라도
07:55 에 깨어나 07:56 에 도로 잠들어 08:00 배치를 놓쳤을 것이다.
→ 그래서 `setup-power.sh` 는 기상 시각을 08:00 에 바짝 붙이고(**07:58**),
   **배터리 유휴 슬립을 1분 → 10분**으로 늘린다. 둘은 세트이고, 하나만 하면 효과가 없다.

**★ 대안: 앱이 매일 다음 기상을 스스로 예약하는 방식 — sudo 때문에 불가능**

`pmset repeat` 이 하나뿐이니, 앱이 `pmset schedule` 로 다음 기상 시각을 그때그때 예약하면
여러 슬롯을 덮을 수 있다. **실제로 시도해 봤고, 안 된다.**

```
$ pmset schedule wake "12/25/26 03:00:00" "orca-probe"
pmset: This operation must be run as root      # rc=1, 아무것도 등록되지 않음
```

launchd **LaunchAgent**(사용자 권한)로 도는 이 앱은 root 가 아니므로 이 경로를 쓸 수 없다. 남는 선택지:

| 방법 | 실현성 | 비고 |
|---|---|---|
| `sudoers` 에 `NOPASSWD: /usr/bin/pmset` 추가 | 가능하나 **비권장** | 앱에 사실상 부분 root 를 주는 것. 이 정도 편의에 감당할 위험이 아니다 |
| root `LaunchDaemon` 분리 | 가능 | 별도 데몬을 만들어 예약만 담당. 복잡도가 크게 오른다 |
| plist 에 `StartCalendarInterval` 추가 | **가장 현실적** | launchd 표준 기능이고 sudo 불필요. 다만 *깨우는* 보장은 없고 깨어 있을 때 정시 실행을 보장한다 |

> plist 변경은 이 문서 범위 밖이다. `~/Library/LaunchAgents/com.daegun.dailyprice.plist` 는
> 직접 수정하지 말고 변경안을 별도로 검토할 것.

### 층 3 — 자도 안 깨지게 (코드 슬립 내성)

층 1·2 로 "배터리 + 덮개 닫힘"을 막을 수 없다는 게 위에서 확인됐다. 그래서 **본류는 이쪽**이다.

- 타임아웃을 벽시계가 아니라 **실제 진행**(토큰 수신, 단계 완료) 기준으로 판정
- 깨어난 뒤 밀린 슬롯을 감지해 catch-up (이미 동작 중 — 11:18~11:44 에 몰아서 완료된 것이 그 증거)
- 작업이 도는 동안 `withWakeLock()` 으로 재수면 지연

이 층은 별도 작업으로 구현 중이다. 이 문서는 그 전제(왜 필요한지)를 기록한다.

### 코드 쪽 어서션: `src/util/power.ts`

```ts
await withWakeLock("뉴스 수집", async () => { /* ... */ });
```

`/usr/bin/caffeinate -i -m -s -w <앱 pid> -t 7200` 을 자식으로 띄우고 작업이 끝나면 `finally` 에서 죽인다.

- `-w <앱 pid>` — 앱이 급사해도 어서션이 남지 않는다. **SIGKILL 실측 검증됨**(앱을 죽이면 caffeinate 도 사라짐).
- `-t 7200` — `finally` 가 못 돌았을 때의 최후 방어선. 이 앱은 `KeepAlive` 로 상시 떠 있어서 `-w` 도
  영원히 안 터지므로, 상한이 없으면 영구 누수가 가능하다.
- 중첩·병렬 호출은 참조 카운트로 묶여 caffeinate 는 항상 1개다.
- caffeinate 가 없거나 실패해도 경고 한 줄만 남기고 **작업은 그대로 진행한다.**

**효용은 딱 두 가지다.** (a) 덮개 열린 채 유휴 슬립 방지 (b) 깨어난 뒤 작업이 끝날 때까지 재수면 지연.
클램셸 슬립은 못 막는다 — 위 층 1 참고.

---

## 3. 재발 시 5분 진단 절차

증상: "아침 탭이 비어 있다" / "수집이 몇 시간째 진행 중이다".

### ① 맥이 잤는지 먼저 본다 (30초)

```bash
pmset -g log | grep -E "Clamshell Sleep|DarkWake" | tail -30
```

- `Entering Sleep state due to 'Clamshell Sleep'` 가 보이면 → **덮개 닫힘 슬립**. 여기서 거의 확정이다.
- `DarkWake ... N secs` 의 N 이 한 자릿수~20초대로 반복되면 → **CPU 기아**. 앱 잘못이 아니다.

### ② 프로세스가 실제로 돌았는지 본다 (30초)

```bash
# ★ 주의: 자식 프로세스를 봐야 한다. 부모(tsx 런처)는 CPU 를 거의 안 쓴다.
ps -eo pid,ppid,etime,time,command | grep "[s]rc/index.ts"
```

```
57469     1  16:58:02  0:00.37  node .../tsx/dist/cli.mjs src/index.ts   ← 런처(무시)
57477 57469  16:58:02  0:31.64  node --require ... src/index.ts          ← ★ 이걸 봐야 한다
```

`ELAPSED` 대비 `TIME`(CPU) 이 **0.1% 미만**이면 잠들어 있었다는 뜻이다. 정상 가동이면 훨씬 높다.

### ③ 로그 하트비트 시각을 DarkWake 시각과 대조한다 (2분)

이게 **결정타**다. 앱 로그는 UTC 이므로 +9 해서 KST 로 맞춘다.

```bash
grep "진행 중" logs/stdout.log | tail -20                       # 앱이 살아 있던 순간들
pmset -g log | grep DarkWake | grep "^$(date +%Y-%m-%d)" | tail -20   # 맥이 깨어 있던 순간들
```

두 목록의 시각이 **초 단위로 겹치면 확정**이다: 앱은 DarkWake 때만 실행됐고, 그 사이는
앱 입장에서 존재하지 않는 시간이었다. (node 타이머는 잠든 동안 흐르지 않고 깨어난 순간 발화한다.)

### ④ 오진하지 말 것

| 진짜 원인 | 오진하기 쉬운 것 | 구분법 |
|---|---|---|
| 슬립/CPU 기아 | "LLM 이 느리다·장애다" | 같은 작업이 깨어 있을 때 133초 → 자면 61분. **토큰 수는 정상**이다 |
| 슬립/CPU 기아 | "네트워크 문제" | DarkWake 시각과 하트비트가 일치하면 슬립이다 |
| 슬립/CPU 기아 | "스케줄러 버그" | `pmset -g log` 에 `Clamshell Sleep` 이 있는지부터 본다 |

### ⑤ 어서션이 새고 있는지 (역방향 점검)

반대로 **맥이 안 자는** 증상이면 어서션 누수를 의심한다.

```bash
pmset -g assertions | grep -A2 caffeinate
pgrep -laf "caffeinate -i -m -s"     # 수집이 안 도는데 남아 있으면 누수
```

수집 작업이 없는데 이 앱이 띄운 caffeinate 가 남아 있으면 버그다. `-t 7200` 때문에 최대 2시간이면
저절로 사라지지만, 그 전이라도 해당 pid 를 죽이면 즉시 해제된다.

---

## 4. 운영 권장

1. **수집 시간대(08:00~10:00, 17:00, 19:00)에 덮개를 닫아야 한다면 AC 를 연결한다.**
   AC 가 클램셸 슬립 자체를 막지는 못하지만(§2 실측), 배터리보다 낫다:
   `caffeinate -s` 가 AC 에서만 유효하고, 열·전력 여유가 있어 유지보수 창이 덜 인색하다.
2. **가장 확실한 건 AC + 덮개 열기다.** AC 설정이 `sleep 0` 이라 유휴 슬립이 아예 없다.
   실측으로 검증된 유일한 조합이므로, 그날 수집이 중요하면 이렇게 둔다.
3. **배터리 + 덮개 닫힘은 "수집 안 되는 상태"로 간주한다.** 막을 방법이 없다.
   깨어난 뒤 catch-up 이 밀린 슬롯을 처리해 주길 기대하는 수밖에 없다(실제로 11:18~11:44 에 그렇게 복구됐다).
4. **`tools/setup-power.sh` 를 한 번 실행해 둔다.** 덮개가 *열려* 있을 때의 실패는 이걸로 막힌다.
   ```bash
   bash tools/setup-power.sh      # 현재 설정 출력 → 변경안 확인 → y/N → sudo
   ```
   되돌리기:
   ```bash
   sudo pmset repeat cancel
   sudo pmset repeat wake MTWRFSU 07:55:00   # 원래 있던 "매일 7:55AM 기상"
   sudo pmset -b sleep 1                     # 원래 배터리 유휴 슬립
   ```
5. **다음 날 아침 검증.** 예약이 실효를 냈는지 확인한다.
   ```bash
   pmset -g log | grep -E "rtc/ |Clamshell Sleep" | tail -20
   ```
   `DarkWake ... rtc/ ... N secs` 의 N 이 여전히 한 자릿수면 못 붙잡은 것이다.

---

## 참고

- `man pmset` — SCHEDULED EVENT ARGUMENTS (반복 이벤트 1쌍 제약), SETTINGS (`sleep`, `disablesleep`)
- `man caffeinate` — `-i` / `-m` / `-s`(AC 전용) / `-w` / `-t`
- `src/util/power.ts` — `withWakeLock()` 구현과 플래그 선택 근거
- `tools/setup-power.sh` — 기상 예약 설정 스크립트(사용자가 직접 실행)
