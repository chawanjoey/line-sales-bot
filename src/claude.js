const OpenAI = require('openai');
const SYSTEM_PROMPT = require('./systemPrompt');
const { searchKnowledge } = require('./vectorStore');

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    'HTTP-Referer': process.env.APP_URL || 'https://localhost',
    'X-Title': 'LINE Sales Training Bot',
  },
});

const MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4-5';

// ── Vector RAG: ดึง context ที่เกี่ยวข้องก่อนส่งให้ Claude ──────────────────
async function buildRagContext(userMessage) {
  if (!process.env.GEMINI_API_KEY) return ''; // ข้ามถ้าไม่มี key

  try {
    const results = await searchKnowledge(userMessage, { limit: 3, threshold: 0.35 });
    if (!results.length) return '';

    const context = results
      .map(r => `[${r.module}] ${r.content}`)
      .join('\n\n---\n\n');

    return `\n\n## 📚 ข้อมูลอ้างอิงที่เกี่ยวข้อง (RAG)\n${context}\n\n---\n`;
  } catch {
    return ''; // fallback gracefully — ไม่ทำให้บอทล่ม
  }
}

async function askClaude(history, employee = null) {
  // เพิ่ม context พนักงานเข้าไปใน system prompt
  let systemPrompt = SYSTEM_PROMPT;
  if (employee) {
    systemPrompt += `\n\n## ข้อมูลผู้เรียนปัจจุบัน\n` +
      `- ชื่อ: ${employee.name}\n` +
      `- แผนก: ${employee.department}\n` +
      `- รหัสพนักงาน: ${employee.employee_code}\n` +
      `- ตำแหน่ง: ${employee.role}\n\n` +
      `ใช้ชื่อผู้เรียนในการสนทนาเพื่อให้ดูเป็นกันเอง`;
  }

  // ── RAG: ดึง context จาก vector DB ตาม user message ล่าสุด ──────────────
  const lastUserMsg = [...history].reverse().find(m => m.role === 'user')?.content || '';
  const ragContext = await buildRagContext(lastUserMsg);
  if (ragContext) {
    systemPrompt += ragContext;
    console.log(`🔍 RAG: injected context for "${lastUserMsg.slice(0, 40)}..."`);
  }

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      { role: 'system', content: systemPrompt },
      ...history,
    ],
  });
  return response.choices[0].message.content;
}

module.exports = { askClaude };
