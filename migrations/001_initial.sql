CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE salons (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Bahia',
  currency TEXT NOT NULL DEFAULT 'BRL',
  opening_hours TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  salon_id INTEGER NOT NULL REFERENCES salons(id),
  email TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','reception','professional')),
  professional_id INTEGER,
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(email)
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE professionals (
  id INTEGER PRIMARY KEY,
  salon_id INTEGER NOT NULL REFERENCES salons(id),
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  default_commission_bps INTEGER NOT NULL DEFAULT 0 CHECK(default_commission_bps BETWEEN 0 AND 10000),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE clients (
  id INTEGER PRIMARY KEY,
  salon_id INTEGER NOT NULL REFERENCES salons(id),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  notes TEXT NOT NULL DEFAULT '',
  consent_contact INTEGER NOT NULL DEFAULT 0,
  consent_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  salon_id INTEGER NOT NULL REFERENCES salons(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('income','expense','both')),
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(salon_id,name,type)
);
CREATE TABLE payment_methods (
  id INTEGER PRIMARY KEY,
  salon_id INTEGER NOT NULL REFERENCES salons(id),
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(salon_id,name)
);
CREATE TABLE services (
  id INTEGER PRIMARY KEY,
  salon_id INTEGER NOT NULL REFERENCES salons(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Geral',
  duration_minutes INTEGER NOT NULL DEFAULT 60 CHECK(duration_minutes > 0),
  price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
  commission_bps INTEGER NOT NULL DEFAULT 0 CHECK(commission_bps BETWEEN 0 AND 10000),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE appointments (
  id INTEGER PRIMARY KEY,
  salon_id INTEGER NOT NULL REFERENCES salons(id),
  client_id INTEGER REFERENCES clients(id),
  professional_id INTEGER REFERENCES professionals(id),
  starts_at TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK(duration_minutes > 0),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','confirmed','completed','cancelled','no_show','blocked')),
  total_cents INTEGER NOT NULL DEFAULT 0 CHECK(total_cents >= 0),
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK(payment_status IN ('pending','paid','void')),
  notes TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE appointment_items (
  id INTEGER PRIMARY KEY,
  salon_id INTEGER NOT NULL REFERENCES salons(id),
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  service_id INTEGER REFERENCES services(id),
  service_name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
  duration_minutes INTEGER NOT NULL CHECK(duration_minutes > 0),
  commission_bps INTEGER NOT NULL DEFAULT 0 CHECK(commission_bps BETWEEN 0 AND 10000)
);
CREATE TABLE financial_transactions (
  id INTEGER PRIMARY KEY,
  salon_id INTEGER NOT NULL REFERENCES salons(id),
  type TEXT NOT NULL CHECK(type IN ('income','expense')),
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  category_id INTEGER REFERENCES categories(id),
  appointment_id INTEGER REFERENCES appointments(id),
  payment_method_id INTEGER REFERENCES payment_methods(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','void')),
  due_date TEXT,
  paid_date TEXT,
  recurrence TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  voided_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE commissions (
  id INTEGER PRIMARY KEY,
  salon_id INTEGER NOT NULL REFERENCES salons(id),
  appointment_id INTEGER NOT NULL REFERENCES appointments(id),
  professional_id INTEGER NOT NULL REFERENCES professionals(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid')),
  paid_transaction_id INTEGER REFERENCES financial_transactions(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(salon_id,appointment_id,professional_id)
);
CREATE TABLE cash_sessions (
  id INTEGER PRIMARY KEY,
  salon_id INTEGER NOT NULL REFERENCES salons(id),
  opened_by INTEGER NOT NULL REFERENCES users(id),
  opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  opening_cents INTEGER NOT NULL DEFAULT 0,
  closed_by INTEGER REFERENCES users(id),
  closed_at TEXT,
  closing_expected_cents INTEGER,
  closing_counted_cents INTEGER,
  notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY,
  salon_id INTEGER NOT NULL REFERENCES salons(id),
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_transactions_period ON financial_transactions(salon_id,status,type,paid_date);
CREATE INDEX idx_transactions_due ON financial_transactions(salon_id,status,due_date);
CREATE INDEX idx_appointments_time ON appointments(salon_id,starts_at,status);
CREATE INDEX idx_clients_name ON clients(salon_id,name);
