const messages = document.getElementById("messages");
const form = document.getElementById("chat-form");
const input = document.getElementById("message");
const send = document.getElementById("send");
const casesNode = document.getElementById("case-list");
const details = document.getElementById("details");
const activity = document.getElementById("tool-activity");
const confirmSlot = document.getElementById("confirm-slot");
const sessionId = globalThis.crypto.randomUUID();
let cases = [];
let selected = null;
let activeTab = "checklist.md";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function addMessage(role, text) {
  const welcome = messages.querySelector(".welcome");
  if (welcome) welcome.remove();
  const bubble = element("div", `bubble ${role}`);
  bubble.append(element("small", "", role === "user" ? "TÚ" : "PERXIA"), document.createTextNode(text));
  messages.append(bubble);
  messages.scrollTop = messages.scrollHeight;
}

function badge(state) {
  const labels = { listo_para_firma: "Lista para firma", requiere_revision: "Requiere revisión", sin_procesar: "Sin procesar" };
  return element("span", `badge ${state === "listo_para_firma" ? "ready" : state === "requiere_revision" ? "review" : ""}`, labels[state] || state);
}

async function refreshCases() {
  const response = await fetch("/api/casos");
  if (!response.ok) throw new Error("No se pudieron cargar los casos");
  cases = await response.json();
  document.getElementById("total-cases").textContent = String(cases.length);
  document.getElementById("ready-cases").textContent = String(cases.filter((item) => item.estado === "listo_para_firma").length);
  document.getElementById("review-cases").textContent = String(cases.filter((item) => item.estado === "requiere_revision").length);
  casesNode.replaceChildren();
  for (const item of cases) {
    const card = element("button", `case-card ${item.caso === selected ? "active" : ""}`);
    card.type = "button";
    const text = element("span");
    text.append(element("span", "case-title", item.cliente), element("span", "case-id", `${item.caso} · ${item.pais} · ${item.formato.toUpperCase()}`));
    card.append(text, badge(item.estado));
    card.addEventListener("click", () => { selected = item.caso; refreshCases().then(showDetails).catch(showError); });
    casesNode.append(card);
  }
  if (selected) await showDetails();
}

function link(item, name, title) {
  const anchor = element("a", "", title);
  anchor.href = `/api/out/${encodeURIComponent(item.caso)}/${encodeURIComponent(name)}`;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  return anchor;
}

async function showDetails() {
  const item = cases.find((entry) => entry.caso === selected);
  if (!item) return;
  details.replaceChildren();
  details.append(element("h3", "", item.cliente), element("p", "sub", `${item.pais} · ${item.formato.toUpperCase()} · ${item.caso}`), badge(item.estado));
  const available = ["checklist.md", "borrador-correo.md", "log.jsonl", "valores-portal.md", "ENVIO-SIMULADO.md"].filter((name) => item.artifacts.includes(name));
  if (!available.length) {
    details.append(element("p", "empty", "Este caso aún no tiene artefactos. Solicita al agente que lo procese."));
    return;
  }
  if (!available.includes(activeTab)) activeTab = available[0];
  const tabs = element("div", "tabs");
  const labels = { "checklist.md": "Checklist", "borrador-correo.md": "Correo", "log.jsonl": "Logs", "valores-portal.md": "Portal", "ENVIO-SIMULADO.md": "Simulación" };
  for (const name of available) {
    const button = element("button", name === activeTab ? "active" : "", labels[name]);
    button.type = "button";
    button.addEventListener("click", () => { activeTab = name; showDetails().catch(showError); });
    tabs.append(button);
  }
  details.append(tabs);
  const preview = element("pre", "preview", "Cargando…");
  details.append(preview);
  const downloads = element("div", "downloads");
  for (const name of item.artifacts) downloads.append(link(item, name, name));
  details.append(downloads);
  try {
    const response = await fetch(`/api/out/${encodeURIComponent(item.caso)}/${encodeURIComponent(activeTab)}`);
    preview.textContent = response.ok ? await response.text() : "Vista previa no disponible.";
  } catch { preview.textContent = "Vista previa no disponible."; }
  confirmSlot.replaceChildren();
  if (item.estado === "listo_para_firma" && item.artifacts.includes("borrador-correo.md") && !item.artifacts.includes("ENVIO-SIMULADO.md")) {
    const button = element("button", "confirm", `Confirmo el envío simulado de ${item.caso}`);
    button.type = "button";
    button.addEventListener("click", () => submitMessage(`Confirmo el envío de ${item.caso}`));
    confirmSlot.append(button);
  }
}

function showError(error) {
  addMessage("agent", error instanceof Error ? error.message : "Ocurrió un error.");
}

async function submitMessage(text) {
  const message = text.trim();
  if (!message || send.disabled) return;
  addMessage("user", message);
  input.value = "";
  send.disabled = true;
  activity.textContent = "El agente está ejecutando las herramientas…";
  try {
    const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, message }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No se pudo procesar el mensaje");
    activity.replaceChildren();
    for (const call of data.toolCalls) activity.append(element("span", "tool-line", `${call.ok ? "✓" : "!"} ${call.name.replace("proveedor_", "")}`));
    addMessage("agent", data.reply);
    const caseId = message.match(/\b(?:co|ec|hn|pa)-[a-z0-9]+(?:-[a-z0-9]+)*\b/i)?.[0];
    if (caseId) selected = caseId.toLowerCase();
    await refreshCases();
  } catch (error) { activity.replaceChildren(); showError(error); }
  finally { send.disabled = false; input.focus(); }
}

form.addEventListener("submit", (event) => { event.preventDefault(); submitMessage(input.value); });
document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => submitMessage(button.dataset.prompt)));
fetch("/api/reset", { method: "POST" }).then(() => refreshCases()).catch(showError);