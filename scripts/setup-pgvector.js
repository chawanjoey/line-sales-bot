// scripts/setup-pgvector.js
// รันครั้งเดียวเพื่อสร้าง pgvector extension + table + index บน Neon
require('dotenv').config();
const pool = require('../src/db');

async function setup() {
  const client = await pool.connect();
  try {
    console.log('🔧 Setting up pgvector on Neon PostgreSQL...\n');

    // 1) enable pgvector extension
    await client.query('CREATE EXTENSION IF NOT EXISTS vector;');
    console.log('✅ Extension: vector enabled');

    // 2) สร้างตาราง sales_knowledge
    await client.query(`
      CREATE TABLE IF NOT EXISTS sales_knowledge (
        id          SERIAL PRIMARY KEY,
        content     TEXT        NOT NULL,
        category    TEXT,          -- 'skill' | 'product_synology' | 'product_logitech' | 'customer' | 'objection'
        module      TEXT,          -- 'M1'..'M7' | 'SY1'..'SY3' | 'LG1'..'LG3' | 'general'
        source      TEXT,          -- 'systemPrompt' หรือชื่อ document
        embedding   vector(768),   -- Google text-embedding-004 output
        created_at  TIMESTAMPTZ DEFAULT now()
      );
    `);
    console.log('✅ Table: sales_knowledge created');

    // 3) ivfflat index สำหรับ cosine similarity (เร็ว)
    await client.query(`
      CREATE INDEX IF NOT EXISTS sales_knowledge_embedding_idx
      ON sales_knowledge
      USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 10);
    `);
    console.log('✅ Index: ivfflat (cosine) created');

    // 4) full-text index บน content
    await client.query(`
      CREATE INDEX IF NOT EXISTS sales_knowledge_category_idx
      ON sales_knowledge (category, module);
    `);
    console.log('✅ Index: category + module created');

    console.log('\n🎉 pgvector setup complete!');
    console.log('👉 รันต่อด้วย: node scripts/ingest.js\n');
  } catch (err) {
    console.error('❌ Setup error:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

setup();
