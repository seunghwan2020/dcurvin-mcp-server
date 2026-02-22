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

app.use(express.json({ limit: "5mb" })); // 이메일 등 긴 텍스트를 위해 용량을 5mb로 넉넉히 늘렸습니다.
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
  if (err) console.error('❌ DB 초기 연결 실패:', err.message);
  else console.log('✅ PostgreSQL DB 연결 성공!');
});

/** ---------------------------
 * 2. 만능 MCP 서버 도구 (마스터키)
 * -------------------------- */
function createMcpServer() {
  const server = new McpServer({
    name: "dcurvin-db-master",
    version: "2.0.0",
  });

  // [만능 도구 1] DB에 있는 모든 테이블 이름 확인
  server.tool(
    "list_tables",
    "PostgreSQL DB에 존재하는 모든 테이블 이름을 조회합니다. 어떤 데이터를 찾아야 할지 모를 때 먼저 이 도구로 테이블 목록을 확인하세요.",
    {},
    async () => {
      try {
        const query = "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'";
        const result = await pool.query(query);
        return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `테이블 조회 에러: ${error.message}` }] };
      }
    }
  );

  // [만능 도구 2] 특정 테이블의 컬럼(열) 구조 확인
  server.tool(
    "get_table_schema",
    "특정 테이블에 어떤 컬럼(데이터 종류)들이 있는지 구조를 확인합니다. SQL 쿼리를 작성하기 전에 반드시 이 도구로 컬럼 이름을 확인하세요.",
    {
      tableName: z.string().describe("구조를 확인할 테이블 이름 (예: emails, inventory_11st, ezadmin_stock)"),
    },
    async ({ tableName }) => {
      try {
        const query = "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1";
        const result = await pool.query(query, [tableName]);
        return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `컬럼 구조 조회 에러: ${error.message}` }] };
      }
    }
  );

  // [만능 도구 3] AI가 직접 작성한 SELECT 쿼리 실행 (읽기 전용 안전장치 포함)
  server.tool(
    "run_select_query",
    "데이터를 가져오기 위해 직접 작성한 SQL SELECT 쿼리를 실행합니다. 복잡한 필터링이나 요약이 필요할 때 사용하세요. 반드시 SELECT 문만 사용해야 합니다.",
    {
      sql_query: z.string().describe("실행할 SQL SELECT 쿼리문 (예: SELECT * FROM emails ORDER BY date DESC LIMIT 5)"),
    },
    async ({ sql_query }) => {
      try {
        // 🚨 안전장치: SELECT로 시작하지 않는 위험한 명령어(DELETE, UPDATE 등)는 차단합니다.
        const upperQuery = sql_query.trim().toUpperCase();
        if (!upperQuery.startsWith("SELECT")) {
          return { content: [{ type: "text", text: "보안 에러: 안전을 위해 오직 SELECT 명령어만 실행할 수 있습니다." }] };
        }

        const result = await pool.query(sql_query);
        return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `SQL 쿼리 실행 에러: ${error.message}` }] };
      }
    }
  );

  return server;
}

/** ---------------------------
 * 3. n8n 통신 (Streamable HTTP)
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
        console.log(`✅ [연결됨] 세션 ID: ${newSessionId}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        console.log(`🔌 [종료됨] 세션 ID: ${transport.sessionId}`);
      }
    };

    const server = createMcpServer();
    await server.connect(transport);
  } else {
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session ID" }, id: null });
    return;
  }

  await transport.handleRequest(req, res, req.body);
}

async function handleSessionRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
}

app.post("/mcp", mcpPostHandler);
app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 만능 DB 에이전트 MCP 서버 구동 완료 (포트: ${PORT})`);
});
