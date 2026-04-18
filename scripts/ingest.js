// scripts/ingest.js
// อ่าน systemPrompt.js → chunk ตาม section → embed → ยัดลง pgvector
require('dotenv').config();
const { insertKnowledge, clearKnowledge, countKnowledge } = require('../src/vectorStore');
const pool = require('../src/db');

// ── Helper: หน่วงเวลา (Gemini free tier: 1,500 req/day, 60 req/min) ──────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Determine category & module จาก section title ─────────────────────────────
function classifySection(title) {
  const t = title.toLowerCase();
  if (t.match(/module\s*[1-7]:|m[1-7]:/)) {
    const m = title.match(/[Mm]odule\s*(\d)|[Mm](\d):/);
    const num = m?.[1] || m?.[2];
    const mod = num ? `M${num}` : 'M?';
    if (t.includes('spin'))           return { category: 'skill', module: 'M2' };
    if (t.includes('fab'))            return { category: 'skill', module: 'M3' };
    if (t.includes('rapport'))        return { category: 'skill', module: 'M4' };
    if (t.includes('objection'))      return { category: 'skill', module: 'M5' };
    if (t.includes('closing'))        return { category: 'skill', module: 'M6' };
    if (t.includes('value') || t.includes('roi')) return { category: 'skill', module: 'M7' };
    return { category: 'skill', module: mod };
  }
  if (t.match(/sy[1-3]:/)) {
    const num = title.match(/SY(\d)/i)?.[1];
    return { category: 'product_synology', module: `SY${num || '?'}` };
  }
  if (t.match(/lg[1-3]:/)) {
    const num = title.match(/LG(\d)/i)?.[1];
    return { category: 'product_logitech', module: `LG${num || '?'}` };
  }
  if (t.includes('ลูกค้า') || t.includes('customer') || t.includes('กลุ่ม')) {
    return { category: 'customer', module: 'general' };
  }
  if (t.includes('สินค้า') || t.includes('product') || t.includes('อ้างอิง')) {
    return { category: 'product_reference', module: 'general' };
  }
  if (t.includes('บทบาท') || t.includes('บุคลิก') || t.includes('กฎ') || t.includes('สอน')) {
    return { category: 'persona', module: 'general' };
  }
  return { category: 'general', module: 'general' };
}

// ── อ่าน systemPrompt string ──────────────────────────────────────────────────
function extractPromptString() {
  // อ่าน raw source แล้ว eval เป็น string
  const raw = require('fs').readFileSync(
    require('path').join(__dirname, '../src/systemPrompt.js'), 'utf8'
  );
  // ดึง content ระหว่าง backtick template literal
  const match = raw.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
  if (!match) throw new Error('Cannot parse SYSTEM_PROMPT from systemPrompt.js');
  return match[1];
}

// ── Chunk โดย split ที่ ### headers ──────────────────────────────────────────
function chunkByHeaders(text) {
  const chunks = [];

  // split ที่ ### (section level 3)
  const sections = text.split(/\n(?=### )/);

  for (const section of sections) {
    const lines = section.trim().split('\n');
    const firstLine = lines[0].trim();

    if (!firstLine) continue;

    // หัวข้อ section
    const title = firstLine.replace(/^###\s*/, '').trim();
    const body  = lines.slice(1).join('\n').trim();

    if (!body || body.length < 30) continue; // ข้ามส่วนที่สั้นเกินไป

    // ถ้า body ยาวเกิน 1,200 char → แบ่ง sub-chunk ที่ ** headers
    const MAX = 1200;
    if (body.length <= MAX) {
      chunks.push({ title, content: `${title}\n\n${body}` });
    } else {
      // แบ่งที่ \n\n**
      const sub = body.split(/\n(?=\*\*)/);
      let buffer = '';
      let subIdx = 0;
      for (const part of sub) {
        if ((buffer + part).length > MAX && buffer.length > 100) {
          chunks.push({ title: `${title} (${++subIdx})`, content: `${title}\n\n${buffer.trim()}` });
          buffer = part;
        } else {
          buffer += '\n' + part;
        }
      }
      if (buffer.trim().length > 50) {
        chunks.push({ title: `${title} (${++subIdx})`, content: `${title}\n\n${buffer.trim()}` });
      }
    }
  }

  return chunks;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Starting ingest pipeline...\n');

  // 1) clear old data
  const deleted = await clearKnowledge('systemPrompt');
  console.log(`🗑️  Cleared ${deleted} old records\n`);

  // 2) parse systemPrompt
  const promptText = extractPromptString();
  const chunks     = chunkByHeaders(promptText);
  console.log(`📄 Found ${chunks.length} chunks to embed\n`);

  // 3) embed & insert
  let ok = 0, fail = 0;
  for (let i = 0; i < chunks.length; i++) {
    const { title, content } = chunks[i];
    const { category, module: mod } = classifySection(title);

    process.stdout.write(`[${i + 1}/${chunks.length}] ${title.slice(0, 50).padEnd(52)} `);
    try {
      await insertKnowledge({ content, category, module: mod, source: 'systemPrompt' });
      console.log(`✅ ${category}/${mod}`);
      ok++;
    } catch (err) {
      console.log(`❌ ${err.message}`);
      fail++;
    }

    // หน่วง 1.2 วินาที — ไม่ให้เกิน 50 req/min (safe ต่อ free tier)
    if (i < chunks.length - 1) await sleep(1200);
  }

  // 4) summary
  const total = await countKnowledge();
  console.log(`\n✅ Done — ${ok} inserted, ${fail} failed`);
  console.log(`📊 Total knowledge in DB: ${total} chunks`);

  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
