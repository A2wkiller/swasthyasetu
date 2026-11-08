/* SwasthyaSetu - one-stop health bridge. Vanilla JS, no build step.
   Real AI: BharatCode Qwen vision (prescription/lab reading) via serve.py proxy
   or a key stored locally. Everything else runs on-device / demo data. */
"use strict";

const API_PROXY = "/api/responses";
const MODEL = "qwen-3.8-27b";
const $ = (id) => document.getElementById(id);

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
  const img = new Image();
  img.onload = () => {
    const max = 1024, scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const url = c.toDataURL("image/jpeg", 0.7);
    cb({ dataUrl: url, b64: url.split(",")[1] });
  };
  img.src = URL.createObjectURL(file);
}
$("fileInput").addEventListener("change", e => {
  const f = e.target.files[0]; if (!f) return;
  downscale(f, d => { currentImage = d; $("preview").src = d.dataUrl; $("preview").classList.remove("hidden"); $("readBtn").disabled = false; $("uploadLabel").textContent = "📷 " + f.name; });
});
$("sampleBtn").addEventListener("click", async () => {
  const kind = document.querySelector("input[name=doctype]:checked").value;
  const url = kind === "labreport" ? "samples/sample-lab-report.jpg" : "samples/sample-prescription.jpg";
  const blob = await (await fetch(url)).blob();
  const r = new FileReader();
  r.onload = () => { currentImage = { dataUrl: r.result, b64: r.result.split(",")[1] }; $("preview").src = r.result; $("preview").classList.remove("hidden"); $("readBtn").disabled = false; $("uploadLabel").textContent = "📷 sample document"; };
  r.readAsDataURL(blob);
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
  const tick = setInterval(() => { secs++; btn.textContent = `Reading with AI… ${secs}s (vision can take up to ~2 min)`; }, 1000);
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
    <p class="muted">${r.doctor_or_lab || ""} ${r.date ? "· " + r.date : ""} · AI confidence: ${r.confidence || "medium"}</p>
    <p><strong>English:</strong> ${r.summary_en}</p>
    <p style="margin-top:6px"><strong>हिंदी:</strong> ${r.summary_hi}</p>`;
  if (r.medicines && r.medicines.length) {
    h += `<h3>Medicines (${r.medicines.length})</h3><table class="med-table"><thead><tr><th>Medicine</th><th>Salt</th><th>How to take</th><th>Purpose</th><th>Cheaper generic (Jan Aushadhi)</th></tr></thead><tbody>`;
    for (const m of r.medicines) h += `<tr><td><strong>${m.name}</strong><br><span class="muted small">${m.dosage} · ${m.duration}</span></td><td>${m.salt}</td><td>${m.frequency}<br><span class="muted small">${m.timing}</span></td><td>${m.purpose_en}<br><span class="muted small">${m.purpose_hi}</span></td><td>${m.generic_alt}<br><span class="muted small">${m.jan_aushadhi}</span></td></tr>`;
    h += `</tbody></table>`;
    const sched = r.medicines.map(m => `<li><strong>${m.name}</strong> - ${m.timing}</li>`).join("");
    h += `<h3>Day schedule</h3><ul>${sched}</ul>`;
  }
  if (r.lab_values && r.lab_values.length) {
    h += `<h3>Lab values</h3><table class="med-table"><thead><tr><th>Test</th><th>Result</th><th>Reference</th><th>Flag</th></tr></thead><tbody>`;
    for (const v of r.lab_values) {
      const cls = v.flag === "abnormal" ? "bad" : v.flag === "borderline" ? "warn" : "ok";
      h += `<tr><td>${v.test}</td><td><strong>${v.value} ${v.unit}</strong></td><td>${v.range}</td><td><span class="pill ${cls}">${v.flag}</span></td></tr>`;
    }
    h += `</tbody></table>`;
  }
  if (r.interactions && r.interactions.length) h += `<h3>Cautions</h3><ul>${r.interactions.map(i => `<li>${i}</li>`).join("")}</ul>`;
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
  if (!mine.length) { box.innerHTML = `<p class="muted">Nothing yet for ${activeProfile().name}. Read a document first.</p>`; $("trendBox").classList.add("hidden"); return; }
  box.innerHTML = mine.map(s => `<div class="tl-item"><img src="${s.thumb}" alt=""><div><strong>${s.kind === "labreport" ? "🧪 Lab report" : "📝 Prescription"}</strong> · ${s.result.doctor_or_lab || "document"}<div class="when">${new Date(s.ts).toLocaleString("en-IN")}</div><div class="small muted">${(s.result.summary_en || "").slice(0, 110)}…</div></div></div>`).join("");
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
  $("remMember").innerHTML = profiles.map(p => `<option value="${p.id}" ${p.id === activeId ? "selected" : ""}>${p.name}</option>`).join("");
  const mine = reminders.filter(r => r.profileId === activeId);
  const now = new Date(), hhmm = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  $("reminderList").innerHTML = mine.length ? mine.map(r => `<div class="rem-row ${r.time <= hhmm && r.active ? "due" : ""}"><strong>${r.time}</strong> ${r.name} <button class="btn small danger" onclick="delReminder('${r.id}')">✕</button></div>`).join("") : `<p class="muted">No reminders for ${activeProfile().name} yet.</p>`;
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
function renderFamily() {
  $("familyList").innerHTML = profiles.map(p => `<div class="doc-card"><h4>${p.name} ${p.id === activeId ? '<span class="badge-active">active</span>' : ""}</h4><p class="muted small">Age: ${p.age || "—"} · Blood: ${p.blood || "—"}</p><div class="formrow"><button class="btn ghost small" onclick="switchProfile('${p.id}')">Switch</button>${profiles.length > 1 ? `<button class="btn small danger" onclick="delProfile('${p.id}')">Remove</button>` : ""}</div></div>`).join("");
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
  $("ecardBox").innerHTML = `<div class="ecard-inner"><h3>🚨 ${p.name}</h3>
    <p><strong>Blood group:</strong> ${p.blood || "—"}</p><p><strong>Conditions:</strong> ${p.conditions || "none listed"}</p>
    <p><strong>Allergies:</strong> ${p.allergies || "none listed"}</p><p><strong>Current medicines:</strong> ${meds.join(", ") || "none listed"}</p>
    <p><strong>Emergency contact:</strong> ${p.emergencyContact || "—"}</p>
    <div class="formrow"><input id="ecBlood" class="inp" style="max-width:120px" placeholder="Blood group" value="${p.blood || ""}"><input id="ecCond" class="inp" placeholder="Conditions" value="${p.conditions || ""}"><input id="ecAllergy" class="inp" placeholder="Allergies" value="${p.allergies || ""}"><input id="ecContact" class="inp" placeholder="Emergency contact" value="${p.emergencyContact || ""}"><button class="btn primary small" onclick="saveEcard()">Save</button></div>
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

/* ---------------- appointments + queue (demo data) ---------------- */
const DOCTORS = [
  { id: "d1", name: "Dr. Sneha Kulkarni", spec: "General Physician", hospital: "CityCare Hospital, Pune", fee: 500, slots: ["09:00", "09:30", "10:00", "17:00", "17:30", "18:00"], taken: ["09:00", "09:30"] },
  { id: "d2", name: "Dr. Arjun Mehta", spec: "Cardiologist", hospital: "Ruby Hall Clinic, Pune", fee: 1200, slots: [], taken: [] },
  { id: "d3", name: "Dr. Priya Nair", spec: "Endocrinologist (thyroid, diabetes)", hospital: "CityCare Hospital, Pune", fee: 900, slots: ["11:00", "11:30", "19:00", "19:30"], taken: ["11:00"] },
  { id: "d4", name: "Dr. Rohan Deshmukh", spec: "Orthopedic", hospital: "Jehangir Hospital, Pune", fee: 800, slots: ["08:00", "08:30", "21:00", "21:30"], taken: [] }
];
function renderDoctors() {
  $("doctorList").innerHTML = DOCTORS.map(d => `<div class="doc-card"><h4>${d.name}</h4><p class="muted small">${d.spec}<br>${d.hospital} · ₹${d.fee}</p><button class="btn primary small" onclick="pickDoctor('${d.id}')">${d.slots.filter(s => !d.taken.includes(s)).length ? "View slots" : "Unavailable today"}</button></div>`).join("");
}
window.pickDoctor = (id) => {
  const d = DOCTORS.find(x => x.id === id);
  $("slotBox").classList.remove("hidden");
  $("slotTitle").textContent = d.name + " - today's slots";
  const free = d.slots.filter(s => !d.taken.includes(s));
  $("slots").innerHTML = d.slots.length ? d.slots.map(s => `<button class="slot ${d.taken.includes(s) ? "taken" : ""}" ${d.taken.includes(s) ? "disabled" : ""} onclick="bookSlot('${id}','${s}')">${s}</button>`).join("") : "";
  $("reschedule").classList.toggle("hidden", !!free.length);
  if (!free.length) $("reschedule").innerHTML = `<strong>${d.name} has no slots today.</strong> Suggested next-day options: <button class="slot" onclick="bookSlot('${id}','Tomorrow 07:30')">Tomorrow 07:30 (early morning)</button> <button class="slot" onclick="bookSlot('${id}','Tomorrow 21:00')">Tomorrow 21:00 (night)</button>`;
};
window.bookSlot = (id, slot) => {
  const d = DOCTORS.find(x => x.id === id);
  booking = { doctor: d.name, spec: d.spec, hospital: d.hospital, fee: d.fee, slot, token: "T-" + (100 + Math.floor(Math.random() * 900)), ahead: 4 + Math.floor(Math.random() * 4) };
  store.set("booking", booking);
  $("bookingConfirm").innerHTML = `<div class="confirm-card"><strong>✅ Booked (demo)</strong><br>${d.name} · ${d.spec}<br>${d.hospital}<br>Slot: <strong>${slot}</strong> · Token: <strong>${booking.token}</strong> · Fee: ₹${d.fee}<br><span class="muted small">Track your turn in the Queue tab.</span></div>`;
  renderQueue();
};
function renderQueue() {
  const box = $("queueBox");
  if (!booking) { box.innerHTML = `<p class="muted">No active token. Book an appointment first (demo data).</p>`; return; }
  const eta = booking.ahead * 8;
  const pct = Math.max(0, Math.min(100, 100 - booking.ahead * 16));
  box.innerHTML = `<p class="queue-token">${booking.doctor} · ${booking.hospital}<br>Token <strong>${booking.token}</strong> · Slot ${booking.slot}</p>
    <p class="queue-big">${booking.ahead > 0 ? booking.ahead + " patients ahead" : "Your turn now!"}</p>
    <div class="progress"><div style="width:${pct}%"></div></div>
    <p class="muted">Estimated wait: ~${eta} min ${booking.ahead <= 2 ? "· we will alert you when 2 patients are left" : ""}</p>
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
  $("labBooked").innerHTML = `<div class="confirm-card"><strong>✅ Home sample collection booked (demo)</strong><br>${test} at ${lab} · ₹${price}<br>Collection: tomorrow 7-9 AM. Pay after sample collection.</div>`;
};

/* ---------------- hospital dashboard (demo) ---------------- */
const BEDS = [["ICU", 4, 10], ["General ward", 38, 60], ["Private rooms", 6, 20]];
let PATIENTS = [
  { bed: "ICU-2", name: "R. Patil", prob: "Post-surgery recovery", bp: [128, 84], hr: 88, spo2: 97 },
  { bed: "ICU-5", name: "S. Shaikh", prob: "Cardiac observation", bp: [150, 96], hr: 104, spo2: 94 },
  { bed: "G-12", name: "M. Iyer", prob: "Dengue fever", bp: [110, 72], hr: 92, spo2: 98 },
  { bed: "G-15", name: "A. Joshi", prob: "Fracture - leg", bp: [118, 78], hr: 76, spo2: 99 },
  { bed: "P-3", name: "K. Singh", prob: "Pneumonia", bp: [135, 88], hr: 96, spo2: 93 }
];
function jitter(v, amt, lo, hi) { return Math.max(lo, Math.min(hi, v + Math.round((Math.random() - 0.5) * amt))); }
function renderHospital() {
  $("beds").innerHTML = BEDS.map(([label, free, total]) => { const pct = Math.round(free / total * 100); return `<div class="bar-row"><div class="small"><strong>${label}</strong>: ${free}/${total} free</div><div class="bar-track"><div class="bar-fill ${pct < 20 ? "low" : ""}" style="width:${pct}%"></div></div></div>`; }).join("");
  const tbody = $("vitalsTable").querySelector("tbody");
  tbody.innerHTML = PATIENTS.map(p => {
    const bad = p.hr > 100 || p.spo2 < 95 || p.bp[0] > 140;
    return `<tr><td>${p.bed}</td><td>${p.name}</td><td>${p.prob}</td><td>${p.bp[0]}/${p.bp[1]}</td><td>${p.hr}</td><td>${p.spo2}%</td><td><span class="pill ${bad ? "bad" : "ok"}">${bad ? "⚠ review" : "stable"}</span></td></tr>`;
  }).join("");
  $("billing").innerHTML = `<table class="med-table"><tbody>
    <tr><td>Room charges (3 days)</td><td>₹9,000</td></tr><tr><td>Doctor visits</td><td>₹2,500</td></tr>
    <tr><td>Medicines</td><td>₹3,150</td></tr><tr><td>Lab tests</td><td>₹1,800</td></tr>
    <tr><td><strong>Total</strong></td><td><strong>₹16,450</strong></td></tr></tbody></table>
    <div class="formrow" style="margin-top:8px"><button class="btn primary small" onclick="alert('Demo payment - no real money moves.')">Pay bill (demo)</button></div>`;
}
setInterval(() => { for (const p of PATIENTS) { p.hr = jitter(p.hr, 6, 60, 122); p.spo2 = jitter(p.spo2, 2, 90, 100); } if ($("tab-hospital").classList.contains("active")) renderHospital(); }, 5000);
$("vitalsAiBtn").addEventListener("click", async () => {
  const box = $("vitalsAi"); box.classList.remove("hidden"); box.textContent = "Summarising…";
  const data = PATIENTS.map(p => `${p.bed} ${p.name} (${p.prob}): BP ${p.bp[0]}/${p.bp[1]}, HR ${p.hr}, SpO2 ${p.spo2}%`).join("; ");
  try {
    const resp = await bharatCall({ model: MODEL, store: false, max_output_tokens: 400, input: "You are a hospital-shift nurse aide. In 3 short lines, summarise which of these simulated demo patients needs review first and why. Data: " + data });
    box.textContent = "AI shift note (demo data): " + respText(resp).trim();
  } catch { box.textContent = "AI shift note (offline demo): ICU-5 S. Shaikh needs review first - heart rate above 100 with borderline SpO2; then P-3 K. Singh for low oxygen saturation. Others stable."; }
});

/* ---------------- init ---------------- */
refreshKeyStatus(); renderDoctors(); renderQueue(); renderLabPrices(); renderHospital(); renderFamily(); renderReminders();
const h = location.hash.slice(1);
if (h && document.getElementById("tab-" + h)) document.querySelector(`.tab[data-tab="${h}"]`).click();
if (new URLSearchParams(location.search).has("autodemo")) {
  (async () => {
    const kind = new URLSearchParams(location.search).get("autodemo") === "lab" ? "labreport" : "prescription";
    document.querySelector(`input[name=doctype][value=${kind === "labreport" ? "labreport" : "prescription"}]`).checked = true;
    const url = kind === "labreport" ? "samples/sample-lab-report.jpg" : "samples/sample-prescription.jpg";
    const blob = await (await fetch(url)).blob();
    const r = new FileReader();
    r.onload = () => { currentImage = { dataUrl: r.result, b64: r.result.split(",")[1] }; $("preview").src = r.result; $("preview").classList.remove("hidden"); $("readBtn").disabled = false; renderScanResult(DEMO_RESULT(), true); };
    r.readAsDataURL(blob);
  })();
}
