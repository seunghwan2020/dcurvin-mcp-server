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
app.use(cors({ origin: "*", exposedHeaders: ["Mcp-Session-Id"] }));

app.get("/", (req, res) => res.status(200).send("ok"));

/** ---------------------------
 * 1. DB 연결 설정
 * -------------------------- */
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.query('SELECT NOW()', (err, res) => {
  if (err) console.error('❌ [DB] 연결 실패:', err.message);
  else console.log('✅ [DB] PostgreSQL 연결 성공 (', res.rows[0].now, ')');
});

/** ---------------------------
 * 2. 만능 MCP 서버 도구 (V2.5.0)
 * -------------------------- */
function createMcpServer() {
  const server = new McpServer({
    name: "dcurvin-master-agent",
    version: "2.5.0",
  });

  // [도구 1] 테이블 리스트
  server.tool("list_tables", "DB의 모든 테이블 목록을 조회합니다.", {}, async () => {
    try {
      const result = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
      return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `에러: ${error.message}` }] };
    }
  });

  // [도구 2] 스키마 확인 (JOIN 키 확인용 필수)
  server.tool(
    "get_table_schema",
    "테이블의 컬럼 구조를 확인합니다. 11번가는 바코드, 물류온은 상품코드 컬럼이 어디인지 확인하세요.",
    { tableName: z.string().describe("테이블 이름") },
    async ({ tableName }) => {
      console.log(`🔎 [구조조회] '${tableName}' 분석 중...`);
      try {
        const query = "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1";
        const result = await pool.query(query, [tableName]);
        return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `에러: ${error.message}` }] };
      }
    }
  );

  // [도구 3] 스마트 쿼리 실행
  server.tool(
    "run_select_query",
    "SQL 조회를 실행합니다. JOIN 쿼리를 통해 매핑된 데이터를 가져올 때 사용하세요.",
    { sql_query: z.string().describe("실행할 SELECT/WITH 쿼리문") },
    async ({ sql_query }) => {
      console.log(`🚀 [쿼리실행] 요청:\n${sql_query}`);
      try {
        const upper = sql_query.trim().toUpperCase();
        if (!upper.startsWith("SELECT") && !upper.startsWith("WITH")) {
          return { content: [{ type: "text", text: "보안 에러: 조회 구문만 허용됩니다." }] };
        }
        if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i.test(sql_query)) {
          return { content: [{ type: "text", text: "보안 에러: 변경 명령어가 감지되었습니다." }] };
        }

        const result = await pool.query(sql_query);
        console.log(`✅ [결과] ${result.rowCount}건 반환`);
        return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `SQL 에러: ${error.message}` }] };
      }
    }
  );

  return server;
}

/** ---------------------------
 * 3. n8n 통신 세션 처리
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
        console.log(`✅ [세션시작] ID: ${newSid}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        console.log(`🔌 [세션종료] ID: ${transport.sessionId}`);
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
app.listen(PORT, () => console.log(`🚀 D.CURVIN 마스터 MCP 가동 (Port: ${PORT})`));
