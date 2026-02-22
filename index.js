import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import pg from "pg";

const app = express();
app.set("trust proxy", 1);

app.use(express.json({ limit: "5mb" })); 
app.use(
  cors({
    origin: "*",
    exposedHeaders: ["Mcp-Session-Id"],
  })
);

app.get("/", (req, res) => res.status(200).send("ok"));

/** ---------------------------
 * 1. DB 연결 설정 및 디버깅 로그
 * -------------------------- */
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.query('SELECT NOW()', (err, res) => {
  if (err) console.error('❌ [디버깅] DB 연결 실패:', err.message);
  else console.log('✅ [디버깅] PostgreSQL DB 연결 성공! (연결 시각:', res.rows[0].now, ')');
});

/** ---------------------------
 * 2. 만능 MCP 서버 도구 (SELECT/WITH 지원)
 * -------------------------- */
function createMcpServer() {
  const server = new McpServer({
    name: "dcurvin-master-agent",
    version: "2.2.0",
  });

  // [도구 1] 테이블 목록 조회
  server.tool(
    "list_tables",
    "DB에 존재하는 모든 테이블 목록을 조회합니다. 새로운 테이블이 추가되었는지 확인할 때 사용하세요.",
    {},
    async () => {
      console.log('🔎 [디버깅] 테이블 목록 스캔 중...');
      try {
        const query = "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'";
        const result = await pool.query(query);
        return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `테이블 조회 에러: ${error.message}` }] };
      }
    }
  );

  // [도구 2] 테이블 구조 확인
  server.tool(
    "get_table_schema",
    "특정 테이블의 컬럼명과 데이터 타입을 확인합니다. 쿼리 작성 전 필수 단계입니다.",
    { tableName: z.string().describe("구조를 확인할 테이블 이름") },
    async ({ tableName }) => {
      console.log(`🔎 [디버깅] '${tableName}' 테이블 구조 파악 중...`);
      try {
        const query = "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1";
        const result = await pool.query(query, [tableName]);
        return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `구조 조회 에러: ${error.message}` }] };
      }
    }
  );

  // [도구 3] 안전한 쿼리 실행 (WITH/SELECT 허용)
  server.tool(
    "run_select_query",
    "데이터 조회를 위한 SQL(SELECT/WITH)을 실행합니다. V2 제품 필터링이나 메일 요약 시 사용하세요.",
    { sql_query: z.string().describe("실행할 SQL 쿼리문") },
    async ({ sql_query }) => {
      console.log(`🚀 [디버깅] 쿼리 실행 요청:\n${sql_query}`);
      try {
        const upperQuery = sql_query.trim().toUpperCase();
        
        // 보안 필터: SELECT/WITH로 시작하는지 검사
        if (!upperQuery.startsWith("SELECT") && !upperQuery.startsWith("WITH")) {
          return { content: [{ type: "text", text: "보안 에러: SELECT 또는 WITH 구문만 사용할 수 있습니다." }] };
        }

        // 위험 명령어 차단
        const forbidden = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i;
        if (forbidden.test(sql_query)) {
          return { content: [{ type: "text", text: "보안 에러: 데이터 훼손 명령어가 감지되었습니다." }] };
        }

        const result = await pool.query(sql_query);
        console.log(`✅ [디버깅] 쿼리 결과: ${result.rowCount}건 반환`);
        return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
      } catch (error) {
        console.error('❌ [디버깅] 쿼리 실행 실패:', error.message);
        return { content: [{ type: "text", text: `SQL 실행 에러: ${error.message}` }] };
      }
    }
  );

  return server;
}

/** ---------------------------
 * 3. n8n 통신 처리
 * -------------------------- */
const transports = {}; 

async function mcpPostHandler(req, res) {
  const sessionIdFromHeader = req.headers["mcp-session-id"]; 
  let transport;

  if (sessionIdFromHeader && transports[sessionIdFromHeader]) {
    transport = transports[sessionIdFromHeader];
  } else if (!sessionIdFromHeader && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        transports[newSessionId] = transport;
        console.log(`✅ [연결] 새 세션 시작: ${newSessionId}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        console.log(`🔌 [종료] 세션 닫힘: ${transport.sessionId}`);
      }
    };

    const server = createMcpServer();
    await server.connect(transport);
  } else {
    res.status(400).json({ error: "Invalid session" });
    return;
  }

  await transport.handleRequest(req, res, req.body);
}

app.post("/mcp", mcpPostHandler);
app.get("/mcp", (req, res) => {
  const sid = req.headers["mcp-session-id"];
  if (sid && transports[sid]) transports[sid].handleRequest(req, res);
  else res.status(400).send("No session");
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 MCP 서버 Ready (Port: ${PORT})`));
