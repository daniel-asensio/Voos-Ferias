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
    # lookahead evita falsos positivos com Porto Alegre/Seguro/Velho/Rico (Brasil)
    "OPO": re.compile(r"\bPorto\b(?!\s+(?:Alegre|Seguro|Velho|Rico))|S[aá] Carneiro", re.I),
    "FAO": re.compile(r"\bFaro\b|Gago Coutinho", re.I),
}

PORTUGAL_PATTERN = re.compile(r"\bPortugal\b|portugues|\bMadeira\b|\bA[çc]ores\b|\bAlgarve\b", re.I)


def is_relevant_news(item: dict) -> bool:
    """Só interessa o que toca Portugal, os nossos aeroportos ou companhias."""
    return bool(item.get("airlines") or item.get("airports")
                or PORTUGAL_PATTERN.search(item.get("title", "")))


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
            text = f"{title} {desc}"
            category, airlines, airports = classify_news(text)
            if not (airlines or airports or PORTUGAL_PATTERN.search(text)):
                continue  # notícia sem ligação a Portugal / LIS / OPO / FAO
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


RYANAIR_CALENDAR_URL = (
    "https://services-api.ryanair.com/farfnd/v4/oneWayFares/{origin}/{dest}/cheapestPerDay"
    "?outboundMonthOfDate={month}-01&currency=EUR"
)
EASYJET_CALENDAR_URL = (
    "https://www.easyjet.com/api/routepricing/v3/searchfares/GetLowestDailyFares"
    "?departureAirport={origin}&arrivalAirport={dest}&currency=EUR"
)
WIZZ_METADATA_URL = "https://wizzair.com/static_fe/metadata.json"
CALENDAR_MONTHS = 3  # meses de tarifas diárias recolhidos por rota


def _months(today: dt.date, count: int) -> list[str]:
    months, year, month = [], today.year, today.month
    for _ in range(count):
        months.append(f"{year:04d}-{month:02d}")
        month += 1
        if month > 12:
            month, year = 1, year + 1
    return months


def fetch_ryanair_calendar(origin: str, dest: str, today: dt.date) -> dict[str, float]:
    """Tarifa mais barata por dia de partida (API pública da Ryanair)."""
    fares: dict[str, float] = {}
    for month in _months(today, CALENDAR_MONTHS):
        try:
            data = _get(RYANAIR_CALENDAR_URL.format(origin=origin, dest=dest, month=month)).json()
        except Exception as exc:  # noqa: BLE001
            print(f"[FR] {origin}-{dest} {month}: {exc}")
            break
        for fare in (data.get("outbound") or {}).get("fares", []):
            price = (fare.get("price") or {}).get("value")
            if price is not None and not fare.get("unavailable") and not fare.get("soldOut"):
                fares[fare["day"]] = round(float(price), 2)
    return fares


def fetch_easyjet_calendar(origin: str, dest: str, today: dt.date) -> dict[str, float]:
    """Tarifa mais barata por dia (serviço 'lowest daily fares' do site da easyJet)."""
    try:
        resp = requests.get(
            EASYJET_CALENDAR_URL.format(origin=origin, dest=dest),
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"}, timeout=TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as exc:  # noqa: BLE001
        print(f"[U2] {origin}-{dest}: {exc}")
        return {}
    fares: dict[str, float] = {}
    for item in data if isinstance(data, list) else data.get("fares", []):
        day = (item.get("departureDateTime") or item.get("departureDate") or "")[:10]
        price = item.get("price")
        if day and price is not None:
            fares[day] = min(fares.get(day, float("inf")), round(float(price), 2))
    return fares


_wizz_api_url: str | None = None


def _wizz_api() -> str | None:
    global _wizz_api_url
    if _wizz_api_url is None:
        try:
            _wizz_api_url = _get(WIZZ_METADATA_URL).json().get("apiUrl") or ""
        except Exception as exc:  # noqa: BLE001
            print(f"[W6] metadata inacessível: {exc}")
            _wizz_api_url = ""
    return _wizz_api_url or None


def fetch_wizz_calendar(origin: str, dest: str, today: dt.date) -> dict[str, float]:
    """Tarifa mais barata por dia (API de horários usada pelo site da Wizz Air)."""
    api = _wizz_api()
    if not api:
        return {}
    fares: dict[str, float] = {}
    for month in _months(today, CALENDAR_MONTHS):
        year, mon = (int(x) for x in month.split("-"))
        last_day = (dt.date(year + (mon == 12), mon % 12 + 1, 1) - dt.timedelta(days=1)).day
        payload = {
            "flightList": [{"departureStation": origin, "arrivalStation": dest,
                            "from": f"{month}-01", "to": f"{month}-{last_day:02d}"}],
            "priceType": "regular", "adultCount": 1, "childCount": 0, "infantCount": 0,
        }
        try:
            resp = requests.post(f"{api}/Api/search/timetable", json=payload, timeout=TIMEOUT,
                                 headers={"User-Agent": USER_AGENT, "Accept": "application/json",
                                          "Origin": "https://wizzair.com", "Referer": "https://wizzair.com/"})
            resp.raise_for_status()
            flights = resp.json().get("outboundFlights", [])
        except Exception as exc:  # noqa: BLE001
            print(f"[W6] {origin}-{dest} {month}: {exc}")
            break
        for f in flights:
            price = (f.get("price") or {}).get("amount")
            day = (f.get("departureDate") or "")[:10]
            if day and price is not None and float(price) > 0:
                fares[day] = min(fares.get(day, float("inf")), round(float(price), 2))
    return fares


CALENDAR_FETCHERS = {"FR": fetch_ryanair_calendar, "U2": fetch_easyjet_calendar, "W6": fetch_wizz_calendar}


def fetch_fare_calendars(config: dict, today: dt.date) -> tuple[dict, list[dict]]:
    """Recolhe as tarifas diárias de todas as rotas vigiadas.

    Devolve (calendars, records):
      calendars = {"LIS-MAD": {"FR": {"2026-09-15": 19.99, ...}, "U2": {...}}}
      records   = um snapshot por (rota, companhia) com a tarifa mínima dos
                  próximos meses — alimenta o histórico de preços.
    """
    names = config.get("destination_names", {})
    calendars: dict[str, dict[str, dict[str, float]]] = {}
    records: list[dict] = []
    min_day = (today + dt.timedelta(days=1)).isoformat()
    for airline, origins in config.get("watched_routes", {}).items():
        fetcher = CALENDAR_FETCHERS.get(airline)
        if not fetcher:
            continue
        found = 0
        for origin, dests in origins.items():
            for dest in dests:
                fares = {d: p for d, p in fetcher(origin, dest, today).items() if d >= min_day}
                if not fares:
                    continue
                found += 1
                route = f"{origin}-{dest}"
                calendars.setdefault(route, {})[airline] = dict(sorted(fares.items()))
                best_day = min(fares, key=fares.get)
                records.append({
                    "route": route, "airline": airline, "date": today.isoformat(),
                    "price": fares[best_day], "currency": "EUR", "travel_date": best_day,
                    "destination_name": names.get(dest, dest),
                })
        print(f"[{airline}] tarifas diárias em {found} rotas")
    return calendars, records


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

    # Título limpo e id estável por companhia: um cartão por página de ofertas,
    # cuja janela se estende enquanto a campanha continuar visível.
    title = f"Ofertas {airline['name']}"
    start = today.isoformat()
    promo = {
        "id": make_promo_id(airline["code"], "pagina-ofertas", ""),
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
