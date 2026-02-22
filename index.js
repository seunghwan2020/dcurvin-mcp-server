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

app.use(express.json({ limit: "2mb" }));
app.use(
  cors({
    origin: "*",
    exposedHeaders: ["Mcp-Session-Id"],
  })
);

// 헬스체크
app.get("/", (req, res) => res.status(200).send("ok"));

/** ---------------------------
 * 1. DB 연결 설정 및 디버깅
 * -------------------------- */
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// 서버가 켜질 때 DB 연결이 정상인지 테스트합니다.
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ [디버깅] DB 초기 연결 실패! DATABASE_URL을 확인하세요:', err.message);
  } else {
    console.log('✅ [디버깅] PostgreSQL DB 연결 성공! (현재 시간:', res.rows[0].now, ')');
  }
});

/** ---------------------------
 * 2. MCP 서버 및 도구(Tools) 생성
 * -------------------------- */
function createMcpServer() {
  const server = new McpServer({
    name: "dcurvin-ai-bridge",
    version: "1.0.0",
  });

  // 🛠️ 디버깅 도구: 현재 DB에 있는 진짜 테이블 이름 스캔
  server.tool(
    "list_database_tables",
    "PostgreSQL DB에 존재하는 모든 테이블 목록을 조회합니다. 테이블을 찾을 수 없다는 에러가 날 때 가장 먼저 이 도구를 사용하세요.",
    {},
    async () => {
      console.log('🔎 [디버깅] AI가 테이블 목록 스캔(list_database_tables)을 요청했습니다.');
      try {
        const query = "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'";
        const result = await pool.query(query);
        console.log(`✅ [디버깅] 찾은 테이블 목록: ${result.rows.map(r => r.table_name).join(', ')}`);
        return {
          content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
        };
      } catch (error) {
        console.error('❌ [디버깅] 테이블 목록 조회 실패:', error.message);
        return {
          content: [{ type: "text", text: `테이블 목록 조회 에러: ${error.message}` }],
        };
      }
    }
  );

  // 📦 메인 도구: 11번가 재고 조회
  server.tool(
    "get_11st_orders",
    "11번가 채널의 최근 재고 내역을 가져옵니다. 주의: 만약 inventory_11st 테이블이 없다고 나오면 먼저 list_database_tables 도구를 써서 진짜 테이블 이름을 확인하세요.",
    {
      limit: z.number().default(5).describe("가져올 데이터 건수 (기본 5건)"),
    },
    async ({ limit }) => {
      console.log(`🔎 [디버깅] AI가 11번가 재고 스캔(get_11st_orders)을 요청했습니다. (제한: ${limit}건)`);
      try {
        const query = "SELECT * FROM inventory_11st ORDER BY fetched_date DESC, fetched_time DESC LIMIT $1";
        const result = await pool.query(query, [limit]);
        console.log(`✅ [디버깅] 11번가 데이터 조회 성공! (${result.rowCount}건 반환)`);
        return {
          content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
        };
      } catch (error) {
        console.error('❌ [디버깅] 11번가 데이터 조회 실패:', error.message);
        return {
          content: [{ type: "text", text: `DB 조회 중 에러가 발생했습니다: ${error.message}` }],
        };
      }
    }
  );

  return server;
}

/** ---------------------------
 * 3. n8n 통신 (Streamable HTTP) 처리
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
        console.log(`✅ [MCP 통신] 새로운 n8n 세션 연결됨: ${newSessionId}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        console.log(`🔌 [MCP 통신] n8n 세션 종료됨: ${transport.sessionId}`);
      }
    };

    const server = createMcpServer();
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID provided" },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
}

async function handleSessionRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
}

app.post("/mcp", mcpPostHandler);
app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 MCP 서버 구동 완료 (포트: ${PORT})`);
});
