import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import pg from 'pg';

// 1. 서버와 DB 준비하기
const app = express();
const { Pool } = pg;

// Railway 환경변수(DATABASE_URL)를 사용해 DB 창고의 문을 엽니다.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// 2. AI 매니저(MCP 서버) 채용하기
const server = new McpServer({
  name: 'dcurvin-ai-bridge',
  version: '1.0.0',
});

// 3. AI에게 쥐어줄 '도구(Tool)' 만들기
// AI가 "11번가 캐리어 주문건 확인해줘"라고 하면 이 도구를 꺼내 씁니다.
server.tool(
  'get_11st_orders',
  'PostgreSQL DB에서 11번가 채널의 최근 주문 내역을 가져옵니다.', // AI가 읽고 언제 쓸지 판단하는 설명서
  {
    limit: z.number().default(5).description('가져올 주문 건수 (기본 5건)'), // AI가 스스로 숫자를 정해서 넘겨줌
  },
  async ({ limit }) => {
    try {
      // 실제 DB 창고에 들어가서 데이터를 찾아옵니다. (테이블 이름이 'orders'라고 가정)
      const query = 'SELECT * FROM orders WHERE channel = $1 LIMIT $2';
      const result = await pool.query(query, ['11st', limit]);
      
      // 찾아온 데이터를 AI가 읽을 수 있는 글자(Text) 형태로 포장해서 줍니다.
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

// 4. n8n과 통신할 비밀 통로(SSE) 열어두기
let transport;

// n8n에서 Endpoint 주소로 'https://내도메인/sse'를 입력하면 여기로 연결됩니다.
app.get('/sse', async (req, res) => {
  transport = new SSEServerTransport('/messages', res);
  await server.connect(transport);
  console.log('n8n과 SSE 연결이 성공했습니다!');
});

// AI가 도구(Tool)를 사용하겠다고 요청을 보내면 처리하는 곳입니다.
app.post('/messages', async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(500).send('통로가 아직 열리지 않았습니다.');
  }
});

// 5. 서버 가동!
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 MCP 서버가 포트 ${PORT}에서 돌아가고 있습니다!`);
});
