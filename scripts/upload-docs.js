// scripts/upload-docs.js
// Upload docs/sales-knowledge.md → Gemini Files API
// บันทึก file URI ไว้ที่ docs/gemini-files.json (อายุ 48 ชม.)
require('dotenv').config();
const { GoogleAIFileManager } = require('@google/generative-ai/server');
const { GoogleGenerativeAI }  = require('@google/generative-ai');
const { buildKnowledge }      = require('./build-knowledge');
const fs   = require('fs');
const path = require('path');

const REGISTRY = path.join(__dirname, '../docs/gemini-files.json');

async function uploadDocs() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set in .env');

  const fileManager = new GoogleAIFileManager(apiKey);
  const genAI       = new GoogleGenerativeAI(apiKey);

  // 1) build clean knowledge doc
  console.log('📝 Building knowledge document...');
  const docPath = buildKnowledge();

  // 2) ลบไฟล์เก่าบน Gemini ถ้ามี
  let registry = { files: [] };
  if (fs.existsSync(REGISTRY)) {
    registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    for (const f of registry.files) {
      try {
        await fileManager.deleteFile(f.name);
        console.log(`🗑️  Deleted old file: ${f.displayName}`);
      } catch { /* ไม่สนถ้าหมดอายุแล้ว */ }
    }
  }

  // 3) upload ไฟล์ใหม่
  console.log('\n⬆️  Uploading to Gemini Files API...');
  const upload = await fileManager.uploadFile(docPath, {
    mimeType:    'text/plain',
    displayName: 'Sales Knowledge Base — Smart Solution Computer',
  });

  const file = upload.file;
  console.log(`✅ Uploaded: ${file.displayName}`);
  console.log(`   URI:  ${file.uri}`);
  console.log(`   Size: ${(file.sizeBytes / 1024).toFixed(1)} KB`);
  console.log(`   Expires: ${new Date(file.expirationTime).toLocaleString('th-TH')}`);

  // 4) รอให้ state เป็น ACTIVE
  process.stdout.write('⏳ Waiting for file to be ACTIVE...');
  let state = file.state;
  let meta  = file;
  while (state === 'PROCESSING') {
    await new Promise(r => setTimeout(r, 2000));
    meta  = await fileManager.getFile(file.name);
    state = meta.state;
    process.stdout.write('.');
  }
  console.log(` ${state}`);

  if (state !== 'ACTIVE') throw new Error(`File state: ${state}`);

  // 5) บันทึก registry
  registry = {
    updatedAt: new Date().toISOString(),
    files: [{ name: meta.name, uri: meta.uri, displayName: meta.displayName, expiresAt: meta.expirationTime }],
  };
  fs.writeFileSync(REGISTRY, JSON.stringify(registry, null, 2), 'utf8');
  console.log(`\n💾 Saved to docs/gemini-files.json`);

  // 6) ทดสอบ query เล็กน้อย
  console.log('\n🧪 Testing quick query...');
  const model  = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const result = await model.generateContent([
    { fileData: { fileUri: meta.uri, mimeType: 'text/plain' } },
    { text: 'สรุปหัวข้อหลักที่มีในเอกสารนี้ในรูปแบบ bullet 5 ข้อ' },
  ]);
  console.log('\n📋 Document summary:');
  console.log(result.response.text());
  console.log('\n🎉 Ready! รัน: node scripts/ask-gemini.js');
}

uploadDocs().catch(err => { console.error('❌', err.message); process.exit(1); });
