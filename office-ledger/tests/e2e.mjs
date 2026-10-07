// End-to-end checks for the office ledger page.
// Runs the real page in Chromium against an in-memory stand-in for the claude.ai
// db / user / assets / downloads capabilities, drives the forms, and checks the money.
//
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node office-ledger/tests/e2e.mjs
//
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const here = path.dirname(fileURLToPath(import.meta.url));
const page_src = fs.readFileSync(path.join(here, "..", "index.html"), "utf8");
const outDir = process.env.LEDGER_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
const htmlPath = path.join(outDir, "ledger-test.html");
fs.writeFileSync(htmlPath, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>body{margin:0}[hidden]{display:none!important}</style></head><body>${page_src}</body></html>`);

// ---- in-memory capability stand-ins -------------------------------------------------
const MOCK = (cfg) => {
  const store = new Map(Object.entries(cfg.seed || {}));
  const listeners = new Set();
  let n = 0; const rid = () => "id" + (++n) + Math.random().toString(36).slice(2, 8);
  const clone = o => JSON.parse(JSON.stringify(o));
  const wait = () => new Promise(r => setTimeout(r, cfg.delay || 0));
  const snapDoc = p => ({ id: p.split("/").pop(), exists: store.has(p), data: () => store.get(p), metadata: {} });
  const colDocs = c => [...store.keys()].filter(k => k.startsWith(c + "/") && k.split("/").length === c.split("/").length + 1).sort().map(snapDoc);
  const notify = () => { for (const l of listeners) setTimeout(() => l.kind === "col" ? l.fn({ docs: colDocs(l.path) }) : l.fn(snapDoc(l.path)), 0); };
  window.__writes = [];
  function docRef(p) {
    return { id: p.split("/").pop(), path: p,
      async get() { return snapDoc(p); },
      async set(d) { await wait(); window.__writes.push(["set", p]); store.set(p, clone(d)); notify(); },
      async update(d) { await wait(); if (!store.has(p)) throw { code: "invalid_argument" }; window.__writes.push(["update", p]); store.set(p, { ...store.get(p), ...clone(d) }); notify(); },
      async delete() { store.delete(p); notify(); },
      async acquire() { return { acquired: true }; },
      onSnapshot(fn) { const l = { kind: "doc", path: p, fn }; listeners.add(l); setTimeout(() => fn(snapDoc(p)), 0); return () => listeners.delete(l); },
      collection(c) { return colRef(p + "/" + c); } };
  }
  function colRef(p) {
    return { path: p, doc: id => docRef(p + "/" + (id || rid())),
      async add(d) { const r = docRef(p + "/" + rid()); await r.set(d); return r; },
      async get() { const docs = colDocs(p); return { docs, size: docs.length, empty: !docs.length }; },
      onSnapshot(fn) { const l = { kind: "col", path: p, fn }; listeners.add(l); setTimeout(() => fn({ docs: colDocs(p) }), 0); return () => listeners.delete(l); },
      where() { return this; }, orderBy() { return this; }, limit() { return this; } };
  }
  const canEdit = cfg.canEdit !== false;
  const user = {
    me: async () => ({ id: "u_me", name: "المستخدم", avatarUrl: "data:image/gif;base64,R0lGODlhAQABAAAAACw=", color: "#333", email: null, isOwner: canEdit, canEdit }),
    can: async () => cfg.canWrite === false ? false : true,
    canEdit: async () => canEdit,
    profiles: async ids => Object.fromEntries((Array.isArray(ids) ? ids : [ids]).map(i => [i, { id: i, name: i === "u_me" ? "المستخدم" : "عضو آخر" }])),
  };
  const assets = canEdit ? { upload: async (b, o) => ({ id: "a" + rid(), url: "/_blob/x", sizeBytes: b.size, contentType: (o && o.type) || b.type }) } : null;
  window.__downloads = [];
  const downloads = { save: async ({ filename, data }) => {
    const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new TextEncoder().encode(String(data));
    window.__downloads.push({ filename, size: buf.length, head: String.fromCharCode(...buf.slice(0, 8)), tail: String.fromCharCode(...buf.slice(-7)) });
    return { status: "saved" };
  } };
  window.__LEDGER_TEST__ = true;
  window.__store = store;
  window.claude = { use: async name => ({ db: { doc: docRef, collection: colRef }, user, assets, downloads })[name] ?? null };
};

// The live ledger's real shape before this change: one client, one legacy payment, one legacy expense with no phase.
const LEGACY = {
  "clients/c1": { name: "زبون قديم", project: "فيلا + عيادة", contract: 20000000, status: "active", location: "بناصر", createdAt: "2026-10-07T18:13:51.976Z", createdBy: "u_old" },
  "entries/old_out": { amount: 600000, at: "2026-10-07T18:14:00.000Z", beneficiaryId: "", category: "materials", clientId: "c1", createdAt: "2026-10-07T18:14:55.166Z", createdBy: "u_old", fromId: "", history: [], memberId: "", method: "cash", note: "", receipts: [], ref: "", supplier: "حديد البناء بار 12", toId: "", type: "out", void: false },
  "entries/old_in": { amount: 2000000, at: "2026-10-07T18:15:00.000Z", beneficiaryId: "", category: "advance", clientId: "c1", createdAt: "2026-10-07T18:16:01.394Z", createdBy: "u_old", fromId: "", history: [], memberId: "", method: "cash", note: "", receipts: [], ref: "", supplier: "", toId: "", type: "in", void: false },
};

// ---- tiny test harness --------------------------------------------------------------
let failures = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log("  ✓ " + msg); } else { failures++; console.log("  ✗ " + msg); } };
const eq = (a, b, msg) => ok(Math.abs(a - b) < 0.005, `${msg} (got ${a}, want ${b})`);
const norm = s => s.replace(/[  ]/g, " ");

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
async function open(cfg, viewport = { width: 400, height: 860 }) {
  const ctx = await browser.newContext({ viewport, colorScheme: cfg.dark ? "dark" : "light" });
  const page = await ctx.newPage();
  page.__errors = [];
  page.on("pageerror", e => page.__errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !/fonts\.g|ERR_|net::|_blob/.test(m.text())) page.__errors.push(m.text()); });
  await page.addInitScript(MOCK, cfg);
  await page.goto("file://" + htmlPath);
  await page.waitForFunction(() => window.__ledger && window.__ledger.S.ready);
  return page;
}
const L = (page, fn, arg) => page.evaluate(fn, arg);
const stats = (page, cid) => L(page, c => { const s = window.__ledger.projStats(c); return { paid: s.paid, out: s.out, bal: s.bal, pct: s.pct, low: s.low, fees: s.fees }; }, cid);
const entries = page => L(page, () => window.__ledger.S.entries.map(e => ({ ...e })));
const closed = page => page.waitForFunction(() => !document.querySelector("#modal-root .sheet"));
const submit = page => page.click("#modal-root .sheet [type=submit]");
async function openProject(page, cid) {
  await page.click("[data-act=tab][data-tab=clients]");
  await page.click(`[data-act=client][data-id="${cid}"]`);
  await page.waitForSelector(".pbar");
}
async function backToDash(page) { if (await page.$("[data-act=pview][data-v=dash]")) await page.click("[data-act=pview][data-v=dash]"); }

// =====================================================================================
console.log("1. Existing data still reads correctly");
const P = await open({ seed: LEGACY, delay: 120 });
let st = await stats(P, "c1");
eq(st.paid, 2000000, "legacy payment counts as client funds");
eq(st.out, 600000, "legacy expense counts as project expense");
eq(st.bal, 1400000, "balance = payments − expenses");
eq(st.pct, 70, "remaining balance percent");
const pc0 = await L(P, () => window.__ledger.phaseCosts("c1"));
eq(pc0[""].material, 600000, "legacy expense lands in “no phase” as materials");
ok((await L(P, () => window.__store.size)) === 3, "no document was rewritten on load");

console.log("2. Client payment");
await openProject(P, "c1");
await P.screenshot({ path: path.join(outDir, "01-project-phone.png"), fullPage: true });
await P.click(".qa [data-act=pay]");
await P.fill("#pf-amount", "1 000 000");
await P.selectOption("#pf-method", "ccp");
ok(!(await P.$eval("#w-d", el => el.disabled)), "editor can change date and time");
await submit(P); await closed(P);
st = await stats(P, "c1");
eq(st.paid, 3000000, "balance rises after the payment");
let es = await entries(P);
const pay1 = es.find(e => e.type === "in" && e.amount === 1000000);
ok(pay1 && pay1.createdBy === "u_me" && pay1.createdAt && pay1.at && pay1.method === "ccp", "payment stores who, when, and method");

console.log("3. Material purchase with automatic total");
await P.click(".qa [data-act=expense][data-kind=material]");
await P.selectOption("#xf-phase", "p02");
await P.fill("#xf-item", "حديد Ø12");
await P.fill("#xf-qty", "70");
await P.fill("#xf-unit", "قضيب");
await P.fill("#xf-price", "1,250");
ok((await P.inputValue("#xf-amount")) === "87500", "total = 70 × 1 250 = 87 500");
ok(await P.$eval("#xf-amount", el => el.readOnly), "computed total is locked");
await P.screenshot({ path: path.join(outDir, "02-material-form-phone.png") });
await submit(P); await closed(P);
es = await entries(P);
const mat = es.find(e => e.item === "حديد Ø12");
ok(mat && mat.amount === 87500 && mat.qty === 70 && mat.unitPrice === 1250 && mat.phaseId === "p02" && mat.kind === "material", "material saved with qty, unit price and phase");

console.log("4. Paying a worker, twice, against one agreed amount");
await P.click(".qa [data-act=expense][data-kind=labor]");
await P.selectOption("#xf-phase", "p02");
await P.selectOption("#xf-worker", "__new");
await P.fill("#xf-wname", "محمد");
await P.fill("#xf-wspec", "حداد");
await P.fill("#xf-jdesc", "تسليح الأساسات");
await P.fill("#xf-agreed", "100000");
await P.fill("#xf-amount", "40000");
await submit(P); await closed(P);
const wid = await L(P, () => window.__ledger.S.workers[0] && window.__ledger.S.workers[0].id);
ok(!!wid, "new worker is saved for next time");
await P.click(".qa [data-act=expense][data-kind=labor]");
ok((await P.inputValue("#xf-phase")) === "p02", "phase defaults to the last one used");
await P.selectOption("#xf-worker", wid);
ok((await P.inputValue("#xf-agreed")) === "100000", "agreed amount comes back when the worker is picked");
await P.fill("#xf-amount", "30000");
const calcTxt = norm(await P.textContent("#xf-calc"));
ok(calcTxt.includes("قبض سابقا40 000") && calcTxt.includes("بعدها70 000") && calcTxt.includes("المتبقي له30 000"), "previously paid 40 000 · after 70 000 · remaining 30 000");
await P.screenshot({ path: path.join(outDir, "03-labor-form-phone.png") });
// double submit: both submissions write the same pre-allocated id
await P.evaluate(() => { const f = document.querySelector("#modal-root form"); f.requestSubmit(); f.requestSubmit(); });
await closed(P);
await P.waitForTimeout(400);
es = await entries(P);
ok(es.filter(e => e.workerId === wid).length === 2, "double submit still gives exactly two worker payments");
ok((await L(P, () => window.__ledger.S.jobs.length)) === 1, "one job for this worker, phase and project");
const ws = await L(P, w => { const x = window.__ledger.workerStats(w); return { due: x.due, paid: x.paid, rem: x.rem }; }, wid);
eq(ws.due, 100000, "worker total due"); eq(ws.paid, 70000, "worker total paid"); eq(ws.rem, 30000, "worker remaining");

console.log("5. Phase summary");
const pc = await L(P, () => window.__ledger.phaseCosts("c1"));
eq(pc.p02.material, 87500, "foundations: materials"); eq(pc.p02.labor, 70000, "foundations: labor"); eq(pc.p02.total, 157500, "foundations: total");
await P.click('[data-act=phase][data-ph="p02"]');
await P.waitForSelector("text=إجمالي تكلفة المرحلة");
await P.screenshot({ path: path.join(outDir, "04-phase-phone.png"), fullPage: true });
await backToDash(P);

console.log("6. Double payment protection");
const before = (await entries(P)).length;
await P.click(".qa [data-act=pay]");
await P.fill("#pf-amount", "5000");
await P.dblclick("#modal-root .sheet [type=submit]");
await P.evaluate(() => { const f = document.querySelector("#modal-root form"); if (f) f.requestSubmit(); });
await closed(P); await P.waitForTimeout(400);
ok((await entries(P)).length === before + 1, "one payment from three submit attempts");

console.log("7. Soft delete keeps the record");
es = await entries(P);
const small = es.find(e => e.amount === 5000);
await P.click("[data-act=pview][data-v=history]");
await P.click(`[data-act=entry][data-id="${small.id}"]`);
await P.click("[data-act=void]");
await P.fill("#void-r", "مسجّلة بالخطأ");
await P.click("[data-act=void-ok]"); await closed(P);
es = await entries(P);
const v = es.find(e => e.id === small.id);
ok(v && v.void === true && v.voidReason === "مسجّلة بالخطأ" && v.voidBy === "u_me" && v.history.some(h => h.action === "void"), "voided entry stays with reason, who and when");
eq((await stats(P, "c1")).paid, 3000000, "voided payment no longer counts");

console.log("8. Editing keeps the original values");
await P.click(`[data-act=entry][data-id="${pay1.id}"]`);
await P.click("[data-act=edit-entry]");
await P.fill("#pf-amount", "1200000");
await submit(P); await closed(P);
es = await entries(P);
const p1 = es.find(e => e.id === pay1.id);
ok(p1.amount === 1200000 && p1.history.length === 1 && p1.history[0].prev.amount === 1000000 && p1.updatedBy === "u_me", "edit history records the old amount and the editor");
eq((await stats(P, "c1")).paid, 3200000, "totals follow the edit");
await backToDash(P);

console.log("9. Office fee moves money between the two accounts");
const comp0 = await L(P, () => window.__ledger.companyTotals().b);
const bal0 = (await stats(P, "c1")).bal;
await P.click("[data-act=fee]");
await P.fill("#ff-amount", "50000");
await submit(P); await closed(P);
eq((await stats(P, "c1")).bal, bal0 - 50000, "project balance drops by the fee");
eq(await L(P, () => window.__ledger.clientTotals("_office").b), 50000, "office account gains the fee");
eq(await L(P, () => window.__ledger.companyTotals().b), comp0, "total cash unchanged by an internal transfer");
eq((await L(P, () => window.__ledger.profitCalc())).dist, 50000, "only transferred fees count as office profit");

console.log("9b. Office: two partners, 50% each, kept apart from client money");
await P.click("[data-act=tab][data-tab=home]");
const doors = (await P.$$(".doors .door")).length, studio = await P.textContent(".studio-n");
ok(doors === 2 && studio.trim() === "Contrast Studio", `home shows Contrast Studio and two areas (${doors} areas, “${studio.trim()}”)`);
await P.screenshot({ path: path.join(outDir, "10-home-phone.png"), fullPage: true });
await P.click(".door[data-tab=office]");
await P.click("[data-act=osub][data-v=team]");
for (const name of ["الشريك الأول", "الشريك الثاني"]) {
  await P.click("[data-act=new-member]");
  ok((await P.inputValue("#mf-kind")) === "partner" && (await P.inputValue("#mf-share")) === "50", `${name}: partner at 50% by default`);
  await P.fill("#mf-name", name);
  await submit(P); await closed(P);
}
const [pa, pb] = await L(P, () => window.__ledger.S.members.filter(m => m.kind === "partner").sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(m => m.id));
await P.click("[data-act=osub][data-v=overview]");
await P.click("[data-act=office-entry][data-type=in]");
await P.fill("#ef-amount", "300000");
await submit(P); await closed(P);
await P.click("[data-act=office-entry][data-cat=office]");
await P.fill("#ef-amount", "60000");
await P.selectOption("#ef-member", pa);
await submit(P); await closed(P);
await P.click("[data-act=office-entry][data-cat=draw]");
ok((await P.inputValue("#ef-cat")) === "draw", "withdrawal form opens on the profit-draw category");
await P.selectOption("#ef-benef", pa);
await P.fill("#ef-amount", "50000");
await submit(P); await closed(P);
const split = await L(P, () => { const ks = [...window.__store.keys()]; return { office: ks.filter(k => k.startsWith("office/")).length, leaked: ks.filter(k => k.startsWith("entries/") && window.__store.get(k).clientId === "_office").length }; });
ok(split.office === 3 && split.leaked === 0, "office transactions are stored in the partners-only office collection");
const pf = await L(P, () => window.__ledger.profitCalc());
eq(pf.dist, 290000, "profit = fee 50 000 + income 300 000 − office expenses 60 000");
eq(pf.dist * pf.share[pa] / 100, 145000, "each partner's 50% share");
eq(pf.draws[pa], 50000, "partner 1 withdrew 50 000 from profits");
eq(pf.expBy[pa], 60000, "partner 1 took 60 000 for office expenses");
eq(await L(P, () => window.__ledger.clientTotals("_office").b), 240000, "office balance after expenses and withdrawals");
const otxt = norm(await P.textContent("main"));
ok(otxt.includes("الشريك الأول") && otxt.includes("95 000") && otxt.includes("145 000"), "partners table: share 145 000, remaining 95 000");
await P.screenshot({ path: path.join(outDir, "11-office-phone.png"), fullPage: true });
await P.click("[data-act=tab][data-tab=clients]");
await P.click("[data-act=csub][data-v=ops]");
ok(!norm(await P.textContent("main")).includes("300 000"), "office income stays out of the clients log");
await openProject(P, "c1");

console.log("10. Low-balance alert");
ok(!(await stats(P, "c1")).low, "no alert while the balance is healthy");
await P.click(".qa [data-act=expense][data-kind=material]");
await P.click("input[name=xk][value=other]", { force: true });
await P.fill("#xf-odesc", "مقاول من الباطن للهيكل");
await P.fill("#xf-amount", "2700000");
await submit(P); await closed(P);
st = await stats(P, "c1");
ok(st.low && st.pct <= 10, `alert at ${st.pct.toFixed(1)}% ≤ 10%`);
ok(await P.isVisible("text=رصيد المشروع منخفض."), "warning text is shown");
await P.screenshot({ path: path.join(outDir, "05-low-alert-phone.png"), fullPage: true });

console.log("11. Payment request statuses");
await P.click(".alert [data-act=new-request]");
const sug = Number(await P.inputValue("#rf-amount"));
ok(sug > 0 && sug % 10000 === 0, `suggested amount ${sug} is prefilled`);
await P.fill("#rf-amount", "2000000");
await P.click("#modal-root [type=submit][value=draft]");
await P.waitForSelector("text=طلب دفعة N°001");
let rq = await L(P, () => window.__ledger.S.requests.map(r => ({ id: r.id, no: r.no, status: window.__ledger.reqStatus(r) })));
ok(rq.length === 1 && rq[0].no === 1 && rq[0].status === "draft", "first request is N°001, Draft");
await P.click("[data-act=req-sent]");
await P.waitForFunction(() => window.__ledger.S.requests[0].sentAt && !document.querySelector("[data-act=req-sent]"));
ok((await L(P, () => window.__ledger.reqStatus(window.__ledger.S.requests[0]))) === "sent", "marked Sent");
ok((await L(P, () => (window.__ledger.S.requests[0].pdfs || []).length)) === 1, "sent PDF is archived in file storage");
await P.click("[data-act=req-pay]");
ok((await P.inputValue("#pf-amount")) === "2000000", "payment form prefilled with the remaining amount");
ok((await P.inputValue("#pf-req")) === rq[0].id, "payment linked to the request");
await P.fill("#pf-amount", "1000000");
await submit(P); await closed(P);
let r0 = await L(P, () => { const r = window.__ledger.S.requests[0]; return { s: window.__ledger.reqStatus(r), paid: window.__ledger.reqPaid(r.id) }; });
ok(r0.s === "partial" && r0.paid === 1000000, "requested 2 000 000, paid 1 000 000: Partially Paid");
await P.click(".qa [data-act=pay]");
ok((await P.inputValue("#pf-req")) === rq[0].id, "next payment defaults to the open request");
await P.fill("#pf-amount", "1000000");
await submit(P); await closed(P);
r0 = await L(P, () => window.__ledger.reqStatus(window.__ledger.S.requests[0]));
ok(r0 === "paid", "fully paid: Paid");

console.log("12. PDF");
await P.click("[data-act=new-request]");
await P.fill("#rf-amount", "450000");
await P.fill("#rf-notes", "Fin des travaux de fondation.");
await submit(P);
await P.waitForSelector(".pdfprev img", { timeout: 15000 });
await P.screenshot({ path: path.join(outDir, "06-pdf-preview-phone.png") });
await P.click("[data-act=pdf-download]");
await P.waitForFunction(() => window.__downloads.length > 0);
const dl = await L(P, () => window.__downloads[0]);
ok(dl.filename === "Demande-de-versement-N002.pdf" && dl.head === "%PDF-1.4" && dl.tail.includes("%%EOF") && dl.size > 50000, `valid PDF ${dl.filename} (${Math.round(dl.size / 1024)} KB)`);
const png = await L(P, async () => (await window.__ledger.requestCanvas(window.__ledger.S.requests[1])).toDataURL("image/png"));
fs.writeFileSync(path.join(outDir, "07-pdf-page.png"), Buffer.from(png.split(",")[1], "base64"));
await P.keyboard.press("Escape");

console.log("13. Phases are data, not code");
await P.click("[data-act=tab][data-tab=office]");
await P.click("[data-act=osub][data-v=settings]");
await P.fill("#ph-new", "أعمال إضافية");
await P.click("[data-act=ph-add]");
await P.click("[data-act=ph-save]");
await P.waitForFunction(() => window.__ledger.S.phasesDoc && window.__ledger.S.phasesDoc.list.length === 15);
await openProject(P, "c1");
await P.click(".qa [data-act=expense][data-kind=material]");
ok((await P.$$eval("#xf-phase option", os => os.map(o => o.textContent))).includes("أعمال إضافية"), "new phase is offered in the expense form");
await P.keyboard.press("Escape");

console.log("14. Worker page and timeline");
await P.click("[data-act=tab][data-tab=clients]");
await P.click("[data-act=csub][data-v=workers]");
await P.click(`[data-act=worker][data-id="${wid}"]`);
const wtxt = norm(await P.textContent("main"));
ok(wtxt.includes("محمد") && wtxt.includes("100 000") && wtxt.includes("70 000") && wtxt.includes("30 000"), "worker page shows due, paid, remaining");
await P.screenshot({ path: path.join(outDir, "08-worker-phone.png"), fullPage: true });
await openProject(P, "c1");
await P.click("[data-act=pview][data-v=history]");
const tl = norm(await P.textContent("main"));
ok(tl.includes("سجّلها") && tl.includes("الأساسات") && tl.includes("الرصيد بعدها"), "timeline shows recorder, phase and running balance");
ok(P.__errors.length === 0, "no script errors" + (P.__errors.length ? ": " + P.__errors.join(" | ") : ""));
const wide = await L(P, () => document.documentElement.scrollWidth);
ok(wide <= 400, `no horizontal scroll on phone (${wide}px)`);

console.log("15. Desktop and dark mode");
const D = await open({ seed: await L(P, () => Object.fromEntries(window.__store)), dark: true }, { width: 1280, height: 900 });
await openProject(D, "c1");
await D.screenshot({ path: path.join(outDir, "09-project-desktop-dark.png"), fullPage: true });
await D.click("[data-act=tab][data-tab=home]");
await D.screenshot({ path: path.join(outDir, "12-home-desktop-dark.png") });
ok(D.__errors.length === 0, "no script errors on desktop");

console.log("16. Permissions");
const C = await open({ seed: LEGACY, canEdit: false });
await openProject(C, "c1");
await C.click(".qa [data-act=pay]");
ok(await C.$eval("#w-d", el => el.disabled), "contributor cannot back-date a payment");
ok(!!(await C.$("text=رفع الصور يحتاج صلاحية")), "contributor is told uploads need editor access");
await C.fill("#pf-amount", "10000");
await submit(C); await closed(C);
const ce = (await entries(C)).find(e => e.amount === 10000);
ok(ce && Math.abs(Date.parse(ce.at) - Date.now()) < 120000, "contributor entry is stamped with the current time");
await C.keyboard.press("Escape");
await C.click("[data-act=tab][data-tab=home]");
ok(!(await C.$("[data-act=tab][data-tab=office]")) && await C.isVisible(".door.locked"), "contributor sees the office area locked");
await C.click("#fab");
ok(!(await C.$("[data-act=office-entry]")) && !!(await C.$("[data-act=transfer]")), "contributor cannot record office money, only transfers");
const R = await open({ seed: LEGACY, canWrite: false });
await openProject(R, "c1");
ok(await R.$eval("#fab", el => el.hidden) && !(await R.$(".qa")), "read-only viewer sees no write buttons");

console.log("17. Number parsing");
const parsed = await L(P, () => ["1,250", "87 500", "1.250.000", "12,5", "0,250", "2 000 000,50", "١٢٥٠"].map(window.__ledger.parseNum));
ok(JSON.stringify(parsed) === JSON.stringify([1250, 87500, 1250000, 12.5, 0.25, 2000000.5, 1250]), "amounts typed with spaces, commas, dots or Arabic digits " + JSON.stringify(parsed));

await browser.close();
console.log(`\n${passes} passed, ${failures} failed. Screenshots: ${outDir}`);
process.exit(failures ? 1 : 0);
