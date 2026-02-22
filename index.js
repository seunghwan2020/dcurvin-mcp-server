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

pool.query('SELECT NOW()', (err) => {
  if (err) console.error('❌ DB 연결 실패:', err.message);
  else console.log('✅ PostgreSQL DB 연결 성공!');
});

/** ---------------------------
 * 2. MCP 서버 도구
 * -------------------------- */
function createMcpServer() {
  const server = new McpServer({
    name: "dcurvin-master-agent",
    version: "2.5.0",
  });

  // [도구 1] 테이블 목록 확인
  server.tool("list_tables", "DB 내 모든 테이블 목록을 확인합니다.", {}, async () => {
    try {
      const result = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
      return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
    } catch (error) { return { content: [{ type: "text", text: error.message }] }; }
  });

  // [도구 2] 테이블 구조 확인
  server.tool("get_table_schema", "테이블의 컬럼 구조를 확인합니다.", { tableName: z.string() }, async ({ tableName }) => {
    try {
      const result = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1", [tableName]);
      return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
    } catch (error) { return { content: [{ type: "text", text: error.message }] }; }
  });

  // [도구 3] 데이터 조회 (SELECT/WITH 허용)
  server.tool(
    "run_select_query",
    "SQL 쿼리를 실행하여 데이터를 조회합니다. 매핑 테이블(product_mapping)을 조인하여 사용하세요.",
    { sql_query: z.string().describe("실행할 SQL SELECT/WITH 쿼리문") },
    async ({ sql_query }) => {
      try {
        const upperQuery = sql_query.trim().toUpperCase();
        if (!upperQuery.startsWith("SELECT") && !upperQuery.startsWith("WITH")) {
          return { content: [{ type: "text", text: "보안 에러: SELECT 또는 WITH 구문만 가능합니다." }] };
        }
        const forbiddenRegex = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i;
        if (forbiddenRegex.test(sql_query)) {
          return { content: [{ type: "text", text: "보안 에러: 파괴적인 명령어는 금지됩니다." }] };
        }
        const result = await pool.query(sql_query);
        return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
      } catch (error) { return { content: [{ type: "text", text: `SQL 에러: ${error.message}` }] }; }
    }
  );

  return server;
}

/** ---------------------------
 * 3. n8n 통신 처리
 * -------------------------- */
const transports = {}; 
async function mcpPostHandler(req, res) {
  const sessionId = req.headers["mcp-session-id"]; 
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res, req.body);
  } else if (!sessionId && isInitializeRequest(req.body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => { transports[sid] = transport; }
    });
    transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
    await (createMcpServer()).connect(transport);
    await transport.handleRequest(req, res, req.body);
  } else {
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "No session" }, id: null });
  }
}

app.post("/mcp", mcpPostHandler);
app.get("/mcp", async (req, res) => {
  const sid = req.headers["mcp-session-id"];
  if (sid && transports[sid]) await transports[sid].handleRequest(req, res);
  else res.status(400).send("Invalid session");
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 D.CURVIN AI Agent Running on ${PORT}`));
