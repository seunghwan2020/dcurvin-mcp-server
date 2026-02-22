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

// 🚨 업그레이드 포인트: 여러 연결을 기억할 수 있는 '명부(Map)'를 만듭니다.
const transports = new Map();

app.get('/sse', async (req, res) => {
  // n8n이 처음 인사하러 오면 고유한 '출입증 번호(세션 ID)'를 발급합니다.
  const sessionId = Math.random().toString(36).substring(2, 15);

  // n8n에게 "앞으로 데이터는 /messages?sessionId=네출입증번호 여기로 보내!" 라고 알려줍니다.
  const transport = new SSEServerTransport(`/messages?sessionId=${sessionId}`, res);
  
  // 명부에 출입증 번호와 통로를 기록해 둡니다.
  transports.set(sessionId, transport);
  await server.connect(transport);
  
  console.log(`[연결 성공] n8n이 접속했습니다. (출입증: ${sessionId})`);

  // n8n이 연결을 끊으면 명부에서 지웁니다.
  req.on('close', () => {
    transports.delete(sessionId);
    console.log(`[연결 종료] 출입증 ${sessionId} 폐기됨.`);
  });
});

// n8n이 데이터를 밀어넣는 전용 문입니다.
app.post('/messages', async (req, res) => {
  // n8n이 들고 온 출입증 번호를 확인합니다.
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);

  // 명부에 있는 정상적인 통로라면 데이터를 받아줍니다.
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    // 서버가 재시작되어 명부가 지워졌는데 n8n이 옛날 출입증을 들고 오면 다시 연결하라고 알려줍니다.
    res.status(404).send('연결이 끊어졌습니다. n8n에서 다시 접속해주세요.');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 MCP 서버가 포트 ${PORT}에서 돌아가고 있습니다!`);
});
