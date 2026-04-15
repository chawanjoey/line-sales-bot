const OpenAI = require('openai');
const SYSTEM_PROMPT = require('./systemPrompt');

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    'HTTP-Referer': process.env.APP_URL || 'https://localhost',
    'X-Title': 'LINE Sales Training Bot',
  },
});

const MODEL = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4-5';

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
