require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const { handleEvent }  = require('./src/lineHandler');
const { getAllEnrolled, setEnrolled, findByEmployeeCode } = require('./src/employeeStore');
const pool = require('./src/db');

const app  = express();
const PORT = process.env.PORT || 3002;
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const ADMIN_TOKEN    = process.env.ADMIN_TOKEN || 'admin1234';

// ── Middleware ────────────────────────────────────────────────────────────────
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── LINE Signature ────────────────────────────────────────────────────────────
function verifyLineSignature(body, signature) {
  const hash = crypto.createHmac('sha256', CHANNEL_SECRET).update(body).digest('base64');
  return hash === signature;
}

// ── Admin Auth Middleware ─────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = req.query.token || req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) {
    if (req.path.startsWith('/admin/api')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.status(401).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0f172a;color:#e2e8f0">
        <h2>🔒 Admin Login</h2>
        <form method="GET" action="/admin">
          <input name="token" type="password" placeholder="Admin Token"
            style="padding:10px;font-size:16px;width:260px;border-radius:8px;border:1px solid #475569;background:#1e293b;color:#e2e8f0">
          <button type="submit"
            style="padding:10px 24px;font-size:16px;margin-left:8px;background:#3b82f6;color:#fff;border:none;border-radius:8px;cursor:pointer">
            เข้าสู่ระบบ
          </button>
        </form>
      </body></html>
    `);
  }
  next();
}

// ── Webhook ───────────────────────────────────────────────────────────────────
app.post('/webhook', (req, res) => {
  const signature = req.headers['x-line-signature'];
  const rawBody   = req.body;
  res.status(200).json({ status: 'ok' });
  if (!signature || !verifyLineSignature(rawBody, signature)) return;
  try {
    const events = JSON.parse(rawBody.toString()).events || [];
    console.log(`📨 ${events.length} event(s)`);
    events.forEach(e => handleEvent(e).catch(console.error));
  } catch (e) { console.error('Parse error:', e.message); }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: '🚀 Sales Bot running', port: PORT }));

// ── Admin API: ดูพนักงานทั้งหมด ───────────────────────────────────────────────
app.get('/admin/api/employees', adminAuth, async (req, res) => {
  try {
    const employees = await getAllEnrolled();
    res.json({ total: employees.length, employees });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin API: Enroll / Unenroll ──────────────────────────────────────────────
app.post('/admin/api/enroll', adminAuth, async (req, res) => {
  const { employeeId, enrolled } = req.body;
  if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
  try {
    await setEnrolled(employeeId, !!enrolled);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin Dashboard ───────────────────────────────────────────────────────────
app.get('/admin', adminAuth, async (req, res) => {
  const token = req.query.token;
  try {
    const employees = await getAllEnrolled();
    const enrolled  = employees.filter(e => e.training_enrolled);
    const avgKPI    = enrolled.length
      ? Math.round(enrolled.reduce((s, e) => s + e.kpiScore, 0) / enrolled.length) : 0;
    const topScore  = enrolled.length ? Math.max(...enrolled.map(e => e.kpiScore)) : 0;
    const completed = enrolled.filter(e => (e.completed_modules || []).length >= 6).length;

    // Group by dept for selector
    const depts = [...new Set(employees.map(e => e.department))].sort();

    const rows = employees.sort((a, b) => {
      if (a.training_enrolled !== b.training_enrolled) return b.training_enrolled - a.training_enrolled;
      return b.kpiScore - a.kpiScore;
    }).map((e, i) => {
      const modules = Array.from({ length: 7 }, (_, m) => {
        const done = (e.completed_modules || []).includes(m + 1) || e.current_module > m + 1;
        return done ? '✅' : (e.current_module === m + 1 ? '🔄' : '⬜');
      }).join('');

      const quizCells = Array.from({ length: 7 }, (_, m) => {
        const q = e.quizSummary[m + 1];
        if (!q) return '<td style="color:#4b5563;text-align:center">—</td>';
        if (q.passedAttempt === 1) return '<td style="color:#22c55e;text-align:center;font-weight:bold">✓10</td>';
        if (q.passed)              return '<td style="color:#f59e0b;text-align:center;font-weight:bold">✓7</td>';
        return '<td style="color:#ef4444;text-align:center">✗0</td>';
      }).join('');

      const gradeColor = e.grade === 'A' ? '#22c55e' : e.grade === 'B' ? '#3b82f6'
                       : e.grade === 'C' ? '#f59e0b' : '#6b7280';
      const enrollBg  = e.training_enrolled ? '#166534' : '#1e293b';
      const enrollTxt = e.training_enrolled ? '#86efac' : '#94a3b8';
      const enrollLbl = e.training_enrolled ? 'enrolled' : 'unenrolled';
      const regBadge  = e.registered
        ? '<span style="color:#22c55e;font-size:11px">● linked</span>'
        : '<span style="color:#6b7280;font-size:11px">○ pending</span>';

      return `
        <tr data-dept="${e.department}" data-enrolled="${e.training_enrolled}">
          <td style="text-align:center">
            <input type="checkbox" class="enroll-cb"
              data-id="${e.id}" ${e.training_enrolled ? 'checked' : ''}
              style="width:16px;height:16px;cursor:pointer">
          </td>
          <td>
            <strong>${e.name}</strong> ${regBadge}<br>
            <small style="color:#64748b">${e.employee_code} · ${e.department}</small>
          </td>
          <td style="text-align:center">
            <span style="background:${gradeColor};color:#fff;padding:2px 8px;border-radius:10px;font-size:12px">${e.grade}</span>
          </td>
          <td style="text-align:center;font-weight:bold;font-size:18px">${e.training_enrolled ? e.kpiScore : '—'}</td>
          ${quizCells}
          <td style="font-size:12px;letter-spacing:2px">${e.training_enrolled ? modules : '<span style="color:#4b5563">ยังไม่เปิดสิทธิ์</span>'}</td>
          <td style="font-size:11px;color:#64748b">${e.training_updated ? e.training_updated.toString().slice(0,16) : '—'}</td>
        </tr>`;
    }).join('');

    res.send(`<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>📊 Sales Coach Admin</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0}
    .header{background:linear-gradient(135deg,#1e3a5f,#0f4c75);padding:20px 32px;display:flex;justify-content:space-between;align-items:center}
    .header h1{font-size:22px}
    .header small{color:#94a3b8;font-size:13px}
    .stats{display:flex;gap:16px;padding:20px 32px;flex-wrap:wrap}
    .stat{background:#1e293b;border-radius:12px;padding:16px 24px;flex:1;min-width:140px;border:1px solid #334155}
    .stat .num{font-size:32px;font-weight:bold}
    .stat .lbl{color:#94a3b8;font-size:12px;margin-top:4px}
    .toolbar{padding:0 32px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
    select,button{padding:8px 16px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;font-size:13px;cursor:pointer}
    button.primary{background:#3b82f6;border-color:#3b82f6}
    button.primary:hover{background:#2563eb}
    button.success{background:#16a34a;border-color:#16a34a}
    button.danger{background:#dc2626;border-color:#dc2626}
    .table-wrap{padding:0 32px 32px;overflow-x:auto}
    table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:12px;overflow:hidden}
    th{background:#1e3a5f;padding:10px 12px;text-align:left;font-size:12px;color:#94a3b8;white-space:nowrap}
    td{padding:10px 12px;border-bottom:1px solid #334155;font-size:13px;vertical-align:middle}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:#263449}
    tr[data-enrolled="false"] td{opacity:.6}
    .legend{padding:0 32px 24px;color:#475569;font-size:11px}
    .toast{position:fixed;bottom:24px;right:24px;background:#22c55e;color:#fff;padding:12px 20px;border-radius:10px;font-size:14px;display:none;z-index:999}
  </style>
</head>
<body>
<div class="header">
  <div>
    <h1>📊 Sales Coach Admin Dashboard</h1>
    <small>Powered by Leave System Employee DB · ${new Date().toLocaleString('th-TH')}</small>
  </div>
  <a href="/admin?token=${token}" style="color:#60a5fa;font-size:13px">🔄 Refresh</a>
</div>

<div class="stats">
  <div class="stat"><div class="num" style="color:#60a5fa">${employees.length}</div><div class="lbl">พนักงานทั้งหมด</div></div>
  <div class="stat"><div class="num" style="color:#a78bfa">${enrolled.length}</div><div class="lbl">ได้รับสิทธิ์ Training</div></div>
  <div class="stat"><div class="num" style="color:#22c55e">${avgKPI}</div><div class="lbl">KPI เฉลี่ย</div></div>
  <div class="stat"><div class="num" style="color:#f59e0b">${topScore}</div><div class="lbl">คะแนนสูงสุด</div></div>
  <div class="stat"><div class="num" style="color:#ec4899">${completed}</div><div class="lbl">เรียนจบ 7 Module</div></div>
</div>

<div class="toolbar">
  <select id="deptFilter" onchange="filterDept()">
    <option value="">ทุกแผนก</option>
    ${depts.map(d => `<option value="${d}">${d}</option>`).join('')}
  </select>
  <select id="enrollFilter" onchange="filterDept()">
    <option value="">ทุกสถานะ</option>
    <option value="true">Enrolled เท่านั้น</option>
    <option value="false">ยังไม่ Enrolled</option>
  </select>
  <button class="success" onclick="saveEnrollments()">💾 บันทึกสิทธิ์ที่เลือก</button>
  <button onclick="selectAll(true)">เลือกทั้งหมด</button>
  <button onclick="selectAll(false)">ยกเลิกทั้งหมด</button>
</div>

<div class="table-wrap">
  <table id="empTable">
    <thead>
      <tr>
        <th>เปิดสิทธิ์</th>
        <th>พนักงาน</th>
        <th>เกรด</th>
        <th>KPI</th>
        <th>M1</th><th>M2</th><th>M3</th><th>M4</th><th>M5</th><th>M6</th><th>M7</th>
        <th>Progress</th>
        <th>อัปเดตล่าสุด</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</div>

<div class="legend">
  🥇 A(90+) ของรางวัลพิเศษ &nbsp;|&nbsp; 🥈 B(75+) Gift Voucher &nbsp;|&nbsp;
  🥉 C(60+) ใบประกาศ &nbsp;|&nbsp; ✓10 = ผ่านครั้งแรก &nbsp;|&nbsp; ✓7 = ผ่านครั้งสอง
</div>

<div class="toast" id="toast"></div>

<script>
const TOKEN = '${token}';

function filterDept() {
  const dept = document.getElementById('deptFilter').value;
  const enr  = document.getElementById('enrollFilter').value;
  document.querySelectorAll('#empTable tbody tr').forEach(tr => {
    const dMatch = !dept || tr.dataset.dept === dept;
    const eMatch = !enr  || tr.dataset.enrolled === enr;
    tr.style.display = dMatch && eMatch ? '' : 'none';
  });
}

function selectAll(val) {
  document.querySelectorAll('.enroll-cb').forEach(cb => {
    const tr = cb.closest('tr');
    if (tr.style.display !== 'none') cb.checked = val;
  });
}

async function saveEnrollments() {
  const checkboxes = document.querySelectorAll('.enroll-cb');
  const updates = [];
  checkboxes.forEach(cb => {
    updates.push(fetch('/admin/api/enroll?token=' + TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: cb.dataset.id, enrolled: cb.checked })
    }));
  });
  await Promise.all(updates);
  showToast('✅ บันทึกสิทธิ์เรียบร้อย!');
  setTimeout(() => location.reload(), 1200);
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 3000);
}
</script>
</body>
</html>`);
  } catch (e) {
    console.error(e);
    res.status(500).send('Error: ' + e.message);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📊 Admin: http://localhost:${PORT}/admin?token=${ADMIN_TOKEN}`);
});
