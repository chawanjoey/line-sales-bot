// scripts/build-knowledge.js
// แปลง systemPrompt.js → docs/sales-knowledge.md (clean knowledge document)
// รันก่อน upload-docs.js เสมอ
const fs   = require('fs');
const path = require('path');

const SRC  = path.join(__dirname, '../src/systemPrompt.js');
const DEST = path.join(__dirname, '../docs/sales-knowledge.md');

function extractPromptString(raw) {
  const match = raw.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
  if (!match) throw new Error('Cannot find SYSTEM_PROMPT template literal');
  return match[1].trim();
}

function buildKnowledge() {
  const raw    = fs.readFileSync(SRC, 'utf8');
  const prompt = extractPromptString(raw);

  // strip persona/instruction lines — เก็บแค่ knowledge content
  const lines = prompt.split('\n');
  const kept  = [];
  let skip = false;

  for (const line of lines) {
    // ข้ามส่วน system rules / markers / persona instructions
    if (line.match(/^## (บุคลิก|สไตล์การสอน|กฎเหล็ก|ขั้นตอนสอน|ระบบ Marker|กฎ Marker|การเริ่มต้น|คำสั่งพิเศษ)/)) {
      skip = true;
    }
    if (line.startsWith('## ') && !line.match(/^## (บุคลิก|สไตล์การสอน|กฎเหล็ก|ขั้นตอนสอน|ระบบ Marker|กฎ Marker|การเริ่มต้น|คำสั่งพิเศษ)/)) {
      skip = false;
    }
    if (!skip) kept.push(line);
  }

  const header = `# คลังความรู้ทักษะการขาย — Smart Solution Computer
> สร้างจาก systemPrompt.js เมื่อ ${new Date().toISOString().slice(0, 10)}
> ใช้เป็น knowledge base สำหรับ Gemini Files API

---

`;

  const content = header + kept.join('\n');
  fs.writeFileSync(DEST, content, 'utf8');

  const lines2 = content.split('\n').length;
  const kb     = (Buffer.byteLength(content, 'utf8') / 1024).toFixed(1);
  console.log(`✅ Built: docs/sales-knowledge.md`);
  console.log(`   ${lines2} lines, ${kb} KB`);
  return DEST;
}

if (require.main === module) {
  buildKnowledge();
}

module.exports = { buildKnowledge };
