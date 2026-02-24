// ============================================
// D.CURVIN 마스터 MCP 서버 v3.0.0
// 스키마 조회 도구 통합 버전
// ============================================

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

pool.query('SELECT NOW()', (err, res) => {
  if (err) console.error('❌ [DB] 연결 실패:', err.message);
  else console.log('✅ [DB] PostgreSQL 연결 성공 (', res.rows[0].now, ')');
});

/** ---------------------------
 * 2. 만능 MCP 서버 도구 (V3.0.0)
 * -------------------------- */
function createMcpServer() {
  const server = new McpServer({
    name: "dcurvin-master-agent",
    version: "3.0.0",
  });

  // ═══════════════════════════════════════════
  // 기존 도구들
  // ═══════════════════════════════════════════

  // [도구 1] 테이블 리스트
  server.tool("list_tables", "DB의 모든 테이블 목록을 조회합니다.", {}, async () => {
    console.log('[STEP 1] list_tables 호출');
    try {
      const result = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
      console.log('[STEP 2] 테이블 목록 조회 완료:', result.rows.length, '개');
      return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
    } catch (error) {
      console.error('[ERROR] list_tables 실패:', error.message);
      return { content: [{ type: "text", text: `에러: ${error.message}` }] };
    }
  });

  // [도구 2] 스키마 확인 (JOIN 키 확인용 필수)
  server.tool(
    "get_table_schema",
    "테이블의 컬럼 구조를 확인합니다. 11번가는 바코드, 물류온은 상품코드 컬럼이 어디인지 확인하세요.",
    { tableName: z.string().describe("테이블 이름") },
    async ({ tableName }) => {
      console.log(`[STEP 1] get_table_schema 호출: '${tableName}'`);
      try {
        const query = "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1";
        const result = await pool.query(query, [tableName]);
        console.log(`[STEP 2] 컬럼 구조 조회 완료: ${result.rows.length}개 컬럼`);
        return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
      } catch (error) {
        console.error('[ERROR] get_table_schema 실패:', error.message);
        return { content: [{ type: "text", text: `에러: ${error.message}` }] };
      }
    }
  );

  // [도구 3] 스마트 쿼리 실행
  server.tool(
    "run_select_query",
    "SQL 조회를 실행합니다. JOIN 쿼리를 통해 매핑된 데이터를 가져올 때 사용하세요.",
    { sql_query: z.string().describe("실행할 SELECT/WITH 쿼리문") },
    async ({ sql_query }) => {
      console.log(`[STEP 1] run_select_query 호출`);
      console.log(`[STEP 1] 쿼리:\n${sql_query}`);
      try {
        const upper = sql_query.trim().toUpperCase();
        if (!upper.startsWith("SELECT") && !upper.startsWith("WITH")) {
          console.log('[STEP 2] 보안 차단: SELECT/WITH 아님');
          return { content: [{ type: "text", text: "보안 에러: 조회 구문만 허용됩니다." }] };
        }
        if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i.test(sql_query)) {
          console.log('[STEP 2] 보안 차단: 변경 명령어 감지');
          return { content: [{ type: "text", text: "보안 에러: 변경 명령어가 감지되었습니다." }] };
        }

        console.log('[STEP 2] 쿼리 실행 중...');
        const result = await pool.query(sql_query);
        console.log(`[STEP 3] 결과: ${result.rowCount}건 반환`);
        return { content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }] };
      } catch (error) {
        console.error('[ERROR] run_select_query 실패:', error.message);
        return { content: [{ type: "text", text: `SQL 에러: ${error.message}` }] };
      }
    }
  );

  // ═══════════════════════════════════════════
  // 신규 도구: API 스키마 조회 (v3.0.0 추가)
  // ═══════════════════════════════════════════

  // [도구 4] API 스키마 요약 조회
  server.tool(
    "get_api_schema_summary",
    "네이버 커머스 API 스키마 요약을 조회합니다. 주문 데이터의 필드 의미를 빠르게 확인할 때 사용하세요.",
    { 
      api_name: z.string().default("naver_commerce_order").describe("API 이름 (기본값: naver_commerce_order)") 
    },
    async ({ api_name = "naver_commerce_order" }) => {
      console.log('[STEP 1] get_api_schema_summary 호출:', api_name);
      
      try {
        const query = `
          SELECT summary, version, updated_at 
          FROM api_schemas 
          WHERE api_name = $1
        `;
        
        console.log('[STEP 2] DB 쿼리 실행');
        const result = await pool.query(query, [api_name]);
        
        if (result.rows.length === 0) {
          console.log('[STEP 3] 스키마 없음');
          return { 
            content: [{ 
              type: "text", 
              text: JSON.stringify({
                success: false,
                message: `API 스키마를 찾을 수 없습니다: ${api_name}`,
                hint: "api_schemas 테이블에 데이터가 있는지 확인하세요."
              }, null, 2)
            }] 
          };
        }
        
        console.log('[STEP 3] 스키마 조회 성공');
        return { 
          content: [{ 
            type: "text", 
            text: JSON.stringify({
              success: true,
              api_name: api_name,
              version: result.rows[0].version,
              updated_at: result.rows[0].updated_at,
              summary: result.rows[0].summary
            }, null, 2)
          }] 
        };
        
      } catch (error) {
        console.error('[ERROR] get_api_schema_summary 실패:', error.message);
        return { 
          content: [{ 
            type: "text", 
            text: JSON.stringify({ success: false, error: error.message }, null, 2)
          }] 
        };
      }
    }
  );

  // [도구 5] API 스키마 상세 조회
  server.tool(
    "get_api_schema_detail",
    "네이버 커머스 API 스키마 상세 정보를 조회합니다. 특정 필드의 가능한 값이나 의미를 정확히 알아야 할 때 사용하세요.",
    { 
      api_name: z.string().default("naver_commerce_order").describe("API 이름"),
      section: z.enum(["order", "productOrder", "shippingAddress", "delivery", "claimReasons", "all"]).describe("조회할 섹션")
    },
    async ({ api_name = "naver_commerce_order", section }) => {
      console.log('[STEP 1] get_api_schema_detail 호출:', api_name, section);
      
      try {
        const query = `
          SELECT full_schema, field_descriptions 
          FROM api_schemas 
          WHERE api_name = $1
        `;
        
        console.log('[STEP 2] DB 쿼리 실행');
        const result = await pool.query(query, [api_name]);
        
        if (result.rows.length === 0) {
          return { 
            content: [{ 
              type: "text", 
              text: JSON.stringify({ success: false, message: `스키마 없음: ${api_name}` }, null, 2)
            }] 
          };
        }
        
        const fullSchema = result.rows[0].full_schema;
        const fieldDescriptions = result.rows[0].field_descriptions;
        
        console.log('[STEP 3] 섹션 필터링:', section);
        
        if (section === 'all') {
          return { 
            content: [{ 
              type: "text", 
              text: JSON.stringify({
                success: true,
                schema: fullSchema,
                descriptions: fieldDescriptions
              }, null, 2)
            }] 
          };
        }
        
        // 특정 섹션만 반환
        const sectionData = fullSchema[section];
        if (!sectionData) {
          return { 
            content: [{ 
              type: "text", 
              text: JSON.stringify({
                success: false,
                message: `섹션을 찾을 수 없습니다: ${section}`,
                available_sections: Object.keys(fullSchema)
              }, null, 2)
            }] 
          };
        }
        
        console.log('[STEP 4] 섹션 데이터 반환');
        return { 
          content: [{ 
            type: "text", 
            text: JSON.stringify({
              success: true,
              section: section,
              schema: sectionData,
              related_descriptions: fieldDescriptions[`${section}_guide`] || null
            }, null, 2)
          }] 
        };
        
      } catch (error) {
        console.error('[ERROR] get_api_schema_detail 실패:', error.message);
        return { 
          content: [{ 
            type: "text", 
            text: JSON.stringify({ success: false, error: error.message }, null, 2)
          }] 
        };
      }
    }
  );

  // [도구 6] 필드/상태코드 설명 조회
  server.tool(
    "get_field_description",
    "특정 필드나 상태 코드의 의미를 조회합니다. 예: productOrderStatus가 PAYED면 무슨 뜻인지, CJGLS가 어떤 택배사인지",
    { 
      field_name: z.string().describe("필드명 또는 상태 코드 (예: productOrderStatus, PAYED, CANCEL_REQUEST, CJGLS)")
    },
    async ({ field_name }) => {
      console.log('[STEP 1] get_field_description 호출:', field_name);
      
      try {
        const query = `
          SELECT full_schema, field_descriptions 
          FROM api_schemas 
          WHERE api_name = 'naver_commerce_order'
        `;
        
        const result = await pool.query(query);
        
        if (result.rows.length === 0) {
          return { 
            content: [{ 
              type: "text", 
              text: JSON.stringify({ success: false, message: '스키마 데이터가 없습니다. api_schemas 테이블을 확인하세요.' }, null, 2)
            }] 
          };
        }
        
        const fullSchema = result.rows[0].full_schema;
        const fieldDescriptions = result.rows[0].field_descriptions;
        
        console.log('[STEP 2] 필드 검색 시작');
        
        // 1. 직접 필드명으로 검색
        for (const [sectionName, sectionData] of Object.entries(fullSchema)) {
          if (sectionData && sectionData[field_name]) {
            console.log('[STEP 3] 필드 발견:', sectionName);
            return { 
              content: [{ 
                type: "text", 
                text: JSON.stringify({
                  success: true,
                  field: field_name,
                  section: sectionName,
                  info: sectionData[field_name]
                }, null, 2)
              }] 
            };
          }
          
          // 2. enum 값 내부 검색 (예: PAYED, CANCEL_REQUEST, CJGLS 등)
          if (sectionData && typeof sectionData === 'object') {
            for (const [subField, subData] of Object.entries(sectionData)) {
              if (subData && subData.values && subData.values[field_name]) {
                console.log('[STEP 3] enum 값 발견:', subField);
                return { 
                  content: [{ 
                    type: "text", 
                    text: JSON.stringify({
                      success: true,
                      code: field_name,
                      parent_field: subField,
                      section: sectionName,
                      meaning: subData.values[field_name],
                      all_values: subData.values
                    }, null, 2)
                  }] 
                };
              }
            }
          }
        }
        
        // 3. field_descriptions에서 검색
        if (fieldDescriptions) {
          for (const [key, value] of Object.entries(fieldDescriptions)) {
            if (value && value[field_name]) {
              return { 
                content: [{ 
                  type: "text", 
                  text: JSON.stringify({
                    success: true,
                    field: field_name,
                    category: key,
                    description: value[field_name]
                  }, null, 2)
                }] 
              };
            }
          }
        }
        
        console.log('[STEP 3] 필드를 찾지 못함');
        return { 
          content: [{ 
            type: "text", 
            text: JSON.stringify({
              success: false,
              message: `필드를 찾을 수 없습니다: ${field_name}`,
              hint: "productOrderStatus, claimStatus, orderId 등의 필드명이나 PAYED, CANCEL_REQUEST, CJGLS 등의 상태/택배사 코드를 입력하세요"
            }, null, 2)
          }] 
        };
        
      } catch (error) {
        console.error('[ERROR] get_field_description 실패:', error.message);
        return { 
          content: [{ 
            type: "text", 
            text: JSON.stringify({ success: false, error: error.message }, null, 2)
          }] 
        };
      }
    }
  );

  return server;
}

/** ---------------------------
 * 3. n8n 통신 세션 처리
 * -------------------------- */
const transports = {}; 

async function mcpPostHandler(req, res) {
  const sid = req.headers["mcp-session-id"]; 
  let transport;

  if (sid && transports[sid]) {
    transport = transports[sid];
  } else if (!sid && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSid) => {
        transports[newSid] = transport;
        console.log(`✅ [세션시작] ID: ${newSid}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        console.log(`🔌 [세션종료] ID: ${transport.sessionId}`);
      }
    };

    const server = createMcpServer();
    await server.connect(transport);
  } else {
    res.status(400).json({ error: "Invalid Session" });
    return;
  }

  await transport.handleRequest(req, res, req.body);
}

app.post("/mcp", mcpPostHandler);
app.get("/mcp", (req, res) => {
  const sid = req.headers["mcp-session-id"];
  if (sid && transports[sid]) transports[sid].handleRequest(req, res);
  else res.status(400).send("No session");
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 D.CURVIN 마스터 MCP v3.0.0 가동 (Port: ${PORT})`));
