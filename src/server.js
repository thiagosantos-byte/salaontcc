const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { db, initDb, closeDb, usingPostgres } = require("./db");
const {
  loadEnv
} = require("./config");
const {
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  clearSession,
  requireRole,
  SESSION_MS
} = require("./auth");
loadEnv();
const PORT = Number(process.env.PORT || 3000);
const ROOT = path.resolve(process.cwd(), "public");
const loginFailures = new Map();
const OWNER = ["owner"];
const FINANCE_WRITE = ["owner", "reception"];
const DAY = 86400000;
function json(res, status, data, headers) {
  res.writeHead(status, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  }, headers || {}));
  res.end(JSON.stringify(data));
}
function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  throw e;
}
async function audit(session, action, entity, id, details) {
  await db.prepare("INSERT INTO audit_logs(salon_id,user_id,action,entity,entity_id,details) VALUES(?,?,?,?,?,?)").run(session.salon_id, session.id, action, entity, id || null, JSON.stringify(details || {}));
}
async function body(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1048576) fail(413, "O envio excedeu o limite de 1 MB.");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    fail(400, "Os dados enviados não estão em JSON válido.");
  }
}
function requiredText(value, label, max) {
  const s = String(value == null ? "" : value).trim();
  if (!s || s.length > (max || 160)) fail(400, label + " é obrigatório e deve ter até " + (max || 160) + " caracteres.");
  return s;
}
function optionalText(value, max) {
  const s = String(value == null ? "" : value).trim();
  if (s.length > (max || 1000)) fail(400, "Um dos campos de texto excede o limite permitido.");
  return s;
}
function integer(value, label, min, max) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) fail(400, label + " inválido.");
  return n;
}
function moneyCents(value) {
  if (Number.isSafeInteger(value)) return integer(value, "Valor", 1, 100000000000);
  const s = String(value == null ? "" : value).trim().replace(/^R\$\s*/i, "").replace(/\s/g, "");
  if (!/^\d{1,9}([,.]\d{1,2})?$/.test(s)) fail(400, "Informe um valor em reais com até duas casas decimais.");
  const parts = s.replace(",", ".").split(".");
  return integer(Number(parts[0]) * 100 + Number((parts[1] || "").padEnd(2, "0")), "Valor", 1, 100000000000);
}
function dateText(value, label, allowBlank) {
  if (!value && allowBlank) return null;
  const s = requiredText(value, label, 30).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + "T12:00:00Z"))) fail(400, label + " deve usar o formato AAAA-MM-DD.");
  return s;
}
async function ensureRow(sql, args, message) {
  const row = await db.prepare(sql).get(...args);
  if (!row) fail(400, message);
  return row;
}
async function tenantRow(table, id, salonId) {
  const allowed = ["clients", "professionals", "services", "categories", "payment_methods", "appointments", "financial_transactions", "commissions", "users"];
  if (!allowed.includes(table)) fail(500, "Recurso inválido.");
  return await ensureRow("SELECT * FROM " + table + " WHERE id=? AND salon_id=?", [id, salonId], "O registro selecionado não existe ou pertence a outro salão.");
}
function localDate(offset) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Bahia",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const get = k => parts.find(p => p.type === k).value;
  return new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")) + (offset || 0))).toISOString().slice(0, 10);
}
function monthBounds(month) {
  const m = /^\d{4}-\d{2}$/.test(month || "") ? month : localDate().slice(0, 7);
  const start = m + "-01";
  const next = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1)).toISOString().slice(0, 10);
  const end = new Date(Date.parse(next + "T00:00:00Z") - DAY).toISOString().slice(0, 10);
  return {
    month: m,
    start,
    end,
    next
  };
}
function priorMonth(month) {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1));
  return monthBounds(d.toISOString().slice(0, 7));
}
async function financialSummary(salonId, start, end) {
  const r = await db.prepare("SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount_cents ELSE 0 END),0) AS income,COALESCE(SUM(CASE WHEN type='expense' THEN amount_cents ELSE 0 END),0) AS expense,COUNT(*) AS n FROM financial_transactions WHERE salon_id=? AND status='paid' AND paid_date>=? AND paid_date<=?").get(salonId, start, end);
  return {
    income: r.income,
    expense: r.expense,
    net: r.income - r.expense,
    count: r.n
  };
}
async function dashboard(salonId, month) {
  const r = monthBounds(month),
    p = priorMonth(r.month),
    current = await financialSummary(salonId, r.start, r.end),
    previous = await financialSummary(salonId, p.start, p.end),
    todayDate = localDate();
  const balance = (await db.prepare("SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount_cents ELSE -amount_cents END),0) AS cents FROM financial_transactions WHERE salon_id=? AND status='paid'").get(salonId)).cents;
  const receivable = await db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS cents,COUNT(*) AS n FROM financial_transactions WHERE salon_id=? AND type='income' AND status='pending'").get(salonId);
  const payable = await db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS cents,COUNT(*) AS n FROM financial_transactions WHERE salon_id=? AND type='expense' AND status='pending'").get(salonId);
  const overdue = await db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS cents,COUNT(*) AS n FROM financial_transactions WHERE salon_id=? AND status='pending' AND due_date<?").get(salonId, todayDate);
  const overdueItems = await db.prepare("SELECT id,type,description,amount_cents,due_date FROM financial_transactions WHERE salon_id=? AND status='pending' AND due_date<? ORDER BY due_date,id LIMIT 4").all(salonId, todayDate);
  const commission = await db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS cents,COUNT(*) AS n FROM commissions WHERE salon_id=? AND status='pending'").get(salonId);
  const daily = await db.prepare("SELECT paid_date AS day,SUM(CASE WHEN type='income' THEN amount_cents ELSE -amount_cents END) AS net,SUM(CASE WHEN type='income' THEN amount_cents ELSE 0 END) AS income,SUM(CASE WHEN type='expense' THEN amount_cents ELSE 0 END) AS expense FROM financial_transactions WHERE salon_id=? AND status='paid' AND paid_date>=? AND paid_date<=? GROUP BY paid_date ORDER BY paid_date").all(salonId, r.start, r.end);
  const upcomingSummary = await db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS cents,COUNT(*) AS n FROM financial_transactions WHERE salon_id=? AND status='pending' AND due_date>=?").get(salonId, todayDate);
  const upcoming = await db.prepare("SELECT id,type,description,amount_cents,due_date,status FROM financial_transactions WHERE salon_id=? AND status='pending' AND due_date>=? ORDER BY due_date,id LIMIT 5").all(salonId, todayDate);
  const appointments = await db.prepare("SELECT a.id,a.starts_at,a.status,a.payment_status,a.total_cents,c.name AS client_name,p.name AS professional_name FROM appointments a LEFT JOIN clients c ON c.id=a.client_id AND c.salon_id=a.salon_id LEFT JOIN professionals p ON p.id=a.professional_id AND p.salon_id=a.salon_id WHERE a.salon_id=? AND a.starts_at>=? AND a.starts_at<? AND a.status IN ('scheduled','confirmed') ORDER BY a.starts_at LIMIT 6").all(salonId, todayDate + "T00:00:00", localDate(8) + "T00:00:00");
  const activity = {
    appointmentsToday: (await db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE salon_id=? AND starts_at>=? AND starts_at<? AND status NOT IN ('cancelled','no_show','blocked')").get(salonId, todayDate + "T00:00:00", localDate(1) + "T00:00:00")).n,
    completedToday: (await db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE salon_id=? AND starts_at>=? AND starts_at<? AND status='completed'").get(salonId, todayDate + "T00:00:00", localDate(1) + "T00:00:00")).n,
    completedMonth: (await db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE salon_id=? AND status='completed' AND substr(starts_at,1,10)>=? AND substr(starts_at,1,10)<=?").get(salonId, r.start, r.end)).n,
    clientsActive: (await db.prepare("SELECT COUNT(*) AS n FROM clients WHERE salon_id=? AND active=1").get(salonId)).n,
    topProfessional: (await db.prepare("SELECT p.name,COUNT(*) AS appointments,COALESCE(SUM(a.total_cents),0) AS revenue FROM appointments a JOIN professionals p ON p.id=a.professional_id AND p.salon_id=a.salon_id WHERE a.salon_id=? AND a.status='completed' AND substr(a.starts_at,1,10)>=? AND substr(a.starts_at,1,10)<=? GROUP BY p.id ORDER BY appointments DESC,revenue DESC,p.name LIMIT 1").get(salonId, r.start, r.end)) || null
  };
  return {
    month: r.month,
    period: {
      start: r.start,
      end: r.end
    },
    asOf: todayDate,
    current,
    previous,
    previousTotals: previous,
    balance,
    receivable,
    payable,
    overdue,
    overdueItems,
    commission: commission.cents,
    commissionCount: commission.n,
    daily,
    upcomingSummary,
    upcoming,
    appointments,
    activity,
    hasPrevious: previous.count > 0
  };
}
async function transactions(session, url) {
  const from = url.searchParams.get("from") || "0000-01-01",
    to = url.searchParams.get("to") || "9999-12-31",
    query = "%" + (url.searchParams.get("q") || "").slice(0, 80) + "%",
    status = url.searchParams.get("status");
  let sql = "SELECT t.*,c.name AS category_name,p.name AS payment_method FROM financial_transactions t LEFT JOIN categories c ON c.id=t.category_id AND c.salon_id=t.salon_id LEFT JOIN payment_methods p ON p.id=t.payment_method_id AND p.salon_id=t.salon_id WHERE t.salon_id=? AND COALESCE(CASE WHEN t.status='paid' THEN t.paid_date ELSE t.due_date END,t.created_at)>=? AND COALESCE(CASE WHEN t.status='paid' THEN t.paid_date ELSE t.due_date END,t.created_at)<=? AND t.description LIKE ?";
  const args = [session.salon_id, from, to, query];
  if (["paid", "pending", "void"].includes(status)) {
    sql += " AND t.status=?";
    args.push(status);
  }
  sql += " ORDER BY COALESCE(CASE WHEN t.status='paid' THEN t.paid_date ELSE t.due_date END,t.created_at) DESC,t.id DESC LIMIT 500";
  return await db.prepare(sql).all(...args);
}
async function appointments(session, url) {
  const from = url.searchParams.get("from") || localDate(-31),
    to = url.searchParams.get("to") || localDate(62),
    query = "%" + (url.searchParams.get("q") || "").slice(0, 80) + "%";
  let sql = "SELECT a.*,c.name AS client_name,c.phone AS client_phone,p.name AS professional_name,GROUP_CONCAT(ai.service_name, ', ') AS service_names FROM appointments a LEFT JOIN clients c ON c.id=a.client_id AND c.salon_id=a.salon_id LEFT JOIN professionals p ON p.id=a.professional_id AND p.salon_id=a.salon_id LEFT JOIN appointment_items ai ON ai.appointment_id=a.id AND ai.salon_id=a.salon_id WHERE a.salon_id=? AND substr(a.starts_at,1,10)>=? AND substr(a.starts_at,1,10)<=? AND (COALESCE(c.name,'') LIKE ? OR COALESCE(p.name,'') LIKE ? OR COALESCE(a.notes,'') LIKE ?)";
  const args = [session.salon_id, from, to, query, query, query];
  if (session.role === "professional") {
    sql += " AND a.professional_id=?";
    args.push(session.professional_id || -1);
  }
  sql += " GROUP BY a.id,c.name,c.phone,p.name ORDER BY a.starts_at LIMIT 500";
  const rows = await db.prepare(sql).all(...args);
  if (session.role === "professional") return rows.map(({
    client_phone,
    total_cents,
    payment_status,
    notes,
    client_id,
    ...safe
  }) => safe);
  return rows;
}
async function professionalServiceIds(salonId, professionalId) {
  return (await db.prepare("SELECT service_id FROM professional_services WHERE salon_id=? AND professional_id=? AND active=1 ORDER BY service_id").all(salonId, professionalId)).map(x => x.service_id);
}
async function getList(resource, session, url) {
  const sid = session.salon_id;
  if (resource === "transactions") {
    requireRole(session, OWNER);
    return await transactions(session, url);
  }
  if (resource === "appointments") return await appointments(session, url);
  if (resource === "clients") {
    requireRole(session, ["owner", "reception"]);
    const q = "%" + (url.searchParams.get("q") || "").slice(0, 80) + "%";
    return await db.prepare("SELECT c.id,c.name,c.phone,c.email,c.notes,c.consent_contact,c.consent_at,c.active,c.created_at,(SELECT MAX(substr(a.starts_at,1,10)) FROM appointments a WHERE a.salon_id=c.salon_id AND a.client_id=c.id AND a.status='completed') AS last_visit,(SELECT ai.service_name FROM appointment_items ai JOIN appointments a ON a.id=ai.appointment_id AND a.salon_id=ai.salon_id WHERE a.salon_id=c.salon_id AND a.client_id=c.id AND a.status='completed' GROUP BY ai.service_name ORDER BY COUNT(*) DESC,SUM(ai.price_cents) DESC,ai.service_name LIMIT 1) AS frequent_service,(SELECT COUNT(*) FROM appointments a WHERE a.salon_id=c.salon_id AND a.client_id=c.id AND a.status='completed') AS completed_visits FROM clients c WHERE c.salon_id=? AND (c.name LIKE ? OR c.phone LIKE ? OR COALESCE(c.email,'') LIKE ?) ORDER BY c.name LIMIT 500").all(sid, q, q, q);
  }
  if (resource === "professionals") {
    let rows;
    if (session.role === "professional") rows = await db.prepare("SELECT id,name,active FROM professionals WHERE salon_id=? AND id=?").all(sid, session.professional_id || -1);else {
      requireRole(session, ["owner", "reception"]);
      rows = session.role === "reception" ? await db.prepare("SELECT id,name,email,phone,active FROM professionals WHERE salon_id=? ORDER BY name").all(sid) : await db.prepare("SELECT id,name,email,phone,active,default_commission_bps FROM professionals WHERE salon_id=? ORDER BY name").all(sid);
    }
    return await Promise.all(rows.map(async p => Object.assign({}, p, {
      service_ids: await professionalServiceIds(sid, p.id)
    })));
  }
  if (resource === "services") {
    if (session.role === "professional") return await db.prepare("SELECT s.id,s.name,s.category,s.duration_minutes,s.price_cents,s.active FROM services s JOIN professional_services ps ON ps.service_id=s.id AND ps.salon_id=s.salon_id WHERE s.salon_id=? AND ps.professional_id=? AND ps.active=1 AND s.active=1 ORDER BY s.name").all(sid, session.professional_id || -1);
    if (session.role === "reception") return await db.prepare("SELECT id,name,category,duration_minutes,price_cents,active FROM services WHERE salon_id=? AND active=1 ORDER BY name").all(sid);
    return await db.prepare("SELECT id,name,category,duration_minutes,price_cents,commission_bps,active FROM services WHERE salon_id=? ORDER BY name").all(sid);
  }
  if (resource === "categories") {
    requireRole(session, OWNER);
    return await db.prepare("SELECT id,name,type,active FROM categories WHERE salon_id=? ORDER BY name").all(sid);
  }
  if (resource === "payment-methods") {
    requireRole(session, FINANCE_WRITE);
    return await db.prepare("SELECT id,name,active FROM payment_methods WHERE salon_id=? ORDER BY name").all(sid);
  }
  if (resource === "my-commissions") {
    requireRole(session, ["professional"]);
    const range = monthBounds(url.searchParams.get("month"));
    return await db.prepare("SELECT cm.id,cm.appointment_id,cm.amount_cents,cm.status,a.starts_at,GROUP_CONCAT(ai.service_name, ', ') AS service_names FROM commissions cm JOIN appointments a ON a.id=cm.appointment_id AND a.salon_id=cm.salon_id LEFT JOIN appointment_items ai ON ai.appointment_id=a.id AND ai.salon_id=a.salon_id WHERE cm.salon_id=? AND cm.professional_id=? AND substr(a.starts_at,1,10)>=? AND substr(a.starts_at,1,10)<=? GROUP BY cm.id,a.starts_at ORDER BY a.starts_at DESC LIMIT 100").all(sid, session.professional_id || -1, range.start, range.end);
  }
  if (resource === "commissions") {
    requireRole(session, OWNER);
    return await db.prepare("SELECT cm.id,cm.appointment_id,cm.professional_id,cm.amount_cents,cm.status,cm.created_at,p.name AS professional_name,a.starts_at FROM commissions cm JOIN professionals p ON p.id=cm.professional_id AND p.salon_id=cm.salon_id JOIN appointments a ON a.id=cm.appointment_id AND a.salon_id=cm.salon_id WHERE cm.salon_id=? ORDER BY cm.status,a.starts_at DESC LIMIT 500").all(sid);
  }
  if (resource === "users") {
    requireRole(session, OWNER);
    return await db.prepare("SELECT id,email,name,role,professional_id,active,must_change_password,created_at FROM users WHERE salon_id=? ORDER BY name").all(sid);
  }
  if (resource === "cash") {
    requireRole(session, OWNER);
    return {
      open: await db.prepare("SELECT * FROM cash_sessions WHERE salon_id=? AND closed_at IS NULL ORDER BY id DESC LIMIT 1").get(sid),
      history: await db.prepare("SELECT * FROM cash_sessions WHERE salon_id=? ORDER BY id DESC LIMIT 20").all(sid)
    };
  }
  if (resource === "settings") {
    requireRole(session, OWNER);
    return {
      salon: await db.prepare("SELECT id,name,timezone,currency,opening_hours FROM salons WHERE id=?").get(sid),
      paymentMethods: await db.prepare("SELECT id,name,active FROM payment_methods WHERE salon_id=? ORDER BY name").all(sid),
      categories: await db.prepare("SELECT id,name,type,active FROM categories WHERE salon_id=? ORDER BY name").all(sid),
      aiMode: process.env.AI_API_KEY && process.env.AI_BASE_URL && process.env.AI_MODEL ? "provedor configurado" : "análise local"
    };
  }
  fail(404, "Esta área não existe.");
}
async function saveClient(session, data, id) {
  requireRole(session, ["owner", "reception"]);
  const name = requiredText(data.name, "Nome", 120),
    phone = optionalText(data.phone, 40),
    email = optionalText(data.email, 160),
    notes = optionalText(data.notes, 1000),
    consent = data.consent_contact ? 1 : 0;
  const old = id ? await tenantRow("clients", id, session.salon_id) : null;
  const at = consent ? old && old.consent_contact ? old.consent_at : new Date().toISOString() : null;
  if (old) {
    await db.prepare("UPDATE clients SET name=?,phone=?,email=?,notes=?,consent_contact=?,consent_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND salon_id=?").run(name, phone || null, email || null, notes, consent, at, id, session.salon_id);
    await audit(session, "updated", "client", id, {
      fields: ["name", "phone", "email", "notes", "consent_contact"]
    });
    return {
      id
    };
  }
  const out = await db.prepare("INSERT INTO clients(salon_id,name,phone,email,notes,consent_contact,consent_at) VALUES(?,?,?,?,?,?,?)").run(session.salon_id, name, phone || null, email || null, notes, consent, at);
  const newId = Number(out.lastInsertRowid);
  await audit(session, "created", "client", newId, {
    consent_contact: consent
  });
  return {
    id: newId
  };
}
async function saveProfessional(session, data, id) {
  requireRole(session, OWNER);
  const name = requiredText(data.name, "Nome", 120),
    email = optionalText(data.email, 160),
    phone = optionalText(data.phone, 40),
    bps = integer(data.default_commission_bps || 0, "Comissão", 0, 10000);
  const requested = Array.isArray(data.service_ids) ? Array.from(new Set(data.service_ids.map(v => integer(v, "Serviço", 1, 2147483647)))) : null;
  if (requested) for (const serviceId of requested) {
    const service = await tenantRow("services", serviceId, session.salon_id);
    if (!service.active) fail(400, "Ative o serviço antes de habilitá-lo para a equipe.");
  }
  const existing = id ? await tenantRow("professionals", id, session.salon_id) : null;
  await db.exec("BEGIN IMMEDIATE");
  try {
    let profId = id;
    if (existing) await db.prepare("UPDATE professionals SET name=?,email=?,phone=?,default_commission_bps=?,active=? WHERE id=? AND salon_id=?").run(name, email || null, phone || null, bps, data.active === false ? 0 : 1, id, session.salon_id);else {
      const out = await db.prepare("INSERT INTO professionals(salon_id,name,email,phone,default_commission_bps) VALUES(?,?,?,?,?)").run(session.salon_id, name, email || null, phone || null, bps);
      profId = Number(out.lastInsertRowid);
    }
    if (requested || !existing) {
      await db.prepare("DELETE FROM professional_services WHERE salon_id=? AND professional_id=?").run(session.salon_id, profId);
      const ids = requested || (await db.prepare("SELECT id FROM services WHERE salon_id=? AND active=1").all(session.salon_id)).map(x => x.id);
      const link = db.prepare("INSERT INTO professional_services(salon_id,professional_id,service_id) VALUES(?,?,?)");
      for (const serviceId of ids) await link.run(session.salon_id, profId, serviceId);
    }
    await audit(session, existing ? "updated" : "created", "professional", profId, {
      name,
      service_ids: requested || undefined
    });
    await db.exec("COMMIT");
    return {
      id: profId
    };
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}
async function saveService(session, data, id) {
  requireRole(session, OWNER);
  const name = requiredText(data.name, "Nome do serviço", 120),
    category = requiredText(data.category || "Geral", "Categoria", 80),
    duration = integer(data.duration_minutes, "Duração", 5, 1440),
    price = moneyCents(data.price),
    bps = integer(data.commission_bps || 0, "Comissão", 0, 10000);
  if (id) {
    await tenantRow("services", id, session.salon_id);
    await db.prepare("UPDATE services SET name=?,category=?,duration_minutes=?,price_cents=?,commission_bps=?,active=? WHERE id=? AND salon_id=?").run(name, category, duration, price, bps, data.active === false ? 0 : 1, id, session.salon_id);
    await audit(session, "updated", "service", id, {
      name,
      price_cents: price
    });
    return {
      id
    };
  }
  const out = await db.prepare("INSERT INTO services(salon_id,name,category,duration_minutes,price_cents,commission_bps) VALUES(?,?,?,?,?,?)").run(session.salon_id, name, category, duration, price, bps);
  const newId = Number(out.lastInsertRowid);
  await db.prepare("INSERT INTO professional_services(salon_id,professional_id,service_id) SELECT ?,id,? FROM professionals WHERE salon_id=? AND active=1").run(session.salon_id, newId, session.salon_id);
  await audit(session, "created", "service", newId, {
    name,
    price_cents: price
  });
  return {
    id: newId
  };
}
function recurringDate(start, rule, index) {
  const d = new Date(start + "T12:00:00Z");
  if (rule === "weekly") {
    d.setUTCDate(d.getUTCDate() + 7 * index);
    return d.toISOString().slice(0, 10);
  }
  const months = rule === "monthly" ? index : rule === "quarterly" ? index * 3 : index * 12,
    originalDay = d.getUTCDate(),
    first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1)),
    last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(originalDay, last));
  return first.toISOString().slice(0, 10);
}
async function saveTransaction(session, data, id) {
  requireRole(session, FINANCE_WRITE);
  const type = data.type === "expense" ? "expense" : data.type === "income" ? "income" : fail(400, "Tipo de lançamento inválido.");
  const description = requiredText(data.description, "Descrição", 160),
    amount = moneyCents(data.amount),
    status = ["paid", "pending"].includes(data.status) ? data.status : "pending";
  const due = dateText(data.due_date, "Vencimento", true),
    paid = status === "paid" ? dateText(data.paid_date || localDate(), "Pagamento", false) : null;
  const categoryId = data.category_id ? integer(data.category_id, "Categoria", 1, 2147483647) : null,
    methodId = data.payment_method_id ? integer(data.payment_method_id, "Forma de pagamento", 1, 2147483647) : null;
  if (categoryId) {
    const c = await tenantRow("categories", categoryId, session.salon_id);
    if (c.type !== "both" && c.type !== type) fail(400, "A categoria não corresponde ao tipo do lançamento.");
  }
  if (methodId) await tenantRow("payment_methods", methodId, session.salon_id);
  const recurrence = optionalText(data.recurrence, 60),
    notes = optionalText(data.notes, 1000);
  if (recurrence && !["weekly", "monthly", "quarterly", "yearly"].includes(recurrence)) fail(400, "Regra de recorrência inválida.");
  if (id) {
    const old = await tenantRow("financial_transactions", id, session.salon_id);
    if (old.status === "void") fail(409, "Um lançamento estornado não pode ser editado.");
    if (old.appointment_id) fail(409, "Recebimentos de atendimento são atualizados pela agenda.");
    await db.prepare("UPDATE financial_transactions SET type=?,description=?,amount_cents=?,category_id=?,payment_method_id=?,status=?,due_date=?,paid_date=?,recurrence=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND salon_id=?").run(type, description, amount, categoryId, methodId, status, due, paid, recurrence || null, notes, id, session.salon_id);
    await audit(session, "updated", "transaction", id, {
      type,
      amount_cents: amount,
      status
    });
    return {
      id
    };
  }
  if (recurrence && !due) fail(400, "Informe o vencimento inicial para criar recorrências.");
  await db.exec("BEGIN IMMEDIATE");
  try {
    const insert = db.prepare("INSERT INTO financial_transactions(salon_id,type,description,amount_cents,category_id,payment_method_id,status,due_date,paid_date,recurrence,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
    const first = await insert.run(session.salon_id, type, description, amount, categoryId, methodId, status, due, paid, recurrence || null, notes, session.id),
      newId = Number(first.lastInsertRowid);
    if (recurrence) {
      for (let i = 1; i < 12; i++) await insert.run(session.salon_id, type, description, amount, categoryId, methodId, "pending", recurringDate(due, recurrence, i), null, recurrence, notes, session.id);
    }
    await audit(session, "created", "transaction", newId, {
      type,
      amount_cents: amount,
      status,
      recurrence: recurrence || null,
      occurrences: recurrence ? 12 : 1
    });
    await db.exec("COMMIT");
    return {
      id: newId,
      occurrences: recurrence ? 12 : 1
    };
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}
async function saveAppointment(session, data, id) {
  requireRole(session, ["owner", "reception"]);
  const s = requiredText(data.starts_at, "Data e hora", 40),
    startsAt = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.length === 16 ? s + ":00-03:00" : s + "-03:00";
  if (Number.isNaN(Date.parse(startsAt))) fail(400, "Data e hora inválida.");
  const status = data.status === "blocked" ? "blocked" : data.status === "confirmed" ? "confirmed" : "scheduled",
    profId = data.professional_id ? integer(data.professional_id, "Profissional", 1, 2147483647) : null,
    clientId = data.client_id ? integer(data.client_id, "Cliente", 1, 2147483647) : null;
  if (status === "blocked" && !profId) fail(400, "Selecione a profissional para bloquear o horário.");
  if (status !== "blocked" && !profId) fail(400, "Selecione uma profissional.");
  if (status !== "blocked" && !clientId) fail(400, "Selecione uma cliente.");
  if (profId && !(await tenantRow("professionals", profId, session.salon_id)).active) fail(400, "A profissional está inativa.");
  if (clientId && !(await tenantRow("clients", clientId, session.salon_id)).active) fail(400, "A cliente está inativa.");
  const ids = Array.isArray(data.service_ids) ? data.service_ids.map(v => integer(v, "Serviço", 1, 2147483647)) : [];
  if (status !== "blocked" && !ids.length) fail(400, "Selecione ao menos um serviço.");
  const selected = await Promise.all(ids.map(async x => await tenantRow("services", x, session.salon_id)));
  if (selected.some(x => !x.active)) fail(400, "Um dos serviços selecionados está arquivado.");
  if (status !== "blocked" && profId) {
    const enabled = new Set(await professionalServiceIds(session.salon_id, profId));
    if (selected.some(x => !enabled.has(x.id))) fail(400, "A profissional não está habilitada para um dos serviços selecionados.");
  }
  const duration = status === "blocked" ? integer(data.duration_minutes || 60, "Duração", 5, 1440) : selected.reduce((n, x) => n + x.duration_minutes, 0),
    total = status === "blocked" ? 0 : selected.reduce((n, x) => n + x.price_cents, 0),
    startMs = Date.parse(startsAt),
    endMs = startMs + duration * 60000;
  const salon = await db.prepare("SELECT opening_hours FROM salons WHERE id=?").get(session.salon_id);
  let hours = {};
  try {
    hours = JSON.parse(salon.opening_hours || "{}");
  } catch {}
  const weekday = Intl.DateTimeFormat("en-US", {
      timeZone: "America/Bahia",
      weekday: "short"
    }).format(new Date(startMs)).toLowerCase().slice(0, 3),
    hoursDay = hours[weekday];
  if (hoursDay) {
    if (!hoursDay.enabled) fail(409, "O salão está marcado como fechado neste dia.");
    const clock = stamp => new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Bahia",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(new Date(stamp));
    if (hoursDay.from && clock(startMs) < hoursDay.from || hoursDay.to && clock(endMs) > hoursDay.to) fail(409, "O horário fica fora do período de funcionamento configurado.");
  }
  if (profId) {
    const existing = await db.prepare("SELECT id,starts_at,duration_minutes FROM appointments WHERE salon_id=? AND professional_id=? AND status IN ('scheduled','confirmed','blocked') AND id<>COALESCE(?,0)").all(session.salon_id, profId, id || null);
    if (existing.some(a => {
      const aStart = Date.parse(a.starts_at);
      return startMs < aStart + a.duration_minutes * 60000 && aStart < endMs;
    })) fail(409, "Esse horário conflita com outro compromisso da profissional.");
  }
  if (clientId) {
    const clientBusy = await db.prepare("SELECT starts_at,duration_minutes FROM appointments WHERE salon_id=? AND client_id=? AND status IN ('scheduled','confirmed') AND id<>COALESCE(?,0)").all(session.salon_id, clientId, id || null);
    if (clientBusy.some(a => {
      const aStart = Date.parse(a.starts_at);
      return startMs < aStart + a.duration_minutes * 60000 && aStart < endMs;
    })) fail(409, "A cliente já tem outro atendimento nesse horário.");
  }
  const notes = optionalText(data.notes, 1000);
  let apptId = id;
  if (id) {
    const old = await tenantRow("appointments", id, session.salon_id);
    if (["completed", "cancelled", "no_show"].includes(old.status)) fail(409, "Atendimentos concluídos ou encerrados não podem ser editados.");
    await db.prepare("UPDATE appointments SET client_id=?,professional_id=?,starts_at=?,duration_minutes=?,status=?,total_cents=?,payment_status=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND salon_id=?").run(clientId, profId, startsAt, duration, status, total, "pending", notes, id, session.salon_id);
    await db.prepare("DELETE FROM appointment_items WHERE appointment_id=? AND salon_id=?").run(id, session.salon_id);
  } else {
    const out = await db.prepare("INSERT INTO appointments(salon_id,client_id,professional_id,starts_at,duration_minutes,status,total_cents,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?)").run(session.salon_id, clientId, profId, startsAt, duration, status, total, notes, session.id);
    apptId = Number(out.lastInsertRowid);
  }
  const add = db.prepare("INSERT INTO appointment_items(salon_id,appointment_id,service_id,service_name,price_cents,duration_minutes,commission_bps) VALUES(?,?,?,?,?,?,?)");
  for (const x of selected) await add.run(session.salon_id, apptId, x.id, x.name, x.price_cents, x.duration_minutes, x.commission_bps);
  await audit(session, id ? "updated" : "created", "appointment", apptId, {
    starts_at: startsAt,
    status,
    total_cents: total
  });
  return {
    id: apptId
  };
}
async function report(salonId, url) {
  const start = dateText(url.searchParams.get("from") || localDate().slice(0, 7) + "-01", "Início", false),
    end = dateText(url.searchParams.get("to") || localDate(), "Fim", false);
  if (start > end) fail(400, "O período inicial deve ser anterior ao final.");
  const totals = await financialSummary(salonId, start, end),
    byCategory = await db.prepare("SELECT COALESCE(c.name,'Sem categoria') AS category,t.type,SUM(t.amount_cents) AS cents,COUNT(*) AS count FROM financial_transactions t LEFT JOIN categories c ON c.id=t.category_id AND c.salon_id=t.salon_id WHERE t.salon_id=? AND t.status='paid' AND t.paid_date>=? AND t.paid_date<=? GROUP BY c.name,t.type ORDER BY cents DESC").all(salonId, start, end),
    services = await db.prepare("SELECT ai.service_name AS name,SUM(ai.price_cents) AS revenue,COUNT(*) AS count,SUM(CAST((CAST(ai.price_cents AS BIGINT)*ai.commission_bps+5000)/10000 AS BIGINT)) AS commission FROM appointment_items ai JOIN appointments a ON a.id=ai.appointment_id AND a.salon_id=ai.salon_id WHERE ai.salon_id=? AND a.status='completed' AND substr(a.starts_at,1,10)>=? AND substr(a.starts_at,1,10)<=? GROUP BY ai.service_name ORDER BY revenue DESC").all(salonId, start, end),
    late = await db.prepare("SELECT id,type,description,amount_cents,due_date FROM financial_transactions WHERE salon_id=? AND status='pending' AND due_date<? ORDER BY due_date").all(salonId, localDate()),
    commissions = await db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS accrued,COALESCE(SUM(CASE WHEN status='paid' THEN amount_cents ELSE 0 END),0) AS paid,COUNT(*) AS count FROM commissions WHERE salon_id=? AND substr(created_at,1,10)>=? AND substr(created_at,1,10)<=?").get(salonId, start, end),
    flow = await db.prepare("SELECT paid_date AS day,SUM(CASE WHEN type='income' THEN amount_cents ELSE -amount_cents END) AS net FROM financial_transactions WHERE salon_id=? AND status='paid' AND paid_date>=? AND paid_date<=? GROUP BY paid_date ORDER BY paid_date").all(salonId, start, end);
  return {
    period: {
      start,
      end
    },
    totals,
    byCategory,
    services,
    late,
    commissions,
    flow,
    criteria: "Receitas e despesas consideram apenas lançamentos pagos e data de pagamento no período. Serviços consideram atendimentos concluídos."
  };
}
function normalizeQuestion(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
async function insights(salonId, question, range) {
  const d = await dashboard(salonId, range.month),
    q = normalizeQuestion(question),
    todayDate = localDate(),
    cutoff = localDate(-60),
    money = cents => new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL"
    }).format(Number(cents || 0) / 100);
  const best = await db.prepare("SELECT ai.service_name AS name,SUM(ai.price_cents) AS revenue,COUNT(*) AS count FROM appointment_items ai JOIN appointments a ON a.id=ai.appointment_id AND a.salon_id=ai.salon_id WHERE ai.salon_id=? AND a.status='completed' AND substr(a.starts_at,1,10)>=? AND substr(a.starts_at,1,10)<=? GROUP BY ai.service_name ORDER BY revenue DESC,count DESC,ai.service_name LIMIT 5").all(salonId, range.start, range.end);
  const top = await db.prepare("SELECT COALESCE(c.name,'Sem categoria') AS name,SUM(t.amount_cents) AS cents FROM financial_transactions t LEFT JOIN categories c ON c.id=t.category_id AND c.salon_id=t.salon_id WHERE t.salon_id=? AND t.type='expense' AND t.status='paid' AND t.paid_date>=? AND t.paid_date<=? GROUP BY c.name ORDER BY cents DESC LIMIT 3").all(salonId, range.start, range.end);
  const professionals = await db.prepare("SELECT p.name,COUNT(*) AS appointments,COALESCE(SUM(a.total_cents),0) AS revenue,COALESCE((SELECT SUM(cm.amount_cents) FROM commissions cm WHERE cm.salon_id=p.salon_id AND cm.professional_id=p.id AND cm.status='pending'),0) AS pending_commission FROM appointments a JOIN professionals p ON p.id=a.professional_id AND p.salon_id=a.salon_id WHERE a.salon_id=? AND a.status='completed' AND substr(a.starts_at,1,10)>=? AND substr(a.starts_at,1,10)<=? GROUP BY p.id ORDER BY appointments DESC,revenue DESC,p.name LIMIT 5").all(salonId, range.start, range.end);
  const previousStart = new Date(Date.UTC(Number(range.month.slice(0, 4)), Number(range.month.slice(5, 7)) - 4, 1)).toISOString().slice(0, 10);
  const history = await db.prepare("SELECT COALESCE(c.name,'Sem categoria') AS name,SUM(t.amount_cents) AS cents,COUNT(*) AS count FROM financial_transactions t LEFT JOIN categories c ON c.id=t.category_id AND c.salon_id=t.salon_id WHERE t.salon_id=? AND t.type='expense' AND t.status='paid' AND t.paid_date>=? AND t.paid_date<? GROUP BY c.name").all(salonId, previousStart, range.start);
  const recent = await db.prepare("SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount_cents ELSE -amount_cents END),0) AS net,COUNT(DISTINCT paid_date) AS active_days FROM financial_transactions WHERE salon_id=? AND status='paid' AND paid_date>=? AND paid_date<=?").get(salonId, localDate(-29), todayDate);
  const unusual = top.map(x => {
    const h = history.find(y => y.name === x.name);
    return h && h.count >= 3 && x.cents > h.cents / 3 * 1.5 && x.cents - h.cents / 3 >= 5000 ? {
      name: x.name,
      current: x.cents,
      monthly_average: Math.round(h.cents / 3),
      samples: h.count
    } : null;
  }).filter(Boolean);
  const completedClientCount = (await db.prepare("SELECT COUNT(*) AS n FROM (SELECT c.id FROM clients c JOIN appointments a ON a.client_id=c.id AND a.salon_id=c.salon_id AND a.status='completed' WHERE c.salon_id=? AND c.active=1 GROUP BY c.id HAVING MAX(substr(a.starts_at,1,10))<?)").get(salonId, cutoff)).n;
  const completedClients = await db.prepare("SELECT c.id,c.name,MAX(substr(a.starts_at,1,10)) AS last_visit,(SELECT ai.service_name FROM appointment_items ai JOIN appointments aa ON aa.id=ai.appointment_id AND aa.salon_id=ai.salon_id WHERE aa.salon_id=c.salon_id AND aa.client_id=c.id AND aa.status='completed' GROUP BY ai.service_name ORDER BY COUNT(*) DESC,SUM(ai.price_cents) DESC,ai.service_name LIMIT 1) AS frequent_service FROM clients c JOIN appointments a ON a.client_id=c.id AND a.salon_id=c.salon_id AND a.status='completed' WHERE c.salon_id=? AND c.active=1 GROUP BY c.id HAVING last_visit<? ORDER BY last_visit,c.name LIMIT 30").all(salonId, cutoff);
  const neverVisited = (await db.prepare("SELECT COUNT(*) AS n FROM clients c WHERE c.salon_id=? AND c.active=1 AND NOT EXISTS(SELECT 1 FROM appointments a WHERE a.salon_id=c.salon_id AND a.client_id=c.id AND a.status='completed')").get(salonId)).n;
  const apptRows = await db.prepare("SELECT starts_at,duration_minutes,status FROM appointments WHERE salon_id=? AND substr(starts_at,1,10)>=? AND substr(starts_at,1,10)<=? AND status IN ('scheduled','confirmed','completed','blocked')").all(salonId, range.start, range.end);
  const peakHours = await db.prepare("SELECT substr(starts_at,12,2) AS hour,COUNT(*) AS count FROM appointments WHERE salon_id=? AND substr(starts_at,1,10)>=? AND substr(starts_at,1,10)<=? AND status IN ('scheduled','confirmed','completed') GROUP BY hour ORDER BY count DESC,hour LIMIT 3").all(salonId, range.start, range.end);
  const salon = await db.prepare("SELECT opening_hours FROM salons WHERE id=?").get(salonId);
  let opening = {};
  try {
    opening = JSON.parse(salon.opening_hours || "{}");
  } catch {}
  const weekdayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
    weekdayLabels = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"],
    weekdayStats = weekdayKeys.map((key, index) => ({
      key,
      index,
      days: 0,
      bookings: 0
    }));
  let openMinutes = 0;
  for (let ms = Date.parse(range.start + "T12:00:00Z"), endMs = Date.parse(range.end + "T12:00:00Z"); ms <= endMs; ms += 86400000) {
    const date = new Date(ms),
      day = weekdayStats[date.getUTCDay()],
      hours = opening[day.key];
    if (!hours || !hours.enabled) continue;
    day.days++;
    const [fh, fm] = String(hours.from || "09:00").split(":").map(Number),
      [th, tm] = String(hours.to || "18:00").split(":").map(Number);
    openMinutes += Math.max(0, th * 60 + tm - (fh * 60 + fm));
  }
  let bookedMinutes = 0;
  for (const appointment of apptRows) {
    bookedMinutes += Number(appointment.duration_minutes) || 0;
    const index = new Date(appointment.starts_at.slice(0, 10) + "T12:00:00Z").getUTCDay();
    if (appointment.status !== "blocked") weekdayStats[index].bookings++;
  }
  const occupancy = openMinutes ? Math.round(bookedMinutes / openMinutes * 100) : null,
    lowWeekdays = weekdayStats.filter(x => x.days).map(x => ({
      ...x,
      perOpenDay: x.bookings / x.days
    })).sort((a, b) => a.perOpenDay - b.perOpenDay).slice(0, 2);
  const serviceTotal = best.reduce((n, x) => n + x.revenue, 0),
    shareBps = serviceTotal ? Math.round(best[0].revenue * 10000 / serviceTotal) : 0,
    comparison = d.hasPrevious ? d.current.net - d.previous.net : null;
  const evidence = {
    periodo: range.month,
    recebido_centavos: d.current.income,
    despesas_pagas_centavos: d.current.expense,
    resultado_centavos: d.current.net,
    comparacao_mes_anterior_centavos: comparison,
    saldo_centavos: d.balance,
    a_receber_centavos: d.receivable.cents,
    a_pagar_centavos: d.payable.cents,
    vencido_centavos: d.overdue.cents,
    comissoes_pendentes_centavos: d.commission,
    principais_servicos: best,
    participacao_do_servico_lider_bps: shareBps,
    principais_despesas: top,
    despesas_acima_do_historico: unusual,
    profissionais_no_periodo: professionals,
    agenda: {
      atendimentos_registrados: apptRows.filter(x => x.status !== "blocked").length,
      minutos_reservados: bookedMinutes,
      minutos_de_funcionamento: openMinutes,
      ocupacao_percentual: occupancy,
      horarios_de_maior_volume: peakHours,
      dias_com_menor_volume: lowWeekdays.map(x => ({
        dia: weekdayLabels[x.index],
        atendimentos_por_dia_aberto: Number(x.perOpenDay.toFixed(1))
      })),
      periodo_com_dias_abertos: weekdayStats.reduce((n, x) => n + x.days, 0)
    },
    clientes: {
      sem_visita_concluida_ha_60_dias_ou_mais: completedClientCount,
      nunca_atenderam: neverVisited,
      limite_em_dias: 60
    },
    ultimos_30_dias: {
      resultado_centavos: recent.net,
      dias_com_movimento: recent.active_days
    }
  };
  let answer,
    privateItems = [];
  if (/cliente|retorn|voltar|fideliz|relacionamento/.test(q)) {
    privateItems = completedClients.slice(0, 12).map(x => ({
      name: x.name,
      last_visit: x.last_visit,
      frequent_service: x.frequent_service
    }));
    answer = completedClients.length ? "Encontrei " + completedClientCount + " cliente(s) sem visita concluída há pelo menos 60 dias. A lista mostra até 8 exemplos: " + privateItems.slice(0, 8).map(x => x.name + " (última visita em " + new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Bahia",
      day: "2-digit",
      month: "2-digit",
      year: "numeric"
    }).format(new Date(x.last_visit + "T12:00:00")) + (x.frequent_service ? "; serviço frequente: " + x.frequent_service : "") + ")").join("; ") + ". Há também " + neverVisited + " cliente(s) sem visita concluída registrada. Uma ação possível é revisar consentimento de contato e oferecer um convite de retorno, sem presumir o motivo da ausência." : "Não há clientes ativas com visita concluída há 60 dias ou mais. " + neverVisited + " cliente(s) ainda não têm atendimento concluído registrado.";
  } else if (/profission|quem.*atend|mais atend/.test(q)) answer = professionals.length ? "No período, " + professionals[0].name + " realizou mais atendimentos concluídos (" + professionals[0].appointments + "), com receita registrada de " + money(professionals[0].revenue) + ". Comissões pendentes são exibidas separadamente e receita não equivale a lucro." : "Não há atendimentos concluídos no período para comparar profissionais.";else if (/agenda|horario|ocup|pico|vago|conflito/.test(q)) {
    const peak = peakHours[0],
      low = lowWeekdays[0];
    answer = "Na agenda de " + range.month + ", há " + evidence.agenda.atendimentos_registrados + " atendimento(s) e " + bookedMinutes + " minutos reservados." + (occupancy === null ? " O horário de funcionamento ainda não está configurado, então não calculei ocupação." : " A ocupação estimada é " + occupancy + "% das horas de funcionamento cadastradas; bloqueios também reservam horário.") + (peak ? " O horário de início com mais atendimentos é " + peak.hour + ":00 (" + peak.count + ")." : "") + (low ? " O menor volume médio aparece em " + weekdayLabels[low.index] + " (" + low.perOpenDay.toFixed(1).replace(".", ",") + " atendimento(s) por dia aberto)." : "") + (q.includes("conflito") ? " O cadastro recusa sobreposição para a mesma profissional; tentativas recusadas não são armazenadas." : "");
  } else if (/incom|atipic|anormal|fora do normal/.test(q)) answer = unusual.length ? "Pelo critério local (categoria com ao menos 3 lançamentos pagos nos 3 meses anteriores, atual acima de 1,5× a média e diferença de ao menos R$ 50), estas categorias ficaram acima do histórico: " + unusual.map(x => x.name + " (" + money(x.current) + " no mês; média anterior " + money(x.monthly_average) + ")").join("; ") + ". Isso é um sinal para revisar, não uma explicação da causa." : "Não há categoria que ultrapasse o critério de alerta neste mês. A comparação exige pelo menos 3 lançamentos pagos na categoria nos 3 meses anteriores.";else if (/compara|mes anterior|desempenho|evolu/.test(q)) answer = d.hasPrevious ? "O resultado líquido realizado em " + range.month + " foi " + money(d.current.net) + ", " + (comparison >= 0 ? "acima" : "abaixo") + " do mês anterior em " + money(Math.abs(comparison)) + ". Foram recebidos " + money(d.current.income) + " e pagas despesas de " + money(d.current.expense) + "." : "Ainda não há movimento pago no mês anterior para formar uma comparação.";else if (/concent|depend|participa/.test(q)) answer = best.length ? "O serviço com maior receita responde por " + (shareBps / 100).toFixed(1).replace(".", ",") + "% da receita de serviços concluídos (" + best[0].name + ", " + money(best[0].revenue) + " de " + money(serviceTotal) + "). A concentração é por serviço e não indica lucro." : "Não há atendimentos concluídos no período para calcular concentração por serviço.";else if (/servi|rent|vend|receita|fatur/.test(q)) answer = best.length ? "O serviço com maior receita em atendimentos concluídos é " + best[0].name + ", com " + money(best[0].revenue) + " em " + best[0].count + " atendimento(s). Isso mede receita, não lucro, pois custos de materiais não são registrados." : "Não há atendimentos concluídos no período para comparar serviços.";else if (/despes|gasto|custo/.test(q)) answer = top.length ? "As maiores categorias de despesas pagas são " + top.map(x => x.name + " (" + money(x.cents) + ")").join(", ") + ". A comparação usa somente despesas pagas." : "Não há despesas pagas neste período.";else if (/proje|previs|tend|caixa|saldo/.test(q)) answer = recent.active_days >= 10 ? "Nos últimos 30 dias o resultado líquido foi " + money(recent.net) + " em " + recent.active_days + " dias com movimentação. Uma referência linear para os próximos 30 dias seria cerca de " + money(recent.net) + ", sem considerar sazonalidade, compromissos ou eventos futuros; não é garantia. Saldo pago registrado: " + money(d.balance) + "." : "Ainda não há movimento em dias suficientes nos últimos 30 dias para estimar tendência do caixa.";else answer = "Em " + range.month + ", foram recebidos " + money(d.current.income) + ", pagas despesas de " + money(d.current.expense) + " e o resultado líquido realizado foi " + money(d.current.net) + ". Há " + money(d.overdue.cents) + " em vencimentos atrasados para revisar.";
  return {
    origin: "análise local",
    answer,
    evidence,
    privateItems,
    limits: "Baseado nos registros do salão. A ocupação compara minutos reservados com o horário cadastrado e inclui bloqueios; receita não é lucro. O copiloto não envia dados pessoais, não faz lançamentos e não substitui a conferência da equipe."
  };
}
async function redactPersonalQuestion(salonId, question) {
  let safe = question.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[e-mail]");
  safe = safe.replace(/\+?\d[\d\s().-]{6,}\d/g, m => m.replace(/\D/g, "").length >= 9 ? "[telefone]" : m);
  const names = (await db.prepare("SELECT name FROM clients WHERE salon_id=?").all(salonId)).map(x => x.name).filter(Boolean);
  for (const name of names) {
    const lower = safe.toLowerCase(),
      needle = name.toLowerCase();
    let at = lower.indexOf(needle);
    while (at >= 0) {
      safe = safe.slice(0, at) + "[cliente]" + safe.slice(at + name.length);
      const updated = safe.toLowerCase();
      at = updated.indexOf(needle, at + 9);
    }
  }
  return safe;
}
async function copilot(session, data) {
  requireRole(session, OWNER);
  const question = requiredText(data.question, "Pergunta", 500),
    safeQuestion = await redactPersonalQuestion(session.salon_id, question),
    range = monthBounds(data.month),
    local = await insights(session.salon_id, question, range),
    personalQuestion = /cliente|retorn|voltar|fideliz|relacionamento/i.test(normalizeQuestion(question));
  let result = local;
  if (!personalQuestion && process.env.AI_API_KEY && process.env.AI_BASE_URL && process.env.AI_MODEL) {
    try {
      const response = await fetch(process.env.AI_BASE_URL.replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + process.env.AI_API_KEY
        },
        signal: AbortSignal.timeout(12000),
        body: JSON.stringify({
          model: process.env.AI_MODEL,
          temperature: 0.2,
          messages: [{
            role: "system",
            content: "Você é a SalaON AI, consultora de gestão para salões. Responda exclusivamente em português brasileiro, em linguagem clara e concisa. Use somente os dados agregados fornecidos, indique período e limites, não invente valores, causas ou recomendações factuais e não execute ações financeiras. Nunca solicite nem tente inferir dados pessoais."
          }, {
            role: "user",
            content: "Pergunta: " + safeQuestion + "\nDados agregados autorizados: " + JSON.stringify(local.evidence)
          }]
        })
      });
      if (response.ok) {
        const payload = await response.json(),
          answer = payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
        if (typeof answer === "string" && answer.trim()) result = {
          origin: "provedor configurado",
          answer: answer.trim().slice(0, 5000),
          evidence: local.evidence,
          privateItems: [],
          limits: local.limits
        };
      } else result = Object.assign({}, local, {
        origin: "análise local (provedor indisponível)"
      });
    } catch {
      result = Object.assign({}, local, {
        origin: "análise local (provedor indisponível)"
      });
    }
  }
  await db.prepare("INSERT INTO ai_conversations(salon_id,user_id,question,answer,origin,period,evidence_json,private_items_json) VALUES(?,?,?,?,?,?,?,?)").run(session.salon_id, session.id, safeQuestion, result.answer, result.origin, range.month, JSON.stringify(result.evidence || {}), JSON.stringify(result.privateItems || []));
  return result;
}
async function copilotHistory(session) {
  requireRole(session, OWNER);
  return (await db.prepare("SELECT id,question,answer,origin,period,evidence_json,private_items_json,created_at FROM ai_conversations WHERE salon_id=? AND user_id=? ORDER BY id DESC LIMIT 12").all(session.salon_id, session.id)).map(x => {
    let evidence = {},
      privateItems = [];
    try {
      evidence = JSON.parse(x.evidence_json || "{}");
    } catch {}
    try {
      privateItems = JSON.parse(x.private_items_json || "[]");
    } catch {}
    return {
      id: x.id,
      question: x.question,
      answer: x.answer,
      origin: x.origin,
      period: x.period,
      evidence,
      privateItems,
      created_at: x.created_at
    };
  });
}
async function notifications(session) {
  const sid = session.salon_id,
    todayDate = localDate(),
    tomorrow = localDate(1),
    week = localDate(8),
    items = [];
  if (session.role === "owner") {
    const overdue = await db.prepare("SELECT COUNT(*) AS n,COALESCE(SUM(amount_cents),0) AS cents FROM financial_transactions WHERE salon_id=? AND status='pending' AND due_date<?").get(sid, todayDate);
    if (overdue.n) items.push({
      id: "overdue",
      title: overdue.n + " conta(s) vencida(s)",
      detail: "Total pendente: " + (overdue.cents / 100).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL"
      }),
      page: "finance"
    });
    const payable = await db.prepare("SELECT COUNT(*) AS n FROM financial_transactions WHERE salon_id=? AND status='pending' AND due_date>=? AND due_date<?").get(sid, todayDate, week);
    if (payable.n) items.push({
      id: "due-week",
      title: payable.n + " vencimento(s) nesta semana",
      detail: "Confira as contas a pagar e a receber.",
      page: "finance"
    });
    const commission = await db.prepare("SELECT COUNT(*) AS n,COALESCE(SUM(amount_cents),0) AS cents FROM commissions WHERE salon_id=? AND status='pending'").get(sid);
    if (commission.n) items.push({
      id: "commission",
      title: commission.n + " comissão(ões) aguardam pagamento",
      detail: "Total pendente: " + (commission.cents / 100).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL"
      }),
      page: "team"
    });
  }
  if (session.role === "owner" || session.role === "reception") {
    const pending = await db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE salon_id=? AND status='scheduled' AND substr(starts_at,1,10)>=? AND substr(starts_at,1,10)<?").get(sid, todayDate, week);
    if (pending.n) items.push({
      id: "confirm",
      title: pending.n + " atendimento(s) aguardam confirmação",
      detail: "Há horários agendados nos próximos 7 dias.",
      page: "agenda"
    });
    const receive = await db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE salon_id=? AND status='completed' AND payment_status='pending' AND substr(starts_at,1,10)>=? AND substr(starts_at,1,10)<?").get(sid, "0000-01-01", tomorrow);
    if (receive.n) items.push({
      id: "receive",
      title: receive.n + " atendimento(s) concluídos sem recebimento",
      detail: "O pagamento ainda precisa ser registrado pela equipe.",
      page: "agenda"
    });
  }
  if (session.role === "professional") {
    const next = await db.prepare("SELECT COUNT(*) AS n,MIN(starts_at) AS next_at FROM appointments WHERE salon_id=? AND professional_id=? AND status IN ('scheduled','confirmed') AND substr(starts_at,1,10)>=? AND substr(starts_at,1,10)<?").get(sid, session.professional_id || -1, todayDate, week);
    if (next.n) items.push({
      id: "my-agenda",
      title: next.n + " atendimento(s) na sua agenda",
      detail: "Próximo horário: " + new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Bahia",
        weekday: "short",
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }).format(new Date(next.next_at)),
      page: "agenda"
    });
    const comm = await db.prepare("SELECT COUNT(*) AS n,COALESCE(SUM(amount_cents),0) AS cents FROM commissions WHERE salon_id=? AND professional_id=? AND status='pending'").get(sid, session.professional_id || -1);
    if (comm.n) items.push({
      id: "my-commission",
      title: "Comissões pendentes",
      detail: comm.n + " demonstrativo(s) · " + (comm.cents / 100).toLocaleString("pt-BR", {
        style: "currency",
        currency: "BRL"
      }),
      page: "dashboard"
    });
  }
  return {
    items: items.slice(0, 8),
    generated_at: new Date().toISOString()
  };
}
function setCookie(res, token, maxAge) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", "salaon_session=" + encodeURIComponent(token) + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + maxAge + secure);
}
function csrf(req, session) {
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) fail(403, "Origem inválida.");
    } catch {
      fail(403, "Origem inválida.");
    }
  }
  if (req.headers["x-csrf-token"] !== session.csrf_token) fail(403, "A sessão expirou. Atualize a página e tente novamente.");
}
function typeOf(file) {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg"
  }[path.extname(file).toLowerCase()] || "application/octet-stream";
}
function staticFile(pathname, res) {
  let requested;
  try {
    requested = decodeURIComponent(pathname);
  } catch {
    requested = "/";
  }
  if (requested === "/" || requested === "/index.html") requested = "/index.html";
  const file = path.resolve(ROOT, "." + requested);
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, "index.html")) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    return res.end("Not found");
  }
  res.writeHead(200, {
    "Content-Type": typeOf(file),
    "Cache-Control": "no-cache"
  });
  fs.createReadStream(file).pipe(res);
}
async function handle(req, res, url) {
  const method = req.method,
    p = url.pathname;
  if (p === "/api/health" && method === "GET") return json(res, 200, { ok: true });
  if (p === "/api/auth/login" && method === "POST") {
    const data = await body(req),
      email = requiredText(data.email, "E-mail", 160).toLowerCase(),
      password = requiredText(data.password, "Senha", 256),
      key = (req.socket.remoteAddress || "local") + "|" + email,
      state = loginFailures.get(key) || {
        count: 0,
        until: 0
      };
    if (state.until > Date.now()) fail(429, "Muitas tentativas. Aguarde alguns minutos.");
    const user = await db.prepare("SELECT * FROM users WHERE lower(email)=lower(?) AND active=1").get(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      state.count++;
      if (state.count >= 8) {
        state.until = Date.now() + 600000;
        state.count = 0;
      }
      loginFailures.set(key, state);
      fail(401, "E-mail ou senha incorretos.");
    }
    loginFailures.delete(key);
    const s = await createSession(user.id);
    setCookie(res, s.token, Math.floor(SESSION_MS / 1000));
    return json(res, 200, {
      user: {
        id: user.id,
        salon_id: user.salon_id,
        email: user.email,
        name: user.name,
        role: user.role,
        professional_id: user.professional_id,
        must_change_password: !!user.must_change_password
      },
      csrf: s.csrf
    });
  }
  let session = await getSession(req);
  if (p === "/api/auth/logout" && method === "POST") {
    if (session) {
      csrf(req, session);
      await clearSession(session);
    }
    setCookie(res, "", 0);
    return json(res, 200, {
      ok: true
    });
  }
  if (!session) fail(401, "Sua sessão terminou. Entre novamente.");
  if (p === "/api/auth/me" && method === "GET") return json(res, 200, {
    user: {
      id: session.id,
      salon_id: session.salon_id,
      email: session.email,
      name: session.name,
      role: session.role,
      professional_id: session.professional_id,
      must_change_password: !!session.must_change_password
    },
    csrf: session.csrf_token
  });
  if (p === "/api/auth/change-password" && method === "POST") {
    csrf(req, session);
    const data = await body(req),
      old = requiredText(data.current_password, "Senha atual", 256),
      next = requiredText(data.new_password, "Nova senha", 256),
      user = await db.prepare("SELECT password_hash FROM users WHERE id=?").get(session.id);
    if (!verifyPassword(old, user.password_hash)) fail(400, "A senha atual não confere.");
    if (next.length < 12) fail(400, "Use uma senha com pelo menos 12 caracteres.");
    await db.prepare("UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?").run(hashPassword(next), session.id);
    await db.prepare("DELETE FROM sessions WHERE user_id=?").run(session.id);
    const fresh = await createSession(session.id);
    setCookie(res, fresh.token, Math.floor(SESSION_MS / 1000));
    await audit(session, "changed", "password", session.id, {});
    return json(res, 200, {
      ok: true,
      csrf: fresh.csrf
    });
  }
  if (session.must_change_password) fail(403, "Troque a senha inicial para continuar.");
  if (method !== "GET") csrf(req, session);
  if (p === "/api/dashboard" && method === "GET") {
    requireRole(session, OWNER);
    return json(res, 200, await dashboard(session.salon_id, url.searchParams.get("month")));
  }
  if (p === "/api/notifications" && method === "GET") return json(res, 200, await notifications(session));
  if (p === "/api/copilot/history" && method === "GET") return json(res, 200, await copilotHistory(session));
  if (p === "/api/copilot" && method === "POST") return json(res, 200, await copilot(session, await body(req)));
  if (p === "/api/reports" && method === "GET") {
    requireRole(session, OWNER);
    return json(res, 200, await report(session.salon_id, url));
  }
  if (p === "/api/reports.csv" && method === "GET") {
    requireRole(session, OWNER);
    const r = await report(session.salon_id, url),
      rows = [["Tipo", "Data", "Descrição", "Categoria", "Valor (R$)", "Status"]],
      items = await db.prepare("SELECT t.type,COALESCE(t.paid_date,t.due_date,'') AS date,t.description,COALESCE(c.name,'Sem categoria') AS category,t.amount_cents/100.0 AS amount,t.status FROM financial_transactions t LEFT JOIN categories c ON c.id=t.category_id AND c.salon_id=t.salon_id WHERE t.salon_id=? AND COALESCE(t.paid_date,t.due_date,'')>=? AND COALESCE(t.paid_date,t.due_date,'')<=? ORDER BY date").all(session.salon_id, r.period.start, r.period.end);
    for (const x of items) rows.push([x.type, x.date, x.description, x.category, x.amount.toFixed(2), x.status]);
    const csv = rows.map(row => row.map(v => '"' + String(/^[\s]*[=+\-@]/.test(String(v)) ? "'" + v : v).replace(/"/g, '""') + '"').join(";")).join("\r\n");
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="salaon-relatorio.csv"',
      "Cache-Control": "no-store"
    });
    return res.end("\ufeff" + csv);
  }
  const itemMatch = p.match(/^\/api\/appointments\/(\d+)\/items$/);
  if (itemMatch && method === "GET") {
    const itemAppt = await tenantRow("appointments", Number(itemMatch[1]), session.salon_id);
    if (session.role === "professional" && itemAppt.professional_id !== session.professional_id) fail(403, "Este atendimento não está atribuído ao seu perfil.");
    requireRole(session, ["owner", "reception"]);
    return json(res, 200, await db.prepare("SELECT service_id,service_name,price_cents,duration_minutes,commission_bps FROM appointment_items WHERE appointment_id=? AND salon_id=?").all(Number(itemMatch[1]), session.salon_id));
  }
  const list = p.match(/^\/api\/([a-z-]+)$/);
  if (list && method === "GET") return json(res, 200, await getList(list[1], session, url));
  if (p === "/api/transactions" && method === "POST") return json(res, 201, await saveTransaction(session, await body(req)));
  let m = p.match(/^\/api\/transactions\/(\d+)$/);
  if (m && method === "PUT") return json(res, 200, await saveTransaction(session, await body(req), Number(m[1])));
  if (m && method === "DELETE") {
    requireRole(session, FINANCE_WRITE);
    const id = Number(m[1]),
      tx = await tenantRow("financial_transactions", id, session.salon_id);
    if (tx.status === "void") fail(409, "Este lançamento já foi estornado.");
    if (await db.prepare("SELECT id FROM commissions WHERE paid_transaction_id=?").get(id)) fail(409, "Este pagamento de comissão exige ajuste manual auditado.");
    await db.exec("BEGIN IMMEDIATE");
    try {
      await db.prepare("UPDATE financial_transactions SET status='void',voided_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND salon_id=?").run(id, session.salon_id);
      let reversal = null;
      if (tx.status === "paid") {
        const out = await db.prepare("INSERT INTO financial_transactions(salon_id,type,description,amount_cents,category_id,payment_method_id,status,paid_date,notes,created_by) VALUES(?,?,?,?,?,?,'paid',?,?,?)").run(session.salon_id, tx.type === "income" ? "expense" : "income", "Estorno do lançamento #" + id + " · " + tx.description, tx.amount_cents, tx.category_id, tx.payment_method_id, localDate(), "Estorno auditável do lançamento pago #" + id, session.id);
        reversal = Number(out.lastInsertRowid);
      }
      if (tx.appointment_id) await db.prepare("UPDATE appointments SET payment_status='pending',updated_at=CURRENT_TIMESTAMP WHERE id=? AND salon_id=?").run(tx.appointment_id, session.salon_id);
      await audit(session, "voided", "transaction", id, {
        reversal_transaction_id: reversal
      });
      await db.exec("COMMIT");
      return json(res, 200, {
        ok: true,
        reversal_id: reversal
      });
    } catch (e) {
      await db.exec("ROLLBACK");
      throw e;
    }
  }
  if (p === "/api/clients" && method === "POST") return json(res, 201, await saveClient(session, await body(req)));
  m = p.match(/^\/api\/clients\/(\d+)$/);
  if (m && method === "PUT") return json(res, 200, await saveClient(session, await body(req), Number(m[1])));
  if (m && method === "DELETE") {
    requireRole(session, ["owner", "reception"]);
    const id = Number(m[1]);
    await tenantRow("clients", id, session.salon_id);
    await db.prepare("UPDATE clients SET active=0,updated_at=CURRENT_TIMESTAMP WHERE id=? AND salon_id=?").run(id, session.salon_id);
    await audit(session, "deactivated", "client", id, {});
    return json(res, 200, {
      ok: true
    });
  }
  if (p === "/api/professionals" && method === "POST") return json(res, 201, await saveProfessional(session, await body(req)));
  m = p.match(/^\/api\/professionals\/(\d+)$/);
  if (m && method === "PUT") return json(res, 200, await saveProfessional(session, await body(req), Number(m[1])));
  if (m && method === "DELETE") {
    requireRole(session, OWNER);
    const id = Number(m[1]);
    await tenantRow("professionals", id, session.salon_id);
    await db.prepare("UPDATE professionals SET active=0 WHERE id=? AND salon_id=?").run(id, session.salon_id);
    const staff = await db.prepare("SELECT id FROM users WHERE salon_id=? AND professional_id=? AND role='professional'").all(session.salon_id, id);
    for (const account of staff) {
      await db.prepare("UPDATE users SET active=0 WHERE id=?").run(account.id);
      await db.prepare("DELETE FROM sessions WHERE user_id=?").run(account.id);
    }
    await audit(session, "deactivated", "professional", id, {
      accounts_closed: staff.length
    });
    return json(res, 200, {
      ok: true
    });
  }
  if (p === "/api/services" && method === "POST") return json(res, 201, await saveService(session, await body(req)));
  m = p.match(/^\/api\/services\/(\d+)$/);
  if (m && method === "PUT") return json(res, 200, await saveService(session, await body(req), Number(m[1])));
  if (m && method === "DELETE") {
    requireRole(session, OWNER);
    const id = Number(m[1]);
    await tenantRow("services", id, session.salon_id);
    await db.prepare("UPDATE services SET active=0 WHERE id=? AND salon_id=?").run(id, session.salon_id);
    await audit(session, "deactivated", "service", id, {});
    return json(res, 200, {
      ok: true
    });
  }
  if (p === "/api/appointments" && method === "POST") return json(res, 201, await saveAppointment(session, await body(req)));
  m = p.match(/^\/api\/appointments\/(\d+)$/);
  if (m && method === "PUT") return json(res, 200, await saveAppointment(session, await body(req), Number(m[1])));
  m = p.match(/^\/api\/appointments\/(\d+)\/(status|receive)$/);
  if (m && method === "POST") {
    const id = Number(m[1]),
      kind = m[2],
      a = await tenantRow("appointments", id, session.salon_id);
    if (kind === "status") {
      const data = await body(req),
        choices = ["scheduled", "confirmed", "completed", "cancelled", "no_show"],
        next = choices.includes(data.status) ? data.status : null;
      if (!next) fail(400, "Status inválido.");
      if (a.status === "blocked" && next === "completed") fail(409, "Um bloqueio não pode ser concluído como atendimento.");
      if (["completed", "cancelled", "no_show"].includes(a.status) && next !== a.status) fail(409, "Um atendimento encerrado não pode ser reaberto.");
      if (a.status === "blocked" && !["blocked", "cancelled"].includes(next)) fail(409, "Um bloqueio só pode permanecer ou ser cancelado.");
      if (session.role === "professional" && a.professional_id !== session.professional_id) fail(403, "Este atendimento não está atribuído ao seu perfil.");
      requireRole(session, ["owner", "reception", "professional"]);
      if (a.payment_status === "paid" && ["cancelled", "no_show"].includes(next)) fail(409, "Há um recebimento vinculado. Registre o estorno financeiro antes de cancelar.");
      await db.exec("BEGIN IMMEDIATE");
      try {
        await db.prepare("UPDATE appointments SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND salon_id=?").run(next, id, session.salon_id);
        if (next === "completed" && a.professional_id && !(await db.prepare("SELECT id FROM commissions WHERE salon_id=? AND appointment_id=? AND professional_id=?").get(session.salon_id, id, a.professional_id))) {
          const parts = await db.prepare("SELECT SUM(CAST((CAST(price_cents AS BIGINT)*commission_bps+5000)/10000 AS BIGINT)) AS amount FROM appointment_items WHERE appointment_id=? AND salon_id=?").get(id, session.salon_id);
          await db.prepare("INSERT INTO commissions(salon_id,appointment_id,professional_id,amount_cents,status) VALUES(?,?,?,?,'pending')").run(session.salon_id, id, a.professional_id, parts.amount || 0);
        }
        await audit(session, "status_changed", "appointment", id, {
          from: a.status,
          to: next
        });
        await db.exec("COMMIT");
        return json(res, 200, {
          ok: true
        });
      } catch (e) {
        await db.exec("ROLLBACK");
        throw e;
      }
    }
    requireRole(session, FINANCE_WRITE);
    const data = await body(req);
    if (a.status !== "completed") fail(409, "Conclua o atendimento antes de registrar o recebimento.");
    if (a.payment_status === "paid") fail(409, "Este atendimento já tem recebimento registrado.");
    const methodId = integer(data.payment_method_id, "Forma de pagamento", 1, 2147483647);
    await tenantRow("payment_methods", methodId, session.salon_id);
    const category = await db.prepare("SELECT id FROM categories WHERE salon_id=? AND type IN ('income','both') AND name='Serviços' ORDER BY id LIMIT 1").get(session.salon_id),
      today = localDate();
    await db.exec("BEGIN IMMEDIATE");
    try {
      const out = await db.prepare("INSERT INTO financial_transactions(salon_id,type,description,amount_cents,category_id,appointment_id,payment_method_id,status,due_date,paid_date,created_by) VALUES(?,'income',?,?,?,?,?,'paid',?,?,?)").run(session.salon_id, "Atendimento #" + id, a.total_cents, category ? category.id : null, id, methodId, today, today, session.id);
      await db.prepare("UPDATE appointments SET payment_status='paid',updated_at=CURRENT_TIMESTAMP WHERE id=? AND salon_id=?").run(id, session.salon_id);
      await audit(session, "received", "appointment", id, {
        transaction_id: Number(out.lastInsertRowid),
        amount_cents: a.total_cents
      });
      await db.exec("COMMIT");
      return json(res, 200, {
        ok: true,
        transaction_id: Number(out.lastInsertRowid)
      });
    } catch (e) {
      await db.exec("ROLLBACK");
      throw e;
    }
  }
  if (p === "/api/commissions/pay" && method === "POST") {
    requireRole(session, OWNER);
    const data = await body(req),
      id = integer(data.id, "Comissão", 1, 2147483647),
      c = await tenantRow("commissions", id, session.salon_id);
    if (c.status === "paid") fail(409, "Esta comissão já foi paga.");
    const category = await db.prepare("SELECT id FROM categories WHERE salon_id=? AND type IN ('expense','both') AND name='Comissões' ORDER BY id LIMIT 1").get(session.salon_id);
    await db.exec("BEGIN IMMEDIATE");
    try {
      const out = await db.prepare("INSERT INTO financial_transactions(salon_id,type,description,amount_cents,category_id,status,paid_date,notes,created_by) VALUES(?,'expense',?,?,?,'paid',?,'Pagamento de comissão',?)").run(session.salon_id, "Comissão · profissional #" + c.professional_id, c.amount_cents, category ? category.id : null, localDate(), session.id);
      await db.prepare("UPDATE commissions SET status='paid',paid_transaction_id=? WHERE id=? AND salon_id=?").run(Number(out.lastInsertRowid), id, session.salon_id);
      await audit(session, "paid", "commission", id, {
        amount_cents: c.amount_cents
      });
      await db.exec("COMMIT");
      return json(res, 200, {
        ok: true
      });
    } catch (e) {
      await db.exec("ROLLBACK");
      throw e;
    }
  }
  if (p === "/api/categories" && method === "POST") {
    requireRole(session, OWNER);
    const d = await body(req),
      name = requiredText(d.name, "Nome", 80),
      type = ["income", "expense", "both"].includes(d.type) ? d.type : fail(400, "Tipo inválido.");
    try {
      const out = await db.prepare("INSERT INTO categories(salon_id,name,type) VALUES(?,?,?)").run(session.salon_id, name, type),
        id = Number(out.lastInsertRowid);
      await audit(session, "created", "category", id, {
        name,
        type
      });
      return json(res, 201, {
        id
      });
    } catch (e) {
      if (String(e.message).includes("UNIQUE")) fail(409, "Essa categoria já existe.");
      throw e;
    }
  }
  if (p === "/api/payment-methods" && method === "POST") {
    requireRole(session, OWNER);
    const d = await body(req),
      name = requiredText(d.name, "Nome", 60);
    try {
      const out = await db.prepare("INSERT INTO payment_methods(salon_id,name) VALUES(?,?)").run(session.salon_id, name),
        id = Number(out.lastInsertRowid);
      await audit(session, "created", "payment_method", id, {
        name
      });
      return json(res, 201, {
        id
      });
    } catch (e) {
      if (String(e.message).includes("UNIQUE")) fail(409, "Essa forma de pagamento já existe.");
      throw e;
    }
  }
  if (p === "/api/cash/open" && method === "POST") {
    requireRole(session, OWNER);
    const d = await body(req),
      opening = d.opening_cents === undefined ? 0 : Number(String(d.opening_cents).replace(",", ".")) === 0 ? 0 : moneyCents(d.opening_cents);
    if (await db.prepare("SELECT id FROM cash_sessions WHERE salon_id=? AND closed_at IS NULL").get(session.salon_id)) fail(409, "Já existe um caixa aberto.");
    const out = await db.prepare("INSERT INTO cash_sessions(salon_id,opened_by,opening_cents,notes) VALUES(?,?,?,?)").run(session.salon_id, session.id, opening, optionalText(d.notes, 500)),
      id = Number(out.lastInsertRowid);
    await audit(session, "opened", "cash_session", id, {
      opening_cents: opening
    });
    return json(res, 201, {
      id
    });
  }
  if (p === "/api/cash/close" && method === "POST") {
    requireRole(session, OWNER);
    const d = await body(req),
      open = await db.prepare("SELECT * FROM cash_sessions WHERE salon_id=? AND closed_at IS NULL ORDER BY id DESC LIMIT 1").get(session.salon_id);
    if (!open) fail(409, "Não há caixa aberto.");
    const counted = Number(String(d.closing_counted_cents).replace(",", ".")) === 0 ? 0 : moneyCents(d.closing_counted_cents),
      sums = await db.prepare("SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount_cents ELSE -amount_cents END),0) AS delta FROM financial_transactions WHERE salon_id=? AND status='paid' AND payment_method_id IN (SELECT id FROM payment_methods WHERE salon_id=? AND name='Dinheiro') AND paid_date>=substr(?,1,10)").get(session.salon_id, session.salon_id, open.opened_at),
      expected = open.opening_cents + sums.delta;
    await db.prepare("UPDATE cash_sessions SET closed_by=?,closed_at=CURRENT_TIMESTAMP,closing_expected_cents=?,closing_counted_cents=?,notes=? WHERE id=?").run(session.id, expected, counted, optionalText(d.notes, 500), open.id);
    await audit(session, "closed", "cash_session", open.id, {
      expected_cents: expected,
      counted_cents: counted
    });
    return json(res, 200, {
      expected,
      counted
    });
  }
  if (p === "/api/users" && method === "POST") {
    requireRole(session, OWNER);
    const d = await body(req),
      email = requiredText(d.email, "E-mail", 160).toLowerCase(),
      name = requiredText(d.name, "Nome", 120),
      password = requiredText(d.password, "Senha inicial", 256),
      role = ["owner", "reception", "professional"].includes(d.role) ? d.role : fail(400, "Papel inválido.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Informe um e-mail válido.");
    if (password.length < 12) fail(400, "Use uma senha inicial com pelo menos 12 caracteres.");
    let prof = d.professional_id ? integer(d.professional_id, "Profissional", 1, 2147483647) : null;
    if (role === "professional") {
      if (!prof) fail(400, "Vincule o acesso ao cadastro da equipe.");
      await tenantRow("professionals", prof, session.salon_id);
    } else prof = null;
    try {
      const out = await db.prepare("INSERT INTO users(salon_id,email,name,role,professional_id,password_hash,must_change_password) VALUES(?,?,?,?,?,?,1)").run(session.salon_id, email, name, role, prof, hashPassword(password)),
        id = Number(out.lastInsertRowid);
      await audit(session, "created", "user", id, {
        email,
        role
      });
      return json(res, 201, {
        id
      });
    } catch (e) {
      if (String(e.message).includes("UNIQUE")) fail(409, "Já existe uma conta com esse e-mail neste salão.");
      throw e;
    }
  }
  const resetMatch = p.match(/^\/api\/users\/(\d+)\/reset-password$/);
  if (resetMatch && method === "POST") {
    requireRole(session, OWNER);
    const id = Number(resetMatch[1]);
    if (id === session.id) fail(400, "Para alterar sua própria senha, use a opção de segurança da conta.");
    const target = await tenantRow("users", id, session.salon_id);
    if (!target.active) fail(409, "Ative o acesso antes de redefinir a senha.");
    const data = await body(req),
      password = requiredText(data.password, "Senha temporária", 256);
    if (password.length < 12) fail(400, "Use uma senha temporária com pelo menos 12 caracteres.");
    await db.prepare("UPDATE users SET password_hash=?,must_change_password=1 WHERE id=? AND salon_id=?").run(hashPassword(password), id, session.salon_id);
    await db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
    await audit(session, "reset", "user_password", id, {});
    return json(res, 200, {
      ok: true
    });
  }
  if (p === "/api/settings" && method === "PUT") {
    requireRole(session, OWNER);
    const d = await body(req),
      name = requiredText(d.name, "Nome do salão", 120),
      raw = d.opening_hours || {},
      keys = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      hours = {};
    for (const day of keys) {
      const h = raw[day];
      if (!h || typeof h.enabled !== "boolean") fail(400, "Configure o horário de cada dia da semana.");
      const from = requiredText(h.from, "Horário de abertura", 5),
        to = requiredText(h.to, "Horário de fechamento", 5);
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(from) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(to)) fail(400, "Use horários válidos para abrir e fechar.");
      if (h.enabled && from >= to) fail(400, "O fechamento deve ser depois da abertura.");
      hours[day] = {
        enabled: h.enabled,
        from,
        to
      };
    }
    await db.prepare("UPDATE salons SET name=?,opening_hours=? WHERE id=?").run(name, JSON.stringify(hours), session.salon_id);
    await audit(session, "updated", "salon", session.salon_id, {
      name
    });
    return json(res, 200, {
      ok: true
    });
  }
  m = p.match(/^\/api\/users\/(\d+)\/deactivate$/);
  if (m && method === "POST") {
    requireRole(session, OWNER);
    const id = Number(m[1]);
    if (id === session.id) fail(400, "Não é possível desativar a própria conta.");
    await tenantRow("users", id, session.salon_id);
    await db.prepare("UPDATE users SET active=0 WHERE id=? AND salon_id=?").run(id, session.salon_id);
    await db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
    await audit(session, "deactivated", "user", id, {});
    return json(res, 200, {
      ok: true
    });
  }
  fail(404, "Esta ação não foi encontrada.");
}
const server = http.createServer(async (req, res) => {
  await db.withContext(async () => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) await handle(req, res, url);
      else if (req.method === "GET") staticFile(url.pathname, res);
      else fail(405, "Método não permitido.");
    } catch (error) {
      if (res.headersSent) return;
      const status = error.status || 500;
      if (status >= 500) console.error(error);
      json(res, status, {
        error: status >= 500 ? "Ocorreu um erro interno." : error.message
      });
    }
  });
});
initDb().then(() => {
  server.listen(PORT, "0.0.0.0", () => console.log(
    "SalaON disponível na porta " + PORT + " | Banco: " + (usingPostgres ? "Supabase PostgreSQL" : dbPathLabel())
  ));
}).catch(async (error) => {
  console.error("Falha ao iniciar o banco do SalaON:", error);
  await closeDb();
  process.exitCode = 1;
});
function dbPathLabel() {
  return process.env.SALAON_DB_PATH || path.join(process.cwd(), "data", "salaon.sqlite");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => {
    closeDb().catch((error) => console.error("Falha ao fechar o banco:", error));
  }));
}
