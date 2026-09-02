/* Voos & Férias — app de consulta de promoções e preços (LIS · OPO · FAO) */
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
    calRoute: null,       // rota cujos preços diários se mostram no calendário
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

  /* ---------- utilidades ---------- */
  const iso = (d) => d.toISOString().slice(0, 10);
  const todayIso = () => iso(new Date());
  function parseIso(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
  function fmtDate(s) {
    if (!s) return "—";
    const d = parseIso(s);
    return `${d.getDate()} ${MESES[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
  }
  function daysBetween(a, b) { return Math.round((parseIso(b) - parseIso(a)) / 864e5); }
  const eur = (n) => `${Number(n).toFixed(2).replace(".", ",")}€`;
  function esc(s) {
    return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function airlineOf(code) {
    return state.airlineById[code] || { code, name: code, color: "#888", airports: [] };
  }
  const dot = (code) => `<span class="dot" style="background:${airlineOf(code).color}"></span>`;
  const shortName = (code) => esc(airlineOf(code).name.split(" (")[0].split(" ")[0]);

  /* ---------- carregamento de dados ---------- */
  async function loadData() {
    if (window.__DATA__) return normalize(window.__DATA__);
    const get = (f) => fetch("data/" + f, { cache: "no-cache" }).then((r) => {
      if (!r.ok) throw new Error(f + ": " + r.status);
      return r.json();
    });
    const [airlines, promotions, history, meta, alerts, news, calendar] = await Promise.all([
      get("airlines.json"), get("promotions.json"), get("price_history.json"),
      get("meta.json").catch(() => ({})),
      get("alerts.json").catch(() => ({ alerts: [] })),
      get("news.json").catch(() => ({ items: [] })),
      get("fare_calendar.json").catch(() => ({ routes: {} })),
    ]);
    return normalize({ airlines, promotions, history, meta, alerts, news, calendar });
  }

  // Aceita o formato antigo do histórico (uma companhia por rota).
  function normalize(data) {
    Object.values((data.history && data.history.routes) || {}).forEach((r) => {
      if (r.snapshots) { r.airlines = { [r.airline || "FR"]: r.snapshots }; delete r.snapshots; }
    });
    data.calendar = data.calendar || { routes: {} };
    return data;
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
  const activeFilterCount = () => state.filters.airports.size + state.filters.airlines.size + (state.filters.dest ? 1 : 0);
  const clearButton = () => activeFilterCount()
    ? ` <button class="btn-ghost" data-clear>Limpar filtros (${activeFilterCount()})</button>` : "";

  function renderChips() {
    const airports = state.data.airlines.airports;
    $("#airport-chips").innerHTML = Object.keys(airports).map((c) =>
      `<button class="chip ${state.filters.airports.has(c) ? "on" : ""}" data-airport="${c}" title="${airports[c]}">${c}</button>`
    ).join("");
    $("#airline-chips").innerHTML = state.data.airlines.airlines.map((a) =>
      `<button class="chip ${state.filters.airlines.has(a.code) ? "on" : ""}" data-airline="${a.code}">
         <span class="dot" style="background:${a.color}"></span>${a.name.split(" ")[0]}</button>`
    ).join("");
    const n = activeFilterCount();
    $("#clear-filters").textContent = n ? `Limpar (${n})` : "Limpar";
    $("#clear-filters").classList.toggle("btn-primary", n > 0);
  }

  /* ---------- rotas e preços (dados partilhados) ---------- */
  const routes = () => (state.data.history && state.data.history.routes) || {};

  // Companhias de uma rota que passam no filtro de companhia.
  function routeAirlines(key) {
    const f = state.filters.airlines;
    return Object.keys(routes()[key].airlines || {}).filter((a) => !f.size || f.has(a));
  }

  // Os filtros globais (aeroporto, companhia, destino) aplicam-se às rotas.
  function filteredRouteKeys() {
    const f = state.filters;
    return Object.keys(routes()).filter((k) => {
      const r = routes()[k];
      const origin = k.split("-")[0];
      if (f.airports.size && !f.airports.has(origin)) return false;
      if (!routeAirlines(k).length) return false;
      if (f.dest) {
        const q = f.dest.toLowerCase();
        if (!k.toLowerCase().includes(q) && !(r.destination_name || "").toLowerCase().includes(q)) return false;
      }
      return true;
    }).sort();
  }

  function routeLabel(key, withAirlines = true) {
    const r = routes()[key];
    const [o, d] = key.split("-");
    const names = withAirlines ? ` · ${routeAirlines(key).map((a) => airlineOf(a).name.split(" ")[0]).join(", ")}` : "";
    return `${o} → ${d}${r.destination_name ? ` (${r.destination_name})` : ""}${names}`;
  }

  // Último preço recolhido por companhia numa rota.
  function latestByAirline(key) {
    return routeAirlines(key).map((a) => {
      const snaps = routes()[key].airlines[a];
      return snaps.length ? { airline: a, snap: snaps[snaps.length - 1], min: Math.min(...snaps.map((s) => s.price)) } : null;
    }).filter(Boolean).sort((x, y) => x.snap.price - y.snap.price);
  }

  // Tarifas diárias (calendário) de uma rota: {dia: [{airline, price}...]} ordenado por preço.
  function dailyFares(key) {
    const cal = (state.data.calendar.routes || {})[key] || {};
    const f = state.filters.airlines;
    const byDay = {};
    Object.entries(cal).forEach(([airline, days]) => {
      if (f.size && !f.has(airline)) return;
      Object.entries(days).forEach(([day, price]) => { (byDay[day] = byDay[day] || []).push({ airline, price }); });
    });
    Object.values(byDay).forEach((l) => l.sort((a, b) => a.price - b.price));
    return byDay;
  }

  /* ---------- estatísticas do topo ---------- */
  function renderStats() {
    const promos = state.data.promotions;
    const live = promos.filter((p) => ["live", "ending"].includes(promoStatus(p))).length;
    const soon = promos.filter((p) => promoStatus(p) === "soon").length;
    const priceAirlines = new Set();
    Object.values(routes()).forEach((r) => Object.keys(r.airlines || {}).forEach((a) => priceAirlines.add(a)));
    $("#stats").innerHTML = [
      `<span class="stat"><b>${live}</b> promoções a decorrer</span>`,
      `<span class="stat"><b>${soon}</b> vão começar</span>`,
      `<span class="stat"><b>${Object.keys(routes()).length}</b> rotas com preços</span>`,
      `<span class="stat"><b>${priceAirlines.size}</b> companhias com preços</span>`,
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

  function renderCalRouteSelect() {
    const keys = filteredRouteKeys().filter((k) => Object.keys((state.data.calendar.routes || {})[k] || {}).length);
    if (!keys.includes(state.calRoute)) {
      state.calRoute = keys.includes("LIS-MAD") ? "LIS-MAD" : (keys[0] || null);
    }
    $("#cal-route").innerHTML = `<option value="">— só promoções —</option>` +
      keys.map((k) => `<option value="${k}" ${k === state.calRoute ? "selected" : ""}>${esc(routeLabel(k))}</option>`).join("");
    $("#cal-route").disabled = !keys.length;
  }

  // Escalão de preço (barato / médio / caro) dentro da rota, para colorir os dias.
  function priceTier(price, sorted) {
    if (sorted.length < 3) return "mid";
    if (price <= sorted[Math.floor(sorted.length * 0.33)]) return "low";
    if (price >= sorted[Math.floor(sorted.length * 0.75)]) return "high";
    return "mid";
  }

  function renderCalendar() {
    renderCalRouteSelect();
    const y = state.month.getFullYear(), m = state.month.getMonth();
    $("#cal-title").textContent = `${MESES[m]} ${y}`;
    const first = new Date(y, m, 1);
    const startOffset = (first.getDay() + 6) % 7; // semana começa à 2ª feira
    const fares = state.calRoute ? dailyFares(state.calRoute) : {};
    const allPrices = Object.values(fares).map((l) => l[0].price).sort((a, b) => a - b);
    const cells = [];
    DOW.forEach((d) => cells.push(`<div class="cal-dow">${d}</div>`));
    const t = todayIso();
    for (let i = 0; i < 42; i++) {
      const date = new Date(y, m, 1 - startOffset + i);
      const dIso = iso(new Date(date.getTime() - date.getTimezoneOffset() * 6e4));
      const inMonth = date.getMonth() === m;
      const promos = promosOnDay(dIso);
      const best = (fares[dIso] || [])[0];
      const price = best
        ? `<span class="cal-price tier-${priceTier(best.price, allPrices)}" title="${esc(airlineOf(best.airline).name)}: ${eur(best.price)}">
             ${dot(best.airline)}${Math.round(best.price)}€</span>` : "";
      const bars = promos.slice(0, 2).map((p) => {
        const a = airlineOf(p.airline);
        const starts = p.booking_start === dIso ? "starts" : "";
        return `<span class="cal-bar ${starts}" style="background:${a.color}" title="${esc(p.title)}">${esc(p.title)}</span>`;
      }).join("");
      const more = promos.length > 2 ? `<span class="cal-more">+${promos.length - 2} promoções</span>` : "";
      const dots = promos.slice(0, 6).map((p) => dot(p.airline)).join("");
      cells.push(
        `<div class="cal-day ${inMonth ? "" : "other"} ${dIso === t ? "today" : ""} ${dIso === state.selectedDay ? "selected" : ""}" data-day="${dIso}">
           <span class="cal-num">${date.getDate()}</span>${price}${bars}${more}
           <span class="cal-dots">${dots}</span>
         </div>`);
    }
    $("#calendar").innerHTML = cells.join("");
    const legend = $("#cal-legend");
    if (state.calRoute) {
      const airlines = Object.keys((state.data.calendar.routes || {})[state.calRoute] || {})
        .filter((a) => !state.filters.airlines.size || state.filters.airlines.has(a));
      legend.innerHTML = `Preço = tarifa mais barata para <b>partir</b> nesse dia em ${esc(routeLabel(state.calRoute, false))} ·
        ${airlines.map((a) => `${dot(a)} ${shortName(a)}`).join(" ")} ·
        <span class="cal-price tier-low">verde = barato</span> <span class="cal-price tier-high">vermelho = caro</span>`;
    } else {
      legend.innerHTML = Object.keys(state.data.calendar.routes || {}).length
        ? "Escolhe uma rota em «Preços de:» para veres o preço de cada dia."
        : "Os preços por dia aparecem no calendário após a próxima recolha diária.";
    }
    renderDayDetail();
  }

  function renderDayDetail() {
    const el = $("#day-detail");
    if (!state.selectedDay) {
      el.innerHTML = `<p class="empty">Clica num dia para veres os preços e as promoções desse dia.</p>`;
      return;
    }
    let html = "";
    if (state.calRoute) {
      const list = dailyFares(state.calRoute)[state.selectedDay] || [];
      html += `<h3 style="margin:0 0 8px">✈️ Partir a ${fmtDate(state.selectedDay)} — ${esc(routeLabel(state.calRoute, false))}</h3>`;
      html += list.length ? `<div class="fare-list">${list.map((f, i) => `
        <div class="fare-row ${i === 0 ? "best" : ""}">
          ${dot(f.airline)} <span class="fare-airline">${esc(airlineOf(f.airline).name)}</span>
          <span class="fare-price">${eur(f.price)}</span>${i === 0 && list.length > 1 ? `<span class="badge live">mais barata</span>` : ""}
        </div>`).join("")}</div>`
        : `<p class="empty">Sem voos com tarifa publicada neste dia (para esta rota e filtros).</p>`;
    }
    const promos = promosOnDay(state.selectedDay);
    html += `<h3 style="margin:16px 0 8px">🏷️ Promoções reserváveis a ${fmtDate(state.selectedDay)}</h3>` +
      (promos.length ? promos.map(promoCard).join("")
        : `<p class="empty">Sem promoções neste dia${activeFilterCount() ? " com os filtros atuais." + clearButton() : "."}</p>`);
    el.innerHTML = html;
  }

  /* ---------- cartões de promoção ---------- */
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
    const drop = p.source === "price_drop"
      ? `<span class="badge live" title="Detetada pelo nosso histórico de preços">💸 queda de preço</span>` : "";
    const strike = strikeAirlines().has(p.airline)
      ? `<span class="badge ending" title="Há notícias de greve desta companhia — ver separador Notícias">⚠️ greve nas notícias</span>` : "";
    return `<article class="promo-card" style="border-left-color:${a.color}">
      <div class="promo-head">
        <span class="promo-airline" style="color:${a.color}">${esc(a.name)}</span>
        <span class="promo-title">${esc(p.title)}</span>
        ${badges[st]}${drop}${extra}${demo}${strike}
      </div>
      ${p.description ? `<p class="promo-desc">${esc(p.description)}</p>` : ""}
      <div class="promo-meta">
        ${p.discount_text ? `<span class="promo-price">${esc(p.discount_text)}</span>` : ""}
        ${p.price_from && !/desde/i.test(p.discount_text || "") ? `<span class="promo-price">desde ${eur(p.price_from)}</span>` : ""}
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
    $("#promo-list").innerHTML = html || `<p class="empty">Nenhuma promoção corresponde aos filtros.${clearButton()}</p>`;
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
      const tags = (n.airlines || []).map((a) =>
        `<span class="chip mini">${dot(a)}${shortName(a)}</span>`).join("") +
        (n.airports || []).map((a) => `<span class="chip mini">🛫 ${a}</span>`).join("");
      return `<article class="news-card">
        <span class="cat-pill ${cat.cls}">${cat.label}</span>
        <div class="news-body">
          <a class="news-title" href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>
          <div class="news-meta">${n.source ? esc(n.source) + " · " : ""}${fmtDate(n.published)}</div>
          ${tags ? `<div class="news-tags">${tags}</div>` : ""}
        </div>
      </article>`;
    }).join("") : `<p class="empty">${items.length
      ? "Nenhuma notícia corresponde aos filtros." + clearButton()
      : "Ainda sem notícias — são recolhidas automaticamente na próxima atualização diária."}</p>`;
  }

  /* ---------- preços ---------- */
  function renderRouteSelect() {
    const keys = filteredRouteKeys();
    const previous = $("#route-select").value;
    $("#route-select").innerHTML = keys.map((k) => `<option value="${k}">${esc(routeLabel(k))}</option>`).join("");
    if (keys.length) {
      const selected = keys.includes(previous) ? previous : (keys.includes("LIS-MAD") ? "LIS-MAD" : keys[0]);
      $("#route-select").value = selected;
      renderPriceChart(selected);
    } else {
      $("#price-chart").innerHTML = `<p class="empty">Nenhuma rota corresponde aos filtros.${clearButton()}</p>`;
      $("#price-summary").innerHTML = "";
      $("#price-answer").textContent = "";
    }
  }

  function renderPriceChart(routeKey) {
    const airlines = routeAirlines(routeKey);
    const series = airlines.map((a) => ({ airline: a, snaps: routes()[routeKey].airlines[a] })).filter((s) => s.snaps.length);
    if (!series.length) { $("#price-chart").innerHTML = ""; return; }
    const dates = [...new Set(series.flatMap((s) => s.snaps.map((x) => x.date)))].sort();
    const all = series.flatMap((s) => s.snaps.map((x) => x.price));
    const W = 900, H = 260, PAD = { l: 46, r: 14, t: 14, b: 30 };
    const min = Math.min(...all), max = Math.max(...all);
    const span = Math.max(max - min, 1);
    const x = (date) => PAD.l + (dates.indexOf(date) / Math.max(dates.length - 1, 1)) * (W - PAD.l - PAD.r);
    const y = (p) => PAD.t + (1 - (p - min) / span) * (H - PAD.t - PAD.b);
    const gridLines = [0, .25, .5, .75, 1].map((f) => {
      const val = min + span * (1 - f);
      const yy = PAD.t + f * (H - PAD.t - PAD.b);
      return `<line x1="${PAD.l}" y1="${yy}" x2="${W - PAD.r}" y2="${yy}" stroke="currentColor" opacity=".12"/>
              <text x="${PAD.l - 6}" y="${yy + 4}" text-anchor="end" font-size="11" fill="currentColor" opacity=".6">${val.toFixed(0)}€</text>`;
    }).join("");
    const nLabels = Math.min(6, dates.length);
    const xLabels = Array.from({ length: nLabels }, (_, i) => {
      const idx = Math.round(i * (dates.length - 1) / Math.max(nLabels - 1, 1));
      const anchor = idx === 0 ? "start" : idx === dates.length - 1 ? "end" : "middle";
      return `<text x="${x(dates[idx])}" y="${H - 8}" text-anchor="${anchor}" font-size="11" fill="currentColor" opacity=".6">${fmtDate(dates[idx])}</text>`;
    }).join("");
    const lines = series.map((s) => {
      const color = airlineOf(s.airline).color;
      const pts = s.snaps.map((p) => `${x(p.date).toFixed(1)},${y(p.price).toFixed(1)}`).join(" ");
      const circles = s.snaps.length < 40 ? s.snaps.map((p) =>
        `<circle cx="${x(p.date)}" cy="${y(p.price)}" r="3" fill="${color}"><title>${esc(airlineOf(s.airline).name)} ${fmtDate(p.date)}: ${eur(p.price)}</title></circle>`).join("") : "";
      return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round"/>${circles}`;
    }).join("");
    // marca o mínimo global
    let best = null;
    series.forEach((s) => s.snaps.forEach((p) => { if (!best || p.price < best.price) best = { ...p, airline: s.airline }; }));
    const legend = series.map((s, i) => {
      const color = airlineOf(s.airline).color;
      return `<rect x="${PAD.l + i * 150}" y="${PAD.t - 2}" width="12" height="4" fill="${color}"/>
              <text x="${PAD.l + i * 150 + 16}" y="${PAD.t + 3}" font-size="11" fill="currentColor" opacity=".75">${esc(airlineOf(s.airline).name)}</text>`;
    }).join("");
    $("#price-chart").innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolução do preço ${esc(routeKey)}">
        ${gridLines}${xLabels}${lines}${legend}
        <circle cx="${x(best.date)}" cy="${y(best.price)}" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
        <text x="${x(best.date)}" y="${y(best.price) - 10}" text-anchor="${x(best.date) > W * 0.75 ? "end" : x(best.date) < W * 0.25 ? "start" : "middle"}" font-size="12" font-weight="700" fill="currentColor">mín. ${eur(best.price)} · ${shortName(best.airline)} (${fmtDate(best.date)})</text>
      </svg>`;
    const latest = latestByAirline(routeKey);
    $("#price-summary").innerHTML =
      latest.map((l) => `<span class="stat">${dot(l.airline)} <b>${eur(l.snap.price)}</b> ${esc(airlineOf(l.airline).name)}
        <small>(${fmtDate(l.snap.date)}${l.snap.travel_date ? `, voo a ${fmtDate(l.snap.travel_date)}` : ""})</small></span>`).join("") +
      `<span class="stat"><b>${eur(min)}</b> mínimo histórico</span><span class="stat"><b>${eur(max)}</b> máximo</span>`;
    answerPriceAt();
  }

  function answerPriceAt() {
    const routeKey = $("#route-select").value;
    const dateVal = $("#price-date").value;
    const out = $("#price-answer");
    if (!routeKey || !dateVal) { out.textContent = ""; return; }
    let best = null;
    routeAirlines(routeKey).forEach((a) => routes()[routeKey].airlines[a].forEach((s) => {
      const dist = Math.abs(daysBetween(s.date, dateVal));
      if (!best || dist < best.dist || (dist === best.dist && s.price < best.price)) best = { ...s, airline: a, dist };
    }));
    if (!best) { out.textContent = "sem dados"; return; }
    const exact = best.dist === 0 ? "" : ` (recolha mais próxima: ${fmtDate(best.date)})`;
    out.textContent = `≈ ${eur(best.price)} · ${airlineOf(best.airline).name}${exact}`;
  }

  function renderBestNow() {
    const rows = filteredRouteKeys().map((key) => {
      const latest = latestByAirline(key);
      if (!latest.length) return null;
      return { key, r: routes()[key], best: latest[0], others: latest.slice(1) };
    }).filter(Boolean).sort((a, b) => a.best.snap.price - b.best.snap.price);
    $("#best-now").innerHTML = rows.length ? `<div style="overflow-x:auto"><table class="best">
      <tr><th>Rota</th><th>Mais barata</th><th>Preço</th><th>Outras companhias</th><th></th></tr>
      ${rows.map(({ key, r, best, others }) => `<tr>
        <td><b>${key.replace("-", " → ")}</b>${r.destination_name ? ` · ${esc(r.destination_name)}` : ""}</td>
        <td>${dot(best.airline)} ${esc(airlineOf(best.airline).name)}</td>
        <td><b>${eur(best.snap.price)}</b><br><small>voo a ${fmtDate(best.snap.travel_date)}</small></td>
        <td>${others.length ? others.map((o) => `${dot(o.airline)} ${shortName(o.airline)} ${eur(o.snap.price)}`).join("<br>") : "<small>—</small>"}</td>
        <td>${best.snap.price <= best.min + 0.01 && routes()[key].airlines[best.airline].length > 1 ? `<span class="badge live">mínimo histórico 🔥</span>` : ""}</td>
      </tr>`).join("")}
    </table></div>` : `<p class="empty">Sem dados de tarifas para estes filtros.${clearButton()}</p>`;
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

  function clearFilters() {
    state.filters = { airports: new Set(), airlines: new Set(), dest: "" };
    $("#dest-search").value = "";
    rerender();
  }

  function bindEvents() {
    document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
      state.view = tab.dataset.view;
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      document.querySelectorAll(".view").forEach((v) => { v.hidden = v.id !== "view-" + state.view; });
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
    $("#clear-filters").addEventListener("click", clearFilters);
    document.addEventListener("click", (e) => { if (e.target.closest("[data-clear]")) clearFilters(); });
    $("#export-ics").addEventListener("click", exportIcs);
    $("#cal-prev").addEventListener("click", () => { state.month.setMonth(state.month.getMonth() - 1); renderCalendar(); });
    $("#cal-next").addEventListener("click", () => { state.month.setMonth(state.month.getMonth() + 1); renderCalendar(); });
    $("#cal-today").addEventListener("click", () => {
      const now = new Date();
      state.month = new Date(now.getFullYear(), now.getMonth(), 1);
      state.selectedDay = todayIso();
      renderCalendar();
    });
    $("#cal-route").addEventListener("change", (e) => { state.calRoute = e.target.value || null; renderCalendar(); });
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
