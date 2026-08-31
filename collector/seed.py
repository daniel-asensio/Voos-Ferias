"""Gera dados de demonstração para a app web.

As promoções e o histórico de preços aqui gerados são EXEMPLOS realistas
(marcados com ``source: "exemplo"`` / ``demo: true``) para a app ficar
funcional antes da primeira recolha real. Na primeira execução do coletor
com dados reais, os exemplos são descartados automaticamente.

Uso: python -m collector.seed
"""

from __future__ import annotations

import datetime as dt
import json
import math
import random
from pathlib import Path

from .collect import CONFIG_PATH, DATA_DIR, save_json
from .sources import make_promo_id

TODAY = dt.date.today()


def d(offset: int) -> str:
    return (TODAY + dt.timedelta(days=offset)).isoformat()


PROMO_SPECS = [
    ("TP", "TAP Air Portugal", "Promoção de Outono TAP — Europa e Atlântico",
     "Descontos em voos para Europa, Brasil e EUA a partir de Lisboa e Porto.",
     "até 25% de desconto", 39.0, ["LIS", "OPO"],
     ["Madrid", "Paris", "Roma", "Rio de Janeiro", "Nova Iorque"], -3, 6, 20, 120,
     "https://www.flytap.com/pt-pt/promocoes"),
    ("FR", "Ryanair", "Flash Sale Ryanair — 24 horas",
     "Tarifas desde 14,99€ em rotas selecionadas a partir de Lisboa, Porto e Faro.",
     "desde 14,99€", 14.99, ["LIS", "OPO", "FAO"],
     ["Madrid", "Barcelona", "Londres", "Milão", "Marselha"], 1, 2, 10, 60,
     "https://www.ryanair.com/pt/pt/ofertas"),
    ("U2", "easyJet", "easyJet — Escapadinhas de outono",
     "Voos baratos para city breaks europeus com partidas dos três aeroportos.",
     "desde 19,99€", 19.99, ["LIS", "OPO", "FAO"],
     ["Londres", "Genebra", "Lyon", "Amesterdão"], -1, 9, 15, 90,
     "https://www.easyjet.com/pt/ofertas"),
    ("VY", "Vueling", "Vueling Big Sale",
     "20% de desconto em todas as rotas com origem em Portugal.",
     "20% de desconto", 24.0, ["LIS", "OPO", "FAO"],
     ["Barcelona", "Bilbau", "Sevilha", "Florença"], 4, 8, 25, 150,
     "https://www.vueling.com/pt/ofertas-de-voos"),
    ("HV", "Transavia", "Transavia — Novembro em promoção",
     "Tarifas reduzidas para França e Países Baixos em novembro.",
     "desde 29€", 29.0, ["LIS", "OPO", "FAO"],
     ["Paris-Orly", "Amesterdão", "Roterdão", "Nantes"], 7, 14, 45, 90,
     "https://www.transavia.com/pt-PT/promocoes/"),
    ("W6", "Wizz Air", "Wizz Air — Desconto de membro WDC",
     "10% extra para membros do Wizz Discount Club em voos desde Lisboa e Porto.",
     "10% de desconto", 22.0, ["LIS", "OPO"],
     ["Budapeste", "Varsóvia", "Bucareste", "Cracóvia"], -5, 4, 12, 100,
     "https://www.wizzair.com/pt-pt"),
    ("S4", "Azores Airlines (SATA)", "Açores em promoção — SATA",
     "Lisboa e Porto para Ponta Delgada e Terceira a preços especiais.",
     "desde 49€ ida e volta", 49.0, ["LIS", "OPO"],
     ["Ponta Delgada", "Terceira"], 2, 12, 30, 120,
     "https://www.azoresairlines.pt/pt-pt/promocoes"),
    ("IB", "Iberia", "Iberia — Semana das Américas",
     "Descontos em voos para a América Latina via Madrid.",
     "até 30% de desconto", 320.0, ["LIS", "OPO"],
     ["Buenos Aires", "Bogotá", "Cidade do México", "Lima"], 10, 17, 60, 180,
     "https://www.iberia.com/pt/ofertas/"),
    ("LH", "Lufthansa", "Lufthansa — Ofertas de inverno",
     "Tarifas promocionais para a Alemanha e ligações intercontinentais.",
     "desde 89€", 89.0, ["LIS", "OPO", "FAO"],
     ["Frankfurt", "Munique", "Banguecoque", "Tóquio"], 14, 28, 60, 200,
     "https://www.lufthansa.com/pt/pt/ofertas-de-voos"),
    ("TP", "TAP Air Portugal", "TAP — Madeira e Açores desde 34€",
     "Campanha nacional: continente para Funchal, Porto Santo e Ponta Delgada.",
     "desde 34€", 34.0, ["LIS", "OPO", "FAO"],
     ["Funchal", "Porto Santo", "Ponta Delgada"], -10, -2, 5, 90,
     "https://www.flytap.com/pt-pt/promocoes"),
    ("FR", "Ryanair", "Ryanair — Black Friday antecipada",
     "Milhares de lugares com desconto para viajar até março.",
     "até 20% de desconto", 12.99, ["LIS", "OPO", "FAO"],
     ["Sevilha", "Dublin", "Manchester", "Bruxelas", "Edimburgo"], 25, 29, 40, 210,
     "https://www.ryanair.com/pt/pt/ofertas"),
    ("KL", "KLM", "KLM — Dream Deals",
     "Promoção intercontinental via Amesterdão, partidas de Lisboa e Porto.",
     "até 25% de desconto", 380.0, ["LIS", "OPO"],
     ["Curaçau", "Singapura", "Cidade do Cabo", "Toronto"], 5, 19, 50, 170,
     "https://www.klm.pt/ofertas"),
]

ROUTES = {
    "LIS-MAD": ("FR", "Madrid", 22, 9),
    "LIS-ORY": ("HV", "Paris-Orly", 48, 18),
    "LIS-FNC": ("TP", "Funchal", 55, 22),
    "LIS-PDL": ("S4", "Ponta Delgada", 60, 24),
    "OPO-BCN": ("VY", "Barcelona", 30, 12),
    "OPO-STN": ("FR", "Londres-Stansted", 26, 11),
    "FAO-STN": ("FR", "Londres-Stansted", 24, 10),
    "FAO-MAN": ("U2", "Manchester", 35, 14),
}


def build_promotions() -> list[dict]:
    promos = []
    for (code, name, title, desc, discount, price, airports, dests,
         b_start, b_end, t_start, t_end, url) in PROMO_SPECS:
        promos.append({
            "id": make_promo_id(code, title, d(b_start)),
            "airline": code,
            "airline_name": name,
            "title": title,
            "description": desc,
            "discount_text": discount,
            "price_from": price,
            "origin_airports": airports,
            "destinations": dests,
            "booking_start": d(b_start),
            "booking_end": d(b_end),
            "travel_start": d(t_start),
            "travel_end": d(t_end),
            "url": url,
            "source": "exemplo",
            "confidence": "exemplo",
            "collected_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        })
    return sorted(promos, key=lambda p: p["booking_start"])


def build_history(days: int = 120) -> dict:
    rng = random.Random(42)
    routes = {}
    for route, (airline, dest_name, base, spread) in ROUTES.items():
        snapshots = []
        promo_dip_at = rng.randrange(20, days - 20)
        for i in range(days, -1, -1):
            date = TODAY - dt.timedelta(days=i)
            season = math.sin((days - i) / 14.0) * spread * 0.4
            weekly = math.sin(date.weekday() * 1.7) * spread * 0.25
            noise = rng.uniform(-spread * 0.3, spread * 0.5)
            price = base + season + weekly + noise
            if abs((days - i) - promo_dip_at) <= 2:  # campanha flash a meio da série
                price *= 0.62
            snapshots.append({
                "date": date.isoformat(),
                "price": round(max(price, base * 0.4), 2),
                "currency": "EUR",
                "travel_date": (date + dt.timedelta(days=45)).isoformat(),
                "demo": True,
            })
        routes[route] = {"airline": airline, "destination_name": dest_name, "snapshots": snapshots}
    return {"routes": routes}


def main() -> None:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    promotions = build_promotions()
    history = build_history()
    save_json(DATA_DIR / "promotions.json", promotions)
    save_json(DATA_DIR / "price_history.json", history)
    save_json(DATA_DIR / "airlines.json", config)
    save_json(DATA_DIR / "meta.json", {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "promotions": len(promotions),
        "routes": len(history["routes"]),
        "is_demo": True,
    })
    print(f"Dados de exemplo gerados: {len(promotions)} promoções, {len(history['routes'])} rotas.")


if __name__ == "__main__":
    main()
