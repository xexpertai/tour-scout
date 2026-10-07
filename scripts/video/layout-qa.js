// Layout QA run in the page (Playwright evaluate): returns a list of issues. Shared by the video
// takes and scripts/video/app-qa.py.
(need) => {
  const issues = [];
  const vw = innerWidth, vh = innerHeight;
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 1) issues.push(`horizontal overflow: ${de.scrollWidth} > ${de.clientWidth}`);
  const pane = document.getElementById('plan-scroll'), map = document.querySelector('.map-box');
  // An element's rectangle as actually painted: clipped to the plan pane when it lives inside it.
  const R = (el) => { const r = el.getBoundingClientRect(); if (!pane || !pane.contains(el) || el === pane) return r;
    const p = pane.getBoundingClientRect(); const top = Math.max(r.top, p.top), bottom = Math.min(r.bottom, p.bottom);
    return { left: r.left, right: r.right, top, bottom: Math.max(top, bottom), width: r.width, height: Math.max(0, bottom - top), raw: r }; };
  // Content inside a closed <details> is not painted, although Chrome still reports its geometry.
  const folded = (el) => { const d = el.closest('details:not([open])'); return Boolean(d) && !el.closest('summary'); };
  // Effective opacity (a map marker fades through its wrapper, not the label itself).
  const opacity = (el) => { let o = 1; for (let a = el; a && a !== document.body; a = a.parentElement) o *= parseFloat(getComputedStyle(a).opacity); return o; };
  const shown = (el) => { if (folded(el)) return false; const r = R(el); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && opacity(el) > 0.05 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw; };
  const textLeaves = [...document.querySelectorAll('body *')].filter((el) => shown(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
  // Header fully in frame.
  const header = document.querySelector('body > div header, header');
  if (header) { const r = R(header); if (r.top < -0.5 || r.left < -0.5 || r.right > vw + 0.5) issues.push('header not fully in frame'); }
  // The plan view starts right under the header (no empty band).
  const mapBox = document.querySelector('.map-box');
  if (header && mapBox && innerWidth >= 1024 && document.getElementById('plan-scroll')) { const gap = mapBox.getBoundingClientRect().top - header.getBoundingClientRect().bottom; if (Math.abs(gap) > 2) issues.push(`gap of ${Math.round(gap)} px between the header and the map`); }
  // Text clipped by the frame or by its pane (plan pane top edge, map pane, dock).
  for (const el of textLeaves) {
    const r = R(el), t = el.textContent.trim().slice(0, 40);
    if (el.closest('#__cursor')) continue;
    // A horizontally scrolling strip (the phone's stop chips) is meant to run past the edge.
    const hScroll = (() => { for (let a = el.parentElement; a; a = a.parentElement) { const ox = getComputedStyle(a).overflowX; if ((ox === 'auto' || ox === 'scroll') && a.scrollWidth > a.clientWidth) return true; } return false; })();
    if (!hScroll && (r.left < -1 || r.right > vw + 1)) issues.push(`text cut by the frame edge: "${t}"`);
    if (pane && pane.contains(el) && r.raw) { const p = pane.getBoundingClientRect(); if (r.raw.top < p.top - 1 && r.raw.bottom > p.top + 2) issues.push(`text cut at the top of the plan pane: "${t}"`); }
    if (map && el.closest('.maplibregl-marker')) { const m = R(map); if (r.left < m.left - 1 || r.right > m.right + 1 || r.top < m.top - 1 || r.bottom > m.bottom + 1) issues.push(`map label cut by the pane edge: "${t}"`); }
    const cs = getComputedStyle(el);
    if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) issues.push(`truncated: "${t}"`);
  }
  // Nothing underneath the scout dock.
  const dock = document.querySelector('#ask');
  if (dock && shown(dock)) { const d = R(dock); for (const el of textLeaves) { if (dock.contains(el) || el.closest('[role=dialog]') || el.closest('#__cursor')) continue; const r = R(el); if (r.bottom > d.top + 1 && r.top < d.bottom - 1 && r.right > d.left && r.left < d.right) { issues.push(`under the dock: "${el.textContent.trim().slice(0, 40)}"`); break; } } }
  // Map labels and pins never collide.
  const boxes = [...document.querySelectorAll('.maplibregl-marker')].filter((m) => !m.classList.contains('crowded') && m.querySelector('.mk') && parseFloat(getComputedStyle(m.querySelector('.mk')).opacity) > 0.5)
    .flatMap((m) => [...m.querySelectorAll('.lbl, .stop-pin, .cand-dot')].filter(shown).map((el) => ({ el, r: R(el), m })));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j]; if (a.m === b.m) continue;
    if (a.r.left < b.r.right - 1 && b.r.left < a.r.right - 1 && a.r.top < b.r.bottom - 1 && b.r.top < a.r.bottom - 1) issues.push(`map collision: "${a.el.textContent.trim() || 'pin'}" / "${b.el.textContent.trim() || 'pin'}"`);
  }
  // Skeletons, mid-sentence ellipses, placeholders, stray spaces.
  if ([...document.querySelectorAll('.skeleton')].some(shown)) issues.push('skeleton block on screen');
  for (const el of document.querySelectorAll('[data-stop] p, #ask p, [role=dialog] p')) if (shown(el) && /…\s*$/.test(el.textContent)) issues.push(`ellipsis: "${el.textContent.trim().slice(-50)}"`);
  const text = document.body.innerText;
  for (const p of ['coming soon', '_pending_', 'DEMO_URL', 'REPO_URL', 'TODO', 'lorem', 'undefined', 'NaN']) if (text.includes(p)) issues.push(`placeholder text: ${p}`);
  const odd = text.match(/[^\s] [.,](?!\d)|\S {2,}\S/); if (odd) issues.push(`stray space: "${odd[0]}"`);
  // The narrated element is on screen (and not covered).
  const find = (sel) => sel.startsWith('text:')
    ? [...document.querySelectorAll('h1,h2,h3,h4,p,span,b,button,li,div')].find((e) => e.children.length === 0 && shown(e) && e.textContent.includes(sel.slice(5)))
    : document.querySelector(sel);
  for (const sel of need || []) {
    const el = find(sel);
    if (!el || !shown(el)) { issues.push(`narrated element not visible: ${sel}`); continue; }
    const r = R(el), x = Math.min(vw - 2, Math.max(1, r.left + r.width / 2)), y = Math.min(vh - 2, Math.max(1, r.top + Math.min(r.height / 2, 20)));
    const top = document.elementFromPoint(x, y); if (top && !el.contains(top) && !top.contains(el) && !top.closest('#__cursor')) issues.push(`narrated element covered: ${sel}`);
  }
  return issues;
}
