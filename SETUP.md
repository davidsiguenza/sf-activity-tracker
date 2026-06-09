# Setup guide for new users

Step-by-step para que otro SE pueda correr sf-activity-tracker en su Mac con SU calendario y SU usuario de Salesforce. Tiempo estimado: **15-20 min**, casi todo en GCP Console.

> **Solo macOS por ahora.** El auto-start está implementado con launchd que es específico de macOS. La app sí funciona en Linux/Windows pero tendrías que arrancarla a mano.

---

## 0. Pre-requisitos

Verifica primero que tienes todo. Pega esto en una terminal y comprueba:

```bash
node --version       # >= v20
sf --version         # @salesforce/cli/2.x
which claude         # /Users/<you>/.local/bin/claude  (DevBar T&P)
git --version
```

**Si te falta algo:**

| Falta | Cómo instalarlo |
|---|---|
| **Node.js** ≥ 20 | `brew install node` o `nvm install 20` |
| **Salesforce CLI** | `brew install --cask sfdx-cli` (o sigue [docs oficiales](https://developer.salesforce.com/tools/sfdxcli)) |
| **Claude Code** (DevBar) | Sigue el canvas T&P de Salesforce internal — necesitas la licencia de tu cuenta `@salesforce.com`. Sin esto, la clasificación no funciona. |
| **git / gh** | `brew install git gh` |

---

## 1. Clona el repo

```bash
mkdir -p ~/Documents/Salesforce/tools
cd ~/Documents/Salesforce/tools
git clone https://github.com/davidsiguenza/sf-activity-tracker.git
cd sf-activity-tracker
```

---

## 2. Autentica `sf` CLI a org62

```bash
sf org login web --alias org62
```

Se abrirá tu browser. Loguea con tu cuenta `@salesforce.com`. Si te pide org URL, es la default `https://login.salesforce.com`.

Verifica:
```bash
sf org list
# Debe mostrar `org62` como Connected
```

---

## 3. Primera arrancada del server (manual, para el setup wizard)

```bash
node server/index.js
```

Se abre tu browser en `http://127.0.0.1:7825` con el **setup wizard**:

1. Tu email Salesforce (default ya pre-rellenado pero edita si hace falta)
2. Click **"Resolver mi user en org62"** → busca tu usuario en org62 y muestra tu nombre, manager y timezone. Si falla, comprueba el paso 2.
3. **SE Opportunity Role**: deja `Core SE` o el rol que tenga sentido para ti
4. **Títulos a excluir**: revisa la lista (Home, Lunch, OOO, etc.). Edita si quieres
5. Click **"Guardar y empezar"**

Se guarda en `~/.config/sf-activity-tracker/config.json`. Ya nunca te volverá a pedir el wizard.

**Deja el server corriendo** en esta terminal mientras haces el siguiente paso.

---

## 4. Configura Google Calendar OAuth (la parte más larga)

Necesitas tu **propio** OAuth client de Google. No se puede compartir con otra persona — el redirect URI y los scopes son per-app.

### 4.1. Crea un proyecto GCP

Ve a [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate)

- "Project name": `sf-activity-tracker-<tuusuario>` (lo que quieras)
- Organization / Location: deja default (o "No organization" si tu cuenta es personal)
- Click **"CREATE"**

Espera unos segundos a que se cree. Asegúrate de que está seleccionado en el selector de proyecto arriba a la izquierda.

### 4.2. Habilita Google Calendar API

[console.cloud.google.com/apis/library/calendar-json.googleapis.com](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)

(con tu proyecto seleccionado) → click **"ENABLE"**

### 4.3. Configura OAuth consent screen

[console.cloud.google.com/apis/credentials/consent](https://console.cloud.google.com/apis/credentials/consent)

- "User Type": **External** → CREATE
- "App name": `sf-activity-tracker`
- "User support email": tu email
- "Developer contact email": tu email
- Resto vacío → SAVE AND CONTINUE
- "Scopes": SAVE AND CONTINUE (sin tocar nada)
- "Test users": ADD USERS → mete tu email `<tu>@salesforce.com` → SAVE AND CONTINUE
- "Summary": BACK TO DASHBOARD

### 4.4. Crea el OAuth client

[console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)

- Click **"+ CREATE CREDENTIALS"** → **OAuth client ID**
- "Application type": **Desktop app**
- "Name": `sf-activity-tracker desktop`
- **IMPORTANTE**: añade un Authorized redirect URI:
  - `http://127.0.0.1:7825/api/oauth/callback`
  - (Algunas versiones del wizard de GCP no muestran este campo para Desktop app — si no lo ves, no pasa nada, déjalo así)
- Click **"CREATE"**

Aparece un popup con tu Client ID y Client secret. Click el botón **⬇ DOWNLOAD JSON**.

Si cerraste el popup: en la lista de Credentials, haz click en tu OAuth client recién creado, y arriba a la derecha hay el botón ⬇ "DOWNLOAD JSON".

Guarda ese JSON en algún sitio (Downloads está bien).

### 4.5. Conecta desde la app

En tu browser con `http://127.0.0.1:7825` abierto:

1. Click **⚙ Settings** arriba a la derecha
2. En la sección **"Google Calendar backend"**, abre el detalle **"Paso 1 · Sube tu OAuth client JSON"**
3. **Abre el archivo JSON descargado**, copia su contenido entero, y pégalo en la textarea
4. Click **"Save client JSON"** → debería decir "✓ ADC credentials found..." o similar
5. Click **"⚡ Connect with Google"** → se abre un browser tab a `accounts.google.com`
6. Loguea con tu cuenta `@salesforce.com`
7. Aparecerá una pantalla roja **"Google hasn't verified this app"** → click **"Advanced"** → **"Go to sf-activity-tracker (unsafe)"** (no es unsafe, es porque tu propio app está en modo Testing)
8. Acepta los permisos: ver calendarios, email, openid
9. Verás un mensaje "Connected. You can close this tab."

Vuelve a la app, **Settings → Test connection** debería decir `✓ Connected. N calendars visible.` con la lista de tus calendarios.

### 4.6. Selecciona qué calendarios leer

En Settings, sección **"Calendarios a leer"**:

- Por defecto leerá de TODOS tus calendarios visibles (incluidos overlays como "Home", "Holidays in Spain", calendarios de compañeros, etc.)
- **Recomendado**: tilda solo los tuyos (tu primary + cualquier secundario que uses para trabajo)
- Click **"Save selection"**

---

## 5. Configura el auto-start (launchd)

Para no tener que correr `node server/index.js` manualmente cada vez:

```bash
# Para el server actual primero (Ctrl+C en la terminal donde está corriendo)
# Luego:
cd ~/Documents/Salesforce/tools/sf-activity-tracker
./bin/launchd-install.sh install
```

A partir de ahora, el server arranca automáticamente al hacer login en macOS.

Comprueba:
```bash
./bin/launchd-install.sh status
# Debe mostrar state = running
```

Y en el browser, recarga `http://127.0.0.1:7825` — sigue funcionando.

---

## 6. Atajo en el escritorio

```bash
./bin/install-desktop-shortcut.sh
```

Aparece **"SF Activity Tracker.command"** en tu Desktop. Doble-click → comprueba server, lo arranca si hace falta, abre browser.

La primera vez macOS te pedirá permisos para abrir un `.command` desde Finder — acepta.

---

## 7. ¡Listo! Primer Analyze

1. Abre la app (doble-click el atajo del Desktop o `http://127.0.0.1:7825`)
2. Selecciona un rango pequeño (ej. "Ayer" o "Esta semana")
3. Click **▶ Analyze**
4. Espera ~5-30s la primera vez (Claude clasifica todos los eventos)
5. Revisa la tabla del Draft Plan: edita Related To si hace falta (los aliases se aprenden con tus correcciones)
6. Tilda los eventos que quieres logueear → **"Create N in org62"**

Próximos análisis del mismo rango → casi instantáneos (cache de clasificaciones).

---

## Archivos que se crean en tu Mac

Todos en `~/.config/sf-activity-tracker/`:

| Archivo | Qué guarda |
|---|---|
| `config.json` | Tu user ID en org62, exclusiones, aliases aprendidos, manualRelatedRecords |
| `oauth-client.json` | Tu OAuth client de GCP |
| `oauth-tokens.json` | Tu refresh token de Google |
| `classifications-cache.json` | Cache de clasificaciones (90 días TTL) |
| `event-overrides.json` | Tus ediciones manuales del draft plan |

Todos son **per-user**. Si compartes con un colega, cada uno tiene los suyos.

---

## Si algo va mal

**El server no responde en `127.0.0.1:7825`:**
```bash
./bin/launchd-install.sh status
tail -f ~/Library/Logs/sf-activity-tracker.log
```

**"Test connection" da 403 con "token does not have Calendar scope":**
Re-autoriza desde la app: Settings → Disconnect → Connect with Google. Asegúrate de que aceptas TODOS los permisos en la pantalla de Google.

**"403: Google API rejected the request: requires a quota project":**
Solo pasa si usas el client default de gcloud, no si usas tu propio OAuth client (camino limpio). Si te aparece, es señal de que hiciste `gcloud auth application-default login` previamente. Borra esas credenciales:
```bash
rm ~/.config/gcloud/application_default_credentials.json
```
y reconecta desde la app.

**Claude tarda mucho en clasificar:**
Reduce el rango (analiza día a día en vez de semana entera) o pulsa **"Re-classify all"** desactivado para reusar el cache.

**Cualquier otra cosa:** botón **"? Help"** en la topbar de la app — hay 9 secciones de ayuda.

---

## Para mantenerlo actualizado

```bash
cd ~/Documents/Salesforce/tools/sf-activity-tracker
git pull
./bin/launchd-install.sh restart   # tras cambios al backend
```

Eso es todo. El frontend se actualiza con un Cmd+R en el browser.
