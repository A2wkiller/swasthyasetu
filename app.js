/* SwasthyaSetu - one-stop health bridge. Vanilla JS, no build step.
   Real AI: BharatCode Qwen vision (prescription/lab reading) via serve.py proxy
   or a key stored locally. Everything else runs on-device / demo data. */
"use strict";

const API_PROXY = "/api/responses";
const MODEL = "qwen-3.8-27b";
const $ = (id) => document.getElementById(id);
const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

/* ---------------- state ---------------- */
const store = {
  get(k, dflt) { try { const v = localStorage.getItem("ss_" + k); return v ? JSON.parse(v) : dflt; } catch { return dflt; } },
  set(k, v) { localStorage.setItem("ss_" + k, JSON.stringify(v)); }
};
let profiles = store.get("profiles", null);
if (!profiles) { profiles = [{ id: "p1", name: "Me", age: "", blood: "", conditions: "", allergies: "", emergencyContact: "" }]; store.set("profiles", profiles); }
let activeId = store.get("active", profiles[0].id);
const activeProfile = () => profiles.find(p => p.id === activeId) || profiles[0];
let scans = store.get("scans", []);       // {id, profileId, ts, kind, thumb, result}
let reminders = store.get("reminders", []); // {id, profileId, name, time, active}
let booking = store.get("booking", null); // {doctor, slot, token, ahead}

/* ---------------- tabs ---------------- */
document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".panel").forEach(p => p.classList.toggle("active", p.id === "tab-" + btn.dataset.tab));
  if (btn.dataset.tab === "timeline") renderTimeline();
  if (btn.dataset.tab === "queue") renderQueue();
  if (btn.dataset.tab === "hospital") configureHospitalRole();
  if (btn.dataset.tab === "emergency") renderEcard();
  if (btn.dataset.tab === "reminders") renderReminders();
  if (btn.dataset.tab === "family") renderFamily();
}));

/* ---------------- BharatCode API ---------------- */
function savedKey() { return store.get("apikey", ""); }
async function bharatCall(payload) {
  try {
    const r = await fetch(API_PROXY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (r.ok) return await r.json();
    if (r.status !== 404) { const t = await r.text(); throw new Error("proxy " + r.status + ": " + t.slice(0, 200)); }
  } catch (e) { if (String(e).startsWith("proxy")) throw e; }
  const key = savedKey();
  if (!key) throw new Error("NO_KEY");
  const r2 = await fetch("https://bharatcode.ai/api/model/v1/responses", {
    method: "POST",
    headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!r2.ok) throw new Error("api " + r2.status + ": " + (await r2.text()).slice(0, 200));
  return r2.json();
}
function refreshKeyStatus() {
  $("keyStatus").textContent = savedKey() ? "Using your saved BharatCode key" : "No key saved: sample docs run in demo mode, or start with serve.py";
}
function respText(resp) {
  let out = "";
  for (const item of resp.output || []) if (item.type === "message")
    for (const c of item.content || []) if (c.type === "output_text") out += c.text || "";
  return out;
}

/* ---------------- scan / AI reader ---------------- */
let currentImage = null; // {dataUrl, b64}
function downscale(file, cb) {
  if (!file.type.startsWith("image/") || file.size > 12 * 1024 * 1024) { alert("Choose an image under 12 MB."); return; }
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(img.src);
    if (!img.width || !img.height || img.width * img.height > 40_000_000) { alert("That image is too large to process safely."); return; }
    const max = 1024, scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const url = c.toDataURL("image/jpeg", 0.7);
    cb({ dataUrl: url, b64: url.split(",")[1] });
  };
  img.onerror = () => { URL.revokeObjectURL(img.src); alert("This image could not be opened."); };
  img.src = URL.createObjectURL(file);
}
$("fileInput").addEventListener("change", e => {
  const f = e.target.files[0]; if (!f) return;
  downscale(f, d => { currentImage = d; $("preview").src = d.dataUrl; $("preview").classList.remove("hidden"); $("readBtn").disabled = false; $("uploadLabel").textContent = f.name; });
});
async function loadSampleDoc(url, kind) {
  try {
    const blob = await (await fetch(url)).blob();
    return await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
  } catch {
    return SAMPLE_DOCS[kind];
  }
}
$("sampleBtn").addEventListener("click", async () => {
  const kind = document.querySelector("input[name=doctype]:checked").value;
  const url = kind === "labreport" ? "samples/sample-lab-report.jpg" : "samples/sample-prescription.jpg";
  const dataUrl = await loadSampleDoc(url, kind === "labreport" ? "labreport" : "prescription");
  currentImage = { dataUrl, b64: dataUrl.split(",")[1] };
  $("preview").src = dataUrl; $("preview").classList.remove("hidden"); $("readBtn").disabled = false; $("uploadLabel").textContent = "Sample document";
});

const SCAN_PROMPT = `You are a careful Indian medical-document reading assistant. Read the attached document image (a doctor's prescription or a lab report from India, possibly handwritten).
Return ONLY compact JSON, no markdown fences:
{
 "doc_type": "prescription" | "labreport",
 "doctor_or_lab": string | null,
 "date": string | null,
 "medicines": [{"name": string, "salt": string, "dosage": string, "frequency": string, "timing": string, "duration": string, "purpose_en": string, "purpose_hi": string, "generic_alt": string, "jan_aushadhi": string}],
 "lab_values": [{"test": string, "value": string, "unit": string, "range": string, "flag": "normal"|"borderline"|"abnormal"}],
 "summary_en": string,
 "summary_hi": string,
 "interactions": [string],
 "confidence": "high"|"medium"|"low"
}
Rules: purpose_hi and summary_hi in simple Hindi (Devanagari). generic_alt = the generic/salt equivalent an Indian pharmacist would recognise; jan_aushadhi = likely Jan Aushadhi generic name if one exists, else "ask pharmacist". If handwriting is unreadable for an item, use "unclear" and lower confidence. interactions: only notable medicine-medicine or medicine-food cautions visible from this document. Never invent values.`;

$("readBtn").addEventListener("click", async () => {
  if (!currentImage) return;
  const btn = $("readBtn"); btn.disabled = true;
  let secs = 0; btn.textContent = "Reading with AI… 0s";
  const tick = setInterval(() => { secs++; btn.textContent = `Reading with AI… ${secs}s (shared model may be queued at busy times)`; }, 1000);
  try {
    let parsed, usedDemo = false;
    try {
      const resp = await bharatCall({
        model: MODEL, store: false, max_output_tokens: 3500,
        input: [
          { role: "system", content: SCAN_PROMPT },
          { role: "user", content: [
            { type: "input_text", text: "Read this document and return the JSON." },
            { type: "input_image", image_url: currentImage.dataUrl }
          ]}
        ]
      });
      const txt = respText(resp).replace(/```json|```/g, "").trim();
      parsed = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
    } catch (e) {
      if (String(e).includes("NO_KEY") || String(e).includes("api 402") || String(e).includes("api 401")) {
        parsed = DEMO_RESULT(); usedDemo = true;
      } else throw e;
    }
    renderScanResult(parsed, usedDemo);
    const scan = { id: "s" + Date.now(), profileId: activeId, ts: Date.now(), kind: parsed.doc_type, thumb: currentImage.dataUrl, result: parsed };
    scans.push(scan); store.set("scans", scans);
    offerReminders(parsed);
  } catch (e) {
    alert("Could not read the document: " + e.message + "\nTip: run with serve.py (see README) or save a BharatCode key.");
  }
  clearInterval(tick);
  btn.disabled = false; btn.textContent = "Read with AI (BharatCode Qwen vision)";
});

function DEMO_RESULT() {
  const kind = document.querySelector("input[name=doctype]:checked").value;
  if (kind === "labreport") return {
    doc_type: "labreport", doctor_or_lab: "City Diagnostics, Pune (sample)", date: "04 Nov 2026",
    medicines: [],
    lab_values: [
      { test: "TSH", value: "6.8", unit: "mIU/L", range: "0.4 - 4.0", flag: "abnormal" },
      { test: "Fasting Blood Sugar", value: "104", unit: "mg/dL", range: "70 - 100", flag: "borderline" },
      { test: "HbA1c", value: "5.6", unit: "%", range: "4.0 - 5.6", flag: "normal" },
      { test: "Vitamin D (25-OH)", value: "18", unit: "ng/mL", range: "30 - 100", flag: "abnormal" }
    ],
    summary_en: "Thyroid (TSH) is above range and vitamin D is low. Fasting sugar is borderline. Show this report to a doctor.",
    summary_hi: "थायरॉयड (TSH) सामान्य से ज़्यादा है और विटामिन D कम है। फास्टिंग शुगर बॉर्डरलाइन है। यह रिपोर्ट डॉक्टर को दिखाएँ।",
    interactions: [], confidence: "medium"
  };
  return {
    doc_type: "prescription", doctor_or_lab: "Dr. S. Kulkarni, Pune (sample)", date: "06 Nov 2026",
    medicines: [
      { name: "Dolo 650", salt: "Paracetamol 650 mg", dosage: "1 tablet", frequency: "Twice a day", timing: "After food, morning and night", duration: "5 days", purpose_en: "Fever and body ache", purpose_hi: "बुखार और बदन दर्द", generic_alt: "Paracetamol 650 mg", jan_aushadhi: "Paracetamol 650 mg tablet" },
      { name: "Pan 40", salt: "Pantoprazole 40 mg", dosage: "1 tablet", frequency: "Once a day", timing: "Before food, morning", duration: "5 days", purpose_en: "Acidity / stomach protection", purpose_hi: "एसिडिटी / पेट की सुरक्षा", generic_alt: "Pantoprazole 40 mg", jan_aushadhi: "Pantoprazole 40 mg tablet" },
      { name: "Sinarest", salt: "Paracetamol + Phenylephrine + CPM", dosage: "1 tablet", frequency: "At night", timing: "After food, night", duration: "3 days", purpose_en: "Cold and congestion", purpose_hi: "सर्दी और नाक बंद होना", generic_alt: "Paracetamol + Phenylephrine + Chlorpheniramine", jan_aushadhi: "ask pharmacist" }
    ],
    lab_values: [],
    summary_en: "Three medicines for fever, cold and acidity, for 3-5 days. Take Dolo and Pan 40 as written; Sinarest only at night because it causes drowsiness.",
    summary_hi: "बुखार, सर्दी और एसिडिटी की तीन दवाएँ, 3-5 दिन के लिए। Dolo और Pan 40 लिखे अनुसार लें; Sinarest सिर्फ रात को क्योंकि इससे नींद आती है।",
    interactions: ["Dolo 650 and Sinarest both contain paracetamol - do not add any other paracetamol medicine alongside."],
    confidence: "high"
  };
}

function renderScanResult(r, usedDemo) {
  const box = $("result"); box.classList.remove("hidden");
  let h = `<div class="card">`;
  if (usedDemo) h += `<p class="warn">Demo mode (no API key reached): showing a pre-computed read of the sample document. Connect a BharatCode key for live reading.</p>`;
  h += `<h2>What this document says</h2>
    <p class="muted">${escapeHTML(r.doctor_or_lab)} ${r.date ? "· " + escapeHTML(r.date) : ""}, AI confidence: ${escapeHTML(r.confidence || "medium")}</p>
    <p><strong>English:</strong> ${escapeHTML(r.summary_en)}</p>
    <p style="margin-top:6px"><strong>हिंदी:</strong> ${escapeHTML(r.summary_hi)}</p>`;
  if (r.medicines && r.medicines.length) {
    h += `<h3>Medicines (${r.medicines.length})</h3><table class="med-table"><thead><tr><th>Medicine</th><th>Salt</th><th>How to take</th><th>Purpose</th><th>Cheaper generic (Jan Aushadhi)</th></tr></thead><tbody>`;
    for (const m of r.medicines) h += `<tr><td><strong>${escapeHTML(m.name)}</strong><br><span class="muted small">${escapeHTML(m.dosage)}, ${escapeHTML(m.duration)}</span></td><td>${escapeHTML(m.salt)}</td><td>${escapeHTML(m.frequency)}<br><span class="muted small">${escapeHTML(m.timing)}</span></td><td>${escapeHTML(m.purpose_en)}<br><span class="muted small">${escapeHTML(m.purpose_hi)}</span></td><td>${escapeHTML(m.generic_alt)}<br><span class="muted small">${escapeHTML(m.jan_aushadhi)}</span></td></tr>`;
    h += `</tbody></table>`;
    const sched = r.medicines.map(m => `<li><strong>${escapeHTML(m.name)}</strong> - ${escapeHTML(m.timing)}</li>`).join("");
    h += `<h3>Day schedule</h3><ul>${sched}</ul>`;
  }
  if (r.lab_values && r.lab_values.length) {
    h += `<h3>Lab values</h3><table class="med-table"><thead><tr><th>Test</th><th>Result</th><th>Reference</th><th>Flag</th></tr></thead><tbody>`;
    for (const v of r.lab_values) {
      const cls = v.flag === "abnormal" ? "bad" : v.flag === "borderline" ? "warn" : "ok";
      h += `<tr><td>${escapeHTML(v.test)}</td><td><strong>${escapeHTML(v.value)} ${escapeHTML(v.unit)}</strong></td><td>${escapeHTML(v.range)}</td><td><span class="pill ${cls}">${escapeHTML(v.flag)}</span></td></tr>`;
    }
    h += `</tbody></table>`;
  }
  if (r.interactions && r.interactions.length) h += `<h3>Cautions</h3><ul>${r.interactions.map(i => `<li>${escapeHTML(i)}</li>`).join("")}</ul>`;
  h += `<p class="warn" style="margin-top:10px">Understanding aid only - confirm with your doctor or pharmacist before acting on this.</p></div>`;
  box.innerHTML = h;
}

function offerReminders(r) {
  if (!r.medicines || !r.medicines.length) return;
  if (!confirm("Add these medicines to Reminders for " + activeProfile().name + "?")) return;
  for (const m of r.medicines) {
    const time = /night/i.test(m.timing) ? "21:00" : /morning/i.test(m.timing) ? "08:00" : "13:00";
    reminders.push({ id: "r" + Date.now() + Math.random().toString(16).slice(2, 6), profileId: activeId, name: m.name + " (" + m.dosage + ")", time, active: true });
  }
  store.set("reminders", reminders);
  alert("Reminders added. See the Reminders tab.");
}

/* ---------------- timeline ---------------- */
function renderTimeline() {
  const mine = scans.filter(s => s.profileId === activeId).sort((a, b) => b.ts - a.ts);
  const box = $("timelineList");
  if (!mine.length) { box.innerHTML = `<p class="muted">Nothing yet for ${escapeHTML(activeProfile().name)}. Read a document first.</p>`; $("trendBox").classList.add("hidden"); return; }
  box.innerHTML = mine.map(s => `<div class="tl-item"><img src="${/^data:image\/(jpeg|png|webp);base64,[a-z0-9+/]*={0,2}$/i.test(s.thumb || "") ? s.thumb : ""}" alt=""><div><strong>${s.kind === "labreport" ? "Lab report" : "Prescription"}</strong>, ${escapeHTML(s.result.doctor_or_lab || "document")}<div class="when">${new Date(s.ts).toLocaleString("en-IN")}</div><div class="small muted">${escapeHTML((s.result.summary_en || "").slice(0, 110))}…</div></div></div>`).join("");
  // trend: same-test values across lab reports
  const series = {};
  for (const s of mine.filter(x => x.result.lab_values)) {
    for (const v of s.result.lab_values) {
      const num = parseFloat(v.value); if (isNaN(num)) continue;
      (series[v.test] = series[v.test] || []).push({ ts: s.ts, v: num, unit: v.unit });
    }
  }
  const names = Object.keys(series).filter(k => series[k].length >= 1);
  if (!names.length) { $("trendBox").classList.add("hidden"); return; }
  $("trendBox").classList.remove("hidden");
  const c = $("trendChart"), ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  const colors = ["#0e7c6b", "#b7791f", "#c53030", "#2b6cb0"];
  names.slice(0, 4).forEach((name, i) => {
    const pts = series[name].sort((a, b) => a.ts - b.ts);
    const vals = pts.map(p => p.v), min = Math.min(...vals), max = Math.max(...vals), span = (max - min) || 1;
    ctx.strokeStyle = colors[i]; ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach((p, j) => {
      const x = 40 + j * ((c.width - 80) / Math.max(1, pts.length - 1));
      const y = c.height - 30 - ((p.v - min) / span) * (c.height - 60);
      j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      ctx.fillStyle = colors[i]; ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill();
      ctx.fillText(String(p.v), x - 8, y - 8);
      ctx.beginPath(); ctx.moveTo(x, y);
    });
    ctx.stroke();
  });
  $("trendLegend").innerHTML = names.slice(0, 4).map((n, i) => `<span style="color:${colors[i]}">●</span> ${n}`).join(" &nbsp; ") + " (per-test scales differ; older → newer)";
}

/* ---------------- reminders ---------------- */
function renderReminders() {
  $("remMember").innerHTML = profiles.map(p => `<option value="${escapeHTML(p.id)}" ${p.id === activeId ? "selected" : ""}>${escapeHTML(p.name)}</option>`).join("");
  const mine = reminders.filter(r => r.profileId === activeId);
  const now = new Date(), hhmm = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  $("reminderList").innerHTML = mine.length ? mine.map(r => `<div class="rem-row ${r.time <= hhmm && r.active ? "due" : ""}"><strong>${escapeHTML(r.time)}</strong> ${escapeHTML(r.name)} <button class="btn small danger" data-reminder-id="${escapeHTML(r.id)}">Remove</button></div>`).join("") : `<p class="muted">No reminders for ${escapeHTML(activeProfile().name)} yet.</p>`;
  $("reminderList").querySelectorAll("[data-reminder-id]").forEach(btn => btn.addEventListener("click", () => delReminder(btn.dataset.reminderId)));
}
window.delReminder = (id) => { reminders = reminders.filter(r => r.id !== id); store.set("reminders", reminders); renderReminders(); };
$("remAdd").addEventListener("click", () => {
  const name = $("remName").value.trim(), time = $("remTime").value, pid = $("remMember").value;
  if (!name || !time) return;
  reminders.push({ id: "r" + Date.now(), profileId: pid, name, time, active: true });
  store.set("reminders", reminders); $("remName").value = ""; renderReminders();
});
setInterval(() => {
  const now = new Date(), hhmm = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  const due = reminders.find(r => r.active && r.time === hhmm);
  if (due) { due.active = false; store.set("reminders", reminders); alert("💊 Time for " + due.name + " (" + (profiles.find(p => p.id === due.profileId) || {}).name + ")"); renderReminders(); }
}, 20000);

/* ---------------- family ---------------- */
function renderHomeActivity() {
  const mins = 12 + Math.floor((Date.now() / 60000) % 50);
  const okk = mins < 90;
  $("homeActivity").innerHTML = `<div class="rem-row ${okk ? "" : "due"}"><strong>🏠 Aai (72), at home</strong>
    <span>Last movement: ${mins} min ago (kitchen), night sleep: 7h 10m, 2 wake-ups</span>
    <span class="pill ${okk ? "ok" : "bad"}">${okk ? "normal" : "check on her"}</span>
    <span class="demo-pill">simulated sensor feed</span></div>`;
}
function renderFamily() {
  renderHomeActivity();
  $("familyList").innerHTML = profiles.map(p => `<div class="doc-card"><h4>${escapeHTML(p.name)} ${p.id === activeId ? '<span class="badge-active">active</span>' : ""}</h4><p class="muted small">Age: ${escapeHTML(p.age || "—")}, Blood: ${escapeHTML(p.blood || "—")}</p><div class="formrow"><button class="btn ghost small" data-switch-profile="${escapeHTML(p.id)}">Switch</button>${profiles.length > 1 ? `<button class="btn small danger" data-delete-profile="${escapeHTML(p.id)}">Remove</button>` : ""}</div></div>`).join("");
  $("familyList").querySelectorAll("[data-switch-profile]").forEach(btn => btn.addEventListener("click", () => switchProfile(btn.dataset.switchProfile)));
  $("familyList").querySelectorAll("[data-delete-profile]").forEach(btn => btn.addEventListener("click", () => delProfile(btn.dataset.deleteProfile)));
}
window.switchProfile = (id) => { activeId = id; store.set("active", id); renderFamily(); };
window.delProfile = (id) => {
  profiles = profiles.filter(p => p.id !== id);
  if (activeId === id) activeId = profiles[0].id;
  store.set("profiles", profiles); store.set("active", activeId); renderFamily();
};
$("famAdd").addEventListener("click", () => {
  const name = $("famName").value.trim(); if (!name) return;
  profiles.push({ id: "p" + Date.now(), name, age: $("famAge").value, blood: $("famBlood").value, conditions: "", allergies: "", emergencyContact: "" });
  store.set("profiles", profiles); $("famName").value = ""; $("famAge").value = ""; $("famBlood").value = ""; renderFamily();
});

/* ---------------- emergency card ---------------- */
function renderEcard() {
  const p = activeProfile();
  const meds = scans.filter(s => s.profileId === p.id && s.result.medicines).flatMap(s => s.result.medicines.map(m => m.name)).slice(0, 5);
  const text = ["EMERGENCY HEALTH CARD", "Name: " + p.name, "Age: " + (p.age || "-"), "Blood: " + (p.blood || "-"),
    "Conditions: " + (p.conditions || "none listed"), "Allergies: " + (p.allergies || "none listed"),
    "Medicines: " + (meds.join(", ") || "none listed"), "Emergency contact: " + (p.emergencyContact || "-")].join("\n");
  $("ecardBox").innerHTML = `<div class="ecard-inner"><h3>🚨 ${escapeHTML(p.name)}</h3>
    <p><strong>Blood group:</strong> ${escapeHTML(p.blood || "—")}</p><p><strong>Conditions:</strong> ${escapeHTML(p.conditions || "none listed")}</p>
    <p><strong>Allergies:</strong> ${escapeHTML(p.allergies || "none listed")}</p><p><strong>Current medicines:</strong> ${escapeHTML(meds.join(", ") || "none listed")}</p>
    <p><strong>Emergency contact:</strong> ${escapeHTML(p.emergencyContact || "—")}</p>
    <div class="formrow"><input id="ecBlood" class="inp" style="max-width:120px" placeholder="Blood group" value="${escapeHTML(p.blood)}"><input id="ecCond" class="inp" placeholder="Conditions" value="${escapeHTML(p.conditions)}"><input id="ecAllergy" class="inp" placeholder="Allergies" value="${escapeHTML(p.allergies)}"><input id="ecContact" class="inp" placeholder="Emergency contact" value="${escapeHTML(p.emergencyContact)}"><button class="btn primary small" onclick="saveEcard()">Save</button></div>
    <div id="qr"></div></div>`;
  if (window.QRCode) new QRCode($("qr"), { text, width: 160, height: 160 });
}
window.saveEcard = () => {
  const p = activeProfile();
  p.blood = $("ecBlood").value; p.conditions = $("ecCond").value; p.allergies = $("ecAllergy").value; p.emergencyContact = $("ecContact").value;
  store.set("profiles", profiles); renderEcard();
};

/* ---------------- symptom triage (rule-based, no diagnosis) ---------------- */
$("symGo").addEventListener("click", () => {
  const t = $("symInput").value.toLowerCase();
  if (!t.trim()) return;
  const redFlags = ["chest pain", "can't breathe", "cannot breathe", "breathing", "unconscious", "seizure", "stroke", "paralysis", "heavy bleeding", "suicidal", "severe burn"];
  const hit = redFlags.find(f => t.includes(f));
  let h = "";
  if (hit) h = `<div class="notice" style="border-color:var(--bad);background:var(--red-bg);color:var(--bad)"><strong>Seek emergency care now (call 108/112).</strong> Your description mentions "${hit}" which can be serious. Do not wait for an app.</div>`;
  else {
    const map = [
      [["fever", "cold", "cough", "throat", "body ache", "chills"], "General physician", "Usually routine - see a doctor within 1-2 days if it persists or worsens."],
      [["stomach", "acidity", "vomit", "loose motion", "diarrhea", "gas"], "General physician / gastroenterologist", "Hydrate well. See a doctor if vomiting or loose motions last beyond a day, or there is blood."],
      [["skin", "rash", "itch", "pimple", "acne"], "Dermatologist", "Usually non-urgent - book a routine visit."],
      [["eye", "vision"], "Ophthalmologist", "Sudden vision change is urgent; otherwise routine."],
      [["tooth", "teeth", "gum"], "Dentist", "Routine unless severe pain/swelling - then same day."],
      ["ear nose throat ent sinus".split(" "), "ENT specialist", "Routine unless hearing loss or severe pain."],
      [["knee", "joint", "back pain", "fracture", "sprain"], "Orthopedic", "Routine unless injury with deformity - then same day."],
      [["headache", "migraine", "dizzy"], "General physician / neurologist", "Routine unless sudden worst-ever headache - then emergency."],
      ["period pregnancy pcos thyroid sugar diabetes anxiety sleep stress".split(" "), "General physician first; they will refer if needed", "Routine booking is fine."]
    ];
    const m = map.find(([keys]) => keys.some(k => t.includes(k)));
    h = `<div class="notice"><strong>Not an emergency pattern.</strong><br>Suggested specialist: <strong>${m ? m[1] : "General physician"}</strong><br>${m ? m[2] : "Book a routine visit; go sooner if anything feels seriously wrong."}<br><br>You can book a (demo) appointment in the Appointments tab. This is triage guidance only, not a diagnosis.</div>`;
  }
  $("symResult").innerHTML = h;
});

/* ---------------- appointments + queue (demo data, Practo/BookMyShow style) ---------------- */
const DOCTORS = [
  { id: "d1", name: "Dr. Sneha Kulkarni", spec: "General Physician", specKey: "physician", hospital: "CityCare Hospital", area: "FC Road, Pune", dist: "2.1 km", exp: 12, rating: 4.8, stories: 412, fee: 500, avail: "today", color: "#148a58",
    days: { Today: { Morning: [["09:00", 1], ["09:30", 1], ["10:00", 0], ["11:15", 0]], Evening: [["17:00", 0], ["17:30", 0], ["18:00", 0]] }, Tomorrow: { Morning: [["08:30", 0], ["09:00", 0], ["10:30", 0]], Evening: [["17:00", 0], ["18:30", 0]] } } },
  { id: "d2", name: "Dr. Arjun Mehta", spec: "Cardiologist", specKey: "cardio", hospital: "Ruby Hall Clinic", area: "Sassoon Road, Pune", dist: "4.6 km", exp: 19, rating: 4.9, stories: 687, fee: 1200, avail: "tomorrow", color: "#7c3aed",
    days: { Today: {}, Tomorrow: { Morning: [["07:30", 0], ["08:00", 0]], Night: [["21:00", 0], ["21:30", 0]] } } },
  { id: "d3", name: "Dr. Priya Nair", spec: "Endocrinologist", specKey: "endo", hospital: "CityCare Hospital", area: "FC Road, Pune", dist: "2.1 km", exp: 9, rating: 4.7, stories: 238, fee: 900, avail: "today", color: "#0369a1",
    days: { Today: { Morning: [["11:00", 1], ["11:30", 0]], Evening: [["19:00", 0], ["19:30", 0]] }, Tomorrow: { Morning: [["10:00", 0], ["10:30", 0]], Evening: [["18:00", 0]] } } },
  { id: "d4", name: "Dr. Rohan Deshmukh", spec: "Orthopedic", specKey: "ortho", hospital: "Jehangir Hospital", area: "Bund Garden, Pune", dist: "5.3 km", exp: 15, rating: 4.6, stories: 355, fee: 800, avail: "today", color: "#b45309",
    days: { Today: { Morning: [["08:00", 0], ["08:30", 0]], Night: [["21:00", 0], ["21:30", 0]] }, Tomorrow: { Morning: [["08:00", 0], ["09:00", 1]], Evening: [["20:30", 0]] } } }
];
const SPEC_FILTERS = [["all", "All"], ["physician", "General Physician"], ["cardio", "Cardiologist"], ["endo", "Endocrinologist"], ["ortho", "Orthopedic"]];
let apptFilter = "all", apptQuery = "";
function initials(name) { return name.replace("Dr. ", "").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(); }
function nextSlot(d) {
  for (const [day, groups] of Object.entries(d.days)) for (const slots of Object.values(groups)) {
    const free = slots.find(s => !s[1]); if (free) return day + " " + free[0];
  }
  return null;
}
function renderDoctors() {
  $("apptChips").innerHTML = SPEC_FILTERS.map(([k, label]) => `<button class="appt-chip ${apptFilter === k ? "active" : ""}" onclick="setApptFilter('${k}')">${label}</button>`).join("");
  const q = apptQuery.toLowerCase();
  const list = DOCTORS.filter(d => (apptFilter === "all" || d.specKey === apptFilter) && (!q || (d.name + d.spec + d.hospital + d.area).toLowerCase().includes(q)));
  $("doctorList").innerHTML = list.length ? list.map(d => {
    const ns = nextSlot(d);
    return `<div class="doc-row">
      <div class="doc-avatar" style="background:${d.color}">${initials(d.name)}</div>
      <div class="doc-mid">
        <div class="doc-name">${d.name}</div>
        <div class="doc-sub">${d.spec}, ${d.exp} yrs exp</div>
        <div class="doc-sub">${d.hospital}, ${d.area}, ${d.dist}</div>
        <div class="doc-meta"><span class="doc-rating">★ ${d.rating}</span><span class="muted small">${d.stories} patient stories</span></div>
      </div>
      <div class="doc-right">
        <div class="doc-fee">₹${d.fee}</div>
        <div class="doc-avail ${d.avail === "today" ? "now" : "later"}">${d.avail === "today" ? "Available Today" : "Next: Tomorrow"}</div>
        ${ns ? `<div class="muted small">Earliest: ${ns}</div>` : ""}
        <button class="btn primary small" onclick="pickDoctor('${d.id}')">Book</button>
      </div>
    </div>`;
  }).join("") : `<p class="muted" style="margin-top:14px">No doctors match - try another specialty or search.</p>`;
}
window.setApptFilter = k => { apptFilter = k; renderDoctors(); };
$("apptQuery").addEventListener("input", e => { apptQuery = e.target.value; renderDoctors(); });
let pickState = { id: null, day: "Today" };
window.pickDoctor = (id) => {
  pickState = { id, day: "Today" };
  $("slotBox").classList.remove("hidden");
  renderSlotPicker();
  $("slotBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
};
window.setPickDay = day => { pickState.day = day; renderSlotPicker(); };
function renderSlotPicker() {
  const d = DOCTORS.find(x => x.id === pickState.id);
  $("slotTitle").textContent = d.name + ", " + d.hospital;
  const days = Object.keys(d.days);
  $("dayChips").innerHTML = days.map(day => `<button class="day-chip ${pickState.day === day ? "active" : ""}" onclick="setPickDay('${day}')">${day}</button>`).join("");
  const groups = d.days[pickState.day] || {};
  const html = Object.entries(groups).map(([label, slots]) => `<div class="slot-group"><div class="slot-group-label">${label}</div><div class="slots">${slots.map(([t, taken]) => `<button class="slot ${taken ? "taken" : ""}" ${taken ? "disabled" : ""} onclick="bookSlot('${d.id}','${pickState.day} ${t}')">${t}</button>`).join("")}</div></div>`).join("");
  $("slots").innerHTML = html;
  const anyFree = Object.values(groups).flat().some(s => !s[1]);
  $("reschedule").classList.toggle("hidden", anyFree || pickState.day !== "Today");
  if (!anyFree && pickState.day === "Today") {
    const tmr = d.days.Tomorrow || {};
    const sug = Object.entries(tmr).flatMap(([, ss]) => ss.filter(s => !s[1]).map(s => s[0])).slice(0, 3);
    $("reschedule").innerHTML = `<strong>No slots today with ${d.name}.</strong> Earliest tomorrow: ` + (sug.length ? sug.map(t => `<button class="slot" onclick="bookSlot('${d.id}','Tomorrow ${t}')">${t}</button>`).join(" ") : "none - try another doctor");
  }
}
window.bookSlot = (id, slot) => {
  const d = DOCTORS.find(x => x.id === id);
  booking = { doctor: d.name, spec: d.spec, hospital: d.hospital + ", " + d.area, fee: d.fee, slot, token: "T-" + (100 + Math.floor(Math.random() * 900)), ahead: 4 + Math.floor(Math.random() * 4) };
  store.set("booking", booking);
  $("bookingConfirm").innerHTML = `<div class="ticket">
    <div class="ticket-head"><span class="ticket-check">✓</span> Appointment booked <span class="demo-pill">demo</span></div>
    <div class="ticket-body">
      <div><div class="doc-name">${d.name}</div><div class="doc-sub">${d.spec}, ${d.hospital}, ${d.area}</div></div>
      <div class="ticket-row"><span>Slot</span><strong>${slot}</strong></div>
      <div class="ticket-row"><span>Token</span><strong class="ticket-token">${booking.token}</strong></div>
      <div class="ticket-row"><span>Fee</span><strong>₹${d.fee} <span class="muted small">(pay at clinic)</span></strong></div>
      <div class="ticket-qr" id="ticketQr"></div>
    </div>
    <div class="ticket-foot">Show the token at reception, Track your turn live in the Queue tab</div>
  </div>`;
  if (window.QRCode) new QRCode($("ticketQr"), { text: `SwasthyaSetu booking ${booking.token} | ${d.name} | ${slot}`, width: 110, height: 110 });
  renderQueue();
};
function renderQueue() {
  const box = $("queueBox");
  if (!booking) { box.innerHTML = `<p class="muted">No active token. Book an appointment first (demo data).</p>`; return; }
  const eta = booking.ahead * 8 + Math.round(crowdCount / 6);
  const pct = Math.max(0, Math.min(100, 100 - booking.ahead * 16));
  box.innerHTML = `<p class="queue-token">${escapeHTML(booking.doctor)}, ${escapeHTML(booking.hospital)}<br>Token <strong>${escapeHTML(booking.token)}</strong>, Slot ${escapeHTML(booking.slot)}</p>
    <p class="queue-big">${booking.ahead > 0 ? booking.ahead + " patients ahead" : "Your turn now!"}</p>
    <div class="progress"><div style="width:${pct}%"></div></div>
    <p class="muted">Estimated wait: ~${eta} min ${booking.ahead <= 2 ? "· we will alert you when 2 patients are left" : ""}</p>
    <p class="muted small">Waiting room now: <strong>${crowdCount} people</strong> <span class="demo-pill">simulated WiFi crowd count</span></p>
    <button class="btn ghost small" onclick="advanceQueue()">Simulate queue moving</button>
    <button class="btn danger small" onclick="cancelToken()">Cancel token</button>`;
}
window.advanceQueue = () => { if (!booking) return; booking.ahead = Math.max(0, booking.ahead - 1); store.set("booking", booking); if (booking.ahead === 2) alert("🔔 Only 2 patients ahead - please head to the clinic."); renderQueue(); };
window.cancelToken = () => { booking = null; store.set("booking", null); renderQueue(); };

/* ---------------- lab price compare (demo) ---------------- */
const LAB_TESTS = { "Thyroid Profile (TSH)": [[380, "City Diagnostics"], [450, "Metropolis"], [299, "HealthFirst Labs"]], "HbA1c": [[350, "City Diagnostics"], [420, "Metropolis"], [330, "HealthFirst Labs"]], "Vitamin D 25-OH": [[900, "City Diagnostics"], [1150, "Metropolis"], [799, "HealthFirst Labs"]], "CBC": [[250, "City Diagnostics"], [300, "Metropolis"], [220, "HealthFirst Labs"]] };
function renderLabPrices() {
  const sel = $("labTest");
  sel.innerHTML = Object.keys(LAB_TESTS).map(t => `<option>${t}</option>`).join("");
  const show = () => {
    const rows = LAB_TESTS[sel.value].slice().sort((a, b) => a[0] - b[0]);
    $("labRows").innerHTML = `<table class="med-table"><thead><tr><th>Lab</th><th>Price</th><th></th></tr></thead><tbody>${rows.map(([p, l], i) => `<tr><td>${l}</td><td><strong>₹${p}</strong> ${i === 0 ? '<span class="pill ok">lowest</span>' : ""}</td><td><button class="btn ghost small" onclick="bookHomeSample('${l}','${sel.value}',${p})">Home sample (demo)</button></td></tr>`).join("")}</tbody></table>`;
  };
  sel.onchange = show; show();
}
window.bookHomeSample = (lab, test, price) => {
  $("labBooked").innerHTML = `<div class="confirm-card"><strong>Home sample collection booked (demo)</strong><br>${test} at ${lab}, ₹${price}<br>Collection: tomorrow 7-9 AM. Pay after sample collection.</div>`;
};

/* ---------------- hospital: live 3D ward + family view + live bill + care log (demo) ---------------- */
const NURSES = ["Nurse Asha", "Nurse Reema", "Nurse Joseph", "Dr. on rounds"];
function mkBill(seed) { return seed.map(([t, item, amt]) => ({ t, item, amt })); }
let PATIENTS = [
  { id: "w1", xy3: [-4.2,-1.6], brpm: 16, sleep: "sleeping", stillMin: 42, bed: "ICU-2", zone: "ICU", name: "R. Patil", age: 58, prob: "Post-surgery recovery", day: "Day 2", sys: 128, dia: 84, hr: 88, spo2: 97, temp: 98.6, xy: [70, 60],
    meds: [["Ceftriaxone", "1 g", "IV"], ["Paracetamol", "500 mg", "Oral"], ["Dressing change", "-", "-"]],
    bill: mkBill([["08:00", "ICU room charge (today so far)", 4200], ["08:05", "Ceftriaxone 1 g IV", 340], ["09:30", "Doctor round", 800]]), log: [] },
  { id: "w2", xy3: [-0.6,-1.6], brpm: 21, sleep: "restless", stillMin: 9, bed: "ICU-5", zone: "ICU", name: "S. Shaikh", age: 63, prob: "Cardiac observation", day: "Day 1", sys: 150, dia: 96, hr: 104, spo2: 94, temp: 99.1, xy: [260, 60],
    meds: [["Sorbitrate", "5 mg", "Sublingual"], ["Atorvastatin", "20 mg", "Oral"], ["ECG recording", "-", "-"]],
    bill: mkBill([["08:00", "ICU room charge (today so far)", 4200], ["08:20", "Cardiac monitor (hourly)", 250]]), log: [] },
  { id: "w3", xy3: [3.6,-1.6], brpm: 18, sleep: "sleeping", stillMin: 67, bed: "G-12", zone: "General", name: "M. Iyer", age: 34, prob: "Dengue fever", day: "Day 3", sys: 110, dia: 72, hr: 92, spo2: 98, temp: 100.4, xy: [450, 60],
    meds: [["Paracetamol", "650 mg", "Oral"], ["ORS fluids", "500 ml", "Oral"], ["Platelet count test", "-", "Lab"]],
    bill: mkBill([["08:00", "General ward bed (today so far)", 1500], ["07:45", "Platelet count", 350]]), log: [] },
  { id: "w4", xy3: [-4.2,1.6], brpm: 14, sleep: "awake", stillMin: 3, bed: "G-15", zone: "General", name: "A. Joshi", age: 27, prob: "Fracture - leg", day: "Day 4", sys: 118, dia: 78, hr: 76, spo2: 99, temp: 98.2, xy: [70, 200],
    meds: [["Aceclofenac", "100 mg", "Oral"], ["Calcium + D3", "1 tab", "Oral"], ["Physiotherapy", "20 min", "-"]],
    bill: mkBill([["08:00", "General ward bed (today so far)", 1500], ["09:00", "Physiotherapy session", 500]]), log: [] },
  { id: "w5", xy3: [-0.6,1.6], brpm: 22, sleep: "restless", stillMin: 14, bed: "P-3", zone: "Private", name: "K. Singh", age: 45, prob: "Pneumonia", day: "Day 2", sys: 135, dia: 88, hr: 96, spo2: 93, temp: 100.1, xy: [260, 200],
    meds: [["Azithromycin", "500 mg", "Oral"], ["Nebulisation", "2.5 mg", "Inhalation"], ["Chest X-ray", "-", "Radiology"]],
    bill: mkBill([["08:00", "Private room (today so far)", 3500], ["08:40", "Nebulisation", 200]]), log: [] },
  { id: "w6", xy3: [3.6,1.6], brpm: 20, sleep: "sleeping", stillMin: 55, bed: "G-18", zone: "General", name: "L. Verma", age: 71, prob: "COPD exacerbation", day: "Day 5", sys: 122, dia: 80, hr: 84, spo2: 95, temp: 98.8, xy: [450, 200],
    meds: [["Budesonide neb", "0.5 mg", "Inhalation"], ["Oxygen support", "2 L/min", "-"], ["Theophylline", "200 mg", "Oral"]],
    bill: mkBill([["08:00", "General ward bed (today so far)", 1500], ["08:10", "Oxygen (per hr)", 120]]), log: [] }
];
let careLog = [];
let wardSelected = "w2", famSelected = "w2", billSelected = "w2";
const pat = id => PATIENTS.find(p => p.id === id);
function patStatus(p) { return (p.hr > 110 || p.spo2 < 92) ? "critical" : (p.hr > 100 || p.spo2 < 95 || p.sys > 140) ? "review" : "stable"; }
function jitter(v, amt, lo, hi) { return Math.max(lo, Math.min(hi, v + (Math.random() - 0.5) * amt)); }
function nowHM() { const d = new Date(); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }

/* 3D ward */
let wardInited = false;
function renderStats() {
  const occ = PATIENTS.length, total = 12;
  const crit = PATIENTS.filter(p => patStatus(p) === "critical").length;
  const rev = PATIENTS.filter(p => patStatus(p) === "review").length;
  const revenue = PATIENTS.reduce((sum, p) => sum + p.bill.reduce((x, b) => x + b.amt, 0), 0);
  const entries = careLog.length;
  $("statRow").innerHTML = [
    ["Beds occupied", occ + "/" + total, Math.round(occ / total * 100) + "% occupancy"],
    ["Patients needing review", crit + rev, crit + " critical, " + rev + " review"],
    ["Care log entries today", entries, "nurse-recorded"],
    ["Revenue today", "₹" + revenue.toLocaleString("en-IN"), "across " + PATIENTS.length + " admitted patients"]
  ].map(([l, v, sub]) => `<div class="stat-card"><div class="stat-label">${l}</div><div class="stat-num">${v}</div><div class="stat-sub">${sub}</div></div>`).join("");
}
function barChart(id, labels, values, color) {
  const c = $(id); if (!c) return; const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  const max = Math.max(...values, 1), bw = c.width / values.length;
  values.forEach((v, i) => {
    const h = (v / max) * (c.height - 46), x = i * bw + bw * 0.22, w = bw * 0.56;
    ctx.fillStyle = color; ctx.beginPath();
    ctx.roundRect(x, c.height - 26 - h, w, h, 6); ctx.fill();
    ctx.fillStyle = "#132a26"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(String(v), x + w / 2, c.height - 32 - h);
    ctx.fillStyle = "#5f7470"; ctx.font = "11px sans-serif";
    ctx.fillText(labels[i], x + w / 2, c.height - 8);
  });
}
function renderDashboard() {
  renderStats();
  const zones = {};
  for (const p of PATIENTS) zones[p.zone] = (zones[p.zone] || 0) + 1;
  barChart("chartCensus", Object.keys(zones), Object.values(zones), "#148a58");
  barChart("chartBill", PATIENTS.map(p => p.bed), PATIENTS.map(p => p.bill.reduce((x, b) => x + b.amt, 0)), "#0e6b46");
}
function renderWard() {
  renderDashboard();
  if (!wardInited) {
    try { Ward3D.init($("wardCanvas"), PATIENTS, id => selectWard(id)); wardInited = true; }
    catch (e) { console.warn("ward3d failed", e); }
  }
  if (wardInited) Ward3D.sync(PATIENTS, wardSelected);
  renderSensorAlerts();
  const p = pat(wardSelected), st = patStatus(p);
  $("wardPatient").innerHTML = `<h3>${p.bed}, ${p.name}</h3>
    <p class="muted">${p.prob}, ${p.day}, Age ${p.age}, ${p.zone}</p>
    <p><span class="pill ${st === "stable" ? "ok" : st === "review" ? "warn" : "bad"}">${st}</span> <span class="live-dot"></span></p>
    <table class="tbl" style="margin-top:8px"><tbody>
      <tr><td>Heart rate</td><td><strong>${Math.round(p.hr)} bpm</strong></td></tr>
      <tr><td>SpO₂</td><td><strong>${Math.round(p.spo2)}%</strong></td></tr>
      <tr><td>BP</td><td><strong>${Math.round(p.sys)}/${Math.round(p.dia)} mmHg</strong></td></tr>
      <tr><td>Temp</td><td><strong>${p.temp.toFixed(1)} °F</strong></td></tr>
      <tr><td>Bill so far today</td><td><strong>₹${p.bill.reduce((s, b) => s + b.amt, 0).toLocaleString("en-IN")}</strong></td></tr>
    </tbody></table>
    <div class="formrow" style="margin-top:10px"><button class="btn primary small" onclick="gotoFamily('${p.id}')">Open family view</button></div>`;
}
window.selectWard = id => { wardSelected = id; renderWard(); };
window.gotoFamily = id => { famSelected = id; billSelected = id; syncSelectors(); document.querySelector('.hosp-tab[data-hview="family"]').click(); };

/* sub-view nav */
document.querySelectorAll(".hosp-tab").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll(".hosp-tab").forEach(x => x.classList.toggle("active", x === b));
  document.querySelectorAll(".hview").forEach(v => v.classList.toggle("active", v.id === "hview-" + b.dataset.hview));
  if (b.dataset.hview === "family") renderFamView();
  if (b.dataset.hview === "bill") renderBill();
  if (b.dataset.hview === "carelog") renderCareLog();
  if (b.dataset.hview === "night") renderNight();
}));
function syncSelectors() {
  $("famSelect").innerHTML = PATIENTS.map(p => `<option value="${p.id}" ${p.id === famSelected ? "selected" : ""}>${p.bed}, ${p.name}</option>`).join("");
  $("billSelect").innerHTML = PATIENTS.map(p => `<option value="${p.id}" ${p.id === billSelected ? "selected" : ""}>${p.bed}, ${p.name}</option>`).join("");
}
$("famSelect").addEventListener("change", e => { famSelected = e.target.value; renderFamView(); });
$("billSelect").addEventListener("change", e => { billSelected = e.target.value; renderBill(); });

/* family view */
let hrHist = {}; // id -> array of hr
/* Animated body view: original lightweight SVG, inspired by the technique of
   open 3D anatomy projects (Z-Anatomy is Unity/CC-BY-SA, too heavy to embed). */
let bodyInited = false;
function renderBody(p) {
  if (!bodyInited) { try { BodyView.init($("bodyCanvas")); bodyInited = true; } catch (e) { console.warn("body3d failed", e); } }
  if (bodyInited) {
    BodyView.setHR(p.hr);
    const ready = BodyView.isReady(), failed = BodyView.hasFailed();
    $("bodyCanvas").style.display = ready ? "block" : "none";
    $("fvBody").style.display = ready ? "none" : "block";
    if (ready) return; // 3D body replaces the SVG fallback
  }
  const beat = (60 / Math.max(40, p.hr)).toFixed(2); // seconds per heartbeat
  const spo2Col = p.spo2 < 94 ? "#ef4444" : p.spo2 < 96 ? "#f59e0b" : "#38bdf8";
  $("fvBody").innerHTML = `<svg viewBox="0 0 200 260" class="body-svg" aria-label="animated body view">
    <g class="body-outline">
      <circle cx="100" cy="30" r="18"/>
      <path d="M78 52 Q100 44 122 52 L128 96 Q130 118 124 138 L120 180 L124 236 Q124 248 114 248 L108 248 L104 186 L96 186 L92 248 L86 248 Q76 248 76 236 L80 180 L76 138 Q70 118 72 96 Z"/>
      <path d="M76 60 Q58 76 56 104 Q55 122 62 130 L70 126 Q64 112 66 96 L74 72 Z"/>
      <path d="M124 60 Q142 76 144 104 Q145 122 138 130 L130 126 Q136 112 134 96 L126 72 Z"/>
    </g>
    <g class="lungs" style="animation-duration:3.4s">
      <ellipse cx="88" cy="88" rx="12" ry="17" fill="${spo2Col}" opacity=".75"/>
      <ellipse cx="112" cy="88" rx="12" ry="17" fill="${spo2Col}" opacity=".75"/>
    </g>
    <g transform="translate(100 108)"><path class="heart-beat" style="animation-duration:${beat}s"
      d="M0 6 C-1 0 -8 -4 -13 0 C-19 5 -14 14 0 24 C14 14 19 5 13 0 C8 -4 1 0 0 6 Z" fill="#ef4444"/></g>
    <g class="body-labels">
      <text x="150" y="92" class="bl">SpO₂ ${Math.round(p.spo2)}%</text>
      <text x="140" y="122" class="bl">♥ ${Math.round(p.hr)} bpm</text>
      <text x="6" y="196" class="bl">${p.temp.toFixed(1)} °F</text>
    </g>
  </svg>`;
}
function renderFamView() {
  const p = pat(famSelected); if (!p) return;
  const st = patStatus(p);
  $("fvHeader").innerHTML = `<h2 style="margin-top:4px">${p.name} <span class="muted" style="font-size:14px;font-weight:400">· ${p.bed}, ${p.zone}, ${p.prob}, ${p.day}</span></h2>
    <span class="pill ${st === "stable" ? "ok" : st === "review" ? "warn" : "bad"}">${st}</span>`;
  $("fvUpdated").textContent = "updated " + nowHM() + ":" + String(new Date().getSeconds()).padStart(2, "0");
  $("fvHr").textContent = Math.round(p.hr);
  $("fvSpo2").textContent = Math.round(p.spo2);
  $("fvBp").textContent = Math.round(p.sys) + "/" + Math.round(p.dia);
  $("fvTemp").textContent = p.temp.toFixed(1);
  const rf = $("fvRf");
  if (p.zone === "ICU") { rf.classList.remove("hidden"); $("fvBrpm").textContent = p.brpm; }
  else rf.classList.add("hidden");
  const active = sensorAlerts.find(a => a.pid === p.id && Date.now() < (p.alertUntil || 0));
  $("fvAlert").innerHTML = active ? `<div class="notice" style="border-color:var(--bad);background:var(--red-bg);color:var(--bad)"><strong>⚠ ${active.text}</strong> (${active.t}) - care team notified. <span class="demo-pill">simulated sensor feed</span></div>` : "";
  renderBody(p);
  const h = hrHist[p.id] = (hrHist[p.id] || []).concat(Math.round(p.hr)).slice(-40);
  const c = $("fvTrend"), ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  const min = Math.min(...h, 60), max = Math.max(...h, 110);
  ctx.strokeStyle = "#148a58"; ctx.lineWidth = 2; ctx.beginPath();
  h.forEach((v, i) => { const x = 10 + i * ((c.width - 20) / 39), y = c.height - 15 - ((v - min) / (max - min)) * (c.height - 30); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  ctx.fillStyle = "#5f7470"; ctx.font = "11px sans-serif"; ctx.fillText(min + " bpm", 10, c.height - 3); ctx.fillText(max + " bpm", 10, 12);
  const mine = careLog.filter(l => l.pid === p.id).slice(-8).reverse();
  $("fvLog").innerHTML = mine.length ? mine.map(l => `<div class="rem-row"><strong>${l.t}</strong> <span>${l.entry}${l.dose !== "-" ? " - " + l.dose : ""}</span> <span class="pill ok">${l.route}</span> <span class="muted small">${l.by}</span></div>`).join("") : `<p class="muted">No entries yet - they appear as the care team records them.</p>`;
}

/* care log */
function renderNight() {
  const rows = PATIENTS.map(p => {
    const stCol = p.sleep === "sleeping" ? "ok" : p.sleep === "restless" ? "warn" : "bad";
    return `<tr><td>${p.bed}</td><td>${p.name}</td><td><span class="pill ${stCol}">${p.sleep}</span></td><td>${p.stillMin} min</td><td>${p.brpm} brpm</td><td>${p.sleep === "awake" && p.stillMin < 5 ? "at washroom / with nurse (simulated)" : p.stillMin > 60 ? "long stillness - check on rounds" : "normal"}</td></tr>`;
  }).join("");
  $("nightTable").querySelector("tbody").innerHTML = rows;
}
function renderCareLog() {
  $("careLogTable").querySelector("tbody").innerHTML = careLog.slice().reverse().map(l =>
    `<tr><td>${l.t}</td><td>${pat(l.pid).bed}, ${pat(l.pid).name}</td><td>${l.entry}</td><td>${l.dose}</td><td>${l.route}</td><td>${l.by}</td></tr>`).join("");
}

/* live bill */
let lastBillTotal = {};
function renderBill() {
  const p = pat(billSelected); if (!p) return;
  const total = p.bill.reduce((s, b) => s + b.amt, 0);
  const el = $("billTotal");
  el.textContent = "₹" + total.toLocaleString("en-IN");
  if (lastBillTotal[p.id] !== undefined && total > lastBillTotal[p.id]) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }
  lastBillTotal[p.id] = total;
  $("billTable").querySelector("tbody").innerHTML = p.bill.slice().reverse().map((b, i) => `<tr class="${i === 0 ? "bill-new" : ""}"><td>${b.t}</td><td>${b.item}</td><td>₹${b.amt.toLocaleString("en-IN")}</td></tr>`).join("");
}


/* ---------------- simulated WiFi sensor feed (RuView-style; NO real hardware) ---------------- */
let sensorAlerts = [];   // {t, pid, kind, text}
let crowdCount = 17;     // simulated waiting-room WiFi count
function sensorTick() {
  // breathing rate drift (contactless feed)
  for (const p of PATIENTS) p.brpm = Math.round(jitter(p.brpm, 1.4, 11, 26));
  // rare fall / bed-exit events
  if (Math.random() < 0.045) {
    const p = PATIENTS[Math.floor(Math.random() * PATIENTS.length)];
    const kind = Math.random() < 0.5 ? "fall-risk" : "bed-exit";
    if (sensorAlerts.some(a => a.pid === p.id && a.kind === kind)) return;
    sensorAlerts.unshift({ t: nowHM(), pid: p.id, kind, text: kind === "fall-risk" ? "Fall-risk movement pattern detected" : "Patient left the bed unassisted" });
    sensorAlerts = sensorAlerts.slice(0, 6);
    p.alertUntil = Date.now() + 22000;
  }
  // crowd drift
  crowdCount = Math.max(3, Math.min(46, crowdCount + Math.round((Math.random() - 0.5) * 5)));
  if ($("tab-hospital").classList.contains("active")) {
    renderSensorAlerts();
    if ($("hview-night").classList.contains("active")) renderNight();
  }
  if ($("tab-queue").classList.contains("active")) renderQueue();
}
setInterval(sensorTick, 4000);
function renderSensorAlerts() {
  const box = $("wardAlerts"); if (!box) return;
  box.innerHTML = sensorAlerts.length ? sensorAlerts.map(a =>
    `<div class="sensor-alert ${Date.now() < (pat(a.pid).alertUntil || 0) ? "hot" : ""}"><strong>${a.t}</strong> ${pat(a.pid).bed}, ${a.text} <span class="demo-pill">simulated sensor feed</span></div>`).join("") : "";
}

/* simulation engine */
const CHARGES = [["Medicine - ward pharmacy", 120, 260], ["Consumables (syringe, line)", 60, 140], ["Nursing care (2 hr block)", 150, 150], ["Monitor usage (hourly)", 250, 250], ["Doctor visit", 500, 800], ["Lab - repeat test", 300, 550], ["Oxygen (per hr)", 120, 120]];
function simTick() {
  for (const p of PATIENTS) {
    p.hr = jitter(p.hr, 4, 62, 118); p.spo2 = jitter(p.spo2, 1.2, 90, 100);
    p.sys = jitter(p.sys, 3, 100, 158); p.dia = jitter(p.dia, 2, 60, 98); p.temp = jitter(p.temp, 0.15, 97.8, 101);
  }
  if (Math.random() < 0.5) { // nurse records something
    const p = PATIENTS[Math.floor(Math.random() * PATIENTS.length)];
    const m = p.meds[Math.floor(Math.random() * p.meds.length)];
    careLog.push({ t: nowHM(), pid: p.id, entry: m[0], dose: m[1], route: m[2], by: NURSES[Math.floor(Math.random() * NURSES.length)] });
    careLog = careLog.slice(-60);
  }
  if (Math.random() < 0.4) { // a charge posts
    const p = PATIENTS[Math.floor(Math.random() * PATIENTS.length)];
    const c = CHARGES[Math.floor(Math.random() * CHARGES.length)];
    p.bill.push({ t: nowHM(), item: c[0], amt: c[1] === c[2] ? c[1] : c[1] + Math.floor(Math.random() * (c[2] - c[1])) });
  }
  if ($("tab-hospital").classList.contains("active")) {
    renderWard();
    if ($("hview-family").classList.contains("active")) renderFamView();
    if ($("hview-bill").classList.contains("active")) renderBill();
    if ($("hview-carelog").classList.contains("active")) renderCareLog();
    if ($("hview-dashboard").classList.contains("active")) renderDashboard();
  }
}
setInterval(simTick, 2000);

/* ECG sweep (family view) */
(function ecg() {
  const c = $("fvEcg"); if (!c || new URLSearchParams(location.search).has("shot")) return; const ctx = c.getContext("2d");
  let x = 0;
  function frame() {
    if ($("hview-family") && $("hview-family").classList.contains("active")) {
      const p = pat(famSelected) || PATIENTS[0];
      ctx.fillStyle = "rgba(255,255,255,0.16)"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.strokeStyle = "#148a58"; ctx.lineWidth = 1.6; ctx.beginPath();
      const beat = Math.max(18, 60 - (p.hr - 60) * 0.5);
      for (let i = 0; i < 4; i++) {
        const xx = (x + i) % c.width, ph = (xx % beat) / beat;
        let y = 40;
        if (ph > 0.42 && ph < 0.5) y = 40 - 34 * Math.sin((ph - 0.42) / 0.08 * Math.PI); // QRS spike
        else if (ph > 0.15 && ph < 0.22) y = 40 - 7 * Math.sin((ph - 0.15) / 0.07 * Math.PI); // P wave
        else if (ph > 0.6 && ph < 0.72) y = 40 - 10 * Math.sin((ph - 0.6) / 0.12 * Math.PI); // T wave
        i ? ctx.lineTo(xx, y) : ctx.moveTo(xx, y);
      }
      ctx.stroke(); x = (x + 4) % c.width;
    }
    requestAnimationFrame(frame);
  }
  frame();
})();

function renderHospital() { renderWard(); syncSelectors(); renderFamView(); renderBill(); renderCareLog(); }

$("vitalsAiBtn").addEventListener("click", async () => {
  const box = $("vitalsAi"); box.classList.remove("hidden"); box.textContent = "Summarising…";
  const data = PATIENTS.map(p => `${p.bed} ${p.name} (${p.prob}): BP ${Math.round(p.sys)}/${Math.round(p.dia)}, HR ${Math.round(p.hr)}, SpO2 ${Math.round(p.spo2)}%`).join("; ");
  try {
    const resp = await bharatCall({ model: MODEL, store: false, max_output_tokens: 400, input: "You are a hospital-shift nurse aide. In 3 short lines, summarise which of these simulated demo patients needs review first and why. Data: " + data });
    box.textContent = "AI shift note (demo data): " + respText(resp).trim();
  } catch { box.textContent = "AI shift note (offline demo): ICU-5 S. Shaikh needs review first - heart rate above 100 with borderline SpO2; then P-3 K. Singh for low oxygen saturation. Others stable."; }
});


/* ---------------- roles & entry screens ---------------- */
let role = store.get("role", null);
function enterApp() {
  document.body.classList.add("in-app");
  $("screen-landing").classList.add("hidden");
  $("screen-staff-login").classList.add("hidden");
  $("appTop").classList.remove("hidden");
  $("appMain").classList.remove("hidden");
  $("roleChip").textContent = role === "staff" ? "Hospital staff portal" : "Patient & family portal";
  const hospTabBtn = document.querySelector('.tab[data-tab="hospital"]');
  hospTabBtn.innerHTML = role === "staff" ? 'Hospital HMS <span class="demo-pill">demo</span>' : 'Track admitted patient <span class="demo-pill">demo</span>';
  document.querySelectorAll("#tabs .tab").forEach(b => {
    b.style.display = (role === "staff" && b.dataset.tab !== "hospital") ? "none" : "";
  });
  if (!location.hash.slice(1) || !document.getElementById("tab-" + location.hash.slice(1)))
    document.querySelector('.tab[data-tab="' + (role === "staff" ? "hospital" : "scan") + '"]').click();
}
function configureHospitalRole() {
  const wardBtn = document.querySelector('.hosp-tab[data-hview="ward"]');
  wardBtn.style.display = role === "staff" ? "" : "none";
  $("careAddForm").classList.toggle("hidden", role !== "staff");
  document.body.classList.toggle("role-staff", role === "staff");
  document.querySelectorAll(".hosp-tab[data-staff]").forEach(b => b.style.display = role === "staff" ? "" : "none");
  if (role === "staff") {
    $("caPatient").innerHTML = PATIENTS.map(p => `<option value="${p.id}">${p.bed}, ${p.name}</option>`).join("");
    document.querySelector('.hosp-tab[data-hview="dashboard"]').click();
  } else {
    document.querySelector('.hosp-tab[data-hview="family"]').click();
  }
}
$("enterPatient").addEventListener("click", () => { role = "patient"; store.set("role", role); enterApp(); });
document.querySelectorAll("[data-enter]").forEach(b => b.addEventListener("click", e => {
  e.preventDefault();
  role = b.dataset.enter; store.set("role", role); enterApp();
  const t = document.querySelector(`.tab[data-tab="${b.dataset.goto}"]`); if (t) t.click();
  window.scrollTo(0, 0);
}));
document.querySelectorAll("[data-staff-entry]").forEach(b => b.addEventListener("click", e => { e.preventDefault(); $("enterStaff").click(); }));
function renderLandingDocs() {
  const el = $("landingDocs"); if (!el) return;
  el.innerHTML = DOCTORS.map(d => `<div class="ldoc">
    <div class="ldoc-av" style="background:${d.color}">${initials(d.name)}</div>
    <strong>${d.name}</strong>
    <div class="ldoc-spec">${d.spec}</div>
    <div class="ldoc-meta">${d.hospital}, ${d.exp} yrs, ★ ${d.rating}</div>
    <div class="ldoc-fee">₹${d.fee}, ${d.avail === "today" ? "Available today" : "Next: tomorrow"}</div>
  </div>`).join("");
}
renderLandingDocs();
$("enterStaff").addEventListener("click", () => { $("screen-landing").classList.add("hidden"); $("screen-staff-login").classList.remove("hidden"); });
$("backToLanding").addEventListener("click", () => { $("screen-staff-login").classList.add("hidden"); $("screen-landing").classList.remove("hidden"); });
$("staffLoginBtn").addEventListener("click", () => { role = "staff"; store.set("role", role); store.set("staffId", $("staffId").value || "staff"); enterApp(); });
$("switchRole").addEventListener("click", () => { role = null; store.set("role", null); document.body.classList.remove("in-app"); $("appTop").classList.add("hidden"); $("appMain").classList.add("hidden"); $("screen-landing").classList.remove("hidden"); });
$("caAdd").addEventListener("click", () => {
  const entry = $("caEntry").value.trim(); if (!entry) return;
  careLog.push({ t: nowHM(), pid: $("caPatient").value, entry, dose: $("caDose").value || "-", route: $("caRoute").value, by: (store.get("staffId", "Staff")) });
  careLog = careLog.slice(-60);
  $("caEntry").value = ""; $("caDose").value = "";
  renderCareLog();
});

/* ---------------- init ---------------- */
const roleParam = new URLSearchParams(location.search).get("role");
if (roleParam === "patient" || roleParam === "staff") { role = roleParam; store.set("role", role); }
refreshKeyStatus(); renderDoctors(); renderQueue(); renderLabPrices(); renderHospital(); renderFamily(); renderReminders();
const h = location.hash.slice(1);
if (h && document.getElementById("tab-" + h)) document.querySelector(`.tab[data-tab="${h}"]`).click();
if (new URLSearchParams(location.search).has("shot")) document.documentElement.classList.add("noanim");
if (location.protocol === "file:") {
  const note = document.createElement("div");
  note.className = "file-helper";
  note.innerHTML = 'Opened from a file. Most features work offline; the 3D anatomy model needs a local server: <strong>python3 serve.py</strong>, then open <strong>http://localhost:8000</strong>. <button type="button" aria-label="Dismiss">Dismiss</button>';
  document.body.appendChild(note);
  note.querySelector("button").addEventListener("click", () => note.remove());
}
if (role) enterApp();
const hv = new URLSearchParams(location.search).get("hview");
if (hv) { document.querySelector('.tab[data-tab="hospital"]').click(); const hb = document.querySelector(`.hosp-tab[data-hview="${hv}"]`); if (hb) hb.click(); }
if (new URLSearchParams(location.search).has("demoseed")) {
  if (!booking) { const d = DOCTORS[0]; booking = { doctor: d.name, spec: d.spec, hospital: d.hospital + ", " + d.area, fee: d.fee, slot: "Today 17:00", token: "T-241", ahead: 5 }; store.set("booking", booking); renderQueue(); }
  if (!sensorAlerts.length) { const p = pat("w2"); p.alertUntil = Date.now() + 60000; sensorAlerts.unshift({ t: nowHM(), pid: "w2", kind: "bed-exit", text: "Patient left the bed unassisted" }); renderSensorAlerts(); if ($("hview-family").classList.contains("active")) renderFamView(); }
}
if (new URLSearchParams(location.search).has("autodemo")) {
  (async () => {
    const kind = new URLSearchParams(location.search).get("autodemo") === "lab" ? "labreport" : "prescription";
    document.querySelector(`input[name=doctype][value=${kind === "labreport" ? "labreport" : "prescription"}]`).checked = true;
    const url = kind === "labreport" ? "samples/sample-lab-report.jpg" : "samples/sample-prescription.jpg";
    const dataUrl = await loadSampleDoc(url, kind === "labreport" ? "labreport" : "prescription");
    currentImage = { dataUrl, b64: dataUrl.split(",")[1] };
    $("preview").src = dataUrl; $("preview").classList.remove("hidden"); $("readBtn").disabled = false; renderScanResult(DEMO_RESULT(), true);
  })();
}

