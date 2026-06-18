import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "../config.ts";
import { log } from "../util/log.ts";
import { api } from "./routes.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const webDist = path.join(repoRoot, "web", "dist");

export function createApp() {
  const app = express();
  app.use(express.json());

  // API
  app.use("/api", api);

  // 정적 프론트 (web 빌드물). 빌드 전이면 안내 메시지.
  if (fs.existsSync(path.join(webDist, "index.html"))) {
    app.use(express.static(webDist));
    // SPA fallback (API 제외)
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.sendFile(path.join(webDist, "index.html"));
    });
  } else {
    app.get("/", (_req, res) => {
      res
        .status(200)
        .type("html")
        .send(
          `<h2>Daily Price Dashboard</h2><p>프론트가 아직 빌드되지 않았습니다. <code>npm run web:build</code> 후 새로고침하세요.</p><p>API는 <code>/api/health</code> 에서 동작 중입니다.</p>`
        );
    });
  }

  return app;
}

export function startServer() {
  const app = createApp();
  return app.listen(config.port, () => {
    log.info(`API/대시보드 서버 시작: http://localhost:${config.port}`);
  });
}
