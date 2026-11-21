const crypto = require("node:crypto");
const {
  db
} = require("./db");
const SESSION_MS = 12 * 60 * 60 * 1000;
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(password, salt, 260000, 32, "sha256");
  return "pbkdf2$260000$" + salt.toString("hex") + "$" + key.toString("hex");
}
function verifyPassword(password, encoded) {
  try {
    const parts = encoded.split("$");
    if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
    const expected = Buffer.from(parts[3], "hex");
    const actual = crypto.pbkdf2Sync(password, Buffer.from(parts[2], "hex"), Number(parts[1]), expected.length, "sha256");
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const csrf = crypto.randomBytes(24).toString("base64url");
  const expires = new Date(Date.now() + SESSION_MS).toISOString();
  await db.prepare("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES(?,?,?,?)").run(tokenHash(token), userId, csrf, expires);
  return {
    token,
    csrf,
    expires
  };
}
async function getSession(req) {
  const cookies = Object.fromEntries((req.headers.cookie || "").split(";").map(part => part.trim()).filter(Boolean).map(part => {
    const i = part.indexOf("=");
    return [decodeURIComponent(part.slice(0, i)), decodeURIComponent(part.slice(i + 1))];
  }));
  const token = cookies.salaon_session;
  if (!token) return null;
  const row = await db.prepare("SELECT s.token_hash,s.csrf_token,s.expires_at,u.id,u.salon_id,u.email,u.name,u.role,u.professional_id,u.must_change_password,u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?").get(tokenHash(token));
  if (!row || !row.active || Date.parse(row.expires_at) <= Date.now()) {
    if (row) await db.prepare("DELETE FROM sessions WHERE token_hash=?").run(row.token_hash);
    return null;
  }
  return {
    ...row,
    tokenHash: row.token_hash
  };
}
async function clearSession(session) {
  if (session) await db.prepare("DELETE FROM sessions WHERE token_hash=?").run(session.tokenHash);
}
function requireRole(session, roles) {
  if (!session) {
    const e = new Error("Entre novamente para continuar.");
    e.status = 401;
    throw e;
  }
  if (roles && !roles.includes(session.role)) {
    const e = new Error("Seu perfil não tem acesso a esta área.");
    e.status = 403;
    throw e;
  }
}
module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  getSession,
  clearSession,
  requireRole,
  SESSION_MS
};
