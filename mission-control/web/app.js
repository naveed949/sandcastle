const $ = (sel) => document.querySelector(sel);

const state = {
  view: "list",
  projectId: null,
  pollTimer: null,
  es: null,
  autoscroll: true,
  streamedRunId: null,
};

async function api(path, opts) {
  const res = await fetch(path, opts);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(body?.error ?? `${res.status}: ${text}`);
  return body;
}

function toast(msg, isError = false) {
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function pill(status) {
  return `<span class="pill ${status}">${status.replace("_", " ")}</span>`;
}

function timeAgo(iso) {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso + "Z").getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/* ---------- preflight indicator ---------- */

async function loadPreflight() {
  try {
    const checks = await api("/api/preflight");
    const failedReq = checks.filter((c) => c.required && !c.ok);
    const warn = checks.filter((c) => !c.required && !c.ok);
    const dot = $("#preflight-dot"),
      label = $("#preflight-label");
    if (failedReq.length > 0) {
      dot.className = "dot red";
      label.textContent = `${failedReq.length} required check${failedReq.length > 1 ? "s" : ""} failing`;
    } else if (warn.length > 0) {
      dot.className = "dot amber";
      label.textContent = `${warn.length} warning${warn.length > 1 ? "s" : ""}`;
    } else {
      dot.className = "dot green";
      label.textContent = "environment ready";
    }
    $("#preflight").title = checks
      .map(
        (c) => `${c.ok ? "✓" : c.required ? "✗" : "!"} ${c.name}: ${c.detail}`,
      )
      .join("\n");
  } catch {
    $("#preflight-dot").className = "dot red";
    $("#preflight-label").textContent = "preflight unavailable";
  }
}

/* ---------- project list ---------- */

async function refreshList() {
  if (state.view !== "list") return;
  const projects = await api("/api/projects");
  const grid = $("#project-grid");
  if (projects.length === 0) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1;">No projects yet.<br/>Click <strong>+ New project</strong> to submit a PRD.</div>`;
    return;
  }
  const withTickets = await Promise.all(
    projects.map(async (p) => ({
      p,
      tickets: await api(`/api/projects/${p.id}`)
        .then((d) => d.tickets)
        .catch(() => []),
    })),
  );
  grid.innerHTML = withTickets
    .map(({ p, tickets }) => {
      const done = tickets.filter((t) => t.status === "done").length;
      const pct = tickets.length
        ? Math.round((done / tickets.length) * 100)
        : 0;
      return `<div class="card" data-id="${p.id}">
        <div class="repo">${p.repo_url}</div>
        ${pill(p.status)}
        ${p.error ? `<div style="color:var(--red);font-size:12px;margin-top:8px;">${escapeHtml(p.error)}</div>` : ""}
        <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="meta">
          <span>${done}/${tickets.length} tickets</span>
          <span>${p.base_branch} → ${p.feature_branch}</span>
          <span style="margin-left:auto;">${timeAgo(p.created_at)}</span>
          ${p.pr_url ? `<a href="${p.pr_url}" target="_blank" onclick="event.stopPropagation()">PR ↗</a>` : ""}
        </div>
      </div>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

/* ---------- project detail ---------- */

async function showProject(id) {
  switchView("detail");
  state.projectId = id;
  selectedAgentId = null;
  clearInterval(state.pollTimer);
  clearInterval(agentLogTimer);
  $("#log-title").textContent = "Pipeline output";
  await renderDetail();
  state.pollTimer = setInterval(renderDetail, 3000);
  watchLatestRun(true);
}

const STAGES = [
  { key: "provisioning", label: "Clone" },
  { key: "installing", label: "Install + Image" },
  { key: "planning", label: "Plan tickets" },
  { key: "running", label: "Agent runs" },
  { key: "pr", label: "PR ready" },
];

function renderStepper(status) {
  const activeIdx = {
    provisioning: 0,
    installing: 1,
    planning: 2,
    running: 3,
    pr_open: 4,
    done: 5,
  }[status];
  $("#stage-stepper").innerHTML = STAGES.map((s, i) => {
    let cls = "";
    if (status === "failed" || status === "cancelled") {
      cls = i === activeIdx ? "failed" : i < activeIdx ? "done" : "";
      if (status === "failed" && i === (activeIdx ?? 0)) cls = "failed";
    } else if (i < activeIdx || activeIdx === 5) cls = "done";
    else if (i === activeIdx) cls = "active";
    return `<span class="step ${cls}">${s.label}</span>`;
  }).join(`<span style="align-self:center;color:var(--border);">→</span>`);
}

async function renderDetail() {
  if (state.view !== "detail" || !state.projectId) return;
  let p;
  try {
    p = await api(`/api/projects/${state.projectId}`);
  } catch {
    return;
  }
  $("#detail-title").textContent = `#${p.id} ${p.repo_url}`;
  $("#detail-status").innerHTML = pill(p.status);
  renderStepper(p.status);

  const banner = $("#detail-banner");
  banner.innerHTML = "";
  if (p.error)
    banner.innerHTML = `<div class="banner error">⚠ ${escapeHtml(p.error)}</div>`;
  if (p.pr_url)
    banner.innerHTML += `<div class="banner success">Pull request ready — review &amp; merge: <a href="${p.pr_url}" target="_blank">${p.pr_url}</a></div>`;

  $("#btn-cancel").disabled = ["done", "cancelled"].includes(p.status);
  $("#btn-retry").style.display = ["failed", "cancelled"].includes(p.status)
    ? ""
    : "none";
  $("#btn-pr").style.display = p.pr_url ? "" : "none";

  renderAgents();

  $("#ticket-rows").innerHTML = p.tickets.length
    ? p.tickets
        .map((t) => {
          const blockers = JSON.parse(t.blockers);
          return `<tr>
        <td class="num">#${t.gh_issue_number}</td>
        <td>${escapeHtml(t.title)}</td>
        <td>${pill(t.status)}</td>
        <td>${blockers.length ? blockers.map((b) => `<span class="chip">#${b}</span>`).join("") : "<span style='color:var(--text-dim)'>—</span>"}</td>
      </tr>`;
        })
        .join("")
    : `<tr><td colspan="4" style="color:var(--text-dim);text-align:center;padding:20px;">
        No tickets indexed yet — MC falls back to <span class="chip">ready-for-agent</span> labeled issues when the PRD has no sub-issues. The template's own planner may still pick work up.
      </td></tr>`;
}

function switchView(view) {
  state.view = view;
  $("#list-view").style.display = view === "list" ? "" : "none";
  $("#detail-view").style.display = view === "detail" ? "" : "none";
  if (view === "list") {
    clearInterval(state.pollTimer);
    clearInterval(agentLogTimer);
    selectedAgentId = null;
    closeStream();
    refreshList();
  }
}

/* ---------- agent cards ---------- */

let selectedAgentId = null;
let agentLogTimer = null;

async function renderAgents() {
  if (state.view !== "detail") return;
  let data;
  try {
    data = await api(`/api/projects/${state.projectId}/agents`);
  } catch {
    return;
  }
  const grid = $("#agent-grid");
  if (!data.agents?.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1;">No agents spawned yet — cards appear as run.ts starts the planner, implementers, reviewers and merger.</div>`;
    return;
  }
  grid.innerHTML = data.agents
    .map(
      (
        a,
      ) => `<div class="card agent-card ${selectedAgentId === a.id ? "selected" : ""}" data-agent="${a.id}">
        <div class="name">${escapeHtml(a.name)} ${pill(a.status)}</div>
        <div class="logfile">${a.branch ? escapeHtml(a.branch) : ""}${a.log_file ? ` · ${escapeHtml(a.log_file)}` : ""}</div>
      </div>`,
    )
    .join("");
}

async function showAgentLog(agentId) {
  selectedAgentId = agentId;
  clearInterval(agentLogTimer);
  $("#log-title").textContent = "Agent log";
  renderAgents();
  const pull = async () => {
    try {
      const res = await api(`/api/agents/${agentId}/log`);
      const term = $("#terminal");
      const text = res.lines?.join("\n") ?? "";
      if (term.dataset.agentLog !== text) {
        term.dataset.agentLog = text;
        term.textContent = text || `(${res.status ?? "waiting for output"})`;
        if (state.autoscroll) term.scrollTop = term.scrollHeight;
      }
    } catch {
      /* ignore */
    }
  };
  await pull();
  agentLogTimer = setInterval(pull, 1500);
}

function showPipelineLog() {
  selectedAgentId = null;
  clearInterval(agentLogTimer);
  $("#log-title").textContent = "Pipeline output";
  $("#terminal").textContent = "";
  renderAgents();
  watchLatestRun(true);
}

/* ---------- run streaming ---------- */

async function watchLatestRun(autoplay) {
  const runs = await api(`/api/projects/${state.projectId}/runs`);
  const latest = runs.at(-1);
  $("#run-info").textContent = latest
    ? `${latest.kind} run #${latest.id} · ${latest.status} · started ${timeAgo(latest.started_at)}`
    : "no run yet";
  // Switch streams whenever a newer run appears (e.g. setup → pipeline).
  if (latest && autoplay && latest.id !== state.streamedRunId) {
    streamRun(latest.id, latest.status === "running");
  }
}

function streamRun(runId, live = false) {
  closeStream();
  state.streamedRunId = runId;
  const term = $("#terminal");
  term.textContent = "";
  state.es = new EventSource(`/api/runs/${runId}/events`);
  for (const evtName of [
    "stdout",
    "stderr",
    "meta",
    "agent",
    "text",
    "toolCall",
  ]) {
    state.es.addEventListener(evtName, (e) =>
      appendLine(term, evtName, e.data),
    );
  }
}

function extractLine(data) {
  try {
    const obj = JSON.parse(data);
    return (
      obj?.payload?.line ??
      obj?.line ??
      (typeof obj === "string" ? obj : null) ??
      data
    );
  } catch {
    return data;
  }
}

function appendLine(term, type, data) {
  const text = extractLine(data);
  if (!text?.trim()) return;
  const div = document.createElement("div");
  if (type === "stderr" || type === "toolCall") div.className = "line-stderr";
  else if (type === "meta") div.className = "line-meta";
  if (/^(===|---)/.test(text)) div.classList.add("line-header");
  if (/^#?\d+:/.test(text) || /^\[/.test(text))
    div.classList.add("line-highlight");
  div.textContent = text;
  term.appendChild(div);
  while (term.childNodes.length > 2000) term.removeChild(term.firstChild);
  if (state.autoscroll) term.scrollTop = term.scrollHeight;
}

function closeStream() {
  if (state.es) {
    state.es.close();
    state.es = null;
  }
}

/* ---------- events ---------- */

$("#btn-new").addEventListener("click", () => {
  $("#form-error").textContent = "";
  $("#new-project").showModal();
});
$("#btn-cancel-form").addEventListener("click", () =>
  $("#new-project").close(),
);
$("#btn-back").addEventListener("click", () => switchView("list"));

$("#autoscroll").addEventListener(
  "change",
  (e) => (state.autoscroll = e.target.checked),
);

$("#new-project-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#btn-submit");
  btn.disabled = true;
  $("#form-error").textContent = "";
  try {
    const p = await api("/api/projects", {
      method: "POST",
      body: new FormData(e.target),
    });
    $("#new-project").close();
    e.target.reset();
    toast(`Project #${p.id} submitted`);
    showProject(p.id);
  } catch (err) {
    $("#form-error").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

document.addEventListener("click", async (e) => {
  const card = e.target.closest(".card[data-id]");
  if (card) return showProject(Number(card.dataset.id));
  const agentCard = e.target.closest(".agent-card[data-agent]");
  if (agentCard) {
    const id = Number(agentCard.dataset.agent);
    if (selectedAgentId === id) return showPipelineLog();
    return showAgentLog(id);
  }
  if (e.target.closest("#btn-cancel")) {
    try {
      await api(`/api/projects/${state.projectId}/cancel`, { method: "POST" });
      toast("Project cancelled");
      renderDetail();
    } catch (err) {
      toast(err.message, true);
    }
  }
  if (e.target.closest("#btn-retry")) {
    try {
      await api(`/api/projects/${state.projectId}/retry`, { method: "POST" });
      toast("Retry started");
      renderDetail().then(() => watchLatestRun(true));
    } catch (err) {
      toast(err.message, true);
    }
  }
});

loadPreflight();
refreshList();
setInterval(() => state.view === "list" && refreshList(), 5000);
