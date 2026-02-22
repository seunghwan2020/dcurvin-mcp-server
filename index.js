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

// 🌟 모든 연결을 기억할 '명부(Map)' 공간
const sessions = new Map();

// 1단계: n8n이 처음 인사(GET)하러 오는 정문
app.get('/sse', async (req, res) => {
  // 접속할 때마다 겹치지 않는 고유한 방 번호를 발급합니다.
  const sessionId = Math.random().toString(36).substring(2);
  console.log(`[새 연결] n8n 접속! 발급된 방 번호: ${sessionId}`);

  // n8n에게 "앞으로 데이터는 /message/방번호 로 보내!" 라고 정확히 명시합니다.
  const transport = new SSEServerTransport(`/message/${sessionId}`, res);
  sessions.set(sessionId, transport);

  await server.connect(transport);

  // n8n이 워크플로우를 끄거나 연결을 끊으면 명부에서 지웁니다.
  req.on('close', () => {
    console.log(`[연결 종료] 방 번호 ${sessionId} 폐기`);
    sessions.delete(sessionId);
  });
});

// 2단계: n8n이 데이터를 밀어넣는(POST) 전용 뒷문
app.post('/message/:sessionId', async (req, res) => {
  // n8n이 들고 온 방 번호를 확인합니다.
  const sessionId = req.params.sessionId;
  const transport = sessions.get(sessionId);

  // 방 번호가 명부에 없으면 돌려보냅니다. (n8n이 재접속하도록 유도)
  if (!transport) {
    console.error(`[에러] 잘못된 방 번호: ${sessionId}`);
    return res.status(404).send('연결이 만료되었습니다. 처음부터 다시 접속해주세요.');
  }

  // 정상적인 방 번호라면 데이터를 AI에게 전달합니다.
  try {
    await transport.handlePostMessage(req, res);
  } catch (error) {
    console.error(`[데이터 처리 에러]:`, error);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 MCP 서버가 포트 ${PORT}에서 돌아가고 있습니다!`);
});
