"""Fontes de dados do coletor de promoções.

Cada fonte devolve promoções normalizadas e/ou registos de preços.
Todas as fontes são tolerantes a falhas: se um site estiver em baixo ou
mudar de formato, a recolha continua com as restantes fontes.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import html
import re
import unicodedata

import requests

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36 VoosFeriasBot/1.0"
)
TIMEOUT = 25

RYANAIR_FARES_URL = "https://services-api.ryanair.com/farfnd/v4/oneWayFares"

# Padrões que indicam uma promoção numa página de ofertas.
PROMO_PATTERNS = [
    re.compile(r"(?:até\s+)?(\d{1,2})\s?%\s*(?:de\s+)?(?:desconto|off|dto)", re.I),
    re.compile(r"desde\s+(\d{1,4}(?:[.,]\d{2})?)\s?€", re.I),
    re.compile(r"€\s?(\d{1,4}(?:[.,]\d{2})?)", re.I),
]
PROMO_KEYWORDS = re.compile(
    r"promo[cç][aã]o|desconto|oferta|sale|flash|black\s?friday|cyber|campanha", re.I
)


def _slug(text: str) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def make_promo_id(airline: str, title: str, start: str) -> str:
    digest = hashlib.sha1(f"{airline}|{title}|{start}".encode()).hexdigest()[:8]
    return f"{airline.lower()}-{_slug(title)[:40]}-{digest}"


def _get(url: str) -> requests.Response:
    resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
    resp.raise_for_status()
    return resp


GOOGLE_NEWS_RSS = "https://news.google.com/rss/search?q={query}&hl=pt-PT&gl=PT&ceid=PT:pt-150"

NEWS_QUERIES = [
    '(greve OR paralisação) (aeroporto OR aviação OR "companhia aérea" OR TAP OR Ryanair OR easyJet OR SATA)',
    'promoção voos (TAP OR Ryanair OR easyJet OR Vueling OR "Wizz Air" OR Transavia)',
    '("nova rota" OR "novas rotas" OR "novo voo") (Lisboa OR Porto OR Faro)',
    'aeroporto (Lisboa OR Porto OR Faro) (atrasos OR cancelamentos OR avaria OR caos)',
]

NEWS_CATEGORIES = [
    ("greve", re.compile(r"greve|paralisa[çc][aã]o|plen[aá]rio|protesto", re.I)),
    ("problema", re.compile(r"avaria|falha|cancelad|atras|incidente|caos|interrompid|encerrad", re.I)),
    ("promocao", re.compile(r"promo[çc][aã]o|desconto|campanha|tarifas?\s+baixa|voos?\s+barato|saldos|oferta", re.I)),
    ("novidade", re.compile(r"nova\s+rota|novas\s+rotas|novo\s+voo|inaugura|lan[çc]a|refor[çc]a|expans[aã]o|estreia", re.I)),
]

AIRLINE_NAME_PATTERNS = {
    "TP": r"\bTAP\b|Air Portugal", "FR": r"Ryanair", "U2": r"easyJet", "VY": r"Vueling",
    "HV": r"Transavia", "W6": r"Wizz", "S4": r"\bSATA\b|Azores Airlines", "IB": r"Iberia",
    "LH": r"Lufthansa", "AF": r"Air France", "KL": r"\bKLM\b", "SN": r"Brussels Airlines",
    "EW": r"Eurowings", "LX": r"\bSWISS\b|\bSwiss\b",
}

AIRPORT_PATTERNS = {
    "LIS": re.compile(r"\bLisboa\b|Humberto Delgado|Portela", re.I),
    "OPO": re.compile(r"\bPorto\b|S[aá] Carneiro", re.I),
    "FAO": re.compile(r"\bFaro\b|Gago Coutinho", re.I),
}


def classify_news(text: str) -> tuple[str, list[str], list[str]]:
    """Devolve (categoria, companhias, aeroportos) detetados no texto."""
    category = "geral"
    for cat, pattern in NEWS_CATEGORIES:
        if pattern.search(text):
            category = cat
            break
    airlines = [code for code, pat in AIRLINE_NAME_PATTERNS.items() if re.search(pat, text)]
    airports = [code for code, pat in AIRPORT_PATTERNS.items() if pat.search(text)]
    return category, airlines, airports


def fetch_news(today: dt.date) -> list[dict]:
    """Notícias de aviação (greves, promoções, problemas, novas rotas) via Google News RSS."""
    import email.utils
    import urllib.parse
    import xml.etree.ElementTree as ET

    items: dict[str, dict] = {}
    for query in NEWS_QUERIES:
        url = GOOGLE_NEWS_RSS.format(query=urllib.parse.quote(query))
        try:
            root = ET.fromstring(_get(url).content)
        except Exception as exc:  # noqa: BLE001
            print(f"[news] falha na pesquisa «{query[:40]}…»: {exc}")
            continue
        for item in root.iter("item"):
            title = (item.findtext("title") or "").strip()
            link = (item.findtext("link") or "").strip()
            if not title or not link:
                continue
            desc = re.sub(r"<[^>]+>", " ", item.findtext("description") or "")
            published = None
            if item.findtext("pubDate"):
                try:
                    published = email.utils.parsedate_to_datetime(item.findtext("pubDate")).date().isoformat()
                except Exception:  # noqa: BLE001
                    pass
            category, airlines, airports = classify_news(f"{title} {desc}")
            key = title.lower()[:120]
            if key in items:
                continue
            items[key] = {
                "title": title,
                "url": link,
                "source": (item.findtext("source") or "").strip() or None,
                "published": published or today.isoformat(),
                "category": category,
                "airlines": airlines,
                "airports": airports,
            }
    result = list(items.values())
    print(f"[news] {len(result)} notícias recolhidas")
    return result


def fetch_ryanair_fares(config: dict, today: dt.date) -> list[dict]:
    """Tarifa mais barata por rota via API pública de tarifas da Ryanair.

    Devolve registos de preço: um snapshot por rota e por dia de recolha,
    que alimenta o histórico "quanto custava o voo X na altura Y".
    """
    records = []
    date_from = today + dt.timedelta(days=3)
    date_to = today + dt.timedelta(days=90)
    for group in config.get("ryanair_routes", []):
        origin = group["origin"]
        try:
            resp = _get(
                f"{RYANAIR_FARES_URL}?departureAirportIataCode={origin}"
                f"&outboundDepartureDateFrom={date_from}&outboundDepartureDateTo={date_to}"
                "&market=pt-pt&limit=200"
            )
            fares = resp.json().get("fares", [])
        except Exception as exc:  # noqa: BLE001 — fonte externa, seguir em frente
            print(f"[ryanair] falha em {origin}: {exc}")
            continue
        wanted = set(group["destinations"])
        best: dict[str, dict] = {}
        for fare in fares:
            out = fare.get("outbound") or {}
            arr = (out.get("arrivalAirport") or {}).get("iataCode")
            price = (out.get("price") or {}).get("value")
            if not arr or price is None or (wanted and arr not in wanted):
                continue
            route = f"{origin}-{arr}"
            if route not in best or price < best[route]["price"]:
                best[route] = {
                    "route": route,
                    "airline": "FR",
                    "date": today.isoformat(),
                    "price": round(float(price), 2),
                    "currency": (out.get("price") or {}).get("currencyCode", "EUR"),
                    "travel_date": (out.get("departureDate") or "")[:10],
                    "destination_name": (out.get("arrivalAirport") or {}).get("name", arr),
                }
        records.extend(best.values())
    return records


def scan_promo_page(airline: dict, today: dt.date) -> list[dict]:
    """Deteção best-effort de promoções na página de ofertas de uma companhia.

    Procura palavras-chave de campanha e padrões de desconto/preço no HTML.
    Quando encontra sinais fortes, regista uma promoção de baixa confiança
    apontando para a página — melhor um alerta verificável do que nada.
    """
    url = airline.get("promo_url")
    if not url:
        return []
    try:
        text = _get(url).text
    except Exception as exc:  # noqa: BLE001
        print(f"[{airline['code']}] página de promoções inacessível: {exc}")
        return []

    plain = html.unescape(re.sub(r"<script.*?</script>|<style.*?</style>|<[^>]+>", " ", text, flags=re.S))
    if not PROMO_KEYWORDS.search(plain):
        return []

    discount = None
    match = PROMO_PATTERNS[0].search(plain)
    if match:
        discount = f"até {match.group(1)}% de desconto"
    price_from = None
    match = PROMO_PATTERNS[1].search(plain)
    if match:
        price_from = float(match.group(1).replace(",", "."))

    title_match = re.search(r"<title[^>]*>(.*?)</title>", text, re.S | re.I)
    title = html.unescape(title_match.group(1)).strip() if title_match else f"Ofertas {airline['name']}"
    title = re.sub(r"\s+", " ", title)[:120]

    start = today.isoformat()
    promo = {
        "id": make_promo_id(airline["code"], title, start),
        "airline": airline["code"],
        "airline_name": airline["name"],
        "title": title,
        "description": "Campanha detetada automaticamente na página de ofertas. Confirmar condições no site.",
        "discount_text": discount,
        "price_from": price_from,
        "origin_airports": airline["airports"],
        "destinations": [],
        "booking_start": start,
        "booking_end": (today + dt.timedelta(days=7)).isoformat(),
        "travel_start": None,
        "travel_end": None,
        "url": url,
        "source": "promo_page",
        "confidence": "baixa",
        "collected_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
    }
    return [promo]
