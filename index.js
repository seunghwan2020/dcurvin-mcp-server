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
 * 1. DB 연결 설정
 * -------------------------- */
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.query('SELECT NOW()', (err, res) => {
  if (err) console.error('❌ [DB 에러] 연결 실패:', err.message);
  else console.log('✅ [DB 성공] PostgreSQL 연결 완료 (', res.rows[0].now, ')');
});

/** ---------------------------
 * 2. 만능 MCP 서버 도구 (매핑 최적화)
 * -------------------------- */
function createMcpServer() {
  const server = new McpServer({
    name: "dcurvin-master-agent",
    version: "2.4.0",
  });

  // [도구 1] 테이블 목록 조회
  server.tool(
    "list_tables",
    "DB의 전체 테이블 목록을 확인합니다.",
    {},
    async () => {
      console.log('🔎 [로그] 테이블 목록 스캔');
      try {
        const query = "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'";
        const result = await pool.query(query);
        return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `에러: ${error.message}` }] };
      }
    }
  );

  // [도구 2] 테이블 구조 확인 (매핑 관계 파악용)
  server.tool(
    "get_table_schema",
    "특정 테이블의 컬럼 구성을 확인합니다. JOIN 쿼리 작성 전 필수 단계입니다.",
    { tableName: z.string().describe("구조를 확인할 테이블 이름") },
    async ({ tableName }) => {
      console.log(`🔎 [로그] '${tableName}' 스키마 조회`);
      try {
        const query = "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1";
        const result = await pool.query(query, [tableName]);
        return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `에러: ${error.message}` }] };
      }
    }
  );

  // [도구 3] 데이터 조회 (SELECT/WITH)
  server.tool(
    "run_select_query",
    "SQL 조회를 실행합니다. product_mapping 테이블을 JOIN하여 공식 명칭을 가져올 때 사용하세요.",
    { sql_query: z.string().describe("실행할 SELECT/WITH 쿼리문") },
    async ({ sql_query }) => {
      console.log(`🚀 [로그] 쿼리 실행:\n${sql_query}`);
      try {
        const upper = sql_query.trim().toUpperCase();
        if (!upper.startsWith("SELECT") && !upper.startsWith("WITH")) {
          return { content: [{ type: "text", text: "보안 에러: 조회를 위한 SELECT/WITH 문만 허용됩니다." }] };
        }

        const forbidden = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i;
        if (forbidden.test(sql_query)) {
          return { content: [{ type: "text", text: "보안 에러: 데이터 변경 명령어가 감지되었습니다." }] };
        }

        const result = await pool.query(sql_query);
        console.log(`✅ [로그] ${result.rowCount}건 반환`);
        return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
      } catch (error) {
        console.error('❌ [로그] SQL 에러:', error.message);
        return { content: [{ type: "text", text: `에러: ${error.message}` }] };
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
  const sid = req.headers["mcp-session-id"]; 
  let transport;

  if (sid && transports[sid]) {
    transport = transports[sid];
  } else if (!sid && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSid) => {
        transports[newSid] = transport;
        console.log(`✅ [세션] 시작: ${newSid}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        console.log(`🔌 [세션] 종료: ${transport.sessionId}`);
      }
    };

    const server = createMcpServer();
    await server.connect(transport);
  } else {
    res.status(400).json({ error: "Invalid Session" });
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
app.listen(PORT, () => console.log(`🚀 MCP 서버 구동 중 (Port: ${PORT})`));
