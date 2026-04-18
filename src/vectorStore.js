// src/vectorStore.js
// Vector store: embed ด้วย Google Gemini text-embedding-004 (ฟรี)
//               ค้นหาด้วย pgvector cosine similarity บน Neon PostgreSQL
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pool = require('./db');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// gemini-embedding-001: output 3072 dims (ระบุ outputDimensionality=768 เพื่อ truncate)
const embedModel = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });

// ─── Embed text → vector 768 มิติ ────────────────────────────────────────────

async function embedText(text) {
  const result = await embedModel.embedContent({
    content: { parts: [{ text }] },
    outputDimensionality: 768,
  });
  return result.embedding.values; // number[] 768 items
}

// ─── Insert knowledge chunk ────────────────────────────────────────────────

async function insertKnowledge({ content, category, module: mod, source = 'systemPrompt' }) {
  const embedding = await embedText(content);
  const vectorStr = `[${embedding.join(',')}]`;
  await pool.query(
    `INSERT INTO sales_knowledge (content, category, module, source, embedding)
     VALUES ($1, $2, $3, $4, $5::vector)`,
    [content, category, mod, source, vectorStr]
  );
}

// ─── Search: ค้นหา top-K chunks ที่เกี่ยวข้องกับ query ──────────────────────

async function searchKnowledge(query, { limit = 4, threshold = 0.3, category = null } = {}) {
  try {
    const embedding = await embedText(query);
    const vectorStr = `[${embedding.join(',')}]`;

    // filter by category ถ้าระบุมา
    const categoryFilter = category ? `AND category = '${category}'` : '';

    const { rows } = await pool.query(
      `SELECT
         content,
         category,
         module,
         1 - (embedding <=> $1::vector) AS similarity
       FROM sales_knowledge
       WHERE 1 - (embedding <=> $1::vector) > $2
       ${categoryFilter}
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [vectorStr, threshold, limit]
    );

    return rows; // [{ content, category, module, similarity }]
  } catch (err) {
    console.error('⚠️ vectorStore search error:', err.message);
    return []; // fallback gracefully
  }
}

// ─── Clear all knowledge (ก่อน re-ingest) ────────────────────────────────────

async function clearKnowledge(source = 'systemPrompt') {
  const { rowCount } = await pool.query(
    'DELETE FROM sales_knowledge WHERE source = $1',
    [source]
  );
  return rowCount;
}

// ─── Count knowledge entries ──────────────────────────────────────────────────

async function countKnowledge() {
  const { rows } = await pool.query('SELECT COUNT(*) FROM sales_knowledge');
  return parseInt(rows[0].count);
}

module.exports = { embedText, insertKnowledge, searchKnowledge, clearKnowledge, countKnowledge };
