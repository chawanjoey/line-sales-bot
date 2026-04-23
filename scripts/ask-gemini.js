#!/usr/bin/env node
// scripts/ask-gemini.js — CLI แทน NotebookLM MCP
// Usage:
//   node scripts/ask-gemini.js "คำถาม"            → one-shot
//   node scripts/ask-gemini.js                     → interactive mode
//   node scripts/ask-gemini.js --ingest "คำถาม"   → ใช้ systemPrompt โดยตรง (ไม่ต้อง upload)
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const readline = require('readline');
const fs       = require('fs');
const path     = require('path');

const REGISTRY   = path.join(__dirname, '../docs/gemini-files.json');
const SYSTEM_TXT = path.join(__dirname, '../docs/sales-knowledge.md');
const MODEL_NAME = 'gemini-2.5-flash';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─── System instruction ────────────────────────────────────────────────────────
const SYSTEM_INSTRUCTION = `คุณคือผู้ช่วยด้านทักษะการขาย IT ของบริษัท Smart Solution Computer
ตอบด้วยภาษาไทย กระชับ ตรงประเด็น อ้างอิงจากเอกสารที่ให้มาเสมอ
ถ้าถามเรื่อง framework ให้ยก script / ตัวอย่างพร้อมใช้ด้วยทุกครั้ง`;

// ─── Load file registry ────────────────────────────────────────────────────────
function loadRegistry() {
  if (!fs.existsSync(REGISTRY)) return null;
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  if (!reg.files?.length) return null;
  const f = reg.files[0];
  // ตรวจว่ายังไม่หมดอายุ (หักไว้ 1 ชม.)
  if (new Date(f.expiresAt) < new Date(Date.now() + 3_600_000)) {
    console.warn('⚠️  File expired — รัน node scripts/upload-docs.js ก่อน');
    return null;
  }
  return f;
}

// ─── Build message parts ───────────────────────────────────────────────────────
function buildParts(question, fileInfo, useInline) {
  if (fileInfo) {
    // ใช้ Gemini Files API URI
    return [
      { fileData: { fileUri: fileInfo.uri, mimeType: 'text/plain' } },
      { text: question },
    ];
  }
  if (useInline && fs.existsSync(SYSTEM_TXT)) {
    // inline text fallback — ไม่ต้อง upload ไฟล์
    const content = fs.readFileSync(SYSTEM_TXT, 'utf8');
    return [
      { text: `เอกสารอ้างอิง:\n\n${content}\n\n---\nคำถาม: ${question}` },
    ];
  }
  // no document — ตอบจาก training data
  return [{ text: question }];
}

// ─── Ask Gemini ────────────────────────────────────────────────────────────────
async function ask(question, fileInfo, useInline = false) {
  const model  = genAI.getGenerativeModel({
    model:             MODEL_NAME,
    systemInstruction: SYSTEM_INSTRUCTION,
  });
  const parts  = buildParts(question, fileInfo, useInline);
  const result = await model.generateContent(parts);
  return result.response.text();
}

// ─── Chat session (เก็บ history) ──────────────────────────────────────────────
async function chatSession(fileInfo, useInline) {
  const model = genAI.getGenerativeModel({
    model:             MODEL_NAME,
    systemInstruction: SYSTEM_INSTRUCTION,
  });

  // inject document เป็น first turn ถ้ามี
  let history = [];
  if (fileInfo) {
    history = [
      { role: 'user',  parts: [
        { fileData: { fileUri: fileInfo.uri, mimeType: 'text/plain' } },
        { text: 'นี่คือเอกสารความรู้ทักษะการขาย กรุณาอ่านและพร้อมตอบคำถาม' },
      ]},
      { role: 'model', parts: [{ text: 'รับทราบครับ อ่านเอกสารแล้ว พร้อมตอบคำถามเรื่องทักษะการขาย IT ได้เลยครับ' }] },
    ];
  } else if (useInline && fs.existsSync(SYSTEM_TXT)) {
    const content = fs.readFileSync(SYSTEM_TXT, 'utf8');
    history = [
      { role: 'user',  parts: [{ text: `เอกสารอ้างอิง:\n\n${content}\n\n---\nกรุณาอ่านและพร้อมตอบคำถาม` }] },
      { role: 'model', parts: [{ text: 'รับทราบครับ อ่านเอกสารแล้ว พร้อมตอบคำถามได้เลยครับ' }] },
    ];
  }

  const chat = model.startChat({ history });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const src = fileInfo ? `📂 ${fileInfo.displayName}` : useInline ? '📄 inline doc' : '🧠 training data';

  console.log(`\n🤖 Gemini Sales Assistant — Interactive Mode`);
  console.log(`   Model: ${MODEL_NAME}  |  Source: ${src}`);
  console.log(`   พิมพ์ "exit" หรือ Ctrl+C เพื่อออก\n`);

  const prompt = () => {
    rl.question('คุณ: ', async (input) => {
      const q = input.trim();
      if (!q) return prompt();
      if (q.toLowerCase() === 'exit' || q === 'ออก') { rl.close(); return; }

      try {
        process.stdout.write('โคชโจ AI: ');
        const result = await chat.sendMessage(q);
        const text   = result.response.text();
        console.log(text + '\n');
      } catch (err) {
        console.error(`❌ Error: ${err.message}\n`);
      }
      prompt();
    });
  };
  prompt();
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args       = process.argv.slice(2);
  const useInline  = args.includes('--inline');
  const filteredArgs = args.filter(a => a !== '--inline');
  const question   = filteredArgs.join(' ').trim();

  const fileInfo = loadRegistry();

  if (!fileInfo && !useInline) {
    console.log('⚠️  ไม่พบ Gemini file — ใช้ inline mode (docs/sales-knowledge.md)');
    console.log('   รัน: node scripts/upload-docs.js เพื่อประสิทธิภาพที่ดีกว่า\n');
  }

  if (question) {
    // one-shot mode
    try {
      const answer = await ask(question, fileInfo, true);
      console.log('\n' + answer);
    } catch (err) {
      console.error('❌', err.message);
      process.exit(1);
    }
    process.exit(0);
  } else {
    // interactive mode
    await chatSession(fileInfo, true);
  }
}

main();
