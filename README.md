# ✈️ Voos & Férias

**Site: https://daniel-asensio.github.io/Voos-Ferias/**

Agregador de **promoções das companhias aéreas** que operam em **Lisboa (LIS), Porto (OPO) e Faro (FAO)**, com:

- 📅 **Calendário** — escolhe uma rota e vê o **preço mais barato para partir em cada dia** (verde = barato, vermelho = caro, com a companhia mais barata nesse dia); as barras coloridas mostram a janela de reserva de cada promoção. Clica num dia para ver as tarifas de todas as companhias e as promoções.
- 🏷️ **Lista de promoções** — filtra por companhia, aeroporto de partida ou destino; separa o que está *a decorrer*, o que *vai começar* e o que *terminou há pouco*.
- 📈 **Histórico de preços** — evolução do preço mais barato por rota, **com uma linha por companhia** (Ryanair, easyJet, Wizz Air), mínimo/máximo e a pergunta “**quanto custava este voo em determinada altura?**”. A tabela "Tarifas mais baratas agora" compara as companhias em cada destino.
- ⬇️ **Exportar .ics** — descarrega as promoções filtradas para o teu Google Calendar / Apple Calendar / Outlook.
- 🔥 **Tarifas mais baratas agora** — tabela com o preço atual de cada rota e um destaque quando está no mínimo histórico.
- 🔔 **Alertas por email** — quando uma rota atinge um novo mínimo histórico (ou aparece uma campanha nova), a recolha diária abre automaticamente uma *issue* no GitHub com o resumo, e o GitHub envia-te a notificação por email.

## Como funciona

```
collector/          coletor em Python
  airlines.json     companhias em LIS/OPO/FAO + páginas de promoções + rotas Ryanair
  sources.py        fontes: API pública de tarifas da Ryanair + deteção nas páginas de ofertas
  collect.py        funde dados novos com os existentes e publica em docs/data/
  seed.py           gera dados de exemplo para a app funcionar antes da 1ª recolha real
docs/               app web estática (pronta para GitHub Pages)
  index.html / app.js / style.css
  data/*.json       dados publicados (promoções, histórico de preços, companhias)
.github/workflows/collect.yml   recolha automática diária
```

O coletor tem duas fontes:

1. **Tarifas diárias da Ryanair, easyJet e Wizz Air** — os serviços de "tarifa mais barata por dia" que os próprios sites usam, para as rotas vigiadas em `watched_routes` (LIS/OPO/FAO → destinos). Alimentam o calendário de preços (`docs/data/fare_calendar.json`, próximos 3 meses) e o histórico (um *snapshot* por rota, companhia e dia de recolha). A TAP, Vueling e as companhias tradicionais não têm serviços abertos deste tipo.
2. **Páginas de promoções das companhias** (TAP, easyJet, Vueling, Transavia, Wizz Air, SATA, Iberia, Lufthansa, …) — deteção best-effort de campanhas por palavras-chave e padrões de desconto. As campanhas detetadas ficam marcadas como *deteção automática* e apontam para a página oficial para confirmares as condições.

## Usar

### Ver a app

Abre `docs/index.html` num browser, ou serve a pasta:

```bash
python -m http.server -d docs 8000
# http://localhost:8000
```

O site é publicado automaticamente no **GitHub Pages** pelos workflows (`pages.yml` publica a cada push ao `main`; `collect.yml` republica após cada recolha diária).

### Recolher dados

```bash
pip install -r requirements.txt
python -m collector.collect        # recolha real (precisa de internet)
python -m collector.seed           # regenerar dados de exemplo
```

### Recolha automática

O workflow [`collect.yml`](.github/workflows/collect.yml) corre **todos os dias às 07:17 (Lisboa)**: recolhe promoções e preços, faz commit dos dados, republica o site e — se alguma rota atingir um **mínimo histórico** (com pelo menos 5 dias de histórico) ou aparecer uma **campanha nova** — abre uma issue `alerta` que chega ao teu email pelas notificações do GitHub. Também podes lançá-lo manualmente no separador **Actions**.

Na primeira recolha real, os dados de exemplo (marcados com o aviso amarelo na app) são descartados automaticamente.

## Notas

- Os preços do histórico são o **mais barato encontrado por rota em cada dia de recolha** — servem para veres tendências e apanhares mínimos, não são garantia de disponibilidade.
- A deteção nas páginas de promoções é frágil por natureza (os sites mudam e alguns bloqueiam robôs); por isso cada campanha detetada tem link direto para a fonte.
- Para acrescentares companhias ou rotas, edita [`collector/airlines.json`](collector/airlines.json).
