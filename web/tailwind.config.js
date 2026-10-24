/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // 본문. 시스템 글꼴은 폰트 로드 실패 시의 대비책일 뿐이다.
        sans: ['"IBM Plex Sans KR"', "-apple-system", "BlinkMacSystemFont", '"Apple SD Gothic Neo"', "sans-serif"],
        // 섹션 제목·마스트헤드. 본문에 쓰지 않는다.
        serif: ["Hahmlet", '"Apple Myungjo"', "serif"],
        // 종목코드·시각·순위 같은 기계적인 값
        mono: ['"IBM Plex Mono"', "ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // 안내 톤. Notice·StatusTag 외에도 경고 글씨에 text-tone-warn 처럼 쓸 수 있다.
        tone: {
          error: "hsl(var(--tone-error))",
          warn: "hsl(var(--tone-warn))",
          info: "hsl(var(--tone-info))",
          success: "hsl(var(--tone-success))",
        },
        // 활성 탭 고유색(App 이 --tab 을 갈아 끼운다)
        tab: "var(--tab)",
        // 경고·오류 배너와 증시 상승에 공용으로 쓰는 빨강. 전 탭이 text-up/bg-up/border-up 으로 쓴다.
        up: "#d63a2b",
        // 증시 하락 색. 한국 증시 관례(상승 빨강 / 하락 파랑)를 따른다 — up 은 위 토큰을 재사용하고
        // 하락만 파랑 토큰을 따로 둔다.
        "stock-down": "#1f5fd6",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [],
};
