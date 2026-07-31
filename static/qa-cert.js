async function loadCertificate() {
  const root = document.getElementById("cert-root");
  const id = window.location.pathname.split("/").filter(Boolean).pop();
  const res = await fetch(`/api/qa/certificates/${encodeURIComponent(id)}`).catch(() => null);
  if (!res || !res.ok) {
    root.innerHTML = `<div class="loading-card">Certificate not found. Double-check the link.</div>`;
    return;
  }
  const cert = await res.json();
  renderCertificate(cert);
}

function renderCertificate(cert) {
  const root = document.getElementById("cert-root");
  const date = new Date(cert.created_at * 1000).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });
  const time = new Date(cert.created_at * 1000).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit",
  });

  const metaRows = [
    cert.task_title ? `<div class="qa-cert-meta-row"><span>Task</span><strong>${esc(cert.task_title)}</strong></div>` : "",
    cert.client_name ? `<div class="qa-cert-meta-row"><span>Client</span><strong>${esc(cert.client_name)}</strong></div>` : "",
    cert.completed_by ? `<div class="qa-cert-meta-row"><span>QA'd by</span><strong>${esc(cert.completed_by)}</strong></div>` : "",
    `<div class="qa-cert-meta-row"><span>Completed</span><strong>${date} at ${time}</strong></div>`,
  ].filter(Boolean).join("");

  root.innerHTML = `
    <div class="qa-cert-badge">
      <div class="qa-cert-badge-icon">&#10003;</div>
      <div class="qa-cert-badge-title">QA Passed</div>
      <div class="qa-cert-badge-service">${esc(cert.service)}</div>
    </div>
    <div class="qa-cert-panel">
      ${metaRows}
    </div>
    <div class="qa-cert-panel">
      <div class="qa-cert-panel-title">Checklist (${cert.items.length}/${cert.items.length} passed)</div>
      <ul class="qa-cert-item-list">
        ${cert.items.map(i => `<li class="qa-cert-item"><span class="qa-cert-check">&#10003;</span>${esc(i.text)}</li>`).join("")}
      </ul>
    </div>
    ${cert.notes ? `
      <div class="qa-cert-panel">
        <div class="qa-cert-panel-title">Notes</div>
        <div class="qa-cert-notes">${esc(cert.notes)}</div>
      </div>
    ` : ""}
    <div class="qa-cert-footer">
      <button class="btn btn-ghost btn-sm" onclick="copyLink()">Copy this link</button>
    </div>
  `;
}

function copyLink() {
  navigator.clipboard?.writeText(window.location.href);
  const btn = event?.target;
  if (btn) {
    const original = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = original; }, 1500);
  }
}

document.addEventListener("DOMContentLoaded", loadCertificate);
