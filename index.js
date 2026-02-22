import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

// (선택) SSE도 같이 유지하고 싶으면 아래 1줄 유지
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import { z } from "zod";
import pg from "pg";

const app = express();
app.set("trust proxy", 1);

/**
 * ✅ 중요: n8n이 보내는 JSON 바디를 읽어야 Streamable HTTP가 동작함
 */
app.use(
  express.json({
    limit: "2mb",
  })
);

/**
 * ✅ 중요: Streamable HTTP는 헤더에 Mcp-Session-Id를 주고받음
 * 클라이언트가 이 헤더를 읽을 수 있게 exposedHeaders 설정 필요
 */
app.use(
  cors({
    origin: "*",
    exposedHeaders: ["Mcp-Session-Id"],
  })
);

// 헬스체크
app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.status(200).send("ok"));

/** ---------------------------
 * DB 연결 설정
 * -------------------------- */
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/** ---------------------------
 * MCP 서버 생성 함수
 * -------------------------- */
function createMcpServer() {
  const server = new McpServer({
    name: "dcurvin-ai-bridge",
    version: "1.0.0",
  });

  // ✅ D.CURVIN 11번가 재고 조회용 Tool
  server.tool(
    "get_11st_orders",
    "PostgreSQL DB에서 11번가 채널(inventory_11st 테이블)의 최근 재고 및 수집 내역을 가져옵니다.",
    {
      limit: z.number().default(5).describe("가져올 데이터 건수 (기본 5건)"),
    },
    async ({ limit }) => {
      try {
        // 실제 데이터가 들어있는 inventory_11st 테이블을 수집 날짜/시간 역순으로 조회합니다.
        const query = "SELECT * FROM inventory_11st ORDER BY fetched_date DESC, fetched_time DESC LIMIT $1";
        const result = await pool.query(query, [limit]);
        
        return {
          content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `DB 조회 중 에러가 발생했습니다: ${error.message}`,
            },
          ],
        };
      }
    }
  );

  return server;
}

/** ---------------------------
 * ✅ Streamable HTTP 세션 관리
 * -------------------------- */
const transports = {}; // { [sessionId]: StreamableHTTPServerTransport }

async function mcpPostHandler(req, res) {
  const sessionIdFromHeader = req.headers["mcp-session-id"]; 
  let transport;

  // 1) 이미 세션이 있으면 기존 transport 사용
  if (sessionIdFromHeader && transports[sessionIdFromHeader]) {
    transport = transports[sessionIdFromHeader];
  }
  // 2) 세션이 없고 initialize 요청이면 새로 생성
  else if (!sessionIdFromHeader && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        transports[newSessionId] = transport;
        console.log(`✅ [MCP] 세션 생성: ${newSessionId}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        console.log(`🔌 [MCP] 세션 종료: ${transport.sessionId}`);
      }
    };

    const server = createMcpServer();
    await server.connect(transport);
  } else {
    // 세션도 없고 initialize도 아니면 에러 반환
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid session ID provided",
      },
      id: null,
    });
    return;
  }

  // Streamable HTTP 핵심 처리
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

/**
 * ✅ n8n용 MCP Endpoint (중요)
 */
app.post("/mcp", mcpPostHandler);
app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

/** ----------------------------------------
 * (선택) 기존 SSE 테스트용 엔드포인트 유지
 * ---------------------------------------- */
const sseTransports = new Map();

app.get("/sse", async (req, res) => {
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const sessionId = Math.random().toString(36).substring(2);
  const transport = new SSEServerTransport(`/sse?sessionId=${sessionId}`, res);

  sseTransports.set(sessionId, transport);

  const server = createMcpServer();
  await server.connect(transport);

  req.on("close", () => {
    sseTransports.delete(sessionId);
  });
});

app.post("/sse", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sseTransports.get(sessionId);

  if (!transport) {
    res.status(400).send("세션이 만료되었습니다. 다시 /sse로 접속하세요.");
    return;
  }

  await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 MCP 서버 실행 중 (PORT: ${PORT})`);
  console.log(`✅ n8n Endpoint: /mcp (HTTP Streamable)`);
  console.log(`🧪 브라우저 테스트용: /sse (SSE)`);
});
