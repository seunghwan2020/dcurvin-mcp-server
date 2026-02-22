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

let globalTransport = null;

// n8n이 처음 통신을 시도할 때 (GET 요청)
app.get('/sse', async (req, res) => {
  // n8n에게 "앞으로 데이터도 똑같이 /sse 로 보내!" 라고 알려줍니다.
  globalTransport = new SSEServerTransport('/sse', res); 
  await server.connect(globalTransport);
  console.log('✅ n8n과 SSE 연결이 성공했습니다!');
});

// n8n이 데이터를 밀어넣을 때 (POST 요청)
app.post('/sse', async (req, res) => {
  if (globalTransport) {
    await globalTransport.handlePostMessage(req, res);
  } else {
    console.log('⚠️ n8n이 끊어진 통로로 데이터를 보냈습니다.');
    res.status(400).send('서버가 재시작되었습니다. n8n 워크플로우를 새로고침 해주세요.');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 MCP 서버가 포트 ${PORT}에서 돌아가고 있습니다!`);
});
