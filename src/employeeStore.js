// employeeStore.js — Employee & Training data (Neon PostgreSQL)
const pool = require('./db');

// ─── Employee Lookup ──────────────────────────────────────────────────────────

async function findByEmployeeCode(code) {
  const { rows } = await pool.query(
    `SELECT id, employee_code, name, department, role, training_enrolled, salescoach_line_uid
     FROM employees
     WHERE employee_code = $1 AND is_active = 1`,
    [code.trim().toUpperCase()]
  );
  return rows[0] || null;
}

async function findBySalescoachUID(lineUserId) {
  const { rows } = await pool.query(
    `SELECT id, employee_code, name, department, role, training_enrolled
     FROM employees
     WHERE salescoach_line_uid = $1`,
    [lineUserId]
  );
  return rows[0] || null;
}

async function linkLineUID(employeeId, lineUserId) {
  await pool.query(
    `UPDATE employees SET salescoach_line_uid = $1, updated_at = NOW()
     WHERE id = $2`,
    [lineUserId, employeeId]
  );
}

// ─── Training Session ─────────────────────────────────────────────────────────

async function getTrainingSession(employeeId) {
  const { rows } = await pool.query(
    `SELECT * FROM training_sessions WHERE employee_id = $1`,
    [employeeId]
  );
  if (rows[0]) return rows[0];

  // สร้างใหม่ถ้ายังไม่มี
  const { rows: newRows } = await pool.query(
    `INSERT INTO training_sessions (employee_id) VALUES ($1) RETURNING *`,
    [employeeId]
  );
  return newRows[0];
}

async function updateModule(employeeId, moduleNumber) {
  // เพิ่ม module เก่าลง completed ถ้ายังไม่มี
  await pool.query(
    `UPDATE training_sessions
     SET current_module    = $1,
         completed_modules = array(
           SELECT DISTINCT unnest(
             CASE WHEN $2 > 1
               THEN array_append(completed_modules, $2 - 1)
               ELSE completed_modules
             END
           ) ORDER BY 1
         ),
         updated_at = NOW()
     WHERE employee_id = $3`,
    [moduleNumber, moduleNumber, employeeId]
  );
}

// ─── Quiz Scores ──────────────────────────────────────────────────────────────

async function recordQuiz(employeeId, moduleNumber, isCorrect, attempt) {
  await pool.query(
    `INSERT INTO quiz_scores (employee_id, module_number, attempt, is_correct)
     VALUES ($1, $2, $3, $4)`,
    [employeeId, moduleNumber, attempt, isCorrect]
  );
}

async function getQuizAttempts(employeeId, moduleNumber) {
  const { rows } = await pool.query(
    `SELECT * FROM quiz_scores
     WHERE employee_id = $1 AND module_number = $2
     ORDER BY attempt ASC`,
    [employeeId, moduleNumber]
  );
  return rows;
}

async function getQuizSummary(employeeId) {
  const { rows } = await pool.query(
    `SELECT module_number, attempt, is_correct
     FROM quiz_scores WHERE employee_id = $1
     ORDER BY module_number, attempt`,
    [employeeId]
  );
  const summary = {};
  for (const row of rows) {
    if (!summary[row.module_number]) {
      summary[row.module_number] = { passed: false, passedAttempt: null, attempts: 0 };
    }
    summary[row.module_number].attempts++;
    if (row.is_correct && !summary[row.module_number].passed) {
      summary[row.module_number].passed = true;
      summary[row.module_number].passedAttempt = row.attempt;
    }
  }
  return summary;
}

// ─── KPI ──────────────────────────────────────────────────────────────────────

function calcKPI(session, quizSummary) {
  let score = 0;
  for (let m = 1; m <= 7; m++) {
    const q = quizSummary[m];
    if (!q) continue;
    if (q.passedAttempt === 1)  score += 10;
    else if (q.passed)          score += 7;
  }
  const allDone = (session.completed_modules || []).length >= 6 || session.current_module > 7;
  if (allDone) score += 30;
  return Math.min(score, 100);
}

function getKPIGrade(score) {
  if (score >= 90) return { grade: 'A', label: '🥇 ดีเยี่ยม', reward: 'ของรางวัลพิเศษ' };
  if (score >= 75) return { grade: 'B', label: '🥈 ดีมาก',   reward: 'Gift Voucher' };
  if (score >= 60) return { grade: 'C', label: '🥉 ดี',       reward: 'ใบประกาศ' };
  if (score >= 40) return { grade: 'D', label: '📘 พอใช้',   reward: '-' };
  return              { grade: 'F', label: '📕 ต้องปรับปรุง', reward: '-' };
}

// ─── Admin: All Employees ─────────────────────────────────────────────────────

async function getAllEnrolled() {
  const { rows } = await pool.query(
    `SELECT
       e.id, e.employee_code, e.name, e.department, e.role,
       e.training_enrolled, e.enrolled_at,
       e.salescoach_line_uid,
       ts.current_module,
       ts.completed_modules,
       ts.started_at  AS training_started,
       ts.updated_at  AS training_updated
     FROM employees e
     LEFT JOIN training_sessions ts ON ts.employee_id = e.id
     WHERE e.is_active = 1 AND e.name != 'ทดสอบ'
     ORDER BY e.department, e.name`
  );

  const result = [];
  for (const row of rows) {
    const quizSummary = row.salescoach_line_uid
      ? await getQuizSummary(row.id)
      : {};
    const session = {
      current_module: row.current_module || 1,
      completed_modules: row.completed_modules || [],
    };
    const kpiScore = calcKPI(session, quizSummary);
    const kpiGrade = getKPIGrade(kpiScore);
    result.push({
      ...row,
      current_module: session.current_module,
      completed_modules: session.completed_modules,
      kpiScore,
      grade: kpiGrade.grade,
      gradeLabel: kpiGrade.label,
      reward: kpiGrade.reward,
      quizSummary,
      registered: !!row.salescoach_line_uid,
    });
  }
  return result;
}

// ─── Admin: Enroll/Unenroll ───────────────────────────────────────────────────

async function setEnrolled(employeeId, enrolled) {
  await pool.query(
    `UPDATE employees
     SET training_enrolled = $1,
         enrolled_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
         updated_at  = NOW()
     WHERE id = $2`,
    [enrolled, employeeId]
  );
}

module.exports = {
  findByEmployeeCode,
  findBySalescoachUID,
  linkLineUID,
  getTrainingSession,
  updateModule,
  recordQuiz,
  getQuizAttempts,
  getQuizSummary,
  calcKPI,
  getKPIGrade,
  getAllEnrolled,
  setEnrolled,
};
