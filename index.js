import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import pg from "pg";

const app = express();
app.set("trust proxy", 1);

// ✅ n8n POST 바디를 읽기 위해 필수
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// (선택) Railway 헬스체크/확인용
app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.status(200).send("ok"));

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// MCP 서버 생성
const server = new McpServer({
  name: "dcurvin-ai-bridge",
  version: "1.0.0",
});

// 예시 툴 (원하는 쿼리로 바꿔도 됨)
server.tool(
  "get_11st_orders",
  "PostgreSQL DB에서 11번가 채널의 최근 주문 내역을 가져옵니다.",
  {
    limit: z.number().default(5).describe("가져올 주문 건수 (기본 5건)"),
  },
  async ({ limit }) => {
    try {
      const query = "SELECT * FROM orders WHERE channel = $1 LIMIT $2";
      const result = await pool.query(query, ["11st", limit]);

      return {
        content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `DB 조회 에러: ${error.message}` }],
      };
    }
  }
);

// ✅ 세션별 transport 저장소 (서버 재시작하면 초기화됨)
const transports = new Map();

/**
 * 1) n8n이 최초로 연결(Handshake)하는 문: GET /mcp
 *    -> SSE 세션을 열고, "앞으로 POST는 /mcp?sessionId=xxx 로 보내" 라고 안내
 */
app.get("/mcp", async (req, res) => {
  console.log("✅ [GET /mcp] n8n 연결 시작");

  // Railway/프록시 환경에서 SSE가 끊기는 걸 줄여주는 헤더
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  // 세션 ID 발급
  const sessionId = Math.random().toString(36).slice(2);

  // ⭐️ 여기 endpoint가 /message 로 나오면 n8n이 헷갈려서 실패함
  //    반드시 /mcp 로 통일
  const transport = new SSEServerTransport(`/mcp?sessionId=${sessionId}`, res);

  transports.set(sessionId, transport);

  try {
    await server.connect(transport);
    console.log(`✅ 세션 생성: ${sessionId}`);
  } catch (e) {
    console.error("❌ server.connect 실패:", e);
    transports.delete(sessionId);
    res.status(500).end();
    return;
  }

  // 연결 종료 시 정리
  req.on("close", () => {
    transports.delete(sessionId);
    console.log(`🔌 연결 종료: ${sessionId}`);
  });
});

/**
 * 2) n8n이 메시지를 보내는 문: POST /mcp?sessionId=xxx
 */
app.post("/mcp", async (req, res) => {
  console.log("✅ [POST /mcp] n8n 메시지 수신");

  const sessionId = req.query.sessionId;
  if (!sessionId) {
    // n8n이 sessionId 없이 때리는 경우: 설정이 잘못됐거나 transport mismatch
    return res
      .status(400)
      .send("sessionId가 없습니다. n8n MCP Client 설정/URL을 확인하세요.");
  }

  const transport = transports.get(sessionId);
  if (!transport) {
    // 서버 재시작 등으로 세션이 날아간 경우
    return res
      .status(400)
      .send("세션이 만료되었습니다. n8n 워크플로우를 다시 실행/새로고침하세요.");
  }

  try {
    await transport.handlePostMessage(req, res);
  } catch (e) {
    console.error("❌ handlePostMessage 실패:", e);
    res.status(500).send("MCP 서버 내부 오류");
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 MCP 서버 실행 중 (PORT: ${PORT})`);
});
