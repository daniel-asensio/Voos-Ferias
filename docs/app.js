/* Voos & Férias — app de consulta de promoções (LIS · OPO · FAO) */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const DOW = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

  const state = {
    data: null,
    airlineById: {},
    view: "calendar",
    month: null,          // Date do 1º dia do mês visível
    selectedDay: null,    // "YYYY-MM-DD"
    newsCat: null,        // filtro de categoria no separador Notícias
    filters: { airports: new Set(), airlines: new Set(), dest: "" },
  };

  const NEWS_CATS = {
    greve: { label: "⚠️ Greves", cls: "cat-greve" },
    problema: { label: "🔧 Problemas e atrasos", cls: "cat-problema" },
    promocao: { label: "🏷️ Promoções", cls: "cat-promocao" },
    novidade: { label: "🆕 Novidades e rotas", cls: "cat-novidade" },
    geral: { label: "📄 Geral", cls: "cat-geral" },
  };

  /* ---------- utilidades de datas ---------- */
  const iso = (d) => d.toISOString().slice(0, 10);
  const todayIso = () => iso(new Date());
  function parseIso(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
  function fmtDate(s) {
    if (!s) return "—";
    const d = parseIso(s);
    return `${d.getDate()} ${MESES[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
  }
  function daysBetween(a, b) { return Math.round((parseIso(b) - parseIso(a)) / 864e5); }

  /* ---------- carregamento de dados ---------- */
  async function loadData() {
    if (window.__DATA__) return window.__DATA__;
    const get = (f) => fetch("data/" + f).then((r) => {
      if (!r.ok) throw new Error(f + ": " + r.status);
      return r.json();
    });
    const [airlines, promotions, history, meta, alerts, news] = await Promise.all([
      get("airlines.json"), get("promotions.json"), get("price_history.json"),
      get("meta.json").catch(() => ({})),
      get("alerts.json").catch(() => ({ alerts: [] })),
      get("news.json").catch(() => ({ items: [] })),
    ]);
    return { airlines, promotions, history, meta, alerts, news };
  }

  function airlineOf(code) {
    return state.airlineById[code] || { code, name: code, color: "#888", airports: [] };
  }

  /* ---------- filtros ---------- */
  function promoStatus(p) {
    const t = todayIso();
    if (p.booking_end && p.booking_end < t) return "over";
    if (p.booking_start > t) return "soon";
    if (p.booking_end && daysBetween(t, p.booking_end) <= 2) return "ending";
    return "live";
  }

  function matchesFilters(p) {
    const f = state.filters;
    if (f.airlines.size && !f.airlines.has(p.airline)) return false;
    if (f.airports.size && !(p.origin_airports || []).some((a) => f.airports.has(a))) return false;
    if (f.dest) {
      const q = f.dest.toLowerCase();
      const hay = ((p.destinations || []).join(" ") + " " + p.title + " " + (p.description || "")).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  const filteredPromos = () => state.data.promotions.filter(matchesFilters);

  function renderChips() {
    const airports = state.data.airlines.airports;
    $("#airport-chips").innerHTML = Object.keys(airports).map((c) =>
      `<button class="chip ${state.filters.airports.has(c) ? "on" : ""}" data-airport="${c}" title="${airports[c]}">${c}</button>`
    ).join("");
    $("#airline-chips").innerHTML = state.data.airlines.airlines.map((a) =>
      `<button class="chip ${state.filters.airlines.has(a.code) ? "on" : ""}" data-airline="${a.code}">
         <span class="dot" style="background:${a.color}"></span>${a.name.split(" ")[0]}</button>`
    ).join("");
  }

  /* ---------- estatísticas do topo ---------- */
  function renderStats() {
    const promos = state.data.promotions;
    const live = promos.filter((p) => promoStatus(p) === "live" || promoStatus(p) === "ending").length;
    const soon = promos.filter((p) => promoStatus(p) === "soon").length;
    const airlines = new Set(promos.map((p) => p.airline)).size;
    const routes = Object.keys(state.data.history.routes || {}).length;
    $("#stats").innerHTML = [
      `<span class="stat"><b>${live}</b> a decorrer</span>`,
      `<span class="stat"><b>${soon}</b> vão começar</span>`,
      `<span class="stat"><b>${airlines}</b> companhias</span>`,
      `<span class="stat"><b>${routes}</b> rotas com histórico</span>`,
    ].join("");
    const al = state.data.alerts;
    if (al && al.date === todayIso() && (al.alerts || []).length) {
      $("#stats").innerHTML += `<span class="stat">🔥 <b>${al.alerts.length}</b> em mínimo histórico hoje</span>`;
    }
    const strikes = strikeAirlines();
    if (strikes.size) {
      const names = [...strikes].map((c) => airlineOf(c).name.split(" ")[0]).join(", ");
      $("#stats").innerHTML += `<span class="stat">⚠️ greve nas notícias: <b>${names}</b></span>`;
    }
  }

  /* ---------- calendário ---------- */
  function promosOnDay(dayIso) {
    return filteredPromos().filter((p) =>
      p.booking_start <= dayIso && (!p.booking_end || p.booking_end >= dayIso));
  }

  function renderCalendar() {
    const y = state.month.getFullYear(), m = state.month.getMonth();
    $("#cal-title").textContent = `${MESES[m]} ${y}`;
    const first = new Date(y, m, 1);
    const startOffset = (first.getDay() + 6) % 7; // semana começa à 2ª feira
    const cells = [];
    DOW.forEach((d) => cells.push(`<div class="cal-dow">${d}</div>`));
    const t = todayIso();
    for (let i = 0; i < 42; i++) {
      const date = new Date(y, m, 1 - startOffset + i);
      const dIso = iso(new Date(date.getTime() - date.getTimezoneOffset() * 6e4));
      const inMonth = date.getMonth() === m;
      const promos = promosOnDay(dIso);
      const bars = promos.slice(0, 3).map((p) => {
        const a = airlineOf(p.airline);
        const starts = p.booking_start === dIso ? "starts" : "";
        return `<span class="cal-bar ${starts}" style="background:${a.color}" title="${esc(p.title)}">${esc(p.title)}</span>`;
      }).join("");
      const more = promos.length > 3 ? `<span class="cal-more">+${promos.length - 3} mais</span>` : "";
      const dots = promos.slice(0, 6).map((p) =>
        `<span class="dot" style="background:${airlineOf(p.airline).color}"></span>`).join("");
      cells.push(
        `<div class="cal-day ${inMonth ? "" : "other"} ${dIso === t ? "today" : ""} ${dIso === state.selectedDay ? "selected" : ""}" data-day="${dIso}">
           <span class="cal-num">${date.getDate()}</span>${bars}${more}
           <span class="cal-dots">${dots}</span>
         </div>`);
    }
    $("#calendar").innerHTML = cells.join("");
    renderDayDetail();
  }

  function renderDayDetail() {
    const el = $("#day-detail");
    if (!state.selectedDay) {
      el.innerHTML = `<p class="empty">Clica num dia para veres as promoções em que podes reservar nesse dia.</p>`;
      return;
    }
    const promos = promosOnDay(state.selectedDay);
    el.innerHTML = `<h3 style="margin:0 0 8px">Promoções reserváveis a ${fmtDate(state.selectedDay)}</h3>` +
      (promos.length ? promos.map(promoCard).join("") : `<p class="empty">Sem promoções neste dia (com os filtros atuais).</p>`);
  }

  /* ---------- lista ---------- */
  function esc(s) {
    return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function promoCard(p) {
    const a = airlineOf(p.airline);
    const st = promoStatus(p);
    const badges = {
      live: `<span class="badge live">a decorrer</span>`,
      soon: `<span class="badge soon">começa a ${fmtDate(p.booking_start)}</span>`,
      ending: `<span class="badge ending">termina em breve — até ${fmtDate(p.booking_end)}</span>`,
      over: `<span class="badge over">terminada</span>`,
    };
    const extra = p.confidence === "baixa"
      ? `<span class="badge" title="Detetada automaticamente — confirmar no site">deteção automática</span>` : "";
    const demo = p.source === "exemplo" ? `<span class="badge">exemplo</span>` : "";
    const strike = strikeAirlines().has(p.airline)
      ? `<span class="badge ending" title="Há notícias de greve desta companhia — ver separador Notícias">⚠️ greve nas notícias</span>` : "";
    return `<article class="promo-card" style="border-left-color:${a.color}">
      <div class="promo-head">
        <span class="promo-airline" style="color:${a.color}">${esc(a.name)}</span>
        <span class="promo-title">${esc(p.title)}</span>
        ${badges[st]}${extra}${demo}${strike}
      </div>
      ${p.description ? `<p class="promo-desc">${esc(p.description)}</p>` : ""}
      <div class="promo-meta">
        ${p.discount_text ? `<span class="promo-price">${esc(p.discount_text)}</span>` : ""}
        ${p.price_from && !/desde/i.test(p.discount_text || "") ? `<span class="promo-price">desde ${p.price_from.toFixed(2).replace(".", ",")} €</span>` : ""}
        <span>🛫 <b>${(p.origin_airports || []).join(" · ")}</b></span>
        ${(p.destinations || []).length ? `<span>📍 ${esc(p.destinations.join(", "))}</span>` : ""}
        <span>🗓️ Reservas: <b>${fmtDate(p.booking_start)} – ${fmtDate(p.booking_end)}</b></span>
        ${p.travel_start ? `<span>✈️ Viagens: ${fmtDate(p.travel_start)} – ${fmtDate(p.travel_end)}</span>` : ""}
        ${p.url ? `<span><a href="${esc(p.url)}" target="_blank" rel="noopener">ver no site ↗</a></span>` : ""}
      </div>
    </article>`;
  }

  function renderList() {
    const promos = filteredPromos();
    const groups = { live: [], ending: [], soon: [], over: [] };
    promos.forEach((p) => groups[promoStatus(p)].push(p));
    groups.live = groups.ending.concat(groups.live); // "termina em breve" primeiro
    const section = (title, list) => list.length
      ? `<div class="promo-section"><h3>${title} (${list.length})</h3>${list.map(promoCard).join("")}</div>` : "";
    const html =
      section("🔥 A decorrer", groups.live) +
      section("⏳ Vão começar", groups.soon.sort((a, b) => a.booking_start.localeCompare(b.booking_start))) +
      section("📁 Terminadas recentemente", groups.over.sort((a, b) => b.booking_end.localeCompare(a.booking_end)));
    $("#promo-list").innerHTML = html || `<p class="empty">Nenhuma promoção corresponde aos filtros.</p>`;
  }

  /* ---------- notícias ---------- */
  function newsItems() { return (state.data.news && state.data.news.items) || []; }

  // Companhias com greve nas notícias dos últimos 10 dias → aviso nos cartões.
  function strikeAirlines() {
    const cutoff = iso(new Date(Date.now() - 10 * 864e5));
    const set = new Set();
    newsItems().forEach((n) => {
      if (n.category === "greve" && n.published >= cutoff) (n.airlines || []).forEach((a) => set.add(a));
    });
    return set;
  }

  function newsMatchesFilters(n) {
    const f = state.filters;
    if (state.newsCat && n.category !== state.newsCat) return false;
    if (f.airlines.size && !(n.airlines || []).some((a) => f.airlines.has(a))) return false;
    if (f.airports.size && !(n.airports || []).some((a) => f.airports.has(a))) return false;
    if (f.dest && !n.title.toLowerCase().includes(f.dest.toLowerCase())) return false;
    return true;
  }

  function renderNews() {
    const items = newsItems();
    const counts = {};
    items.forEach((n) => { counts[n.category] = (counts[n.category] || 0) + 1; });
    $("#news-cats").innerHTML =
      `<button class="chip ${state.newsCat === null ? "on" : ""}" data-cat="">Todas (${items.length})</button>` +
      Object.entries(NEWS_CATS).filter(([c]) => counts[c]).map(([c, m]) =>
        `<button class="chip ${state.newsCat === c ? "on" : ""}" data-cat="${c}">${m.label} (${counts[c]})</button>`
      ).join("");
    const list = items.filter(newsMatchesFilters);
    $("#news-list").innerHTML = list.length ? list.map((n) => {
      const cat = NEWS_CATS[n.category] || NEWS_CATS.geral;
      const tags = (n.airlines || []).map((a) => {
        const al = airlineOf(a);
        return `<span class="chip mini"><span class="dot" style="background:${al.color}"></span>${esc(al.name.split(" ")[0])}</span>`;
      }).join("") + (n.airports || []).map((a) => `<span class="chip mini">🛫 ${a}</span>`).join("");
      return `<article class="news-card">
        <span class="cat-pill ${cat.cls}">${cat.label}</span>
        <div class="news-body">
          <a class="news-title" href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>
          <div class="news-meta">${n.source ? esc(n.source) + " · " : ""}${fmtDate(n.published)}</div>
          ${tags ? `<div class="news-tags">${tags}</div>` : ""}
        </div>
      </article>`;
    }).join("") : `<p class="empty">${items.length
      ? "Nenhuma notícia corresponde aos filtros."
      : "Ainda sem notícias — são recolhidas automaticamente na próxima atualização diária."}</p>`;
  }

  /* ---------- preços ---------- */
  function routeLabel(key) {
    const r = state.data.history.routes[key];
    const [o, d] = key.split("-");
    return `${o} → ${d}${r.destination_name ? ` (${r.destination_name})` : ""} · ${airlineOf(r.airline).name}`;
  }

  function renderRouteSelect() {
    const keys = Object.keys(state.data.history.routes || {}).sort();
    $("#route-select").innerHTML = keys.map((k) => `<option value="${k}">${esc(routeLabel(k))}</option>`).join("");
    if (keys.length) renderPriceChart(keys[0]);
    else $("#price-chart").innerHTML = `<p class="empty">Ainda sem histórico de preços — aparece após a primeira recolha.</p>`;
  }

  function renderPriceChart(routeKey) {
    const route = state.data.history.routes[routeKey];
    const snaps = route.snapshots;
    if (!snaps.length) return;
    const W = 900, H = 260, PAD = { l: 46, r: 14, t: 14, b: 30 };
    const prices = snaps.map((s) => s.price);
    const min = Math.min(...prices), max = Math.max(...prices);
    const span = Math.max(max - min, 1);
    const x = (i) => PAD.l + (i / Math.max(snaps.length - 1, 1)) * (W - PAD.l - PAD.r);
    const y = (p) => PAD.t + (1 - (p - min) / span) * (H - PAD.t - PAD.b);
    const pts = snaps.map((s, i) => `${x(i).toFixed(1)},${y(s.price).toFixed(1)}`).join(" ");
    const minIdx = prices.indexOf(min);
    const gridLines = [0, .25, .5, .75, 1].map((f) => {
      const val = min + span * (1 - f);
      const yy = PAD.t + f * (H - PAD.t - PAD.b);
      return `<line x1="${PAD.l}" y1="${yy}" x2="${W - PAD.r}" y2="${yy}" stroke="currentColor" opacity=".12"/>
              <text x="${PAD.l - 6}" y="${yy + 4}" text-anchor="end" font-size="11" fill="currentColor" opacity=".6">${val.toFixed(0)}€</text>`;
    }).join("");
    const nLabels = Math.min(6, snaps.length);
    const xLabels = Array.from({ length: nLabels }, (_, i) => {
      const idx = Math.round(i * (snaps.length - 1) / Math.max(nLabels - 1, 1));
      const anchor = idx === 0 ? "start" : idx === snaps.length - 1 ? "end" : "middle";
      return `<text x="${x(idx)}" y="${H - 8}" text-anchor="${anchor}" font-size="11" fill="currentColor" opacity=".6">${fmtDate(snaps[idx].date)}</text>`;
    }).join("");
    const color = airlineOf(route.airline).color;
    $("#price-chart").innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolução do preço ${esc(routeKey)}">
        ${gridLines}${xLabels}
        <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round"/>
        <circle cx="${x(minIdx)}" cy="${y(min)}" r="5" fill="${color}"/>
        <text x="${x(minIdx)}" y="${y(min) - 9}" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">mín. ${min.toFixed(2)}€ (${fmtDate(snaps[minIdx].date)})</text>
      </svg>`;
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const last = snaps[snaps.length - 1];
    $("#price-summary").innerHTML = [
      `<span class="stat"><b>${last.price.toFixed(2)}€</b> última recolha (${fmtDate(last.date)})</span>`,
      `<span class="stat"><b>${min.toFixed(2)}€</b> mínimo histórico</span>`,
      `<span class="stat"><b>${max.toFixed(2)}€</b> máximo</span>`,
      `<span class="stat"><b>${avg.toFixed(2)}€</b> média</span>`,
    ].join("");
    answerPriceAt();
  }

  function answerPriceAt() {
    const routeKey = $("#route-select").value;
    const dateVal = $("#price-date").value;
    const out = $("#price-answer");
    if (!routeKey || !dateVal) { out.textContent = ""; return; }
    const snaps = state.data.history.routes[routeKey].snapshots;
    let best = null;
    for (const s of snaps) {
      if (!best || Math.abs(daysBetween(s.date, dateVal)) < Math.abs(daysBetween(best.date, dateVal))) best = s;
    }
    if (!best) { out.textContent = "sem dados"; return; }
    const exact = best.date === dateVal ? "" : ` (recolha mais próxima: ${fmtDate(best.date)})`;
    out.textContent = `≈ ${best.price.toFixed(2)}€${exact}`;
  }

  function renderBestNow() {
    const rows = Object.entries(state.data.history.routes || {}).map(([key, r]) => {
      const last = r.snapshots[r.snapshots.length - 1];
      if (!last) return null;
      const min = Math.min(...r.snapshots.map((s) => s.price));
      const isMin = last.price <= min + 0.01;
      return { key, r, last, isMin };
    }).filter(Boolean).sort((a, b) => a.last.price - b.last.price);
    $("#best-now").innerHTML = rows.length ? `<table class="best">
      <tr><th>Rota</th><th>Companhia</th><th>Preço atual</th><th>Data de recolha</th><th></th></tr>
      ${rows.map(({ key, r, last, isMin }) => `<tr>
        <td><b>${key.replace("-", " → ")}</b>${r.destination_name ? ` · ${esc(r.destination_name)}` : ""}</td>
        <td><span class="dot" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${airlineOf(r.airline).color}"></span> ${esc(airlineOf(r.airline).name)}</td>
        <td><b>${last.price.toFixed(2)}€</b></td>
        <td>${fmtDate(last.date)}</td>
        <td>${isMin ? `<span class="badge live">mínimo histórico 🔥</span>` : ""}</td>
      </tr>`).join("")}
    </table>` : `<p class="empty">Sem dados de tarifas ainda.</p>`;
  }

  /* ---------- exportação ICS ---------- */
  function exportIcs() {
    const promos = filteredPromos().filter((p) => promoStatus(p) !== "over");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//VoosFerias//PT", "CALSCALE:GREGORIAN"];
    promos.forEach((p) => {
      const end = parseIso(p.booking_end || p.booking_start);
      end.setDate(end.getDate() + 1); // DTEND exclusivo em eventos de dia inteiro
      lines.push("BEGIN:VEVENT",
        `UID:${p.id}@voos-ferias`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${p.booking_start.replace(/-/g, "")}`,
        `DTEND;VALUE=DATE:${iso(end).replace(/-/g, "")}`,
        `SUMMARY:${p.airline_name || p.airline}: ${p.title.replace(/[,;\\]/g, " ")}`,
        `DESCRIPTION:${(p.discount_text || "")} ${(p.description || "").replace(/[,;\\\n]/g, " ")} ${p.url || ""}`.trim(),
        "END:VEVENT");
    });
    lines.push("END:VCALENDAR");
    const blob = new Blob([lines.join("\r\n")], { type: "text/calendar" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "promocoes-voos.ics";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ---------- navegação e eventos ---------- */
  function rerender() {
    renderChips();
    renderStats();
    if (state.view === "calendar") renderCalendar();
    if (state.view === "list") renderList();
    if (state.view === "news") renderNews();
    if (state.view === "prices") { renderRouteSelect(); renderBestNow(); }
  }

  function bindEvents() {
    document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
      state.view = tab.dataset.view;
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      document.querySelectorAll(".view").forEach((v) => { v.hidden = v.id !== "view-" + state.view; });
      $("#filters").hidden = state.view === "prices";
      rerender();
    }));
    $("#airport-chips").addEventListener("click", (e) => {
      const c = e.target.closest("[data-airport]");
      if (!c) return;
      toggleSet(state.filters.airports, c.dataset.airport);
      rerender();
    });
    $("#airline-chips").addEventListener("click", (e) => {
      const c = e.target.closest("[data-airline]");
      if (!c) return;
      toggleSet(state.filters.airlines, c.dataset.airline);
      rerender();
    });
    $("#dest-search").addEventListener("input", (e) => { state.filters.dest = e.target.value.trim(); rerender(); });
    $("#clear-filters").addEventListener("click", () => {
      state.filters = { airports: new Set(), airlines: new Set(), dest: "" };
      $("#dest-search").value = "";
      rerender();
    });
    $("#export-ics").addEventListener("click", exportIcs);
    $("#cal-prev").addEventListener("click", () => { state.month.setMonth(state.month.getMonth() - 1); renderCalendar(); });
    $("#cal-next").addEventListener("click", () => { state.month.setMonth(state.month.getMonth() + 1); renderCalendar(); });
    $("#cal-today").addEventListener("click", () => {
      const now = new Date();
      state.month = new Date(now.getFullYear(), now.getMonth(), 1);
      state.selectedDay = todayIso();
      renderCalendar();
    });
    $("#calendar").addEventListener("click", (e) => {
      const day = e.target.closest("[data-day]");
      if (!day) return;
      state.selectedDay = day.dataset.day;
      renderCalendar();
    });
    $("#news-cats").addEventListener("click", (e) => {
      const c = e.target.closest("[data-cat]");
      if (!c) return;
      state.newsCat = c.dataset.cat || null;
      renderNews();
    });
    $("#route-select").addEventListener("change", (e) => renderPriceChart(e.target.value));
    $("#price-date").addEventListener("change", answerPriceAt);
  }

  function toggleSet(set, val) { set.has(val) ? set.delete(val) : set.add(val); }

  /* ---------- arranque ---------- */
  loadData().then((data) => {
    state.data = data;
    data.airlines.airlines.forEach((a) => { state.airlineById[a.code] = a; });
    const now = new Date();
    state.month = new Date(now.getFullYear(), now.getMonth(), 1);
    state.selectedDay = todayIso();
    if (data.meta && data.meta.is_demo) $("#demo-banner").hidden = false;
    if (data.meta && data.meta.generated_at) {
      $("#meta-info").textContent = "Última atualização dos dados: " +
        new Date(data.meta.generated_at).toLocaleString("pt-PT");
    }
    bindEvents();
    rerender();
  }).catch((err) => {
    document.querySelector("main").innerHTML =
      `<p class="empty">Não foi possível carregar os dados (${esc(err.message)}). ` +
      `Corre <code>python -m collector.seed</code> para gerar dados de exemplo.</p>`;
  });
})();
