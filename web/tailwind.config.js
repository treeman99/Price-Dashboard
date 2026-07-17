/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
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
        // 가격 변동 색 (명세: 하락 초록, 상승 빨강) — 쇼핑 관점이라 '싸질수록 좋다'
        down: "#2ecc71",
        up: "#e74c3c",
        // 증시 등락 색. 한국 증시 관례(상승 빨강 / 하락 파랑)를 따른다.
        // up 은 위 토큰과 같은 빨강이라 재사용하고, 하락만 파랑 토큰을 따로 둔다
        // — 가격 탭의 down(초록)을 증시에 쓰면 한국식에도 미국식에도 안 맞는 배색이 된다.
        "stock-down": "#2563eb",
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
