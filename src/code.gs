/** ============================================================
 * 00_constants.gs — Recurring Task Tracking & Escalation System
 * Allo Innoware prototype | Google Sheets + Apps Script
 * Schema map, column indexes, defaults. All other modules rely on this.
 * ============================================================ */

var APP_TZ = 'Asia/Kolkata';

var SHEET = {
  CONFIG:   'Config',
  TASKS:    'Task_Master',
  CYCLES:   'Cycle_Log',
  ALERTS:   'Alert_Log',
  OUTBOX:   'Email_Outbox',
  AUDIT:    'Audit_Log',
  RUNLOG:   'Run_Log',
  DASH:     'Manager_Dashboard',
  HOLIDAYS: 'Holidays',
  TESTS:    'Test_Cases'
};

var EMP_PREFIX = 'Emp_';

/* ---- Cycle_Log columns (1-indexed) ---- */
var CYCLE_COLS = {
  ID:1, TASKID:2, TASK:3, EMP:4, EMAIL:5, CYCLENO:6, SCHED:7, DUE:8,
  REM:9, L1DT:10, ACKDT:11, RES:12, STATUS:13, PROOF:14, CBY:15, CAT:16,
  SRC:17, REMSENT:18, L1SENT:19, ACKBY:20, ACKAT:21, L2SENT:22, L2REASON:23,
  EXTUNTIL:24, EXTREASON:25, REMARKS:26, UPDATED:27
};

/* ---- Task_Master columns ---- */
var TASK_COLS = {
  ID:1, NAME:2, TAB:3, EMP:4, EMAIL:5, TYPE:6, FREQ:7, MODE:8, START:9,
  REGEX:10, PROFILE:11, ACTIVE:12, DELEGATE:13, PAUSED:14, NOTES:15
};

/* ---- Alert_Log columns ---- */
var ALERT_COLS = {
  ID:1, LEVEL:2, CYCLE:3, EMP:4, TASK:5, DUE:6, OVERDUE:7, STATUS:8,
  SENTAT:9, MACK:10, MACKBY:11, MACKAT:12, MACTION:13, AREASON:14,
  OUTCOME:15, PROCESSED:16
};

/* ---- Email_Outbox columns ---- */
var OUTBOX_COLS = {
  KEY:1, TYPE:2, TO:3, CC:4, SUBJ:5, BODY:6, STATUS:7, ATT:8,
  QAT:9, SAT:10, ERR:11, SSAT:12
};

/* ---- Run_Log columns ---- */
var RUNLOG_COLS = {
  ID:1, TRIG:2, START:3, END:4, DUR:5, CREATED:6, RECON:7, QUEUED:8,
  SENT:9, FAILED:10, ERR:11
};

/* ---- Test_Cases columns ---- */
var TEST_COLS = { ID:1, SCEN:2, SETUP:3, EXPECTED:4, ACTUAL:5, RESULT:6, EVIDENCE:7, RUNAT:8 };

/* ---- Cycle state machine ----
 * SCHEDULED -> OPEN (due day reached) -> OVERDUE (past due/extended)
 * live + valid proof -> COMPLETED / COMPLETED-LATE
 * skipped (engine stepped past) or manager Waive -> MISSED
 * Closed cycles are immutable; edits are reverted + audited.
 */
var LIVE_STATUSES = ['SCHEDULED','OPEN','OVERDUE'];
var TERMINAL_STATUSES = ['COMPLETED','COMPLETED-LATE','MISSED'];

/* ---- Config defaults (Config sheet can override any value) ---- */
var CFG_DEFAULTS = {
  MANAGER_EMAIL:            'manager@example.com',
  LEADERSHIP_EMAILS:        'leadership@example.com',
  SANDBOX_EMAIL:            '',           // blank = sheet owner (TestMode recipient)
  WORKING_DAYS:             '1,2,3,4,5,6',// JS getDay(): 0=Sun .. 6=Sat
  WORK_START:               '09:00',
  WORK_END:                 '18:00',
  DAILY_DUE_TIME:           '11:00',
  PERIODIC_DUE_TIME:        '17:00',
  REMINDER_OFFSET_DAILY_MIN:   '30',      // due - 30 min = 10:30
  REMINDER_OFFSET_PERIODIC_MIN:'180',     // due - 3 h = 14:00
  L1_OFFSET_MIN:            '30',         // due + 30 min working time
  ACK_OFFSET_DAILY_MIN:     '120',        // 11:00 -> 13:00 same day
  ACK_OFFSET_PERIODIC_MIN:  '180',        // 17:00 -> 11:00 next working day
  RESOLVE_OFFSET_DAILY_MIN:   '240',      // 11:00 -> 15:00 same day
  RESOLVE_OFFSET_PERIODIC_MIN:'540',      // 17:00 -> 17:00 next working day
  DIGEST_TIME:              '09:30',
  REMINDER_ENABLED:         'ON',
  EMAIL_ENABLED:            'ON',         // OFF = dry-run (outbox marks SENT without sending)
  TESTMODE:                 'OFF',        // ON = all mail routed to sandbox
  SIMNOW:                   '',           // 'yyyy-MM-dd HH:mm' = simulated clock
  HEARTBEAT_MAX_MIN:        '45',
  WEBAPP_BASE_URL:          ''            // signed ack/done links; blank = disabled
};

/* Employee tab layout (same on every Emp_ tab) */
var EMP_COLS = {
  ID:1, TASK:2, CYCLE:3, DUE:4, STATUS:5, PROOFREQ:6,
  INPUT_PROOF:7, INPUT_DONE:8, CODE:9, INPUT_REMARKS:10, CAT:11
};

/** ============================================================
 * 01_core.gs — Config layer, properties, locks, sheet utilities,
 * audit logging. Single source of truth helpers used everywhere.
 *
 * v1.2 PERF: Apps Script charges one network round-trip (~0.2–0.5 s)
 * per getValue/setValue/appendRow. This layer now provides:
 *   1. Per-execution read caches for Cycle_Log / Task_Master /
 *      Alert_Log / Email_Outbox — every write invalidates or updates
 *      the cache, so reads are always consistent (Test 8 safe).
 *   2. Buffered audit(): rows are collected in memory and written in
 *      ONE setValues by flushAudit() at the end of each entry point.
 *   3. writeCycleProps: ONE full-column read cached per execution,
 *      so each status update is a single write (was read+write).
 * ============================================================ */

var _CFG = null;

/* ---------- v1.2 perf caches (reset automatically each execution) ---------- */
var _TICKCACHE = null;        // { cycles, tasks, alerts, outbox } object lists
var _CYC_SHEET_CACHE = null;  // raw Cycle_Log value block for writeCycleProps
var _AUDIT_BUF = [];          // buffered audit rows

function cacheInit() { _TICKCACHE = { cycles: null, tasks: null, alerts: null, outbox: null }; _HOL_SET = null; }
function cacheClear() { _TICKCACHE = null; _CYC_SHEET_CACHE = null; _HOL_SET = null; }
function _cycDirty()  { if (_TICKCACHE) _TICKCACHE.cycles = null; }
function _taskDirty() { if (_TICKCACHE) _TICKCACHE.tasks = null; }
function _alrtDirty() { if (_TICKCACHE) _TICKCACHE.alerts = null; }
function _obxDirty()  { if (_TICKCACHE) _TICKCACHE.outbox = null; }

function getCfg(force) {
  if (!_CFG || force) _CFG = loadCfg();
  return _CFG;
}
function invalidateCfg() { _CFG = null; }


/** Normalizes one Config value to a clean HH:mm string.
 *  Handles: time-typed cells (returned by getValues as Date objects,
 *  epoch 1899-12-30), plain serial numbers (0.375 = 09:00), text "9:00".
 *  Returns '' for anything unparseable so the default applies. */
function cfgTime_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, APP_TZ, 'HH:mm');
  if (typeof v === 'number' && isFinite(v)) {
    var mins = Math.round(v * 24 * 60) % 1440;
    return ('0' + Math.floor(mins / 60)).slice(-2) + ':' + ('0' + (mins % 60)).slice(-2);
  }
  var s = String(v === undefined || v === null ? '' : v).trim();
  return /^\d{1,2}:\d{2}$/.test(s) ? s : '';
}

var TIME_KEYS = { WORK_START:1, WORK_END:1, DAILY_DUE_TIME:1, PERIODIC_DUE_TIME:1, DIGEST_TIME:1 };

function loadCfg() {
  var sh = sheet(SHEET.CONFIG);
  var vals = sh.getDataRange().getValues();
  var raw = {};
  for (var i = 1; i < vals.length; i++) {
    if (vals[i][0] !== '' && vals[i][0] !== null) raw[String(vals[i][0]).trim()] = vals[i][1];
  }
  var c = {};
  Object.keys(CFG_DEFAULTS).forEach(function (k) {
    var v = raw[k];
    var s = (v === undefined || v === null || String(v).trim() === '') ? '' : String(v).trim();
    if (TIME_KEYS[k]) s = cfgTime_(v) || String(CFG_DEFAULTS[k]);  // v1.4: typed cells
    c[k] = (s === '') ? CFG_DEFAULTS[k] : s;
  });
  c.WD = String(c.WORKING_DAYS).split(',').map(function (x) { return +x; });
  return c;
}


/** Write one Config key (used by menu + tests). */
function setConfig(key, val) {
  var sh = sheet(SHEET.CONFIG);
  var vals = sh.getDataRange().getValues();
  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][0]).trim() === key) {
      sh.getRange(r + 1, 2).setValue(val);
      invalidateCfg();
      audit('SYSTEM', 'CONFIG_CHANGED', '', key + ' = ' + val, '');
      return;
    }
  }
  sh.appendRow([key, val]);
  invalidateCfg();
  audit('SYSTEM', 'CONFIG_CHANGED', '', key + ' = ' + val, '');
}

/* ---------- Properties (secrets + heartbeat) ---------- */
function getProp(k) {
  return PropertiesService.getScriptProperties().getProperty(k);
}
function setProp(k, v) {
  PropertiesService.getScriptProperties().setProperty(k, String(v));
}

/** Batch-write several Config keys: 1 read + k writes + 1 reload
 *  (was k×(read+write+audit+reload) — used by the test harness). */
function setConfigs(obj) {
  var sh = sheet(SHEET.CONFIG);
  var vals = sh.getDataRange().getValues();
  var found = {};
  for (var r = 1; r < vals.length; r++) {
    var k = String(vals[r][0]).trim();
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
      sh.getRange(r + 1, 2).setValue(obj[k]);
      found[k] = true;
    }
  }
  var missing = Object.keys(obj).filter(function (k) { return !found[k]; })
    .map(function (k) { return [k, obj[k]]; });
  if (missing.length) sh.getRange(sh.getLastRow() + 1, 1, missing.length, 2).setValues(missing);
  invalidateCfg();
  audit('SYSTEM', 'CONFIG_CHANGED', '', JSON.stringify(obj), '');
}

/* ---------- Sheet access ---------- */
function ss() { return SpreadsheetApp.getActive(); }

function sheet(name) {
  var s = ss().getSheetByName(name);
  if (!s) throw new Error('Sheet "' + name + '" missing — run ⚡ Setup / Repair first.');
  return s;
}

function readRaw(name) {
  return sheet(name).getDataRange().getValues();
}

/* Cycle_Log rows as objects keyed by CYCLE_COLS (cache-aware).
 * Callers must never mutate the returned objects directly — all
 * ledger writes go through writeCycleProps / createCycle, which
 * keep this cache consistent. */
function readCycles() {
  if (_TICKCACHE && _TICKCACHE.cycles) return _TICKCACHE.cycles;
  var vals = readRaw(SHEET.CYCLES);
  var out = [];
  for (var r = 1; r < vals.length; r++) {
    if (!vals[r][0]) continue;
    var o = { row: r + 1 };
    for (var k in CYCLE_COLS) o[k] = vals[r][CYCLE_COLS[k] - 1];
    out.push(o);
  }
  if (_TICKCACHE) _TICKCACHE.cycles = out;
  return out;
}

function findCycle(cycleId) {
  var all = readCycles();
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].ID) === String(cycleId)) return all[i];
  }
  return null;
}

/** Perf-critical v1.2: the Cycle_Log value block is read ONCE per
 *  execution; every call afterwards is a single-row write (was
 *  full read + write per call). The tick read-cache is updated in
 *  place so later reads see the new state immediately. */
function writeCycleProps(cycleId, updates) { // updates = {COLKEY: value}
  var sh = sheet(SHEET.CYCLES);
  if (!_CYC_SHEET_CACHE) {
    var last = sh.getLastRow();
    _CYC_SHEET_CACHE = { vals: last >= 2 ? sh.getRange(2, 1, last - 1, CYCLE_COLS.UPDATED).getValues() : [] };
  }
  var vals = _CYC_SHEET_CACHE.vals;
  for (var r = 0; r < vals.length; r++) {
    if (String(vals[r][0]) === String(cycleId)) {
      for (var k in updates) vals[r][CYCLE_COLS[k] - 1] = updates[k];
      vals[r][CYCLE_COLS.UPDATED - 1] = getNow();
      sh.getRange(r + 2, 1, 1, CYCLE_COLS.UPDATED).setValues([vals[r]]);
      if (_TICKCACHE && _TICKCACHE.cycles) {
        _TICKCACHE.cycles.forEach(function (o) {
          if (String(o.ID) === String(cycleId)) for (var k2 in updates) o[k2] = updates[k2];
        });
      }
      return true;
    }
  }
  return false;
}

/** v1.3: batched writeCycleProps — many cycle updates, ONE setValues.
 *  updatesById = { cycleId: { COLKEY: value, ... }, ... } */
function writeCyclePropsBatch(updatesById) {
  var ids = Object.keys(updatesById);
  if (!ids.length) return 0;
  var sh = sheet(SHEET.CYCLES);
  if (!_CYC_SHEET_CACHE) {
    var last = sh.getLastRow();
    _CYC_SHEET_CACHE = { vals: last >= 2 ? sh.getRange(2, 1, last - 1, CYCLE_COLS.UPDATED).getValues() : [] };
  }
  var vals = _CYC_SHEET_CACHE.vals;
  var firstRow = -1, lastRow = -1;
  for (var r = 0; r < vals.length; r++) {
    var ups = updatesById[String(vals[r][0])];
    if (!ups) continue;
    for (var k in ups) vals[r][CYCLE_COLS[k] - 1] = ups[k];
    vals[r][CYCLE_COLS.UPDATED - 1] = getNow();
    if (firstRow < 0) firstRow = r;
    lastRow = r;
  }
  if (firstRow >= 0) {
    sh.getRange(firstRow + 2, 1, lastRow - firstRow + 1, CYCLE_COLS.UPDATED)
      .setValues(vals.slice(firstRow, lastRow + 1));
    if (_TICKCACHE && _TICKCACHE.cycles) {
      _TICKCACHE.cycles.forEach(function (o) {
        var u = updatesById[String(o.ID)];
        if (u) for (var k2 in u) o[k2] = u[k2];
      });
    }
  }
  return firstRow >= 0 ? (lastRow - firstRow + 1) : 0;
}

/* Task_Master rows (cache-aware) */
function readTasks() {
  if (_TICKCACHE && _TICKCACHE.tasks) return _TICKCACHE.tasks;
  var vals = readRaw(SHEET.TASKS);
  var out = [];
  for (var r = 1; r < vals.length; r++) {
    if (!vals[r][0]) continue;
    var o = { row: r + 1 };
    for (var k in TASK_COLS) o[k] = vals[r][TASK_COLS[k] - 1];
    o.id = String(o.ID).trim();
    o.name = String(o.NAME).trim();
    o.tab = String(o.TAB).trim();
    o.emp = String(o.EMP).trim();
    o.email = String(o.EMAIL).trim();
    o.type = String(o.TYPE).trim().toUpperCase();
    o.freq = +o.FREQ || 1;
    o.mode = String(o.MODE || 'FIXED').trim().toUpperCase();
    o.regex = String(o.REGEX || '').trim();
    o.profile = String(o.PROFILE || 'PERIODIC').trim().toUpperCase();
    o.active = String(o.ACTIVE).trim().toUpperCase() !== 'NO';
    o.delegate = String(o.DELEGATE || '').trim();
    o.paused = o.PAUSED ? new Date(o.PAUSED) : null;
    out.push(o);
  }
  if (_TICKCACHE) _TICKCACHE.tasks = out;
  return out;
}

function taskById(taskId) {
  var all = readTasks();
  for (var i = 0; i < all.length; i++) if (all[i].id === String(taskId)) return all[i];
  return null;
}

/* Alert_Log rows (cache-aware) */
function readAlerts() {
  if (_TICKCACHE && _TICKCACHE.alerts) return _TICKCACHE.alerts;
  var vals = readRaw(SHEET.ALERTS);
  var out = [];
  for (var r = 1; r < vals.length; r++) {
    if (!vals[r][0]) continue;
    var o = { row: r + 1 };
    for (var k in ALERT_COLS) o[k] = vals[r][ALERT_COLS[k] - 1];
    out.push(o);
  }
  if (_TICKCACHE) _TICKCACHE.alerts = out;
  return out;
}

/* Outbox rows (cache-aware) */
function readOutbox() {
  if (_TICKCACHE && _TICKCACHE.outbox) return _TICKCACHE.outbox;
  var vals = readRaw(SHEET.OUTBOX);
  var out = [];
  for (var r = 1; r < vals.length; r++) {
    if (!vals[r][0]) continue;
    var o = { row: r + 1 };
    for (var k in OUTBOX_COLS) o[k] = vals[r][OUTBOX_COLS[k] - 1];
    out.push(o);
  }
  if (_TICKCACHE) _TICKCACHE.outbox = out;
  return out;
}

/* ---------- Audit (v1.2: buffered — ONE setValues per flush) ----------
 * audit() itself does NO I/O. Entry points (tick, applyCompletion,
 * onEditHandler, _testFinish, setup/reset) call flushAudit() when
 * the buffered rows must land. If an execution dies before flushing,
 * audit rows are lost — acceptable: audit is best-effort by design
 * and must never block business flow. */
function audit(actor, event, cycleId, detail, runId) {
  _AUDIT_BUF.push([new Date(), runId || '', actor || 'SYSTEM', event, cycleId || '', detail || '']);
  if (_AUDIT_BUF.length >= 200) flushAudit(); // safety valve
}

function flushAudit() {
  if (!_AUDIT_BUF.length) return;
  var rows = _AUDIT_BUF;
  _AUDIT_BUF = [];
  try {
    var sh = sheet(SHEET.AUDIT);
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, 6).setValues(rows);
  } catch (e) { /* never block business flow on audit failure */ }
}

/* ---------- Lock ---------- */
function lock30() {
  var l = LockService.getScriptLock();
  return l.tryLock(30000) ? l : null;
}

function toastMsg(msg, title) {
  try { ss().toast(msg, title || 'Task System', 8); } catch (e) {}
}

/* ---------- Misc ---------- */
function runIdNew() { return 'R' + Date.now().toString(36) + Math.floor(Math.random() * 1e4); }

function plainText(html) { return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }

function tabOwnerOf(tabName) {
  var all = readTasks();
  for (var i = 0; i < all.length; i++) if (all[i].tab === tabName) return all[i].emp;
  return 'unknown(' + tabName + ')';
}

/** v1.5: never let sandbox resolution stall the outbox.
 *  Session.getEffectiveUser() requires the userinfo.email scope, which
 *  some execution contexts don't grant. Order: explicit sandbox address,
 *  then the session user, then manager as a safe last resort. */
function sandboxRecipient(c) {
  if (c.SANDBOX_EMAIL) return c.SANDBOX_EMAIL;
  try {
    var e = Session.getEffectiveUser().getEmail();
    if (e) return e;
  } catch (err) { /* scope not granted — fall through */ }
  return c.MANAGER_EMAIL;
}

/** ============================================================
 * 02_datetime.gs — Clock abstraction + SLA / working-time math.
 * Pure functions (no SpreadsheetApp calls except isHoliday read).
 * getNow() is the ONLY clock in the codebase (SimNow-aware).
 * ============================================================ */

/** The single clock. Returns simulated time when Config.SIMNOW is set. */
function getNow() {
  var c = getCfg();
  if (c.SIMNOW && c.SIMNOW !== '') {
    var d = new Date(c.SIMNOW);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

/* ---------- formatting ---------- */
function fmtDT(d) { return d ? Utilities.formatDate(d, APP_TZ, 'dd MMM yyyy HH:mm') : ''; }
function fmtD(d)  { return d ? Utilities.formatDate(d, APP_TZ, 'dd MMM yyyy') : ''; }
function fmtT(d)  { return d ? Utilities.formatDate(d, APP_TZ, 'HH:mm') : ''; }
function dayKey(d)  { return Utilities.formatDate(d, APP_TZ, 'yyyy-MM-dd'); }
function dateKey(d) { return Utilities.formatDate(d, APP_TZ, 'yyyyMMdd'); }

function parseHm(s) {
  var p = String(s).split(':');
  return { h: +p[0] || 0, m: +(p[1] || 0) };
}
function hmToMin(s) { var p = parseHm(s); return p.h * 60 + p.m; }

/** Date at a specific wall-clock time on d's calendar day (IST). */
function atTime(d, hm) {
  var p = (typeof hm === 'string') ? parseHm(hm) : hm;
  var y  = +Utilities.formatDate(d, APP_TZ, 'yyyy');
  var mo = +Utilities.formatDate(d, APP_TZ, 'M') - 1;
  var da = +Utilities.formatDate(d, APP_TZ, 'd');
  return new Date(y, mo, da, p.h, p.m, 0, 0);
}

function startOfDay(d) { return atTime(d, '00:00'); }

function minutesOfDay(d) {
  return +Utilities.formatDate(d, APP_TZ, 'H') * 60 + +Utilities.formatDate(d, APP_TZ, 'm');
}

/** Add N days, preserving a time-of-day (IST has no DST). */
function addDaysAtTime(d, days, hm) {
  return atTime(new Date(d.getTime() + days * 86400000), hm);
}

/* ---------- service calendar ---------- */
/* v1.2 perf: Holidays read ONCE per execution (was one full-sheet read
 * per isWorkingDay call — the working-day shift loops multiplied this
 * into dozens of round-trips per tick). */
var _HOL_SET = null;

function isHoliday(d) {
  if (!_HOL_SET) {
    _HOL_SET = {};
    var vals = readRaw(SHEET.HOLIDAYS);
    for (var i = 1; i < vals.length; i++) {
      if (vals[i][0]) _HOL_SET[dayKey(new Date(vals[i][0]))] = true;
    }
  }
  return !!_HOL_SET[dayKey(d)];
}

function isWorkingDay(d, c) {
  return c.WD.indexOf(d.getDay()) >= 0 && !isHoliday(d);
}

/** Same time-of-day, moved forward to the next working day if needed. */
function shiftToWorkingDay(d, timeStr, c) {
  var g = 0;
  while (!isWorkingDay(d, c) && g++ < 30) d = addDaysAtTime(d, 1, timeStr);
  return d;
}

/** Next working day at work-start. */
function nextWorkingDayStart(d, c) {
  var n = addDaysAtTime(d, 1, c.WORK_START);
  var g = 0;
  while (!isWorkingDay(n, c) && g++ < 30) n = addDaysAtTime(n, 1, c.WORK_START);
  return n;
}

/**
 * Add `min` minutes of WORKING time (working days, 09:00–18:00, minus holidays).
 * Used for all SLA offsets so deadlines never land outside the service window.
 */
function workingTimeAdd(start, min, c) {
  var d = new Date(start.getTime());
  var rem = +min, g = 0;
  while (rem > 0 && g++ < 120) {
    if (!isWorkingDay(d, c)) { d = nextWorkingDayStart(d, c); continue; }
    var ws = atTime(d, c.WORK_START), we = atTime(d, c.WORK_END);
    if (d < ws) d = new Date(ws.getTime());
    if (d.getTime() >= we.getTime()) { d = nextWorkingDayStart(d, c); continue; }
    var avail = Math.floor((we - d) / 60000);
    if (rem <= avail) { d = new Date(d.getTime() + rem * 60000); rem = 0; }
    else { rem -= avail; d = nextWorkingDayStart(d, c); }
  }
  if (rem > 0) d = new Date(d.getTime() + rem * 60000);
  return d;
}

function quietHours(now, c) {
  if (!isWorkingDay(now, c)) return true;
  var m = minutesOfDay(now);
  return m < hmToMin(c.WORK_START) || m >= hmToMin(c.WORK_END);
}

/* ---------- SLA timeline (snapshot per cycle at creation) ---------- */
function dueTimeForTask(task, c) {
  return task.profile === 'DAILY' ? c.DAILY_DUE_TIME : c.PERIODIC_DUE_TIME;
}

function slaTimeline(dueDt, profile, c) {
  var remMin = profile === 'DAILY' ? +c.REMINDER_OFFSET_DAILY_MIN : +c.REMINDER_OFFSET_PERIODIC_MIN;
  return {
    reminder:  new Date(dueDt.getTime() - remMin * 60000),
    l1:        workingTimeAdd(dueDt, +c.L1_OFFSET_MIN, c),
    ackBy:     workingTimeAdd(dueDt, profile === 'DAILY' ? +c.ACK_OFFSET_DAILY_MIN : +c.ACK_OFFSET_PERIODIC_MIN, c),
    resolveBy: workingTimeAdd(dueDt, profile === 'DAILY' ? +c.RESOLVE_OFFSET_DAILY_MIN : +c.RESOLVE_OFFSET_PERIODIC_MIN, c)
  };
}

/**
 * Next due date. FIXED: prevDue + N (working-day shifted, same time).
 * ROLLING: completedAt + N. Matches decision D1 (both supported).
 */
function computeNextDue(prevDue, task, completedAt, c) {
  var dt = dueTimeForTask(task, c);
  if (task.mode === 'ROLLING') {
    var base = completedAt || getNow();
    return shiftToWorkingDay(addDaysAtTime(base, task.freq, dt), dt, c);
  }
  return shiftToWorkingDay(addDaysAtTime(prevDue, task.freq, dt), dt, c);
}

function hoursBetween(a, b) {
  return Math.round(((b - a) / 3600000) * 10) / 10;
}

/** ============================================================
 * 03_setup.gs — One-click bootstrap.
 * Run setup() once from the Apps Script editor (or ⚡ menu):
 *   • builds every tab + header + formatting
 *   • writes Config defaults (never overwrites your edits)
 *   • inserts the 4 dummy tasks from the assignment brief
 *   • creates employee tabs, protections, triggers, HMAC secret
 *
 * v1.5 repairs (run automatically by Setup / Repair Structure):
 *   • ⚡ "Send Test Email (verify mail)" menu → mailSelfTest()
 *   • stale sample holiday rows (2025) moved to their next occurrence
 *   • Alert_Log Outcome formulas refreshed (old ones rendered empty
 *     Completed At as the zero-date "30 Dec 00:00")
 * ============================================================ */

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  var single = ui.createMenu('Run Single Test');
  [[1, '7-day cycle closes, next spawns'],
   [2, 'Single-point completion capture'],
   [3, 'Daily code reject / accept'],
   [4, 'Same-day L1 alert, no duplicate'],
   [5, 'Manager ack captured'],
   [6, 'L2 leadership escalation'],
   [7, 'DAILY timeline walk'],
   [8, 'No duplicates on replay']].forEach(function (p) {
    single.addItem('T' + p[0] + ' — ' + p[1], 'runT' + p[0]);
  });
  ui.createMenu('⚡ Task System')
    .addItem('Setup / Repair Structure', 'menuSetup')
    .addItem('Run Engine Tick Now', 'menuTick')
    .addItem('Send Test Email (verify mail)', 'menuSelfTest')
    .addSeparator()
    .addItem('Run All Tests (T1–T8) — fast mode', 'menuRunTestsWrapper')
    .addSubMenu(single)
    .addSeparator()
    .addItem("Toggle TestMode", 'menuToggleTestMode')
    .addItem('Reset Demo Data', 'menuResetData')
    .addItem("Show Today's Daily Codes", 'menuShowCodes')
    .addToUi();
}

function menuSetup() { setup(); }
function menuTick() { tick('MENU'); toastMsg('Tick complete.'); }
function menuSelfTest() { mailSelfTest(); }
function menuRunTests() { runAllTests(); }
function menuToggleTestMode() {
  var c = getCfg(true);
  var next = c.TESTMODE === 'ON' ? 'OFF' : 'ON';
  setConfig('TESTMODE', next);
  toastMsg('TestMode is now ' + next + (next === 'ON' ? ' — all mail goes to the sandbox address.' : ' — live recipients active.'), 'TestMode');
}
function menuResetData() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.alert('Reset Demo Data', 'This clears Cycle_Log, Alert_Log, Email_Outbox, employee tabs and restores the 4 sample tasks. Continue?', ui.ButtonSet.YES_NO);
  if (r === ui.Button.YES) resetData();
}
function menuShowCodes() { showTodayCodes(); }

function setup() {
  buildStructure();
  writeConfigDefaults();
  sampleTasks();
  ensureEmpTabs();
  protectSheets();
  installTriggers();
  cacheClear(); // structure changed — drop all per-execution caches
  flushAudit();
  if (!getProp('HMAC_SECRET')) {
    setProp('HMAC_SECRET', Utilities.getUuid() + Utilities.getUuid());
  }
  var tz = Session.getScriptTimeZone();
  var tzMsg = (tz !== APP_TZ)
    ? ' ⚠ Project timezone is "' + tz + '" — set it to ' + APP_TZ + ' in Apps Script → Project Settings.'
    : '';
  toastMsg('Setup complete. Replace placeholder emails in Config / Task_Master.' + tzMsg, 'Setup');
}

/* ---------- structure ---------- */
var HEADERS = {};
HEADERS[SHEET.CONFIG]   = ['Key', 'Value'];
HEADERS[SHEET.TASKS]    = ['TaskID','Task Name','Tab','Assigned To','Email','Type (TICKET/DAILY_CHECK)','Frequency (days)','Mode (FIXED/ROLLING)','Start Date','Proof Rule (regex)','SLA Profile (DAILY/PERIODIC)','Active (YES/NO)','Delegate Email','Paused Until','Notes'];
HEADERS[SHEET.CYCLES]   = ['CycleID','TaskID','Task','Employee','Email','Cycle #','Scheduled At','Due DT','Reminder DT','L1 DT','AckBy DT','ResolveBy DT','Status','Proof','Completed By','Completed At','Entry Source','Reminder Sent At','L1 Sent At','Ack By','Ack At','L2 Sent At','L2 Reason','Extended Until','Extension Reason','Remarks','Last Updated'];
HEADERS[SHEET.ALERTS]   = ['AlertID','Level','CycleID','Employee','Task','Due','Overdue (h)','Status','Sent At','Manager Ack (YES/NO)','Ack By','Ack At','Manager Action','Action Reason','Outcome','Processed'];
HEADERS[SHEET.OUTBOX]   = ['DedupeKey','Type','To','Cc','Subject','Body (HTML)','Status','Attempts','Queued At','Sent At','Error','Send Started At'];
HEADERS[SHEET.AUDIT]    = ['Timestamp','RunID','Actor','Event','CycleID','Detail'];
HEADERS[SHEET.RUNLOG]   = ['RunID','Trigger','Start','End','Duration (s)','Cycles Created','Reconciled','Queued','Sent','Failed','Errors'];
HEADERS[SHEET.DASH]     = ['Manager_Dashboard (auto-generated — do not edit)'];
HEADERS[SHEET.HOLIDAYS] = ['Date','Name'];
HEADERS[SHEET.TESTS]    = ['ID','Scenario','Setup','Expected','Actual','Result','Evidence','Run At'];

function buildStructure() {
  var s = ss();
  Object.keys(HEADERS).forEach(function (name) {
    var sh = s.getSheetByName(name) || s.insertSheet(name);
    sh.getRange(1, 1, 1, HEADERS[name][0].length ? HEADERS[name].length : 1).setValues([HEADERS[name]]);
    var h = sh.getRange(1, 1, 1, HEADERS[name].length);
    h.setFontWeight('bold').setFontColor('#ffffff').setBackground('#1f4e79');
    sh.setFrozenRows(1);
    sh.setName(name); // no-op safety
  });

  /* Cycle_Log formats */
  var cyc = sheet(SHEET.CYCLES);
  cyc.getRange('H2:L1000').setNumberFormat('dd MMM HH:mm');
  cyc.getRange('P2:P1000').setNumberFormat('dd MMM HH:mm');
  cyc.getRange('R2:X1000').setNumberFormat('dd MMM HH:mm');

  /* Alert_Log formats + dropdowns */
  var al = sheet(SHEET.ALERTS);
  al.getRange('F2:F1000').setNumberFormat('dd MMM HH:mm');
  al.getRange('I2:I1000').setNumberFormat('dd MMM HH:mm');
  al.getRange('L2:L1000').setNumberFormat('dd MMM HH:mm');
  al.getRange('J2:J1000').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['YES','NO'], true).setAllowInvalid(true).build());
  al.getRange('M2:M1000').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Following up','Reassigned','Extend','Waive'], true).setAllowInvalid(true).build());

  /* v1.5 (D4): refresh the Outcome formula on every existing Alert_Log
   * row — older rows carried a formula that rendered an empty
   * Completed At as the Sheets zero-date "30 Dec 00:00". */
  if (al.getLastRow() > 1) {
    var ids = al.getRange(2, 1, al.getLastRow() - 1, 1).getValues();
    var fs = ids.map(function (v, i) { return [v[0] ? outcomeFormula(i + 2) : '']; });
    al.getRange(2, ALERT_COLS.OUTCOME, fs.length, 1).setValues(fs);
  }

  /* Outbox / audit / runlog formats */
  sheet(SHEET.OUTBOX).getRange('I2:J1000').setNumberFormat('dd MMM HH:mm');
  sheet(SHEET.AUDIT).getRange('A2:A2000').setNumberFormat('dd MMM HH:mm:ss');

  /* Holidays sample rows (only when the tab is empty) */
  var hol = sheet(SHEET.HOLIDAYS);
  if (hol.getLastRow() < 2) {
    var holRows = holidaySampleRows_();
    hol.getRange(2, 1, holRows.length, 2).setValues(holRows);
  }
  hol.getRange('A2:A100').setNumberFormat('dd MMM yyyy');
  repairHolidaySamples_(hol);
}

/* Sample holidays, each set to its NEXT upcoming occurrence. */
function holidaySampleRows_() {
  var nowD = startOfDay(getNow());
  return [
    ['Republic Day',      0,  26],
    ['Holi',              2,  4],
    ['Independence Day',  7,  15],
    ['Gandhi Jayanti',    9,  2],
    ['Christmas',         11, 25]
  ].map(function (h) {
    var y = +Utilities.formatDate(nowD, APP_TZ, 'yyyy');
    var d = new Date(y, h[1], h[2]);
    if (d < nowD) d = new Date(y + 1, h[1], h[2]); // past this year → next occurrence
    return [d, h[0]];
  });
}

/** v1.5 (D6): repair stale sample rows — if a known sample holiday sits
 *  on a past date, move it to its next occurrence. Only touches the
 *  five sample names; user-added holidays are never modified. */
function repairHolidaySamples_(hol) {
  var SAMPLES = { 'Republic Day': [0, 26], 'Holi': [2, 4], 'Independence Day': [7, 15],
                  'Gandhi Jayanti': [9, 2], 'Christmas': [11, 25] };
  var nowD = startOfDay(getNow());
  var vals = hol.getDataRange().getValues();
  var fixes = [];
  for (var i = 1; i < vals.length; i++) {
    var nm = String(vals[i][1] || '').trim();
    if (!SAMPLES[nm]) continue;
    var y = +Utilities.formatDate(nowD, APP_TZ, 'yyyy');
    var want = new Date(y, SAMPLES[nm][0], SAMPLES[nm][1]);
    if (want < nowD) want = new Date(y + 1, SAMPLES[nm][0], SAMPLES[nm][1]);
    var have = vals[i][0] ? new Date(vals[i][0]) : null;
    if (!have || isNaN(have.getTime()) || dayKey(have) !== dayKey(want)) {
      fixes.push([i + 1, want]);
    }
  }
  fixes.forEach(function (f) { hol.getRange(f[0], 1).setValue(f[1]); });
}

function writeConfigDefaults() {
  var sh = sheet(SHEET.CONFIG);
  var vals = sh.getDataRange().getValues();
  var have = {};
  for (var r = 1; r < vals.length; r++) if (vals[r][0]) have[String(vals[r][0]).trim()] = true;
  var rows = Object.keys(CFG_DEFAULTS).filter(function (k) { return !have[k]; })
    .map(function (k) { return [k, CFG_DEFAULTS[k]]; });
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, 2).setValues(rows);
}

function sampleTasks() {
  var sh = sheet(SHEET.TASKS);
  if (sh.getLastRow() > 1) return; // never overwrite user's tasks
  var today = startOfDay(new Date());
  var rows = [
    ['T1','Daily Operations Update','Emp_A','Employee A','employee.a@example.com','DAILY_CHECK',1,'FIXED',today,'','DAILY','YES','','','Post the update in the WhatsApp group INCLUDING today\'s code, then tick Done + paste the code in your tab.'],
    ['T2','Portal Task A','Emp_B','Employee B','employee.b@example.com','TICKET',7,'FIXED',today,'^[A-Z]{2,5}-\\d{3,6}$','PERIODIC','YES','','','Complete on portal, then enter the Ticket ID in your tab.'],
    ['T3','Portal Task B','Emp_C','Employee C','employee.c@example.com','TICKET',15,'FIXED',today,'^[A-Z]{2,5}-\\d{3,6}$','PERIODIC','YES','','','Complete on portal, then enter the Ticket ID in your tab.'],
    ['T4','Portal Task C','Emp_D','Employee D','employee.d@example.com','TICKET',30,'FIXED',today,'^[A-Z]{2,5}-\\d{3,6}$','PERIODIC','YES','','','Complete on portal, then enter the Ticket ID in your tab.']
  ];
  sh.getRange(2, 1, rows.length, TASK_COLS.NOTES).setValues(rows);
}

function ensureEmpTabs() {
  var s = ss();
  readTasks().forEach(function (t) {
    if (!t.tab) return;
    var sh = s.getSheetByName(t.tab);
    if (!sh) sh = s.insertSheet(t.tab);
    sh.getRange(1, 1, 1, 11).setValues([[
      'CycleID','Task','Cycle','Due','Status','Proof Required',
      'Ticket ID / Ref','Done','Today\u2019s Code','Remarks','Completed At'
    ]]);
    var h = sh.getRange(1, 1, 1, 11);
    h.setFontWeight('bold').setFontColor('#ffffff').setBackground('#2e7d32');
    sh.setFrozenRows(1);
    sh.hideColumns(EMP_COLS.ID);
    sh.setColumnWidth(EMP_COLS.INPUT_DONE, 70);
    sh.getRange(2, EMP_COLS.DUE, 200, 1).setNumberFormat('dd MMM HH:mm');
    sh.getRange(2, EMP_COLS.CAT, 200, 1).setNumberFormat('dd MMM HH:mm');
    sh.getRange(2, EMP_COLS.INPUT_DONE, 200, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireCheckbox().build());
    /* status colors */
    var rules = [
      SpreadsheetApp.newConditionalFormatRule().whenTextContains('OVERDUE')
        .setBackground('#f4c7c3').setRanges([sh.getRange(2, EMP_COLS.STATUS, 200, 1)]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextContains('SCHEDULED')
        .setBackground('#fff2cc').setRanges([sh.getRange(2, EMP_COLS.STATUS, 200, 1)]).build(),
      SpreadsheetApp.newConditionalFormatRule().whenTextContains('COMPLETED')
        .setBackground('#d9ead3').setRanges([sh.getRange(2, EMP_COLS.STATUS, 200, 1)]).build()
    ];
    sh.setConditionalFormatRules(rules);
  });
}

function protectSheets() {
  [SHEET.CONFIG, SHEET.TASKS, SHEET.CYCLES, SHEET.OUTBOX, SHEET.AUDIT,
   SHEET.RUNLOG, SHEET.DASH, SHEET.ALERTS].forEach(function (name) {
    var sh = sheet(name);
    if (sh.protect().canDomainEdit()) {
      var p = sh.protect();
      p.setDescription('System sheet (warning-only): ' + name);
      p.setWarningOnly(true);
    }
  });
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'tickEngine' || fn === 'onEditHandler') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('tickEngine').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('onEditHandler').forSpreadsheet(ss()).onEdit().create();
}

function resetData() {
  [SHEET.CYCLES, SHEET.ALERTS, SHEET.OUTBOX, SHEET.RUNLOG, SHEET.TESTS].forEach(function (n) {
    var sh = sheet(n);
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).clearContent();
  });
  var au = sheet(SHEET.AUDIT);
  if (au.getLastRow() > 1) au.getRange(2, 1, au.getLastRow() - 1, au.getLastColumn()).clearContent();
  var tm = sheet(SHEET.TASKS);
  if (tm.getLastRow() > 1) tm.getRange(2, 1, tm.getLastRow() - 1, tm.getLastColumn()).clearContent();
  cacheClear(); // everything just changed on disk
  sampleTasks();
  ensureEmpTabs();
  setConfigs({ SIMNOW: '', TESTMODE: 'OFF' });
  flushAudit();
  toastMsg('Demo data reset. Run "Run Engine Tick Now" to create today\u2019s cycles.', 'Reset');
}

function showTodayCodes() {
  var now = getNow();
  var lines = readTasks().filter(function (t) { return t.active && t.type === 'DAILY_CHECK'; })
    .map(function (t) { return t.name + ' (' + t.id + '): ' + getDailyCode(t.id, now); });
  toastMsg(lines.join('\n') || 'No DAILY_CHECK tasks.', "Today's Codes");
}


/** ============================================================
 * 04_engine.gs — The tick. Runs every 10 min (trigger) or on demand.
 * Order: spawn cycles → state machine → reconcile → rebuild employee
 * tabs → detect alerts → send outbox → digests → dashboard → heartbeat.
 * Every stage is individually try/caught: one failure never blocks
 * the rest, and the whole run is idempotent (Test 8).
 * ============================================================ */

function tickEngine() { tick('TRIGGER'); }

function tick(triggerName) {
  var tn = triggerName || 'MANUAL';
  /* v1.2: the 10-minute background trigger stands down while the test
   * suite runs — it would steal the lock, double every engine pass and
   * interleave writes with the tests (source of TRIGGER rows inside
   * test runs and of multi-minute suites). */
  if (tn === 'TRIGGER') {
    var c0 = getCfg(true);
    if (c0.TESTS_RUNNING === 'ON') return { skipped: true };
  }
  var lock = lock30();
  if (!lock) { audit('SYSTEM','RUN_SKIPPED','','Lock busy — run skipped',''); flushAudit(); return { skipped: true }; }
  var runId = runIdNew();
  var started = new Date();
  var res = { created: 0, reconciled: 0, queued: 0, sent: 0, failed: 0, errors: [] };
  try {
    var c = getCfg(true);
    cacheInit(); // v1.2: one read per sheet per tick, not one per function
    sheet(SHEET.RUNLOG).appendRow([runId, tn, started, '', '', 0, 0, 0, 0, 0, '']);
    safe(function () { res.created += ensureCycles(c, runId); }, 'ensureCycles', res);
    safe(function () { advanceStates(c, runId); },              'advanceStates', res);
    /* reconcile is a safety net for edits that missed onEdit; the test
     * suite applies completions directly, so skipping it in TESTS mode
     * saves 4 employee-tab reads per tick without hiding any behaviour */
    if (c.TESTS_RUNNING !== 'ON') safe(function () { reconcileAll(c, runId, res); }, 'reconcile', res);
    /* TESTS_RUNNING: harness skips cosmetic rebuilds so the whole
     * test suite fits inside Apps Script's 6-minute execution cap */
    if (c.TESTS_RUNNING !== 'ON') safe(function () { rebuildEmpTabs(c, runId); }, 'rebuildEmpTabs', res);
    safe(function () { processManagerActions(c, runId); },      'managerActions', res);
    safe(function () { res.queued += detectAlerts(c, runId); }, 'detectAlerts', res);
    safe(function () { var s = sendOutbox(c, runId); res.sent = s.sent; res.failed = s.failed; }, 'sendOutbox', res);
    safe(function () { sendDigests(c, runId); },                'digests', res);
    if (c.TESTS_RUNNING !== 'ON') safe(function () { refreshDashboard(c); }, 'dashboard', res);
    setProp('LAST_TICK', started.toISOString());
    flushAudit(); // v1.2: buffered audit rows land in ONE write
    finishRun(runId, res, new Date());
  } finally {
    cacheClear();
    lock.releaseLock();
  }
  return res;
}

function safe(fn, name, res) {
  try { fn(); } catch (err) {
    res.errors.push(name + ': ' + (err && err.message ? err.message : err));
    audit('SYSTEM', 'ERROR', '', name + ': ' + (err && err.message ? err.message : err), '');
  }
}

function finishRun(runId, res, ended) {
  var sh = sheet(SHEET.RUNLOG);
  var vals = readRaw(SHEET.RUNLOG);
  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][0]) === runId) {
      /* one batched write for columns End..Errors */
      sh.getRange(r + 1, RUNLOG_COLS.END, 1, 8).setValues([[
        ended,
        Math.round((ended - vals[r][2]) / 100) / 10,
        res.created, res.reconciled, res.queued, res.sent, res.failed,
        res.errors.join(' | ').slice(0, 900)
      ]]);
      return;
    }
  }
}

/* ---------- 1. Recurrence: ensure every active task has exactly one live cycle ---------- */
function ensureCycles(c, runId) {
  var cycles = readCycles();
  var byTask = {};
  cycles.forEach(function (cy) {
    (byTask[cy.TASKID] = byTask[cy.TASKID] || []).push(cy);
  });
  var existing = {};
  cycles.forEach(function (cy) { existing[String(cy.ID)] = true; });
  var now = getNow();
  var today = startOfDay(now);
  var created = 0;

  readTasks().forEach(function (t) {
    if (!t.active) return;
    if (t.paused && t.paused >= today) return;
    var list = byTask[t.id] || [];
    var live = list.filter(function (cy) { return LIVE_STATUSES.indexOf(String(cy.STATUS)) >= 0; });
    if (live.length > 0) return;

    list.sort(function (a, b) { return new Date(a.DUE) - new Date(b.DUE); });
    var last = list.length ? list[list.length - 1] : null;
    var iter = 0, due;

    if (!last) {
      var anchor = t.START ? new Date(t.START) : today;
      due = shiftToWorkingDay(atTime(anchor, dueTimeForTask(t, c)), dueTimeForTask(t, c), c);
      while (due < today && iter++ < 366) {
        createCycle(t, due, 'MISSED', c, existing, runId) && created++;
        due = computeNextDue(due, t, null, c);
      }
      createCycle(t, due, 'SCHEDULED', c, existing, runId) && created++;
    } else {
      due = computeNextDue(new Date(last.DUE), t, last.CAT ? new Date(last.CAT) : null, c);
      while (due < today && iter++ < 366) {
        createCycle(t, due, 'MISSED', c, existing, runId) && created++;
        due = computeNextDue(due, t, null, c);
      }
      createCycle(t, due, 'SCHEDULED', c, existing, runId) && created++;
    }
  });
  return created;
}

/** Idempotent by CycleID = TaskID-yyyymmdd(due). Returns true if a row was written. */
function createCycle(t, dueDt, status, c, existing, runId) {
  var id = t.id + '-' + dateKey(dueDt);
  if (existing[id]) return false;
  existing[id] = true;
  var tl = slaTimeline(dueDt, t.profile, c);
  /* cycle # derived from the in-memory `existing` map (O(n), no re-read);
   * IDs are TaskID-yyyymmdd, so the prefix is unambiguous */
  var no = 1, kx;
  for (kx in existing) if (kx.indexOf(t.id + '-') === 0) no++;
  sheet(SHEET.CYCLES).appendRow([
    id, t.id, t.name, t.emp, t.email, no, getNow(), dueDt,
    tl.reminder, tl.l1, tl.ackBy, tl.resolveBy, status,
    '', '', '', '', '', '', '', '', '', '', '', '', '', getNow()
  ]);
  _cycDirty(); _CYC_SHEET_CACHE = null; // v1.2: appended row must be visible to the next reader
  audit('SYSTEM', 'CYCLE_CREATED', id, t.name + ' due ' + fmtDT(dueDt) + ' [' + status + ']', runId);
  return true;
}

/* ---------- 2. State machine ---------- */
function advanceStates(c, runId) {
  var now = getNow();
  var updates = {};
  readCycles().forEach(function (cy) {
    var st = String(cy.STATUS);
    if (LIVE_STATUSES.indexOf(st) < 0) return;
    var dueEff = new Date(cy.EXTUNTIL || cy.DUE);
    var next = st;
    if (st === 'SCHEDULED' && now >= startOfDay(dueEff)) next = 'OPEN';
    if ((st === 'SCHEDULED' || st === 'OPEN') && now > dueEff) next = 'OVERDUE';
    if (next !== st) {
      updates[String(cy.ID)] = { STATUS: next };
      audit('SYSTEM', 'STATE_' + next, String(cy.ID), fmtDT(dueEff), runId);
    }
  });
  writeCyclePropsBatch(updates); // v1.3: one write for all transitions (was one per cycle)
}

/* ---------- 5. Employee tabs: single operating surface, rebuilt each tick ---------- */
function rebuildEmpTabs(c, runId) {
  var now = getNow();
  var cycles = readCycles();
  readTasks().forEach(function (t) {
    if (!t.tab || !t.active) return;
    var sh = ss().getSheetByName(t.tab);
    if (!sh) return;
    var rows = cycles.filter(function (cy) {
      if (cy.TASKID !== t.id) return false;
      var st = String(cy.STATUS);
      if (LIVE_STATUSES.indexOf(st) >= 0) return true;
      return (st === 'COMPLETED' || st === 'COMPLETED-LATE') &&
             cy.CAT && dayKey(new Date(cy.CAT)) === dayKey(now);
    });
    rows.sort(function (a, b) { return new Date(a.DUE) - new Date(b.DUE); });

    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 11).clearContent();
    var pending = 0, overdue = 0;
    var out = rows.map(function (cy) {
      var st = String(cy.STATUS);
      var isLive = LIVE_STATUSES.indexOf(st) >= 0;
      if (isLive) { pending++; if (st === 'OVERDUE') overdue++; }
      var dueEff = new Date(cy.EXTUNTIL || cy.DUE);
      return [
        cy.ID, cy.TASK, t.freq + '-day \u00b7 ' + fmtD(new Date(cy.DUE)), new Date(cy.DUE), st,
        t.type === 'TICKET' ? 'Ticket ID (format: ' + (t.regex || 'any') + ')' : 'Tick Done + paste today\u2019s code',
        cy.PROOF || '', st.indexOf('COMPLETED') === 0 ? true : false,
        (t.type === 'DAILY_CHECK' && isLive) ? getDailyCode(t.id, now) : '',
        cy.REMARKS || '', cy.CAT ? new Date(cy.CAT) : ''
      ];
    });
    if (out.length) sh.getRange(2, 1, out.length, 11).setValues(out);
    sh.getRange(1, 13).setValue(
      t.emp + ' \u2014 pending: ' + pending + ' | overdue: ' + overdue +
      ' | refreshed ' + fmtT(now) + (c.TESTMODE === 'ON' ? ' | TESTMODE' : ''));
  });
}

/** ============================================================
 * 05_completion.gs — Completion service (the ONLY way a cycle
 * closes), daily HMAC reference codes, and the reconcile sweep.
 * Shared by onEdit, reconcile, web-app links and the test harness.
 * ============================================================ */

/* ---------- Daily reference code: OPS-XXXX-XX ---------- */
function getDailyCode(taskId, d) {
  var secret = getProp('HMAC_SECRET') || 'dev-secret';
  var sig = Utilities.computeHmacSha256Signature(dayKey(d || getNow()) + '|' + taskId, secret);
  var hex = sig.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
  var AL = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var chars = '';
  for (var i = 0; i + 1 < hex.length && chars.length < 6; i += 2) {
    chars += AL[parseInt(hex.substr(i, 2), 16) % 32];
  }
  return 'OPS-' + chars.slice(0, 4) + '-' + chars.slice(4, 6);
}

/** Accept today's code OR the cycle's own due-date code (midnight rollover). */
function validateDailyCode(taskId, code, dueDt) {
  var codeN = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!codeN) return { ok: false, msg: 'Daily code is empty' };
  var now = getNow();
  var cands = [getDailyCode(taskId, now), getDailyCode(taskId, new Date(dueDt))];
  if (cands.indexOf(codeN) >= 0) return { ok: true };
  return { ok: false, msg: 'Wrong or stale code "' + codeN + '" — use today\u2019s code from your tab (col I)' };
}

function ticketUsed(proof, exceptCycleId) {
  var p = String(proof).trim().toUpperCase();
  var all = readCycles();
  for (var i = 0; i < all.length; i++) {
    if (String(all[i].ID) === String(exceptCycleId)) continue;
    if (all[i].PROOF && String(all[i].PROOF).trim().toUpperCase() === p) return true;
  }
  return false;
}

/**
 * Close a cycle with proof. Throws a user-readable error on any
 * rejection (state guard, regex, uniqueness, code check).
 * opts: { actor, source: TAB|RECONCILE|LINK, runId, alreadyLocked }
 */
function applyCompletion(cycleId, proof, opts) {
  opts = opts || {};
  var lock = opts.alreadyLocked ? null : lock30();
  if (!opts.alreadyLocked && !lock) throw new Error('System busy — try again in a moment.');
  try {
    var c = getCfg();
    var cyc = findCycle(cycleId);
    if (!cyc) throw new Error('Unknown task row ' + cycleId);
    if (TERMINAL_STATUSES.indexOf(String(cyc.STATUS)) >= 0)
      throw new Error('Cycle already closed (' + cyc.STATUS + ')');
    var t = taskById(cyc.TASKID);
    if (!t) throw new Error('Task not found for ' + cyc.TASKID);

    var proofS = String(proof || '').trim();
    if (!proofS) throw new Error('Proof is empty');

    if (t.type === 'TICKET') {
      if (t.regex) {
        var re = new RegExp(t.regex);
        if (!re.test(proofS)) throw new Error('Ticket ID "' + proofS + '" does not match required format (' + t.regex + ')');
      }
      if (ticketUsed(proofS, cyc.ID)) throw new Error('Ticket ID "' + proofS + '" was already used on another cycle');
    } else {
      var v = validateDailyCode(t.id, proofS, new Date(cyc.DUE));
      if (!v.ok) throw new Error(v.msg);
    }

    var now = getNow();
    var dueEff = new Date(cyc.EXTUNTIL || cyc.DUE);
    var st = now <= dueEff ? 'COMPLETED' : 'COMPLETED-LATE';
    var upd = { PROOF: proofS, CBY: opts.actor || 'unknown', CAT: now, SRC: opts.source || 'TAB', STATUS: st };
    if (opts.remarks) upd.REMARKS = opts.remarks;
    writeCycleProps(String(cyc.ID), upd);
    audit(opts.actor || 'unknown', 'COMPLETED', String(cyc.ID), st + ' | proof: ' + proofS + ' | via ' + (opts.source || 'TAB'), opts.runId || '');
    spawnAfterCompletion(t, cyc, c);
    stampEmpTab(String(cyc.ID), st, proofS, now);
    flushAudit(); // v1.2: applyCompletion also runs outside ticks (onEdit/link) — land audit rows now
    return { ok: true, status: st, cycleId: String(cyc.ID) };
  } finally {
    if (lock) lock.releaseLock();
  }
}

/** Spawn the next cycle immediately so the next period is tracked without waiting for a tick. */
function spawnAfterCompletion(t, closedCycle, c) {
  var cycles = readCycles(); // v1.2: ONE read serves both the existing-map and the live check
  var existing = {};
  cycles.forEach(function (cy) { existing[String(cy.ID)] = true; });
  var live = cycles.some(function (cy) {
    return cy.TASKID === t.id && LIVE_STATUSES.indexOf(String(cy.STATUS)) >= 0;
  });
  if (live) return;
  var now = getNow();
  var today = startOfDay(now);
  var iter = 0, due = computeNextDue(new Date(closedCycle.DUE), t, closedCycle.CAT ? new Date(closedCycle.CAT) : null, c);
  while (due < today && iter++ < 366) {
    createCycle(t, due, 'MISSED', c, existing, 'COMPLETION');
    due = computeNextDue(due, t, null, c);
  }
  createCycle(t, due, 'SCHEDULED', c, existing, 'COMPLETION');
}

/** Reflect the completion on the employee tab row (if visible).
 *  v1.3: getDataRange() spans 13 columns (rebuildEmpTabs keeps a status
 *  note in M1) — the row is now sliced to the 11 schema columns before
 *  writing. The tab is a VIEW of the ledger: any failure here is
 *  audited (STAMP_FAILED) and can never invalidate a completion. */
function stampEmpTab(cycleId, status, proof, completedAt) {
  try {
    var cyc = findCycle(cycleId);
    if (!cyc) return;
    var t = taskById(cyc.TASKID);
    if (!t || !t.tab) return;
    var sh = ss().getSheetByName(t.tab);
    if (!sh) return;
    var vals = sh.getDataRange().getValues();
    for (var r = 1; r < vals.length; r++) {
      if (String(vals[r][0]) === String(cycleId)) {
        vals[r][EMP_COLS.STATUS - 1] = status;
        vals[r][EMP_COLS.INPUT_PROOF - 1] = proof;
        vals[r][EMP_COLS.INPUT_DONE - 1] = true;
        vals[r][EMP_COLS.CAT - 1] = completedAt;
        sh.getRange(r + 1, 1, 1, EMP_COLS.CAT).setValues([vals[r].slice(0, EMP_COLS.CAT)]);
        return;
      }
    }
  } catch (err) {
    audit('SYSTEM', 'STAMP_FAILED', String(cycleId), String(err && err.message ? err.message : err), '');
  }
}

/* ---------- Reconcile sweep: tab edits that missed the onEdit event ---------- */
function reconcileAll(c, runId, res) {
  var cycles = readCycles();
  var byId = {};
  cycles.forEach(function (cy) { byId[String(cy.ID)] = cy; });
  readTasks().forEach(function (t) {
    if (!t.tab || !t.active) return;
    var sh = ss().getSheetByName(t.tab);
    if (!sh) return;
    var vals = sh.getDataRange().getValues();
    for (var r = 1; r < vals.length; r++) {
      var cid = String(vals[r][0] || '').trim();
      if (!cid || !byId[cid]) continue;
      var cy = byId[cid];
      if (TERMINAL_STATUSES.indexOf(String(cy.STATUS)) >= 0) continue;
      var proof = String(vals[r][EMP_COLS.INPUT_PROOF - 1] || '').trim();
      var done = vals[r][EMP_COLS.INPUT_DONE - 1] === true;
      if (!proof && !done) continue;
      if (!proof) continue; // checkbox alone is not proof
      try {
        applyCompletion(cid, proof, { actor: t.emp, source: 'RECONCILE', runId: runId, alreadyLocked: true });
        res.reconciled++;
        audit('SYSTEM', 'RECONCILED', cid, 'Proof found on tab without ledger completion', runId);
      } catch (err) {
        audit('SYSTEM', 'REJECTED_EDIT', cid, 'Reconcile: ' + (err && err.message ? err.message : err), runId);
      }
    }
  });
}

/** ============================================================
 * 06_onedit.gs — Single-point employee update handler (Tests 2+3).
 * Runs as an installable onEdit trigger. Employees edit ONLY
 * columns G (Ticket ID / Ref), H (Done checkbox), J (Remarks) on
 * their own tab. Everything else is rejected/reverted + audited.
 * ============================================================ */

function onEditHandler(e) {
  try {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    var tab = sh.getName();
    if (tab.indexOf(EMP_PREFIX) !== 0) return;
    var row = e.range.getRow();
    if (row < 2) return;
    var col = e.range.getColumn();
    if ([EMP_COLS.INPUT_PROOF, EMP_COLS.INPUT_DONE, EMP_COLS.INPUT_REMARKS].indexOf(col) < 0) {
      // edits to derived columns are cleared (the next tick rebuilds them anyway);
      // CycleID (col 1) is left untouched because row mapping depends on it
      var numRowsGuard = e.range.getNumRows();
      if (e.range.getColumn() !== EMP_COLS.ID) {
        for (var rr = row; rr < row + numRowsGuard; rr++) {
          if (rr < 2) continue;
          for (var cc = 2; cc <= 11; cc++) {
            if ([EMP_COLS.INPUT_PROOF, EMP_COLS.INPUT_DONE, EMP_COLS.INPUT_REMARKS].indexOf(cc) >= 0) continue;
            e.range.offset(rr - row, cc - e.range.getColumn()).clearContent();
          }
        }
      }
      SpreadsheetApp.getActive().toast('Only Ticket ID / Ref (G), Done (H), Remarks (J) are editable.', 'Read-only cell');
      return;
    }
    var numRows = e.range.getNumRows();
    var runId = 'E' + Date.now().toString(36);
    for (var r = row; r < row + numRows; r++) {
      processEmpEdit(sh, r, col, runId); // multi-cell paste handled row by row
    }
  } catch (err) {
    try { SpreadsheetApp.getActive().toast('⚠ ' + (err && err.message ? err.message : err)); } catch (x) {}
  } finally {
    flushAudit(); // v1.2: audit is buffered — land rows when the edit handler ends
  }
}

function processEmpEdit(sh, row, col, runId) {
  var s = SpreadsheetApp.getActive();
  var tab = sh.getName();
  var actor = tabOwnerOf(tab);
  var cycleId = String(sh.getRange(row, EMP_COLS.ID).getValue() || '').trim();
  var val = sh.getRange(row, col).getValue();

  /* remarks: always accepted, persisted to ledger */
  if (col === EMP_COLS.INPUT_REMARKS) {
    if (cycleId) {
      writeCycleProps(cycleId, { REMARKS: String(val || '') });
      audit(actor, 'REMARKS', cycleId, String(val || ''), runId);
    }
    return;
  }

  if (!cycleId) { revert(sh, row, col); s.toast('Row ' + row + ': no CycleID — row skipped'); return; }

  var cyc = findCycle(cycleId);
  if (!cyc) { revert(sh, row, col); s.toast('Unknown task row — skipped'); return; }

  if (TERMINAL_STATUSES.indexOf(String(cyc.STATUS)) >= 0) {
    revert(sh, row, col);
    s.toast('Cycle already closed (' + cyc.STATUS + ') — update ignored');
    audit(actor, 'REJECTED_EDIT', cycleId, 'Edit on closed cycle, col ' + col, runId);
    return;
  }

  var t = taskById(cyc.TASKID);
  if (!t) { revert(sh, row, col); s.toast('Task missing — skipped'); return; }

  if (col === EMP_COLS.INPUT_PROOF) {                 // Ticket ID / Ref
    var proof = String(val || '').trim();
    if (!proof) return;                               // clearing the cell is allowed
    try {
      applyCompletion(cycleId, proof, { actor: actor, source: 'TAB', runId: runId });
      s.toast('✔ Completed: ' + t.name + (t.type === 'DAILY_CHECK' ? ' (daily done)' : ' (ticket logged)'));
    } catch (err) {
      revert(sh, row, col);
      s.toast('✖ Rejected: ' + (err && err.message ? err.message : err));
      audit(actor, 'REJECTED_EDIT', cycleId, String(err && err.message ? err.message : err), runId);
    }
    return;
  }

  if (col === EMP_COLS.INPUT_DONE) {                  // Done checkbox (daily)
    if (val !== true) return;                         // unchecking is ignored
    if (t.type !== 'DAILY_CHECK') {
      revert(sh, row, col);
      s.toast('Done checkbox is for daily tasks only — enter the Ticket ID instead');
      return;
    }
    var code = String(sh.getRange(row, EMP_COLS.INPUT_PROOF).getValue() || '').trim();
    if (!code) {
      revert(sh, row, col);
      s.toast('Paste today\u2019s code (col I) into "Ticket ID / Ref" first, then tick Done');
      return;
    }
    try {
      applyCompletion(cycleId, code, { actor: actor, source: 'TAB', runId: runId });
      s.toast('✔ Daily task marked done');
    } catch (err) {
      revert(sh, row, col);
      s.toast('✖ Rejected: ' + (err && err.message ? err.message : err));
      audit(actor, 'REJECTED_EDIT', cycleId, String(err && err.message ? err.message : err), runId);
    }
  }
}

function revert(sh, row, col) {
  sh.getRange(row, col).clearContent();
  if (col === EMP_COLS.INPUT_DONE) sh.getRange(row, col).setValue(false);
}

/** ============================================================
 * 07_alerts.gs — SLA alert detection (Tests 4–7), transactional
 * email outbox (append-once: zero duplicates), digests, manager
 * action processor (ack / extend / waive), mail self-test and
 * email templates. THIS IS THE MAIL FILE — all sending logic
 * lives here (queue → send → confirm).
 * Timeline per profile (all working-time, snapshot per cycle):
 *   DAILY    reminder 10:30 | due 11:00 | L1 11:30 | ack 13:00 | resolve 15:00
 *   PERIODIC reminder 14:00 | due 17:00 | L1 17:30 | ack D+1 11:00 | resolve D+1 17:00
 *
 * v1.5 defect fixes (audit of the 19 Oct export):
 *  D1/D2  L2 double-fire: L2a + L2b were two independent branches that
 *         could BOTH pass in the same tick (clock jumps past both the
 *         ack-by and the resolve-by deadline) → two identical L2 mails
 *         with the same DedupeKey. Now ONE adjudication per cycle with
 *         reason priority (past resolve-by > not acknowledged), and
 *         queueAlert itself is append-once: a per-execution key
 *         registry rebuilt from the sheet makes a duplicate insert
 *         impossible, regardless of caller.
 *  D3     Leadership digest was built from Alert_Log (inherits any
 *         duplicate rows) → now built from Cycle_Log (the ledger).
 *  D4     Outcome formula rendered an empty Completed At as the Sheets
 *         zero-date "30 Dec 00:00" → now shows " | open" instead.
 *  +      Digests get real subjects (were just "Task System: ").
 *
 * v1.6 hardening (audit of the export-6 run — T4/T6/T7 failed together):
 *  E1  emailL1 called buildSignedLink(), which lives in the OPTIONAL
 *      10_webapp.gs module. If that file is missing from the project,
 *      every detectAlerts pass threw "buildSignedLink is not defined"
 *      at the first overdue cycle — aborting the WHOLE per-cycle pass:
 *      no reminders, no L1, no L2 for any cycle (Alert_Log stayed
 *      empty; only digests survived). Fix: alertLink_() uses the
 *      signed-link feature only when the module exists. An optional
 *      feature can never again break core alerting.
 *  E2  detectAlerts now wraps each cycle in its own try/catch and logs
 *      a VISIBLE ERROR row in Audit_Log — one bad cycle can never
 *      again silence the alerts of all the others.
 * ============================================================ */

/* ---------- append-once key registry (per execution) ---------- */
var _QUEUED_KEYS = null;

/** Lazily built from the Outbox sheet; every queueAlert() success adds
 *  its key, so no key can ever be inserted twice in one execution, and
 *  the sheet itself guards across executions. */
function outboxKeyRegistry_() {
  if (!_QUEUED_KEYS) {
    _QUEUED_KEYS = {};
    readOutbox().forEach(function (o) { _QUEUED_KEYS[String(o.KEY)] = true; });
  }
  return _QUEUED_KEYS;
}

/* ---------- detection ---------- */
function detectAlerts(c, runId) {
  var now = getNow();
  var today = startOfDay(now);
  _QUEUED_KEYS = null;                 // fresh registry for this pass
  var outboxKeys = outboxKeyRegistry_(); // shared object with queueAlert
  /* task lookup cached once — was a full Task_Master read PER cycle */
  var tmap = {};
  readTasks().forEach(function (t) { tmap[t.id] = t; });
  var queued = 0;

  readCycles().forEach(function (cy) {
    /* v1.6 (E2): isolate each cycle — a failure is logged and VISIBLE,
     * but can no longer abort the remaining cycles in this pass. */
    try {
      var st = String(cy.STATUS);
      if (LIVE_STATUSES.indexOf(st) < 0) return;
      var t = tmap[String(cy.TASKID)];
      if (!t || !t.active) return;
      if (t.paused && t.paused >= today) return;

      var cid = String(cy.ID);
      var dueEff = new Date(cy.EXTUNTIL || cy.DUE);
      var empTo = t.delegate || cy.EMAIL;

      /* employee reminder (once, before due) */
      if (c.REMINDER_ENABLED === 'ON' && !cy.REMSENT && now >= new Date(cy.REM) && now < dueEff &&
          !outboxKeys[cid + '|REM']) {
        if (queueAlert('REMINDER', cid + '|REM', empTo, '', emailReminder(t, cy, dueEff), c, null, cid, runId, cy)) {
          outboxKeys[cid + '|REM'] = true;
          queued++;
        }
      }
      /* L1: manager email, same day (Test 4) */
      if (!cy.L1SENT && now >= new Date(cy.L1DT) && !outboxKeys[cid + '|L1']) {
        if (queueAlert('L1', cid + '|L1', c.MANAGER_EMAIL, '', emailL1(t, cy, dueEff, c), c, 'L1', cid, runId, cy)) {
          outboxKeys[cid + '|L1'] = true;
          queued++;
        }
      }
      /* L2: ONE adjudication per cycle, at most ONE escalation email ever.
       * Reason priority: past resolve-by deadline > manager never acknowledged.
       * (Old code had two independent branches that could both fire in the
       * same tick and queue two L2 mails with the same DedupeKey — D1/D2.) */
      if (!cy.L2SENT && !outboxKeys[cid + '|L2']) {
        var l2reason = '';
        if (now >= new Date(cy.EXTUNTIL || cy.RES)) {
          l2reason = 'Unresolved past the resolve-by deadline';
        } else if (cy.L1SENT && !cy.ACKAT && now >= new Date(cy.ACKDT)) {
          l2reason = 'Manager did not acknowledge the pending-task alert';
        }
        if (l2reason && queueAlert('L2', cid + '|L2', c.LEADERSHIP_EMAILS, c.MANAGER_EMAIL,
            emailL2(t, cy, dueEff, l2reason, c), c, 'L2', cid, runId, cy)) {
          outboxKeys[cid + '|L2'] = true;
          writeCycleProps(cid, { L2REASON: l2reason }); // human-readable reason on the ledger
          queued++;
        }
      }
    } catch (err) {
      audit('SYSTEM', 'ERROR', String(cy && cy.ID ? cy.ID : ''),
        'cycle skipped: ' + String(err && err.message ? err.message : err), runId);
    }
  });
  return queued;
}

/** Transactional insert: unique DedupeKey, QUEUED before anything is sent.
 *  APPEND-ONCE: returns false and writes nothing if the key already
 *  exists (in this execution or on the sheet). `cyc` may be passed by
 *  callers who already hold the cycle object (saves a full ledger read).
 *  `subj` overrides the derived subject (used by digests). */
function queueAlert(type, key, to, cc, html, c, level, cycleId, runId, cyc, subj) {
  var cyc = (cyc === undefined) ? findCycle(cycleId) : cyc;
  var keys = outboxKeyRegistry_();
  if (keys[String(key)]) return false; // append-once guard (D1 root fix)
  sheet(SHEET.OUTBOX).appendRow([
    key, type, to, cc || '', subj || subjectFor(type, cyc), html, 'QUEUED', 0, getNow(), '', '', ''
  ]);
  keys[String(key)] = true;
  _obxDirty(); // appended row must be visible to the next reader
  if (level) {
    var sh = sheet(SHEET.ALERTS);
    sh.appendRow([
      key, level, cycleId, cyc ? cyc.EMP : '', cyc ? cyc.TASK : '',
      cyc ? new Date(cyc.DUE) : '', cyc ? hoursBetween(new Date(cyc.EXTUNTIL || cyc.DUE), getNow()) : '',
      'QUEUED', '', '', '', '', '', '', '', ''
    ]);
    var actualRow = sh.getLastRow(); // write outcome formula at its true row
    sh.getRange(actualRow, ALERT_COLS.OUTCOME).setValue(outcomeFormula(actualRow));
    _alrtDirty();
    audit('SYSTEM', level + '_QUEUED', cycleId, 'key=' + key, runId);
  } else {
    audit('SYSTEM', type + '_QUEUED', cycleId || '', 'key=' + key, runId);
  }
  return true;
}

function subjectFor(type, cyc) {
  var base = cyc ? (cyc.TASK + ' (' + cyc.EMP + '), due ' + fmtDT(new Date(cyc.EXTUNTIL || cyc.DUE))) : '';
  if (type === 'L1') return '[ACTION] Overdue: ' + base;
  if (type === 'L2') return '[ESCALATION] ' + base;
  if (type === 'REMINDER') return '[Reminder] Due soon: ' + base;
  return 'Task System: ' + base;
}

/** v1.5 (D4): an empty Completed At must NOT render as the Sheets
 *  zero-date "30 Dec 00:00" — open cycles show " | open". */
function outcomeFormula(row) {
  var m = 'MATCH(C' + row + ',Cycle_Log!$A:$A,0)';
  return '=IFERROR(INDEX(Cycle_Log!$M:$M,' + m + ')&IF(INDEX(Cycle_Log!$P:$P,' + m + ')="" ,'+
         '" | open"," | done: "&TEXT(INDEX(Cycle_Log!$P:$P,' + m + '),"dd MMM HH:mm")),"\u2014")';
}

/* ---------- outbox sender: QUEUED -> SENDING -> SENT | FAILED ---------- */
/* One full-row write per state change. Column order for the batched row write: */
var OUTBOX_ORDER = ['KEY','TYPE','TO','CC','SUBJ','BODY','STATUS','ATT','QAT','SAT','ERR','SSAT'];

function writeOutboxRow(sh, o) {
  sh.getRange(o.row, 1, 1, OUTBOX_ORDER.length)
    .setValues([OUTBOX_ORDER.map(function (k) { return o[k]; })]);
}

function sendOutbox(c, runId) {
  var now = getNow();
  var res = { sent: 0, failed: 0 };
  if (c.EMAIL_ENABLED === 'ON' && MailApp.getRemainingDailyQuota() <= 0) {
    audit('SYSTEM', 'MAIL_QUOTA', '', 'Daily mail quota exhausted — send deferred', runId);
    return res;
  }
  var obs = readOutbox().slice().sort(function (a, b) { return new Date(a.QAT) - new Date(b.QAT); }); // sort a copy — cache array stays untouched
  var sh = sheet(SHEET.OUTBOX);
  var alertsCache = readAlerts(); // one read shared by all confirmSent calls below

  obs.forEach(function (o) {
    var st = String(o.STATUS);
    if (st === 'SENT' || st === 'SENT-DRY' || st === 'FAILED') return; // terminal
    if (st === 'SENDING' && o.SSAT && (now - new Date(o.SSAT)) < 10 * 60000) return; // assumed in-flight
    if (quietHours(now, c)) return; // stays QUEUED for the next window

    var to = c.TESTMODE === 'ON' ? sandboxRecipient(c) : o.TO;
    var cc = c.TESTMODE === 'ON' ? '' : o.CC;
    var subj = (c.TESTMODE === 'ON' ? '[TESTMODE] ' : '') + o.SUBJ;

    o.STATUS = 'SENDING'; o.SSAT = now;
    writeOutboxRow(sh, o);
    try {
      if (c.EMAIL_ENABLED === 'ON') {
        MailApp.sendEmail({ to: to, cc: cc, subject: subj, htmlBody: String(o.BODY), body: plainText(o.BODY) });
      }
      o.STATUS = c.EMAIL_ENABLED === 'ON' ? 'SENT' : 'SENT-DRY';
      o.SAT = getNow();
      writeOutboxRow(sh, o);
      confirmSent(String(o.KEY), String(o.TYPE), runId, alertsCache);
      res.sent++;
    } catch (err) {
      o.ATT = (+o.ATT || 0) + 1;
      o.ERR = String(err && err.message ? err.message : err).slice(0, 400);
      o.STATUS = o.ATT >= 3 ? 'FAILED' : 'QUEUED'; // retry next tick
      writeOutboxRow(sh, o);
      if (o.ATT >= 3) {
        res.failed++;
        queueOwnerAlert(String(o.KEY), err, c, runId);
      }
    }
  });
  _obxDirty(); // row statuses changed on disk
  return res;
}

/** Flags set AFTER confirmed send — the anti-duplicate guarantee.
 *  `alerts` = optional pre-read Alert_Log array (perf: avoids a full read per sent mail). */
function confirmSent(key, type, runId, alerts) {
  var parts = key.split('|');
  var cid = parts[0];
  var now = getNow();
  if (cid.indexOf('-') < 0) return;
  if (type === 'L1' || type === 'L2') {
    writeCycleProps(cid, type === 'L1' ? { L1SENT: now } : { L2SENT: now });
    (alerts || readAlerts()).forEach(function (a) {
      if (String(a.ID) === key) {
        /* STATUS+SENTAT are adjacent — ONE write */
        sheet(SHEET.ALERTS).getRange(a.row, ALERT_COLS.STATUS, 1, 2).setValues([['SENT', now]]);
        a.STATUS = 'SENT'; a.SENTAT = now; // keep the tick read-cache consistent
      }
    });
    _alrtDirty();
    audit('SYSTEM', type + '_SENT', cid, 'key=' + key, runId);
  }
  if (type === 'REMINDER') writeCycleProps(cid, { REMSENT: now });
}

function queueOwnerAlert(key, err, c, runId) {
  var k = 'OWNER|' + key + '|' + dayKey(getNow());
  var html = '<p>Outbox item failed 3 times.</p><p><b>DedupeKey:</b> ' + key + '</p><p><b>Error:</b> ' +
    String(err && err.message ? err.message : err) + '</p>';
  queueAlert('OWNER', k, sandboxRecipient(c), '', html, c, null, '', runId, null,
    'Task System failure: ' + key); // append-once inside queueAlert
}

/* ---------- digests (spam control: one consolidated mail/day) ----------
 * v1.5 (D3): BOTH digests are built from Cycle_Log (the ledger), never
 * from Alert_Log — the ledger has exactly one row per cycle, so a
 * duplicate alert can never multiply digest lines. */
function sendDigests(c, runId) {
  var now = getNow();
  if (minutesOfDay(now) < hmToMin(c.DIGEST_TIME)) return;
  if (quietHours(now, c)) return;

  var haveKeys = outboxKeyRegistry_();

  var live = readCycles().filter(function (cy) {
    return LIVE_STATUSES.indexOf(String(cy.STATUS)) >= 0;
  });

  /* manager digest: all open overdue cycles */
  var overdue = live.filter(function (cy) { return String(cy.STATUS) === 'OVERDUE'; });
  var mgrKey = 'DIGEST|MGR|' + dayKey(now);
  if (overdue.length && !haveKeys[mgrKey]) {
    var rows = overdue.map(function (cy) {
      return [cy.EMP, cy.TASK, fmtDT(new Date(cy.EXTUNTIL || cy.DUE)), cy.STATUS,
              cy.L1SENT ? 'yes' : 'no', cy.ACKAT ? 'yes' : 'NO'];
    });
    if (queueAlert('DIGEST', mgrKey, c.MANAGER_EMAIL, '',
        emailDigest('Morning digest — ' + overdue.length + ' open overdue item(s)',
                    ['Employee', 'Task', 'Due', 'Status', 'L1 sent', 'Acked'], rows),
        c, null, '', runId, null,
        'Daily digest: ' + overdue.length + ' open overdue item(s)')) {
      haveKeys[mgrKey] = true;
    }
  }

  /* leadership digest: all live cycles escalated to leadership (L2 sent) */
  var escalated = live.filter(function (cy) { return cy.L2SENT; });
  var leadKey = 'DIGEST|LEAD|' + dayKey(now);
  if (escalated.length && !haveKeys[leadKey]) {
    var lrows = escalated.map(function (cy) {
      return [cy.EMP, cy.TASK, fmtDT(new Date(cy.EXTUNTIL || cy.DUE)),
              cy.L2REASON || 'Escalated', fmtDT(new Date(cy.L2SENT)), cy.ACKAT ? 'yes' : 'NO'];
    });
    queueAlert('DIGEST', leadKey, c.LEADERSHIP_EMAILS, '',
        emailDigest('Escalation digest — ' + escalated.length + ' item(s) escalated to leadership',
                    ['Employee', 'Task', 'Due', 'L2 Reason', 'Escalated At', 'Acked'], lrows),
        c, null, '', runId, null,
        'Escalation digest: ' + escalated.length + ' item(s)');
  }
}

/* ---------- mail self-test (verify the pipeline end to end) ---------- */
/** ⚡ menu: "Send Test Email (verify mail)". Sends ONE real email to the
 *  sandbox address (or the sheet owner when TESTMODE is OFF) straight
 *  through MailApp, proving: OAuth authorization, daily quota, and the
 *  recipient address. Engine emails themselves stay governed by
 *  EMAIL_ENABLED / TESTMODE as configured. */
function mailSelfTest() {
  var c = getCfg(true);
  var to = sandboxRecipient(c);
  var stamp = Utilities.formatDate(new Date(), APP_TZ, 'dd MMM yyyy HH:mm:ss');
  var quota = MailApp.getRemainingDailyQuota();
  var html = htmlShell('Mail self-test',
    '<p>The mail pipeline works. Sent at <b>' + stamp + '</b>.</p>' +
    htmlTable(['Check', 'Value'], [
      ['Recipient', to],
      ['TESTMODE', c.TESTMODE],
      ['EMAIL_ENABLED', c.EMAIL_ENABLED],
      ['Remaining daily quota', String(quota)]
    ]) +
    (c.EMAIL_ENABLED === 'ON'
      ? '<p style="color:#38761d"><b>EMAIL_ENABLED=ON — engine alert emails will really send.</b></p>'
      : '<p style="color:#b45f06"><b>EMAIL_ENABLED=OFF — the engine is in dry-run: Outbox rows show SENT-DRY and nothing is sent.</b></p>'));
  try {
    MailApp.sendEmail({ to: to, subject: '[Task System] Mail self-test ' + stamp,
                        htmlBody: html, body: plainText(html) });
    audit('SYSTEM', 'MAIL_SELFTEST', '', 'to=' + to + ' | quota=' + quota, 'SELFTEST');
    flushAudit();
    toastMsg('Test email sent to ' + to + '. Check the inbox (and spam folder). ' +
             'Remaining quota: ' + quota + '. Engine mode: EMAIL_ENABLED=' + c.EMAIL_ENABLED + '.',
             'Mail self-test');
  } catch (err) {
    flushAudit();
    toastMsg('Send FAILED: ' + (err && err.message ? err.message : err) +
             ' — run it again and complete the Google authorization prompt, or check the quota.',
             'Mail self-test');
  }
}

/* ---------- manager action processor (Test 5 + T14) ---------- */
function processManagerActions(c, runId) {
  var now = getNow();
  /* one ledger read shared by both passes (was findCycle = full read per alert row) */
  var byId = {};
  readCycles().forEach(function (cy) { byId[String(cy.ID)] = cy; });
  /* ONE Alert_Log read + ONE task map for the whole pass */
  var alerts = readAlerts();
  var tmap = {};
  readTasks().forEach(function (t) { tmap[t.id] = t; });
  var processed = []; // PROCESSED='YES' rows, written below
  /* 1. mirror direct Alert_Log acks into the ledger (manager's designed input surface) */
  alerts.forEach(function (a) {
    if (String(a.MACK) !== 'YES' || !a.MACKAT) return;
    var cyc = byId[String(a.CYCLE)];
    if (cyc && !cyc.ACKAT) {
      writeCycleProps(String(a.CYCLE), { ACKBY: String(a.MACKBY || 'MANAGER'), ACKAT: new Date(a.MACKAT) });
      audit(String(a.MACKBY || 'MANAGER'), 'ACK', String(a.CYCLE), 'Synced from Alert_Log', runId);
    }
  });
  /* 2. process pending manager actions */
  alerts.forEach(function (a) {
    var act = String(a.MACTION || '').trim();
    if (!act || String(a.PROCESSED) === 'YES') return;
    var cid = String(a.CYCLE);
    var cyc = byId[cid];
    if (!cyc) { processed.push(a.row); return; }
    var t = tmap[String(cyc.TASKID)];

    if (act === 'Extend' && !cyc.EXTUNTIL && t) {
      var newUntil = workingTimeAdd(now, t.profile === 'DAILY' ? +c.RESOLVE_OFFSET_DAILY_MIN : +c.RESOLVE_OFFSET_PERIODIC_MIN, c);
      var upd = { EXTUNTIL: newUntil, EXTREASON: String(a.AREASON || 'Extended by manager') };
      if (!cyc.ACKAT) { upd.ACKBY = String(a.MACKBY || 'MANAGER'); upd.ACKAT = now; } // extension implies engagement
      writeCycleProps(cid, upd);
      audit(String(a.MACKBY || 'MANAGER'), 'EXTEND', cid, 'Until ' + fmtDT(newUntil) + ' | ' + (a.AREASON || ''), runId);
    } else if (act === 'Waive') {
      writeCycleProps(cid, { STATUS: 'MISSED', L2REASON: 'Waived by manager: ' + (a.AREASON || '') });
      audit(String(a.MACKBY || 'MANAGER'), 'WAIVE', cid, a.AREASON || '', runId);
    } else {
      audit(String(a.MACKBY || 'MANAGER'), 'MANAGER_ACTION', cid, act + ' | ' + (a.AREASON || ''), runId);
    }
    processed.push(a.row);
  });
  if (processed.length) {
    var shA = sheet(SHEET.ALERTS);
    processed.forEach(function (r) { shA.getRange(r, ALERT_COLS.PROCESSED).setValue('YES'); });
    _alrtDirty();
  }
}

/** Ack helper (used by Alert_Log edits via menu, signed link, or tests). */
function markManagerAck(cycleId, by) {
  var now = getNow();
  var done = false;
  readAlerts().forEach(function (a) {
    if (String(a.CYCLE) === String(cycleId) && a.LEVEL === 'L1') {
      /* MACK/MACKBY/MACKAT are adjacent — ONE write */
      sheet(SHEET.ALERTS).getRange(a.row, ALERT_COLS.MACK, 1, 3)
        .setValues([['YES', by || 'MANAGER', now]]);
      a.MACK = 'YES'; a.MACKBY = by || 'MANAGER'; a.MACKAT = now;
      done = true;
    }
  });
  _alrtDirty();
  writeCycleProps(String(cycleId), { ACKBY: by || 'MANAGER', ACKAT: now });
  audit(by || 'MANAGER', 'ACK', String(cycleId), 'Manager acknowledged pending-task alert', '');
  flushAudit(); // may run outside a tick (menu/link/test) — land rows now
  return done;
}

/* ---------- templates ---------- */
function htmlShell(title, body) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px">' +
    '<h2 style="color:#1f4e79;margin:0 0 12px">' + title + '</h2>' + body +
    '<p style="color:#888;font-size:11px;margin-top:18px">Automated by the Recurring Task System (Allo Innoware prototype). ' +
    'Open the sheet: ' + ss().getUrl() + '</p></div>';
}

function htmlTable(headers, rows) {
  var h = '<tr>' + headers.map(function (x) {
    return '<th style="text-align:left;background:#1f4e79;color:#fff;padding:6px 10px">' + x + '</th>';
  }).join('') + '</tr>';
  var b = rows.map(function (r) {
    return '<tr>' + r.map(function (x) {
      return '<td style="border-bottom:1px solid #ddd;padding:6px 10px">' + String(x) + '</td>';
    }).join('') + '</tr>';
  }).join('');
  return '<table style="border-collapse:collapse;font-size:13px">' + h + b + '</table>';
}

/** v1.6 (E1): signed links are an OPTIONAL feature delivered by
 *  10_webapp.gs. This guard makes their absence harmless: if the
 *  webapp module is not installed, emails simply omit the one-click
 *  link and fall back to the documented Alert_Log ack workflow.
 *  It can never throw, so it can never block an alert. */
function alertLink_(action, cycleId) {
  try {
    if (typeof buildSignedLink === 'function') return buildSignedLink(action, cycleId) || '';
  } catch (e) { /* optional feature — never block an alert */ }
  return '';
}

function emailL1(t, cy, dueEff, c) {
  var ackBy = fmtDT(new Date(cy.ACKDT)), resBy = fmtDT(new Date(cy.RES));
  var ackLink = alertLink_('ack', String(cy.ID));
  var body = '<p><b>' + cy.TASK + '</b> assigned to <b>' + cy.EMP + '</b> is past due (due ' + fmtDT(dueEff) + ').</p>' +
    htmlTable(['Item', 'Detail'], [
      ['Task', cy.TASK], ['Employee', cy.EMP], ['Due', fmtDT(dueEff)],
      ['Ack by', ackBy], ['Resolve by', resBy], ['Cycle', String(cy.ID)]
    ]) +
    '<p><b>What to do:</b> open the sheet \u2192 Alert_Log \u2192 set <i>Manager Ack = YES</i> and choose an action ' +
    '(Following up / Reassigned / Extend / Waive). ' + (ackLink ? 'Or <a href="' + ackLink + '">acknowledge with one click</a>.' : '') + '</p>';
  return htmlShell('Pending task alert', body);
}

function emailL2(t, cy, dueEff, reason, c) {
  var body = '<p>The item below has been <b>escalated to leadership</b>.</p>' +
    htmlTable(['Item', 'Detail'], [
      ['Task', cy.TASK], ['Employee', cy.EMP], ['Due', fmtDT(dueEff)],
      ['Overdue by', hoursBetween(dueEff, getNow()) + ' h'],
      ['Reason', reason], ['Cycle', String(cy.ID)], ['Manager', c.MANAGER_EMAIL]
    ]) +
    '<p>Manager is CC\u2019d. The item stays on the manager dashboard until completed.</p>';
  return htmlShell('Escalation to leadership', body);
}

function emailReminder(t, cy, dueEff) {
  var isDaily = t.type === 'DAILY_CHECK';
  var body = '<p><b>' + cy.TASK + '</b> is due at <b>' + fmtDT(dueEff) + '</b>.</p>' +
    (isDaily
      ? '<p>Post your update in the WhatsApp group including today\u2019s code <b>' + getDailyCode(t.id, getNow()) +
        '</b>, then tick <i>Done</i> and paste the code in your tab (' + t.tab + ').</p>'
      : '<p>Complete the portal task and enter the Ticket ID in your tab (' + t.tab + ').</p>');
  return htmlShell('Task reminder', body);
}

/** v1.5: headers are now passed in so both digests have aligned columns. */
function emailDigest(title, headers, rows) {
  var body = '<p>' + rows.length + ' item(s):</p>' +
    htmlTable(headers, rows) +
    '<p>Details: Manager_Dashboard tab.</p>';
  return htmlShell(title, body);
}


/** ============================================================
 * 08_dashboard.gs — Manager visibility without opening employee
 * tabs: pending/overdue per employee, open overdue list, KPIs,
 * heartbeat. Entirely script-owned (regenerated every tick).
 *
 * v1.5 (D5): every count is derived from Cycle_Log (the ledger).
 * Alert_Log may contain historical duplicate rows from before the
 * append-once fix — the dashboard no longer reads it at all, so
 * legacy duplicates can never inflate "Unacked L1" / "Escalated"
 * or skew MTTA again.
 * ============================================================ */

function refreshDashboard(c) {
  var sh = sheet(SHEET.DASH);
  sh.clearContents();
  var now = getNow();

  var title = sh.getRange(1, 1);
  title.setValue('Manager Dashboard — Recurring Task System').setFontWeight('bold').setFontSize(14).setFontColor('#1f4e79');
  sh.getRange(1, 5).setValue('TESTMODE IS ON — emails go to sandbox only').setFontColor('#b45f06').setFontWeight('bold');
  if (c.TESTMODE !== 'ON') sh.getRange(1, 5).clearContent();

  /* heartbeat */
  var last = getProp('LAST_TICK');
  var lastD = last ? new Date(last) : null;
  var staleMin = lastD ? Math.round((now - lastD) / 60000) : -1;
  var hb = sh.getRange(3, 1);
  hb.setValue('Last engine tick:');
  sh.getRange(3, 2).setValue(lastD ? fmtDT(lastD) : 'NEVER');
  var ok = lastD && staleMin <= (+c.HEARTBEAT_MAX_MIN);
  var hbs = sh.getRange(3, 3);
  hbs.setValue(lastD ? (ok ? 'OK' : 'STALE (' + staleMin + ' min)') : 'NO TICK YET');
  hbs.setFontWeight('bold').setFontColor(ok ? '#38761d' : '#cc0000');
  sh.getRange(3, 4).setValue('Sim clock: ' + (c.SIMNOW ? c.SIMNOW + ' (SIMULATION)' : 'real time'));

  var cycles = readCycles();

  /* per-employee block */
  sh.getRange(5, 1).setValue('Team status').setFontWeight('bold');
  var hdr = ['Employee', 'Pending', 'Overdue', 'Unacked L1', 'Escalated (L2)', 'On-time % (30d)'];
  sh.getRange(6, 1, 1, hdr.length).setValues([hdr]).setFontWeight('bold').setBackground('#d9e2f3');
  var emps = {};
  readTasks().forEach(function (t) { if (t.active && t.emp) emps[t.emp] = true; });
  var row = 7;
  Object.keys(emps).forEach(function (emp) {
    var mine = cycles.filter(function (cy) { return cy.EMP === emp; });
    var live = mine.filter(function (cy) { return LIVE_STATUSES.indexOf(String(cy.STATUS)) >= 0; });
    var od = live.filter(function (cy) { return String(cy.STATUS) === 'OVERDUE'; });
    /* ledger-derived flags — one row per cycle, duplicates impossible */
    var unack = live.filter(function (cy) { return cy.L1SENT && !cy.ACKAT; }).length;
    var esc = live.filter(function (cy) { return cy.L2SENT; }).length;
    sh.getRange(row, 1, 1, 6).setValues([[
      emp, live.length, od.length, unack, esc, onTimePct(mine, now)
    ]]);
    if (od.length) sh.getRange(row, 3).setFontWeight('bold').setFontColor('#cc0000');
    row++;
  });

  /* open overdue list */
  row += 1;
  sh.getRange(row, 1).setValue('Open overdue cycles (needs action)').setFontWeight('bold');
  row++;
  var hdr2 = ['CycleID', 'Employee', 'Task', 'Due', 'Overdue (h)', 'Status', 'L1 sent', 'Manager acked', 'Escalated'];
  sh.getRange(row, 1, 1, hdr2.length).setValues([hdr2]).setFontWeight('bold').setBackground('#f4c7c3');
  row++;
  var openOd = cycles.filter(function (cy) { return String(cy.STATUS) === 'OVERDUE'; });
  openOd.sort(function (a, b) { return new Date(a.DUE) - new Date(b.DUE); });
  openOd.forEach(function (cy) {
    sh.getRange(row, 1, 1, hdr2.length).setValues([[
      cy.ID, cy.EMP, cy.TASK, fmtDT(new Date(cy.EXTUNTIL || cy.DUE)),
      hoursBetween(new Date(cy.EXTUNTIL || cy.DUE), now), cy.STATUS,
      cy.L1SENT ? 'yes' : 'no', cy.ACKAT ? 'yes (' + fmtDT(new Date(cy.ACKAT)) + ')' : 'NO',
      cy.L2SENT ? 'yes' : 'no'
    ]]);
    row++;
  });
  if (!openOd.length) { sh.getRange(row, 1).setValue('None \u2714'); row++; }

  /* KPIs */
  row += 1;
  sh.getRange(row, 1).setValue('KPIs (last 30 days)').setFontWeight('bold');
  row++;
  var kpi = kpis30d(cycles, now);
  sh.getRange(row, 1, 1, 2).setValues([['Cycles created', kpi.created]]);
  row++;
  sh.getRange(row, 1, 1, 2).setValues([['Completed on time', kpi.onTime]]);
  row++;
  sh.getRange(row, 1, 1, 2).setValues([['Completed late', kpi.late]]);
  row++;
  sh.getRange(row, 1, 1, 2).setValues([['Missed', kpi.missed]]);
  row++;
  sh.getRange(row, 1, 1, 2).setValues([['Extensions', kpi.extensions]]);
  row++;
  sh.getRange(row, 1, 1, 2).setValues([['MTTA (alert \u2192 ack)', kpi.mtta]]);
  row++;
  sh.getRange(row, 1, 1, 2).setValues([['MTTR (alert \u2192 completion)', kpi.mttr]]);
  row++;
  sh.getRange(row, 1).setValue('Auto-refreshed ' + fmtDT(now)).setFontColor('#888');
}

function onTimePct(mine, now) {
  var win = new Date(now.getTime() - 30 * 86400000);
  var rel = mine.filter(function (cy) { return new Date(cy.DUE) >= win; });
  var done = rel.filter(function (cy) { return String(cy.STATUS).indexOf('COMPLETED') === 0 || String(cy.STATUS) === 'MISSED'; });
  if (!done.length) return '\u2014';
  var ontime = done.filter(function (cy) { return String(cy.STATUS) === 'COMPLETED'; }).length;
  return Math.round(ontime / done.length * 100) + '%';
}

/** v1.5: MTTA now comes from the ledger (L1SENT → ACKAT per cycle);
 *  the Alert_Log path it replaced double-counted duplicate alerts. */
function kpis30d(cycles, now) {
  var win = new Date(now.getTime() - 30 * 86400000);
  var rel = cycles.filter(function (cy) { return new Date(cy.DUE) >= win; });
  var onTime = 0, late = 0, missed = 0;
  rel.forEach(function (cy) {
    var st = String(cy.STATUS);
    if (st === 'COMPLETED') onTime++;
    else if (st === 'COMPLETED-LATE') late++;
    else if (st === 'MISSED') missed++;
  });
  var acked = cycles.filter(function (cy) {
    return cy.L1SENT && cy.ACKAT && new Date(cy.DUE) >= win;
  });
  var mtta = acked.length
    ? Math.round(acked.reduce(function (s, cy) { return s + (new Date(cy.ACKAT) - new Date(cy.L1SENT)); }, 0) / acked.length / 3600000 * 10) / 10 + ' h'
    : '\u2014';
  var resolved = cycles.filter(function (cy) {
    return String(cy.STATUS).indexOf('COMPLETED') === 0 && cy.CAT && cy.L1SENT && new Date(cy.DUE) >= win;
  });
  var mttr = resolved.length
    ? Math.round(resolved.reduce(function (s, cy) { return s + (new Date(cy.CAT) - new Date(cy.L1SENT)); }, 0) / resolved.length / 3600000 * 10) / 10 + ' h'
    : '\u2014';
  return { created: rel.length, onTime: onTime, late: late, missed: missed,
    extensions: rel.filter(function (cy) { return cy.EXTUNTIL; }).length, mtta: mtta, mttr: mttr };
}


/** ============================================================
 * 09_tests.gs — Automated test harness (assignment Tests 1–8) v2.
 * Run from ⚡ menu ("Run All Tests — fast mode" or "Run Single Test").
 *
 * v1.5: T6 is now a true regression test for the L2 double-fire
 * defect (D1/D2): it jumps the sim clock PAST BOTH the ack-by and
 * the resolve-by deadline in ONE step and asserts exactly one L2
 * mail (the old code queued two here). All other bodies unchanged.
 *
 * v2 (timeout fix):
 *  • TESTS_RUNNING flag → engine tick skips dashboard/tab rebuilds
 *    so the whole suite finishes well inside the 6-minute cap
 *  • time-budget guard: suite always WRITES its results and cleans up
 *  • init pins SimNow to the next WORKING day 10:00 → weekend-proof
 *    (a Sunday run would otherwise break the day+1 walks)
 *  • "Run Single Test" submenu: prerequisites replayed silently
 *  • Test_Cases tab auto-created if missing
 * EMAIL forced dry-run (nothing is sent), TESTMODE forced ON.
 * Tests run in an isolated TT-* namespace and clean up after.
 * After the run: ⚡ Reset Demo Data restores the sample scenario.
 * ============================================================ */

var _TEST_RESULTS = [];
var TEST_BUDGET_MS = 240000; // abort the suite after 4 min (hard cap is 6)

var SCENARIOS = {
  1: 'Recurring cycle: 7-day task closes and next cycle auto-spawns',
  2: 'Single-point completion: ledger gets who/when/proof from one edit',
  3: 'Daily task: wrong code rejected, today\u2019s code accepted',
  4: 'Same-day manager alert: exactly one L1 email (deduped across ticks)',
  5: 'Manager acknowledgement is captured and outcome tracked',
  6: 'Leadership escalation: past both deadlines -> exactly one L2 email',
  7: 'DAILY timeline walk: reminder -> L1 -> L2b each fire once',
  8: 'No duplicates: 3 ticks + replayed edits change nothing'
};

/* Prerequisites per test (replayed silently in single-test mode). */
var PREREQS = { 1: [], 2: [], 3: [], 4: [3], 5: [3], 6: [], 7: [3, 4, 5], 8: [1, 2, 3, 4, 5, 7, 6] };
var TEST_ORDER = [1, 2, 3, 4, 5, 7, 6, 8]; // dependency order (T7 before T6)

/* ---------- entry points ---------- */
function menuRunTestsWrapper() { runAllTests(); }
function runT1() { runSingleTest(1); }
function runT2() { runSingleTest(2); }
function runT3() { runSingleTest(3); }
function runT4() { runSingleTest(4); }
function runT5() { runSingleTest(5); }
function runT6() { runSingleTest(6); }
function runT7() { runSingleTest(7); }
function runT8() { runSingleTest(8); }

function _testInit(label) {
  cacheClear(); // drop any stale per-execution caches from earlier runs
  var c0 = getCfg(true);
  var upd = { TESTS_RUNNING: 'ON', SIMNOW: '' }; // ONE batched Config write
  if (c0.TESTMODE !== 'ON') upd.TESTMODE = 'ON';
  if (c0.EMAIL_ENABLED !== 'OFF') upd.EMAIL_ENABLED = 'OFF'; // dry-run: outbox marks SENT-DRY, no mail
  setConfigs(upd);
  cleanupTestArtifacts();
  insertTestTasks();
  getCfg(true);
  /* Weekend-proof: pin the sim clock to the next working day 10:00 so
   * every "+1 day" walk in the tests lands on a working day. */
  var wd = nextWorkingDayStart(new Date(), getCfg());
  setSim(Utilities.formatDate(wd, APP_TZ, 'yyyy-MM-dd') + ' 10:00');
  tick('TESTS-INIT' + (label ? '-' + label : '')); // create "today" cycles for TT-* tasks
}

function _testFinish() {
  try { writeTestResults(); }
  catch (e) { toastMsg('Could not write Test_Cases: ' + (e && e.message ? e.message : e), 'Tests'); }
  try { cleanupTestArtifacts(); } catch (e) {}
  flushAudit();                                     // land buffered audit rows
  setConfigs({ SIMNOW: '', TESTS_RUNNING: 'OFF' }); // also re-arms the background trigger
  cacheClear();
}

function runAllTests() {
  _TEST_RESULTS = [];
  var t0 = Date.now();
  try {
    _testInit('');
    for (var i = 0; i < TEST_ORDER.length; i++) {
      var n = TEST_ORDER[i];
      if (Date.now() - t0 > TEST_BUDGET_MS) {
        for (var j = i; j < TEST_ORDER.length; j++) {
          _TEST_RESULTS.push({
            id: 'T' + TEST_ORDER[j], scen: SCENARIOS[TEST_ORDER[j]], expected: 'per scenario',
            actual: 'SKIPPED — time budget. Run it alone via ⚡ Run Single Test.', pass: false, evidence: ''
          });
        }
        break;
      }
      t(n, SCENARIOS[n], TEST_FNS[n]);
    }
    var passed = _TEST_RESULTS.filter(function (r) { return r.pass; }).length;
    toastMsg('Tests: ' + passed + '/' + _TEST_RESULTS.length + ' passed. Results in the Test_Cases tab. Run ⚡ Reset Demo Data to restore the sample scenario.', 'Test run');
  } finally {
    _testFinish();
  }
  return _TEST_RESULTS;
}

function runSingleTest(n) {
  _TEST_RESULTS = [];
  try {
    _testInit('T' + n);
    (PREREQS[n] || []).forEach(function (p) { try { TEST_FNS[p](); } catch (e) { } });
    t(n, SCENARIOS[n], TEST_FNS[n]);
    var r0 = _TEST_RESULTS[0];
    toastMsg('T' + n + ': ' + (r0 && r0.pass ? 'PASS ✓' : 'FAIL — open the Test_Cases tab for evidence'), 'Single test T' + n);
  } finally {
    _testFinish();
  }
  return _TEST_RESULTS;
}

/* ---------- test bodies ---------- */

function testBody1() {
  var c1 = findLiveCycle('TT-W');
  assert(c1, 'No live TT-W cycle after init tick');
  var r = applyCompletion(c1.ID, 'AAA-111', { actor: 'Employee B', source: 'TAB' });
  var nextId = 'TT-W-' + dateKey(computeNextDue(new Date(c1.DUE), taskById('TT-W'), null, getCfg()));
  var next = findCycle(nextId);
  assert(next, 'Next cycle ' + nextId + ' was not created');
  assert(String(next.STATUS) === 'SCHEDULED', 'Next cycle status is ' + next.STATUS);
  var c = getCfg();
  var expDue = shiftToWorkingDay(addDaysAtTime(new Date(c1.DUE), 7, '17:00'), '17:00', c);
  assert(dayKey(next.DUE) === dayKey(expDue), 'Next due ' + fmtD(new Date(next.DUE)) + ' != ' + fmtD(expDue));
  return 'closed ' + c1.ID + ' -> next due ' + fmtDT(new Date(next.DUE));
}

function testBody2() {
  var cyc = findLiveCycle('TT-P');
  assert(cyc, 'No live TT-P cycle');
  applyCompletion(cyc.ID, 'DEF-45678', { actor: 'Employee C', source: 'TAB' });
  var after = findCycle(cyc.ID);
  assert(String(after.PROOF) === 'DEF-45678', 'Proof not saved');
  assert(String(after.CBY) === 'Employee C', 'Completed By not saved');
  assert(after.CAT, 'Completed At not stamped');
  assert(String(after.SRC) === 'TAB', 'Entry Source not TAB');
  return 'ledger: proof/CBY/CAT/source all written for ' + cyc.ID;
}

function testBody3() {
  var cyc = findLiveCycle('TT-D');
  assert(cyc, 'No live TT-D cycle');
  var rejected = false;
  try { applyCompletion(cyc.ID, 'OPS-0000-00', { actor: 'Employee A', source: 'TAB' }); }
  catch (e) { rejected = true; }
  assert(rejected, 'Wrong code was NOT rejected');
  var good = getDailyCode('TT-D', getNow());
  var r = applyCompletion(cyc.ID, good, { actor: 'Employee A', source: 'TAB' });
  assert(String(r.status).indexOf('COMPLETED') === 0, 'Valid code did not complete');
  return 'rejected fake code; accepted ' + good + ' -> ' + r.status;
}

function testBody4() {
  setSimNextDay('11:31'); // TT-D next cycle due 11:00 the next working day
  tick('TEST-T4');
  var key = findLiveCycle('TT-D').ID + '|L1';
  tick('TEST-T4b'); // run again — must not duplicate
  var n = countOutbox(key);
  assert(n === 1, 'Expected exactly 1 L1 outbox row, found ' + n);
  return 'outbox rows for ' + key + ' = 1 after two ticks (dry-run SENT-DRY)';
}

function testBody5() {
  var cyc = findLiveCycle('TT-D');
  markManagerAck(cyc.ID, 'Manager (test)');
  var after = findCycle(cyc.ID);
  assert(after.ACKAT, 'Ack not stamped on cycle');
  var code = getDailyCode('TT-D', getNow());
  applyCompletion(cyc.ID, code, { actor: 'Employee A', source: 'TAB' });
  var done = findCycle(cyc.ID);
  assert(String(done.STATUS).indexOf('COMPLETED') === 0, 'Cycle not completed after ack');
  return 'ack at ' + fmtDT(new Date(after.ACKAT)) + '; cycle later ' + done.STATUS;
}

function testBody7() {
  tick('TEST-T7-spawn'); // ensure TT-D next cycle exists
  var cyc = findLiveCycle('TT-D');
  assert(cyc, 'No live TT-D cycle for walk');
  var id = cyc.ID;
  setSimDayAfter(getNow(), 1, '10:31'); // due-day minus 30 min
  tick('TEST-T7a');
  assert(countOutbox(id + '|REM') === 1, 'Reminder not queued once');
  setSimDayAfter(new Date(getCfg().SIMNOW), 0, '11:31');
  tick('TEST-T7b');
  assert(countOutbox(id + '|L1') === 1, 'L1 not queued once');
  setSimDayAfter(new Date(getCfg().SIMNOW), 0, '13:01');
  tick('TEST-T7c');
  assert(countOutbox(id + '|L2') === 1, 'L2b (no ack) not queued once');
  assert(countOutbox(id + '|L1') === 1 && countOutbox(id + '|REM') === 1, 'Duplicates in earlier stages');
  return id + ': REM/L1/L2 exactly once each';
}

/** v1.5 regression (D1/D2): jump PAST BOTH deadlines (ack-by AND
 *  resolve-by) in ONE step, then tick ONCE. The old code queued two
 *  L2 mails here (L2b + L2a branches both passed in the same pass);
 *  the single adjudication must queue exactly one, with the
 *  resolve-by reason taking priority. */
function testBody6() {
  pauseTask('TT-D'); pauseTask('TT-W'); // isolate TT-P
  var cyc = findLiveCycle('TT-P');
  assert(cyc, 'No live TT-P cycle');
  var id = cyc.ID;
  setSimAtDue(cyc, '17:31');
  tick('TEST-T6a'); // L1 same day
  assert(countOutbox(id + '|L1') === 1, 'L1 missing for TT-P');
  var resDt = new Date(findCycle(id).RES); // resolve-by = next WORKING day 17:00
  setSimDay(new Date(resDt.getTime() + 60000), '17:01'); // past ack-by AND resolve-by
  tick('TEST-T6b');
  assert(countOutbox(id + '|L2') === 1, 'L2 escalation not exactly once (double-fire?)');
  assert(readAlerts().filter(function (a) { return a.CYCLE === id && a.LEVEL === 'L2'; }).length === 1,
    'Alert_Log L2 row count = ' + readAlerts().filter(function (a) { return a.CYCLE === id && a.LEVEL === 'L2'; }).length);
  tick('TEST-T6c'); // one more tick for the replay check
  assert(countOutbox(id + '|L2') === 1, 'L2 duplicated on replay tick (outbox)');
  assert(readAlerts().filter(function (a) { return a.CYCLE === id && a.LEVEL === 'L2'; }).length === 1,
    'L2 duplicated on replay tick (Alert_Log)');
  return id + ': past both deadlines -> exactly 1 L2 (reason: resolve-by deadline)';
}

function testBody8() {
  var snap = countsSnapshot();
  tick('TEST-T8a'); tick('TEST-T8b'); tick('TEST-T8c');
  var after = countsSnapshot();
  assert(snap.cycles === after.cycles && snap.outbox === after.outbox && snap.alerts === after.alerts,
    'Rows changed: cycles ' + snap.cycles + '->' + after.cycles + ', outbox ' + snap.outbox + '->' + after.outbox +
    ', alerts ' + snap.alerts + '->' + after.alerts);
  var live = findLiveCycle('TT-P');
  assert(live, 'No live TT-P cycle for replay probe');
  var dup = false;
  try { applyCompletion(live.ID, 'AAA-111', { actor: 'X', source: 'TAB' }); } catch (e) { dup = true; }
  assert(dup, 'Reused Ticket ID was NOT rejected');
  var closedCyc = null;
  readCycles().forEach(function (cy) {
    if (cy.TASKID === 'TT-W' && TERMINAL_STATUSES.indexOf(String(cy.STATUS)) >= 0 && !closedCyc) closedCyc = cy;
  });
  assert(closedCyc, 'No closed TT-W cycle to probe');
  var closed = false;
  try { applyCompletion(closedCyc.ID, 'ZZZ-999', { actor: 'X', source: 'TAB' }); } catch (e) { closed = true; }
  assert(closed, 'Edit on closed cycle was NOT rejected');
  return '3 ticks: 0 new cycles/emails; reused ticket + closed-cycle edits rejected';
}

var TEST_FNS = {
  1: testBody1, 2: testBody2, 3: testBody3, 4: testBody4,
  5: testBody5, 6: testBody6, 7: testBody7, 8: testBody8
};

/* ---------- harness helpers ---------- */
function t(id, scen, fn) {
  var t0 = Date.now(), ev = '';
  try {
    ev = String(fn());
    ev += '  [' + ((Date.now() - t0) / 1000).toFixed(1) + 's]';
    _TEST_RESULTS.push({ id: 'T' + id, scen: scen, expected: 'per scenario', actual: 'PASS', pass: true, evidence: ev });
  } catch (err) {
    ev += '  [failed after ' + ((Date.now() - t0) / 1000).toFixed(1) + 's]';
    _TEST_RESULTS.push({ id: 'T' + id, scen: scen, expected: 'per scenario', actual: 'FAIL: ' + (err && err.message ? err.message : err), pass: false, evidence: ev });
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function countOutbox(keyPrefix) {
  return readOutbox().filter(function (o) { return String(o.KEY) === keyPrefix; }).length;
}

function countsSnapshot() {
  return {
    cycles: readRaw(SHEET.CYCLES).filter(function (r) { return r[0]; }).length,
    outbox: readRaw(SHEET.OUTBOX).filter(function (r) { return r[0]; }).length,
    alerts: readRaw(SHEET.ALERTS).filter(function (r) { return r[0]; }).length
  };
}

function findLiveCycle(taskId) {
  var all = readCycles().filter(function (cy) {
    return cy.TASKID === taskId && LIVE_STATUSES.indexOf(String(cy.STATUS)) >= 0;
  });
  all.sort(function (a, b) { return new Date(a.DUE) - new Date(b.DUE); });
  return all.length ? all[all.length - 1] : null;
}

function insertTestTasks() {
  var sh = sheet(SHEET.TASKS);
  var today = startOfDay(getNow());
  sh.getRange(sh.getLastRow() + 1, 1, 3, TASK_COLS.NOTES).setValues([
    ['TT-D', 'TEST Daily Ops', 'Emp_A', 'Employee A', 'employee.a@example.com', 'DAILY_CHECK', 1, 'FIXED', today, '', 'DAILY', 'YES', '', '', 'test task'],
    ['TT-W', 'TEST Weekly Portal', 'Emp_B', 'Employee B', 'employee.b@example.com', 'TICKET', 7, 'FIXED', today, '^[A-Z]{2,5}-\\d{3,6}$', 'PERIODIC', 'YES', '', '', 'test task'],
    ['TT-P', 'TEST 15-day Portal', 'Emp_C', 'Employee C', 'employee.c@example.com', 'TICKET', 15, 'FIXED', today, '^[A-Z]{2,5}-\\d{3,6}$', 'PERIODIC', 'YES', '', '', 'test task']
  ]);
  _taskDirty(); // Task_Master changed on disk
}

function pauseTask(taskId) {
  var far = new Date(getNow().getTime() + 60 * 86400000);
  var sh = sheet(SHEET.TASKS);
  var vals = readRaw(SHEET.TASKS);
  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][0]) === taskId) sh.getRange(r + 1, TASK_COLS.PAUSED).setValue(far);
  }
  _taskDirty(); // Task_Master changed on disk
}

function setSim(str) { setConfig('SIMNOW', str); getCfg(true); }
function setSimNextDay(hm) {
  var d = new Date(getNow().getTime() + 24 * 3600000);
  setSim(Utilities.formatDate(d, APP_TZ, 'yyyy-MM-dd') + ' ' + hm);
}
function setSimDay(d, hm) { setSim(Utilities.formatDate(d, APP_TZ, 'yyyy-MM-dd') + ' ' + hm); }
function setSimDayAfter(d, days, hm) {
  var n = new Date(d.getTime() + days * 86400000);
  setSim(Utilities.formatDate(n, APP_TZ, 'yyyy-MM-dd') + ' ' + hm);
}
function setSimAtDue(cyc, hm) { setSimDay(new Date(cyc.DUE), hm); }

function writeTestResults() {
  var s = ss();
  var sh = s.getSheetByName(SHEET.TESTS);
  if (!sh) {
    sh = s.insertSheet(SHEET.TESTS);
    sh.getRange(1, 1, 1, 8).setValues([['ID', 'Scenario', 'Setup', 'Expected', 'Actual', 'Result', 'Evidence', 'Run At']])
      .setFontWeight('bold').setFontColor('#ffffff').setBackground('#1f4e79');
    sh.setFrozenRows(1);
  }
  var now = getNow();
  var rows = _TEST_RESULTS.map(function (r) {
    return [r.id, r.scen, 'runAllTests() harness', r.expected, r.actual, r.pass ? 'PASS' : 'FAIL', r.evidence, now];
  });
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, 8).setValues(rows); // ONE write
}

/** Remove every TT-* artifact and clear test rows from employee tabs.
 *  TT- rows are appended contiguously, so each sheet needs at most
 *  a couple of batched deleteRows/clearContent calls. */
function cleanupTestArtifacts() {
  cacheClear(); // row indexes shift below
  wipeByPrefix(SHEET.TASKS, 1, 'TT-');
  wipeByPrefix(SHEET.CYCLES, 1, 'TT-');
  wipeByPrefix(SHEET.ALERTS, 3, 'TT-');      // CycleID col
  wipeByPrefix(SHEET.OUTBOX, 1, 'TT-');
  [EMP_PREFIX + 'A', EMP_PREFIX + 'B', EMP_PREFIX + 'C', EMP_PREFIX + 'D'].forEach(function (tab) {
    clearByPrefix(tab, 1, 'TT-', EMP_COLS.CAT);
  });
}

/** Delete every row whose `col` value starts with prefix, in contiguous
 *  blocks (1 read + 1 deleteRows per block, bottom-up). */
function wipeByPrefix(sheetName, col, prefix) {
  var sh = sheet(sheetName);
  var last = sh.getLastRow();
  if (last < 2) return;
  var vals = sh.getRange(2, 1, last - 1, Math.max(col, 1)).getValues();
  var runs = [], start = -1;
  for (var r = 0; r < vals.length; r++) {
    var hit = String(vals[r][col - 1] || '').indexOf(prefix) === 0;
    if (hit && start < 0) start = r;
    if (!hit && start >= 0) { runs.push([start + 2, r - start]); start = -1; }
  }
  if (start >= 0) runs.push([start + 2, vals.length - start]);
  for (var i = runs.length - 1; i >= 0; i--) sh.deleteRows(runs[i][0], runs[i][1]);
}

/** Clear (not delete) every row whose `col` value starts with prefix. */
function clearByPrefix(tabName, col, prefix, width) {
  var sh = ss().getSheetByName(tabName);
  if (!sh) return;
  var last = sh.getLastRow();
  if (last < 2) return;
  var vals = sh.getRange(2, 1, last - 1, col).getValues();
  var runs = [], start = -1;
  for (var r = 0; r < vals.length; r++) {
    var hit = String(vals[r][col - 1] || '').indexOf(prefix) === 0;
    if (hit && start < 0) start = r;
    if (!hit && start >= 0) { runs.push([start + 2, r - start]); start = -1; }
  }
  if (start >= 0) runs.push([start + 2, vals.length - start]);
  runs.forEach(function (run) { sh.getRange(run[0], 1, run[1], width).clearContent(); });
}

/** ============================================================
 * 10_webapp.gs — OPTIONAL one-click signed links (Test 5 helper).
 * Deploy as Web App (see README §7) and paste the URL into
 * Config → WEBAPP_BASE_URL. Links are HMAC-signed, expiring
 * (24 h) and single-use. Without deployment, the system works
 * normally — the manager acks in Alert_Log instead.
 * ============================================================ */

function buildSignedLink(action, cycleId) {
  var c = getCfg();
  if (!c.WEBAPP_BASE_URL) return '';
  var exp = Date.now() + 24 * 3600000;
  var sig = hmacToken(action + '|' + cycleId + '|' + exp);
  return c.WEBAPP_BASE_URL + '?action=' + encodeURIComponent(action) +
    '&cycle=' + encodeURIComponent(cycleId) +
    '&token=' + encodeURIComponent(exp + '.' + sig);
}

function hmacToken(s) {
  var secret = getProp('HMAC_SECRET') || 'dev-secret';
  var raw = Utilities.computeHmacSha256Signature(s, secret);
  return raw.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

function verifyToken(action, cycleId, token) {
  if (!token || token.indexOf('.') < 0) return 'invalid token';
  var parts = token.split('.');
  var exp = +parts[0], sig = parts[1];
  if (!exp || exp < Date.now()) return 'link expired';
  var expected = hmacToken(action + '|' + cycleId + '|' + exp);
  if (expected !== sig) return 'bad signature';
  var usedKey = 'USED_' + Utilities.base64EncodeWebSafe(token);
  if (getProp(usedKey)) return 'link already used';
  setProp(usedKey, '1');
  return '';
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  var page = function (title, msg, ok) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:Arial;max-width:480px;margin:60px auto;text-align:center">' +
      '<h2 style="color:' + (ok ? '#38761d' : '#cc0000') + '">' + title + '</h2><p>' + msg + '</p></div>');
  };
  try {
    if (!p.action || !p.cycle) return page('Bad request', 'Missing parameters.', false);
    var err = verifyToken(p.action, p.cycle, p.token);
    if (err) return page('Link rejected', err, false);

    if (p.action === 'ack') {
      markManagerAck(p.cycle, 'Manager (email link)');
      return page('Acknowledged \u2714', 'Cycle ' + p.cycle + ' is marked as reviewed by the manager. ' +
        'Now open the sheet \u2192 Alert_Log and set a Manager Action (Following up / Reassigned / Extend / Waive).', true);
    }
    if (p.action === 'done') {
      var cyc = findCycle(p.cycle);
      if (!cyc) return page('Not found', 'Unknown cycle ' + p.cycle, false);
      var t = taskById(cyc.TASKID);
      if (!t || t.type !== 'DAILY_CHECK') return page('Not allowed', 'Done links apply to daily tasks only.', false);
      var r = applyCompletion(p.cycle, p.code || '', { actor: cyc.EMP + ' (email link)', source: 'LINK' });
      return page('Marked done \u2714', 'Cycle ' + p.cycle + ' completed (' + r.status + ').', true);
    }
    return page('Unknown action', p.action, false);
  } catch (err) {
    return page('Error', String(err && err.message ? err.message : err), false);
  }
}