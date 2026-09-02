"""Coletor de promoções e preços — Voos & Férias.

Corre todas as fontes, funde o resultado com os dados existentes em
``docs/data/`` e grava os JSON que a app web consome.

Uso:
    python -m collector.collect            # recolha normal
    python -m collector.collect --dry-run  # não grava nada
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

from . import sources

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = Path(__file__).resolve().parent / "airlines.json"
DATA_DIR = ROOT / "docs" / "data"

# Promoções terminadas há mais de este nº de dias deixam de ser publicadas.
KEEP_EXPIRED_DAYS = 45
# Histórico de preços mantido por rota.
KEEP_HISTORY_DAYS = 400
# Notícias publicadas há mais de este nº de dias são removidas.
KEEP_NEWS_DAYS = 45
MAX_NEWS = 120


def load_json(path: Path, default):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return default


def save_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def merge_promotions(existing: list[dict], new: list[dict], today: dt.date) -> list[dict]:
    # Migra cartões antigos de deteção automática para o id estável e título limpo.
    for p in existing:
        if p.get("source") == "promo_page":
            p["id"] = sources.make_promo_id(p["airline"], "pagina-ofertas", "")
            p["title"] = f"Ofertas {p.get('airline_name') or p['airline']}"
    by_id = {p["id"]: p for p in existing}
    for promo in new:
        current = by_id.get(promo["id"])
        if current and current.get("source") in ("promo_page", "price_drop"):
            # Campanha ainda ativa: estende a janela e atualiza os valores.
            current["booking_end"] = max(current["booking_end"], promo["booking_end"])
            for field in ("discount_text", "price_from", "title", "description", "collected_at"):
                if promo.get(field) is not None:
                    current[field] = promo[field]
        else:
            by_id[promo["id"]] = promo
    cutoff = (today - dt.timedelta(days=KEEP_EXPIRED_DAYS)).isoformat()
    kept = [p for p in by_id.values() if (p.get("booking_end") or p.get("booking_start", "")) >= cutoff]
    kept.sort(key=lambda p: (p.get("booking_start") or "", p["id"]))
    return kept


def merge_history(history: dict, records: list[dict]) -> dict:
    routes = history.setdefault("routes", {})
    for rec in records:
        route = routes.setdefault(
            rec["route"],
            {"airline": rec["airline"], "destination_name": rec.get("destination_name"), "snapshots": []},
        )
        if rec.get("destination_name"):
            route["destination_name"] = rec["destination_name"]
        snapshots = {s["date"]: s for s in route["snapshots"]}
        prev = snapshots.get(rec["date"])
        if prev is None or rec["price"] < prev["price"]:
            snapshots[rec["date"]] = {
                "date": rec["date"],
                "price": rec["price"],
                "currency": rec.get("currency", "EUR"),
                "travel_date": rec.get("travel_date"),
            }
        route["snapshots"] = sorted(snapshots.values(), key=lambda s: s["date"])[-KEEP_HISTORY_DAYS:]
    return history


def merge_news(existing: list[dict], new: list[dict], today: dt.date) -> tuple[list[dict], list[dict]]:
    """Funde notícias por título normalizado; devolve (todas, greves novas).

    Greves só contam como alerta quando publicadas nos últimos 3 dias —
    evita inundar o email na primeira recolha ou com notícias antigas.
    """
    # Reclassifica o que está guardado — regras novas aplicam-se ao histórico.
    for n in existing:
        n["category"], n["airlines"], n["airports"] = sources.classify_news(n["title"])
    by_key = {n["title"].lower()[:120]: n for n in existing if sources.is_relevant_news(n)}
    strike_cutoff = (today - dt.timedelta(days=3)).isoformat()
    fresh_strikes = []
    for item in new:
        key = item["title"].lower()[:120]
        if key not in by_key:
            by_key[key] = item
            if item["category"] == "greve" and item.get("published", "") >= strike_cutoff:
                fresh_strikes.append(item)
    cutoff = (today - dt.timedelta(days=KEEP_NEWS_DAYS)).isoformat()
    kept = [n for n in by_key.values() if n.get("published", "") >= cutoff]
    kept.sort(key=lambda n: n.get("published", ""), reverse=True)
    return kept[:MAX_NEWS], fresh_strikes


def price_drop_promos(history: dict, records: list[dict], config: dict, today: dt.date) -> list[dict]:
    """Cria cartões de promoção quando a tarifa de hoje está ≥30% abaixo do habitual.

    Não depende das páginas das companhias (que bloqueiam robôs): usa o
    próprio histórico de preços. Precisa de ≥5 dias de histórico real.
    """
    import statistics

    names = {a["code"]: a["name"] for a in config["airlines"]}
    airports = config.get("airports", {})
    promos = []
    for rec in records:
        snaps = history.get("routes", {}).get(rec["route"], {}).get("snapshots", [])
        prev = [s["price"] for s in snaps if s["date"] < rec["date"] and not s.get("demo")]
        if len(prev) < 5:
            continue
        median = statistics.median(prev)
        if median <= 0 or rec["price"] > median * 0.7:
            continue
        pct = round((1 - rec["price"] / median) * 100)
        origin, dest = rec["route"].split("-")
        dest_name = rec.get("destination_name") or dest
        origin_name = (airports.get(origin) or origin).split(" —")[0]
        promos.append({
            "id": sources.make_promo_id(rec["airline"], f"queda-{rec['route']}", ""),
            "airline": rec["airline"],
            "airline_name": names.get(rec["airline"], rec["airline"]),
            "title": f"{origin_name} → {dest_name} a {rec['price']:.2f}€ (−{pct}% vs. habitual)",
            "description": (f"Tarifa de hoje bem abaixo da mediana de {median:.2f}€ dos últimos "
                            f"{len(prev)} dias de recolha. Voo mais barato a {rec.get('travel_date') or '—'}."),
            "discount_text": f"−{pct}% vs. habitual",
            "price_from": rec["price"],
            "origin_airports": [origin],
            "destinations": [f"{dest_name} ({dest})"],
            "booking_start": today.isoformat(),
            "booking_end": (today + dt.timedelta(days=2)).isoformat(),
            "travel_start": rec.get("travel_date"),
            "travel_end": None,
            "url": "https://www.ryanair.com/pt/pt",
            "source": "price_drop",
            "confidence": "média",
            "collected_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        })
    if promos:
        print(f"[preços] {len(promos)} quedas de preço viram promoções")
    return promos


def compute_price_alerts(history: dict, records: list[dict]) -> list[dict]:
    """Rotas cujo preço de hoje iguala ou bate o mínimo histórico.

    Só alerta com pelo menos 5 dias de histórico real, para não disparar
    nos primeiros dias de recolha.
    """
    alerts = []
    for rec in records:
        snaps = history.get("routes", {}).get(rec["route"], {}).get("snapshots", [])
        prev = [s["price"] for s in snaps if s["date"] < rec["date"] and not s.get("demo")]
        if len(prev) >= 5 and rec["price"] <= min(prev):
            alerts.append({
                "route": rec["route"],
                "destination_name": rec.get("destination_name"),
                "airline": rec["airline"],
                "price": rec["price"],
                "previous_min": round(min(prev), 2),
                "travel_date": rec.get("travel_date"),
            })
    return sorted(alerts, key=lambda a: a["price"])


def write_alert_body(alerts: list[dict], fresh_promos: list[dict], fresh_strikes: list[dict],
                     today: dt.date) -> None:
    """Gera alert_body.md na raiz — o workflow abre uma issue (→ email) com ele."""
    path = ROOT / "alert_body.md"
    if not alerts and not fresh_promos and not fresh_strikes:
        path.unlink(missing_ok=True)
        return
    lines = [f"Alerta automático do Voos & Férias — {today.isoformat()}", ""]
    if alerts:
        lines += ["## 🔥 Rotas em mínimo histórico", "",
                  "| Rota | Preço hoje | Mínimo anterior | Data do voo |", "|---|---|---|---|"]
        for a in alerts:
            dest = f" ({a['destination_name']})" if a.get("destination_name") else ""
            lines.append(f"| **{a['route'].replace('-', ' → ')}**{dest} | "
                         f"**{a['price']:.2f}€** | {a['previous_min']:.2f}€ | {a.get('travel_date') or '—'} |")
        lines.append("")
    if fresh_promos:
        lines += ["## 🏷️ Novas campanhas detetadas", ""]
        for p in fresh_promos:
            lines.append(f"- **{p['airline_name']}** — {p['title']} ({p['url']})")
        lines.append("")
    if fresh_strikes:
        lines += ["## ⚠️ Greves nas notícias", ""]
        for n in fresh_strikes[:10]:
            lines.append(f"- {n['title']} ({n['url']})")
        if len(fresh_strikes) > 10:
            lines.append(f"- … e mais {len(fresh_strikes) - 10} notícias de greve no site")
        lines.append("")
    lines.append("Consulta tudo no site do projeto (separador Preços / Promoções / Notícias).")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Alertas: {len(alerts)} mínimos, {len(fresh_promos)} campanhas novas, "
          f"{len(fresh_strikes)} greves → alert_body.md")


def run(dry_run: bool = False) -> int:
    today = dt.date.today()
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))

    promotions = load_json(DATA_DIR / "promotions.json", [])
    history = load_json(DATA_DIR / "price_history.json", {"routes": {}})
    news = load_json(DATA_DIR / "news.json", {"items": []})["items"]
    had_demo = any(p.get("source") == "exemplo" for p in promotions)

    new_promos: list[dict] = []
    for airline in config["airlines"]:
        new_promos.extend(sources.scan_promo_page(airline, today))
    price_records = sources.fetch_ryanair_fares(config, today)
    new_news = sources.fetch_news(today)

    got_real_data = bool(new_promos or price_records)
    if got_real_data and had_demo:
        # Primeira recolha real: descartar os dados de demonstração.
        promotions = [p for p in promotions if p.get("source") != "exemplo"]
        if any(s.get("demo") for r in history["routes"].values() for s in r["snapshots"]):
            history = {"routes": {}}

    new_promos.extend(price_drop_promos(history, price_records, config, today))
    known_ids = {p["id"] for p in promotions}
    # Quedas de preço ficam fora do email de alerta (os mínimos históricos já o cobrem).
    fresh_promos = [p for p in new_promos if p["id"] not in known_ids and p["source"] != "price_drop"]
    alerts = compute_price_alerts(history, price_records)

    promotions = merge_promotions(promotions, new_promos, today)
    history = merge_history(history, price_records)
    news, fresh_strikes = merge_news(news, new_news, today)

    meta = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "promotions": len(promotions),
        "routes": len(history["routes"]),
        "is_demo": had_demo and not got_real_data,
    }

    print(
        f"Promoções novas: {len(new_promos)} | publicadas: {len(promotions)} | "
        f"preços de hoje: {len(price_records)} rotas"
    )
    if dry_run:
        print("(dry-run: nada foi gravado)")
        return 0

    save_json(DATA_DIR / "promotions.json", promotions)
    save_json(DATA_DIR / "price_history.json", history)
    save_json(DATA_DIR / "airlines.json", config)
    save_json(DATA_DIR / "meta.json", meta)
    save_json(DATA_DIR / "alerts.json", {"date": today.isoformat(), "alerts": alerts})
    save_json(DATA_DIR / "news.json", {"items": news})
    write_alert_body(alerts, fresh_promos, fresh_strikes, today)
    print(f"Dados gravados em {DATA_DIR}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="não gravar ficheiros")
    args = parser.parse_args()
    return run(dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
