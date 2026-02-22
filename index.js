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

let activeTransport = null;

// n8n이 처음 인사하러 오는 정문 (새로운 이름으로 파서 뇌를 리셋시킵니다)
app.get('/mcp', async (req, res) => {
  console.log('✅ n8n 연결 요청(GET) 들어옴!');
  // n8n에게 "앞으로 데이터는 /messages 로 보내라"고 지시서(Endpoint)를 내립니다.
  activeTransport = new SSEServerTransport('/messages', res);
  await server.connect(activeTransport);
});

// n8n이 지시를 받고 데이터를 보내는 전용 뒷문
app.post('/messages', async (req, res) => {
  if (activeTransport) {
    await activeTransport.handlePostMessage(req, res);
  } else {
    res.status(400).send('연결이 없습니다.');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 MCP 서버가 포트 ${PORT}에서 돌아가고 있습니다!`);
});
