async function main() {
  const {
    loadEnv
  } = require("../src/config");
  loadEnv();
  const {
    db,
    initDb
  } = require("../src/db");
  await initDb();
  const {
    hashPassword
  } = require("../src/auth");
  const salonCount = (await db.prepare("SELECT COUNT(*) AS n FROM salons").get()).n;
  if (salonCount) {
    console.log("Já existem dados. O seed não alterou o banco.");
    return;
  }
  const passArg = process.argv.indexOf("--password");
  const password = process.env.SALAON_DEMO_PASSWORD || (passArg >= 0 ? process.argv[passArg + 1] : "");
  if (!password || password.length < 12) {
    console.error("Defina SALAON_DEMO_PASSWORD ou use --password com no mínimo 12 caracteres.");
    process.exitCode = 1;
    return;
  }
  const isoDay = offset => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Bahia",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    const get = t => parts.find(p => p.type === t).value;
    const day = new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")) + offset));
    return day.toISOString().slice(0, 10);
  };
  const stamp = (offset, time) => isoDay(offset) + "T" + time + ":00-03:00";
  const salon = await db.prepare("INSERT INTO salons(name) VALUES('SalaON Estúdio de Beleza')").run();
  const salonId = Number(salon.lastInsertRowid);
  const user = await db.prepare("INSERT INTO users(salon_id,email,name,role,password_hash,must_change_password) VALUES(?,?,?,?,?,1)").run(salonId, process.env.SALAON_DEMO_EMAIL || "dona@salaon.local", "Gestora SalaON", "owner", hashPassword(password));
  const ownerId = Number(user.lastInsertRowid);
  const addCategory = db.prepare("INSERT INTO categories(salon_id,name,type) VALUES(?,?,?)");
  const cats = {};
  for (const [name, type] of [["Serviços", "income"], ["Produtos", "income"], ["Aluguel", "expense"], ["Produtos e materiais", "expense"], ["Contas fixas", "expense"], ["Comissões", "expense"], ["Outros", "both"]]) cats[name] = Number((await addCategory.run(salonId, name, type)).lastInsertRowid);
  const addMethod = db.prepare("INSERT INTO payment_methods(salon_id,name) VALUES(?,?)");
  const methods = {};
  for (const name of ["Pix", "Dinheiro", "Débito", "Crédito", "Transferência", "Manual"]) methods[name] = Number((await addMethod.run(salonId, name)).lastInsertRowid);
  const addProf = db.prepare("INSERT INTO professionals(salon_id,name,email,phone,default_commission_bps) VALUES(?,?,?,?,?)");
  const p1 = Number((await addProf.run(salonId, "Camila Nascimento", "camila@example.local", "", 4000)).lastInsertRowid);
  const p2 = Number((await addProf.run(salonId, "Joana Santos", "joana@example.local", "", 3500)).lastInsertRowid);
  const addClient = db.prepare("INSERT INTO clients(salon_id,name,phone,email,notes,consent_contact,consent_at) VALUES(?,?,?,?,?,?,?)");
  const c1 = Number((await addClient.run(salonId, "Marina Oliveira", "(71) 90000-0101", "", "", 1, new Date().toISOString())).lastInsertRowid);
  const c2 = Number((await addClient.run(salonId, "Lívia Costa", "(71) 90000-0102", "", "", 0, null)).lastInsertRowid);
  const c3 = Number((await addClient.run(salonId, "Rafaela Almeida", "(71) 90000-0103", "", "", 1, new Date().toISOString())).lastInsertRowid);
  const addService = db.prepare("INSERT INTO services(salon_id,name,category,duration_minutes,price_cents,commission_bps) VALUES(?,?,?,?,?,?)");
  const s1 = Number((await addService.run(salonId, "Escova e finalização", "Cabelo", 60, 8500, 4000)).lastInsertRowid);
  const s2 = Number((await addService.run(salonId, "Manicure em gel", "Unhas", 75, 12000, 3500)).lastInsertRowid);
  const s3 = Number((await addService.run(salonId, "Hidratação capilar", "Cabelo", 45, 10000, 4000)).lastInsertRowid);
  const addAppt = db.prepare("INSERT INTO appointments(salon_id,client_id,professional_id,starts_at,duration_minutes,status,total_cents,payment_status,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)");
  const addItem = db.prepare("INSERT INTO appointment_items(salon_id,appointment_id,service_id,service_name,price_cents,duration_minutes,commission_bps) VALUES(?,?,?,?,?,?,?)");
  const addTxn = db.prepare("INSERT INTO financial_transactions(salon_id,type,description,amount_cents,category_id,appointment_id,payment_method_id,status,due_date,paid_date,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
  const addComm = db.prepare("INSERT INTO commissions(salon_id,appointment_id,professional_id,amount_cents,status) VALUES(?,?,?,?,?)");
  async function completed(client, prof, service, price, duration, offset, name, method) {
    const appt = Number((await addAppt.run(salonId, client, prof, stamp(offset, "14:00"), duration, "completed", price, "paid", "", ownerId)).lastInsertRowid);
    await addItem.run(salonId, appt, service.id, service.name, price, duration, service.bps);
    await addTxn.run(salonId, "income", service.name + " · " + name, price, cats.Serviços, appt, methods[method], "paid", isoDay(offset), isoDay(offset), "", ownerId);
    await addComm.run(salonId, appt, prof, Math.round(price * service.bps / 10000), "pending");
  }
  const enableService = db.prepare("INSERT INTO professional_services(salon_id,professional_id,service_id) VALUES(?,?,?)");
  for (const professionalId of [p1, p2]) for (const serviceId of [s1, s2, s3]) await enableService.run(salonId, professionalId, serviceId);
  const services = [{
    id: s1,
    name: "Escova e finalização",
    price: 8500,
    minutes: 60,
    bps: 4000
  }, {
    id: s2,
    name: "Manicure em gel",
    price: 12000,
    minutes: 75,
    bps: 3500
  }, {
    id: s3,
    name: "Hidratação capilar",
    price: 10000,
    minutes: 45,
    bps: 4000
  }];
  await completed(c1, p1, services[0], 8500, 60, -2, "Marina", "Pix");
  await completed(c2, p2, services[1], 12000, 75, -5, "Lívia", "Crédito");
  await completed(c3, p1, services[2], 10000, 45, -9, "Rafaela", "Débito");
  await completed(c1, p2, services[0], 8500, 60, -13, "Marina", "Pix");
  await completed(c2, p1, services[1], 12000, 75, -21, "Lívia", "Dinheiro");
  for (const [offset, description, amount, category] of [[-1, "Compra de produtos", 14500, "Produtos e materiais"], [-8, "Aluguel do espaço", 85000, "Aluguel"], [-16, "Reposição de esmaltes", 9800, "Produtos e materiais"]]) {
    await addTxn.run(salonId, "expense", description, amount, cats[category], null, methods.Pix, "paid", isoDay(offset), isoDay(offset), "", ownerId);
  }
  await addTxn.run(salonId, "expense", "Conta de energia", 22000, cats["Contas fixas"], null, methods.Manual, "pending", isoDay(3), null, "Vencimento próximo", ownerId);
  await addTxn.run(salonId, "income", "Pacote de serviços", 18000, cats.Serviços, null, methods.Manual, "pending", isoDay(-4), null, "Aguardando confirmação manual", ownerId);
  for (const [client, prof, service, offset, time] of [[c3, p2, services[1], 1, "10:00"], [c1, p1, services[2], 2, "13:30"], [c2, p2, services[0], 4, "15:00"]]) {
    const appt = Number((await addAppt.run(salonId, client, prof, stamp(offset, time), service.minutes, "confirmed", service.price, "pending", "", ownerId)).lastInsertRowid);
    await addItem.run(salonId, appt, service.id, service.name, service.price, service.minutes, service.bps);
  }
  console.log("Seed criado. Acesse com " + (process.env.SALAON_DEMO_EMAIL || "dona@salaon.local") + " e a senha definida na execução do seed.");
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  const { closeDb } = require("../src/db");
  await closeDb();
});
