# SF Activity Tracker

Local web app que lee Google Calendar, matchea eventos con oportunidades de **org62** usando Claude (headless), clasifica el SE Task Type / CF / CR, y crea Events + Deal Contributions con un click — sin tener que abrir Activity Editor.

> Built by [@davidsiguenza](https://github.com/davidsiguenza) — pensado para SEs que quieren ver de un vistazo qué del calendario está logueado y qué falta, en lugar de ir evento a evento.

## Por qué

| Herramienta | Visualiza | Auto-matchea | Clasifica | Crea events |
|---|---|---|---|---|
| Activity Editor (Salesforce) | ✓ | ✗ | ✗ | manual |
| Tampermonkey "Calendar View" | ✓ | ✗ | ✗ | manual |
| Slack skill "Activity Logging" | ✗ | ✓ | ✓ | ✓ |
| **sf-activity-tracker** | **✓** | **✓** | **✓** | **✓** |

Calendar plus inteligencia plus aprobación visual antes de escribir a org62.

## Cómo funciona

```
┌──────────────────────────────────────┐
│  Browser (localhost:7825)            │
│  ├─ FullCalendar                     │
│  ├─ Date range + "Analyze" button    │
│  ├─ Draft plan editable              │
│  └─ "Create in org62" approval       │
└────────────┬─────────────────────────┘
             │ HTTP
┌────────────▼─────────────────────────┐
│  Node backend (zero-dep)             │
│  ├─ /api/analyze   → fetch + match   │
│  ├─ /api/create    → SSE batch write │
│  └─ /api/config    → JSON store      │
└──┬───────────────┬────────────┬──────┘
   ▼               ▼            ▼
┌──────┐   ┌───────────┐   ┌──────────┐
│ sf   │   │ claude -p │   │ ~/.config│
│ CLI  │   │ (json)    │   │ /sf-...  │
│      │   │ ↳ Google  │   │          │
│ org62│   │   MCP     │   │          │
└──────┘   └───────────┘   └──────────┘
```

- **`sf` CLI** — queries y create-record contra `org62`. Reusa tu auth ya hecha (`sf org login`).
- **`claude -p`** (DevBar Claude Code, no API key) — hace dos cosas: fetch del Google Calendar (vía Google MCP que ya tienes auth) y el matching+clasificación en una sola llamada con JSON estructurado.
- **Persistencia** — `~/.config/sf-activity-tracker/config.json`. Editable a mano.

## Calendar backend: rápido (Google API) o lento (Claude)

La app puede traer eventos de dos formas:

| Backend | Velocidad | Tokens LLM | Setup |
|---|---|---|---|
| **Google Calendar API directo** ⚡ | ~500ms | 0 | 1 comando, una vez |
| **Claude `-p` + Google MCP** 🐢 | 30–180s | ~5–10k por análisis | Cero |

**Recomendado**: configura el API directo. Hay dos caminos:

### Camino rápido (5 segundos, funciona hoy)

```bash
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/calendar.readonly,https://www.googleapis.com/auth/userinfo.email
```

`cloud-platform` es el scope amplio que Google exige al client_id default de gcloud. Calendar.readonly se está deprecando en ese client default — Google avisa que se bloqueará "pronto" (sin fecha exacta). Cuando llegue ese día, salta al camino limpio.

### Camino limpio (10 min, permanente)

Crea tu propio OAuth client en GCP Console (gratis):

1. Ve a [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate) y crea un proyecto (nombre libre)
2. APIs & Services → Library → habilita **Google Calendar API**
3. APIs & Services → OAuth consent screen → External → completa los datos mínimos (nombre app, email contacto)
4. APIs & Services → Credentials → "+ Create Credentials" → OAuth client ID → tipo **Desktop app** → descarga el JSON
5. Corre:
   ```bash
   gcloud auth application-default login \
     --client-id-file=~/Downloads/client_secret_<YOUR_FILE>.json \
     --scopes=https://www.googleapis.com/auth/calendar.readonly,https://www.googleapis.com/auth/userinfo.email
   ```

Tu propio client = tus propias credenciales = no caduca por cambios en el client default de Google.

Esto crea `~/.config/gcloud/application_default_credentials.json` con un refresh token. La app lo detecta solo y lo usa. Si expira o lo revocas, fallback automático a Claude y la app te avisa con badge ⚠.

**Verificar**: ⚙ Settings → "Test connection" en la sección "Google Calendar backend".

## Pre-requisitos

- macOS (probado en Darwin 25.x)
- **Node.js >= 20** (`node --version`)
- **`sf` CLI** autenticado a org62 (`sf org login web --alias org62`)
- **Claude Code** instalado (DevBar T&P) — el comando `claude` debe estar en PATH
- **Google MCP** ya conectado en Claude Code (lo usas en otras conversaciones)

Verifica que todo está OK:
```bash
sf org list | grep org62          # debe mostrar Connected
which claude && claude --version  # 2.x+
node --version                    # v20+
```

## Instalación

```bash
git clone https://github.com/davidsiguenza/sf-activity-tracker.git
cd sf-activity-tracker
node server/index.js              # arranca y abre el browser
```

**Cero dependencias npm.** Solo built-ins de Node.

## Primer uso (setup)

1. Arranca con `node server/index.js`.
2. Se abre `http://127.0.0.1:7825` en tu browser.
3. **Setup wizard:**
   - Te pregunta tu email (default `dsiguenza@salesforce.com`)
   - Click "Resolver mi user en org62" → consulta `User WHERE Email = …` y muestra tu user ID, manager y timezone
   - Confirma SE Opportunity Role (default `Core SE`)
   - Edita la lista de títulos a excluir (Lunch, OOO, etc.)
   - Click "Guardar y empezar"
4. Listo. La app guarda todo en `~/.config/sf-activity-tracker/config.json`.

## Día a día

1. Abre la app.
2. Selecciona rango de fechas (o usa los botones rápidos: Hoy / Ayer / Esta semana / Semana pasada / Este mes).
3. Click **▶ Analyze** — tarda 1-2 min (claude -p + sf queries).
4. Mira el calendario:
   - **Gris dashed** = identificado, se va a crear
   - **Gris sólido tachado** = ya existe en org62 (no se duplica)
   - **Amarillo con borde** = flagged — ambiguo, requiere tu input
   - **Punteado tenue** = excluded / skip
5. Revisa la tabla draft plan. Edita lo que haga falta:
   - Cambiar Related To (dropdown con tus DCs activas)
   - Cambiar SE Task Type (los 30 valores válidos del picklist de org62)
   - Tildar/destildar CF, CR
   - Desmarcar la checkbox de la izquierda para no crear ese evento
6. Click **Create in org62**. Stream en vivo del progreso (DCs primero, luego Events).
7. Los eventos creados pasan a gris sólido en el calendario.

## Qué hay en el config

`~/.config/sf-activity-tracker/config.json`:

```json
{
  "seUserId": "0050M00000Bq7kvQAB",
  "seName": "David Sigüenza",
  "seEmail": "dsiguenza@salesforce.com",
  "managerId": "0053000000C0McXAAV",
  "timeZone": "Europe/Madrid",
  "seOpportunityRole": "Core SE",
  "excludedTitles": ["Home", "Lunch", "OOO", "Out of Office", "Gym", "Wellness"],
  "internalEmailDomains": ["salesforce.com", "tableau.com", "slack.com", "mulesoft.com"],
  "catchAll": null,
  "aliasTable": [
    { "alias": "Dentaid", "matches": [{ "id": "006...", "name": "Dentaid Demo - FY26", "type": "Opportunity" }] }
  ],
  "taxonomyCorrections": [
    { "keyword": "1:1 sergio", "seTaskType": "Admin" }
  ]
}
```

- **aliasTable**: keywords del título de calendar → records de Salesforce. Crece a medida que corriges el matching.
- **taxonomyCorrections**: keyword del título → SE Task Type, persistente.
- **internalEmailDomains**: emails que NO disparan el override "external attendee → CF=true".

## Endpoints (para hackear)

| Método | Path | Body | Comentario |
|---|---|---|---|
| GET | `/api/health` | — | check sf + config |
| GET | `/api/config` | — | dump del JSON |
| PUT | `/api/config` | partial | merge into config |
| POST | `/api/setup/resolve-user` | `{email}` | query org62 User |
| POST | `/api/setup/save` | full setup | guarda y crea config |
| POST | `/api/setup/lookup` | `{search}` | busca Opp/Account/SI por nombre |
| POST | `/api/analyze` | `{fromIso,toIso}` | calendar + match + classify |
| POST | `/api/create` | `{approved:[…]}` | SSE stream — crea DCs + Events |
| POST | `/api/config/alias` | `{alias,matches}` | guarda alias |
| POST | `/api/config/correction` | `{keyword,seTaskType}` | guarda corrección |

## Out of scope (v0.1)

- Soporte multi-SE (single-tenant — solo tu user)
- Two-tier OpportunityFieldHistory check para opps cerradas
- Resolución de Slack links del description
- Quarterly CF/CR progress dashboard
- Mid-batch checkpoint resume (si revientas mid-run, re-analiza el rango)
- "Neither" record customizable

Si te hacen falta, hablamos.

## Troubleshooting

**`sf org list` no muestra org62 como Connected**
→ `sf org login web --alias org62` y autoriza en el browser.

**`claude -p` da timeout o "command not found"**
→ Verifica que tienes Claude Code (DevBar T&P) instalado. `which claude` debe devolver una ruta.

**Analyze devuelve "Failed to fetch calendar events"**
→ El Google MCP no está disponible o no está autenticado. Abre Claude Code interactivo, asegúrate de que Google está conectado en AI Suite settings, y reintenta.

**"Setup not complete"**
→ El config no existe. Borra `~/.config/sf-activity-tracker/` y arranca de nuevo (forzará el wizard).

**"Picklist value not valid"**
→ La taxonomía se queda atrasada respecto a org62. Re-query los picklists:
```bash
sf sobject describe --sobject Event --target-org org62 --json | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print('\n'.join(p['value'] for f in d['result']['fields'] if f['name']=='SE_Task_Type__c' for p in f['picklistValues']))"
```
Y actualiza `server/lib/prompts.js` (`SE_TASK_TYPES`) y `public/app.js` (`SE_TASK_TYPES`).

## Licencia

MIT.
