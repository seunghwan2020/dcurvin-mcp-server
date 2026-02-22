import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import pg from 'pg';

const app = express();
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

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
      const query = 'SELECT * FROM orders WHERE channel = $1 LIMIT $2';
      const result = await pool.query(query, ['11st', limit]);
      return {
        content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `DB 조회 중 에러가 발생했습니다: ${error.message}` }],
      };
    }
  }
);

// 🚨 연결된 통로들을 안전하게 보관하는 명부
const transports = new Map();

// 1. n8n이 처음 인사(GET)하러 오는 문
app.get('/mcp', async (req, res) => {
  console.log('✅ n8n GET 요청 수신!');
  // Railway 클라우드 환경에서 데이터가 막히지 않게 필수 설정
  res.setHeader('X-Accel-Buffering', 'no');

  // n8n이 접속할 때마다 고유한 출입증(세션 ID) 발급
  const sessionId = Math.random().toString(36).substring(2);
  
  // n8n에게 "앞으로 데이터는 /mcp?sessionId=출입증번호 여기로 보내!" 라고 지시합니다.
  const transport = new SSEServerTransport(`/mcp?sessionId=${sessionId}`, res);
  
  transports.set(sessionId, transport);
  await server.connect(transport);
  
  req.on('close', () => {
    transports.delete(sessionId);
    console.log(`[연결 종료] 세션 ${sessionId} 폐기`);
  });
});

// 2. n8n이 데이터를 밀어넣는(POST) 문 (주소를 완전히 똑같이 맞췄습니다)
app.post('/mcp', async (req, res) => {
  console.log('✅ n8n POST 요청 수신!');
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);

  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    // 서버가 재시작되어 명부가 없으면 n8n에게 다시 접속하라고 알려줍니다.
    res.status(400).send('세션이 만료되었습니다. n8n 워크플로우를 새로고침 하세요.');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 MCP 서버가 포트 ${PORT}에서 돌아가고 있습니다!`);
});
