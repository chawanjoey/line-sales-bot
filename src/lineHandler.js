const line = require('@line/bot-sdk');
const { askClaude } = require('./claude');
const { addMessage, getChatHistory, resetChatHistory } = require('./sessionStore');
const {
  findByEmployeeCode,
  findBySalescoachUID,
  linkLineUID,
  getTrainingSession,
  updateModule,
  recordQuiz,
  getQuizAttempts,
  calcKPI,
  getKPIGrade,
} = require('./employeeStore');

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

// ─── Loading Animation ────────────────────────────────────────────────────────

async function showLoading(userId, seconds = 20) {
  try {
    const res = await fetch('https://api.line.me/v2/bot/chat/loading/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ chatId: userId, loadingSeconds: seconds }),
    });
    const body = await res.text();
    console.log(`⏳ Loading → ${res.status}: ${body}`);
  } catch (e) {
    console.error('Loading error:', e.message);
  }
}

// ─── Marker Parsing ───────────────────────────────────────────────────────────

async function parseAndStripMarkers(text, employeeId, moduleNumber) {
  let clean = text;

  const quizPassFirst  = clean.match(/\[QUIZ:PASS:FIRST:M(\d+)\]/);
  const quizPassSecond = clean.match(/\[QUIZ:PASS:SECOND:M(\d+)\]/);
  const quizFail       = clean.match(/\[QUIZ:FAIL:M(\d+)\]/);

  if (quizPassFirst) {
    const m = parseInt(quizPassFirst[1]);
    await recordQuiz(employeeId, m, true, 1);
    console.log(`✅ Quiz PASS 1st try M${m}`);
    clean = clean.replace(/\[QUIZ:PASS:FIRST:M\d+\]/g, '');
  } else if (quizPassSecond) {
    const m = parseInt(quizPassSecond[1]);
    await recordQuiz(employeeId, m, true, 2);
    console.log(`✅ Quiz PASS 2nd try M${m}`);
    clean = clean.replace(/\[QUIZ:PASS:SECOND:M\d+\]/g, '');
  } else if (quizFail) {
    const m = parseInt(quizFail[1]);
    const attempts = await getQuizAttempts(employeeId, m);
    await recordQuiz(employeeId, m, false, attempts.length + 1);
    console.log(`❌ Quiz FAIL M${m}`);
    clean = clean.replace(/\[QUIZ:FAIL:M\d+\]/g, '');
  }

  // ลบ [REG:...] ถ้า Claude ยังใส่มา
  clean = clean.replace(/\[REG:[^\]]*\]/g, '');

  return clean.trim();
}

// ─── Message Splitter ─────────────────────────────────────────────────────────

function splitMessage(text, maxLength = 1500) {
  if (text.length <= maxLength) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > 0 && parts.length < 5) {
    if (remaining.length <= maxLength) { parts.push(remaining); break; }
    let cutAt = remaining.lastIndexOf('\n', maxLength);
    if (cutAt < maxLength / 2) cutAt = maxLength;
    parts.push(remaining.slice(0, cutAt).trim());
    remaining = remaining.slice(cutAt).trim();
  }
  return parts;
}

// ─── Reply Helper ─────────────────────────────────────────────────────────────

function reply(replyToken, text) {
  return lineClient.replyMessage({
    replyToken,
    messages: [{ type: 'text', text }],
  });
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId    = event.source.userId;
  const userText  = event.message.text.trim();
  const replyToken = event.replyToken;

  // ── คำสั่งรีเซ็ต ──
  if (userText === '/reset' || userText === 'เริ่มใหม่') {
    await resetChatHistory(userId);
    return reply(replyToken, '🔄 รีเซ็ตแล้วครับ! พิมพ์ "สวัสดี" เพื่อเริ่มเรียนใหม่');
  }

  // ── ตรวจว่าลงทะเบียนแล้วหรือยัง ──────────────────────────────────────────
  let employee = await findBySalescoachUID(userId);

  if (!employee) {
    // ── Registration flow ──────────────────────────────────────────────────
    // ดูว่าเคยทักมาแล้วหรือยัง (มี chat history ไหม)
    const history = await getChatHistory(userId);

    if (history.length === 0) {
      // ครั้งแรกสุด — ถามรหัสพนักงาน
      await addMessage(userId, 'assistant', '__ASKING_CODE__');
      return reply(replyToken,
        '👋 สวัสดีครับ! ยินดีต้อนรับสู่ "โค้ชปิดดีล AI" 🎯\n\n' +
        'กรุณากรอก **รหัสพนักงาน** (Employee Code)\n' +
        'เช่น SM5609235\n\n' +
        '💡 ดูรหัสพนักงานได้ที่ระบบลางาน'
      );
    }

    // รอรับ Employee Code
    const lastMsg = history[history.length - 1];
    if (lastMsg?.content === '__ASKING_CODE__') {
      const code = userText.toUpperCase().trim();
      const emp = await findByEmployeeCode(code);

      if (!emp) {
        return reply(replyToken,
          `❌ ไม่พบรหัส "${code}" ในระบบครับ\n\n` +
          'กรุณาตรวจสอบรหัสพนักงานและลองใหม่อีกครั้ง\n' +
          'หรือติดต่อ HR เพื่อขอความช่วยเหลือ'
        );
      }

      if (!emp.training_enrolled) {
        return reply(replyToken,
          `⚠️ สวัสดีคุณ ${emp.name} ครับ\n\n` +
          'คุณยังไม่ได้รับสิทธิ์เข้า Training รอบนี้ครับ\n' +
          'กรุณาติดต่อ HR เพื่อขอเปิดสิทธิ์'
        );
      }

      // ผูก LINE userId กับพนักงาน
      await linkLineUID(emp.id, userId);
      await resetChatHistory(userId);

      console.log(`✅ Registered: ${emp.name} (${emp.employee_code}) → ${userId}`);

      return reply(replyToken,
        `✅ ยืนยันตัวตนสำเร็จครับ!\n\n` +
        `👤 ${emp.name}\n` +
        `🏢 แผนก: ${emp.department}\n\n` +
        `พร้อมเริ่มเรียนหลักสูตร 7 Module แล้ว 🚀\n` +
        `พิมพ์ "สวัสดี" เพื่อเริ่มได้เลยครับ!`
      );
    }

    // กรณีอื่น — ถามรหัสใหม่
    return reply(replyToken,
      'กรุณากรอก **รหัสพนักงาน** ก่อนเริ่มใช้งานครับ\nเช่น SM5609235'
    );
  }

  // ── พนักงานลงทะเบียนแล้ว — เข้าสู่โหมดเรียน ──────────────────────────────

  // คำสั่ง /progress
  if (userText === '/progress' || userText === 'ความคืบหน้า') {
    const session = await getTrainingSession(employee.id);
    const completed = (session.completed_modules || []).length;
    const { rows: qs } = await require('./db').query(
      'SELECT module_number, attempt, is_correct FROM quiz_scores WHERE employee_id = $1',
      [employee.id]
    );
    const quizSummary = {};
    for (const r of qs) {
      if (!quizSummary[r.module_number]) quizSummary[r.module_number] = { passed: false, passedAttempt: null };
      if (r.is_correct && !quizSummary[r.module_number].passed) {
        quizSummary[r.module_number].passed = true;
        quizSummary[r.module_number].passedAttempt = r.attempt;
      }
    }
    const kpi = calcKPI(session, quizSummary);
    const { grade, label } = getKPIGrade(kpi);
    return reply(replyToken,
      `📊 ความคืบหน้าของ ${employee.name}\n` +
      `Module ที่เรียนอยู่: ${session.current_module}/7\n` +
      `เรียนจบแล้ว: ${completed} Module\n` +
      `${'✅'.repeat(completed)}${'⬜'.repeat(7 - completed)}\n\n` +
      `🏆 คะแนน KPI: ${kpi}/100\n` +
      `เกรด: ${label} (${grade})`
    );
  }

  if (userText === '/score' || userText === 'คะแนน') {
    const session = await getTrainingSession(employee.id);
    const { rows: qs } = await require('./db').query(
      'SELECT module_number, attempt, is_correct FROM quiz_scores WHERE employee_id = $1',
      [employee.id]
    );
    const quizSummary = {};
    for (const r of qs) {
      if (!quizSummary[r.module_number]) quizSummary[r.module_number] = { passed: false, passedAttempt: null };
      if (r.is_correct && !quizSummary[r.module_number].passed) {
        quizSummary[r.module_number].passed = true;
        quizSummary[r.module_number].passedAttempt = r.attempt;
      }
    }
    const kpi = calcKPI(session, quizSummary);
    const { grade, label, reward } = getKPIGrade(kpi);
    return reply(replyToken,
      `🏆 คะแนน KPI ของ ${employee.name}\n\n` +
      `คะแนนรวม: ${kpi}/100\n` +
      `เกรด: ${label} (${grade})\n` +
      `รางวัล: ${reward}`
    );
  }

  // ── แสดง Loading ──────────────────────────────────────────────────────────
  await showLoading(userId, 30);

  try {
    const session = addMessage(userId, 'user', userText);
    const history = await getChatHistory(userId);

    // ส่งให้ Claude พร้อม context พนักงาน
    const rawReply = await askClaude(history, employee);

    // Parse markers
    const trainingSession = await getTrainingSession(employee.id);
    const reply_text = await parseAndStripMarkers(rawReply, employee.id, trainingSession.current_module);

    await addMessage(userId, 'assistant', reply_text);

    // อัปเดต module ถ้า Claude พูดถึง Module ใหม่
    const moduleMatch = reply_text.match(/Module\s*(\d)/i);
    if (moduleMatch) {
      await updateModule(employee.id, parseInt(moduleMatch[1]));
    }

    const messages = splitMessage(reply_text);
    return lineClient.replyMessage({
      replyToken,
      messages: messages.map(text => ({ type: 'text', text })),
    });

  } catch (error) {
    console.error('Handler error:', error);
    return reply(replyToken, '⚠️ เกิดข้อผิดพลาด กรุณาลองใหม่ครับ');
  }
}

module.exports = { handleEvent };
