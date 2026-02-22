import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import pg from 'pg';

const app = express();
const { Pool } = pg;

// DB 연결 에러로 서버 전체가 죽는 것을 방지
let pool;
try {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
} catch (err) {
  console.error('DB 연결 설정 에러:', err);
}

const server = new McpServer({
  name: 'dcurvin-ai-bridge',
  version: '1.0.0',
});

server.tool(
  'get_11st_orders',
  'PostgreSQL DB에서 11번가 채널의 최근 주문 내역을 가져옵니다.',
  {
    limit: z.number().default(5).describe('가져올 주문 건수 (기본 5건)'),
  },
  async ({ limit }) => {
    try {
      if (!pool) throw new Error('DB가 연결되지 않았습니다.');
      const query = 'SELECT * FROM orders WHERE channel = $1 LIMIT $2';
      const result = await pool.query(query, ['11st', limit]);
      return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `DB 에러: ${error.message}` }] };
    }
  }
);

const transports = new Map();

// 🌟 핵심 1: n8n이 처음 인사하러 올 때 무조건 받아주는 '블랙홀 GET'
app.get('/*', async (req, res) => {
  console.log(`[연결 수신] n8n이 ${req.path} 경로로 접속했습니다.`);
  res.setHeader('X-Accel-Buffering', 'no');
  
  const sessionId = Math.random().toString(36).substring(2);
  
  // n8n에게 "앞으로 데이터는 /message?sessionId=... 로 보내!" 라고 지시
  const transport = new SSEServerTransport(`/message?sessionId=${sessionId}`, res);
  transports.set(sessionId, transport);
  
  await server.connect(transport);
});

// 🌟 핵심 2: n8n이 데이터를 보낼 때 무조건 받아주는 '블랙홀 POST'
app.post('/*', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);
  
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(404).send('세션 없음. 새로고침 요망');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 MCP 서버 구동 완료 (포트 ${PORT})`);
});
