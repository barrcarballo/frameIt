# Bitácora de desarrollo — FrameIt

UI táctil de la cabina de fotos FrameIt (Raspberry Pi 3 + iPad Air vía noVNC,
Chromium en modo kiosco, 1024×768 horizontal). Vanilla HTML/CSS/JS, sin
frameworks. Construida a partir del archivo de Figma `frameIt_UI`
(`ilIGLfdxQmZx48uP4MAs38`), pantalla por pantalla.

---

## Sesión 1 — 04/09

### Objetivo
Arrancar la UI: conectar el MCP de Figma, extraer las pantallas del diseño y
construir las primeras en código.

### Setup
- Se autorizó el MCP de Figma (claude.ai/connectors) para poder leer el archivo de diseño.
- Se relevaron las 7 pantallas que existen en el archivo de Figma:
  1. `01.unboarding` → Bienvenida
  2. `02.mode` → Selección de modo
  3. `03.selection` → Selección de marco
  4. `04.capturing` → Captura
  5. `05.preview` → Preview
  6. `06.background` → Selección de fondo
  7. `07.export` → Entrega
  - **Falta diseñar en Figma la 8va pantalla del brief (Agradecimiento).**
- Estructura de proyecto creada:
  - `index.html` — single-page app, todas las pantallas como `<section data-screen="...">` dentro de `#app` (stage fijo 1024×768), solo una visible a la vez.
  - `css/styles.css` — design tokens en `:root` + una sección por pantalla.
  - `js/app.js` — screen manager (`showScreen`, `session` state, idle timeout 60s en pantallas intermedias / 2min en entrega).
  - `assets/` — `logo/`, `img/`, `frames/`, `fonts/`.

### Decisiones tomadas
- **Isologo (Momo Trust Display):** no se usa como fuente web (el usuario no tiene el archivo de esa tipografía) — se exporta como SVG estático desde Figma y se usa como imagen (`assets/logo/isologo.svg`).
- **Alumni Sans Pinstripe:** se verificó que sí es una Google Font real, pero **solo existe el weight 400 (Regular)** — el brief menciona Semibold/Bold pero no existen en la fuente real. Se decidió auto-hostear el `.ttf` localmente en `assets/fonts/` (no vía CDN de Google), pensando en que la Raspberry Pi puede no tener internet estable durante un evento.
- **Colores reales del archivo de Figma difieren del brief** (`frameit-brief-desarrollo.md`):
  | Uso | Brief | Figma real (usado en código) |
  |---|---|---|
  | Vinotinto | `#3D0A05` | `#3D0303` |
  | Rojo FrameIt | `#A30F0A` | `#950606` |
  | Rosa institucional | `#F5DCDC` | `#FFDEDE` |
  - *Pendiente: actualizar el brandbook si corresponde.*
- **Corner-bracket motif:** se estandarizó como elemento reutilizable (`assets/logo/corner-bracket.svg`) con margen de **42px horizontal / 112px vertical** desde cada borde de la pantalla (calcado del archivo de Figma). Regla de layout acordada: los brackets delimitan el "área segura" — el contenido interactivo se ajusta para entrar (o quedar deliberadamente afuera) de ese rectángulo, nunca al revés.
- **Cámara (MVP de escritorio):** para poder probar en la compu antes de tener la Pi con la webcam USB, se usa `getUserMedia` del navegador con fallback a una foto estática si falla el permiso o no hay cámara. Queda marcado con un comentario `TODO` en el HTML el punto exacto donde se reemplaza por el feed real (OpenCV/v4l2) en producción.
- **Estilo de tipografía:** por pedido puntual del usuario, `body` lleva `-webkit-text-stroke: 1px currentColor` (refuerza el trazo fino de Alumni Sans Pinstripe). No estaba en el brief original, es una decisión de esta sesión.

### Pantallas construidas
- ✅ **01 — Bienvenida:** fondo con foto institucional + tint rosa, isologo centrado, "Toca para comenzar".
- ✅ **02 — Selección de modo:** dos tarjetas clickeables (Foto tira / Foto individual), cada una con un stack de polaroids superpuestos y rotados (fan), corner-brackets en las 4 esquinas. Al tocar una, guarda `session.mode` y navega a la pantalla 3.
- ✅ **03 — Selección de marco:** preview de cámara en vivo (con fallback), overlay del marco generativo seleccionado, 6 miniaturas de marcos para elegir, botón de captura que navega a la pantalla 4.

### Bugs encontrados y resueltos
1. **SVG del logo con fondo indebido:** al exportar el nodo del isologo desde Figma, el export arrastró elementos de fondo de la pantalla ancestro (rects sin `fill` → negro por defecto, más un `mask group` completo de la pantalla de bienvenida). Se limpió el SVG a mano dejando solo los grupos reales del logo.
2. **Stroke de la tipografía "sin efecto":** en realidad sí se aplicaba, pero el navegador estaba sirviendo CSS cacheado — se resolvió con hard refresh.
3. **Label "Foto tira" tapado:** el contenedor del stack de polaroids (`.photo-stack--strip`) tenía altura fija insuficiente para la tarjeta rotada más alta (la rotación agranda el bounding box: `|w·cos(a)|+|h·sin(a)|` de ancho, `|w·sin(a)|+|h·cos(a)|` de alto) — se agrandó el contenedor.
4. **Watermark superpuesto a la última foto en "Foto tira":** cálculo de alto de contenido con `box-sizing:border-box` que olvidó restar el `border` (no solo el padding) — 2px de diferencia causaban la superposición. Se corrigió sumando margen extra.
5. **Cámara mostraba siempre la foto estática pese a tener permiso concedido:** bug real de CSS — `.camera-photo { display:block }` (regla de autor) tiene la misma especificidad que `[hidden] { display:none }` (regla del user-agent), y al venir después en la cascada le ganaba, anulando el atributo `hidden` del fallback. Se agregó `.camera-photo[hidden] { display:none }` para desempatar a favor del estado oculto.
6. **`getUserMedia` no funciona sobre `file://`:** requiere contexto seguro (HTTPS o localhost). Se levantó un servidor local (`python3 -m http.server 8080`) para poder probar la cámara real.
7. **Marco de cámara pisaba las miniaturas:** el alto original (622px, calcado de una lectura de metadata que no coincidía con el `get_design_context` real) hacía que la foto terminara en y=702, invadiendo el inicio de las miniaturas (y=656). Se resolvió recalculando todo el layout vertical para que la cámara ocupe el área delimitada por los corner-brackets (112px a 656px) y las miniaturas queden afuera, en el margen inferior.

### Pendientes para la próxima sesión (cerrados en Sesión 2, ver abajo)
- ~~Construir pantallas 04 a 07~~ → hecho.
- Definir contenido de la pantalla **08 — Agradecimiento** (no existe todavía en el archivo de Figma).
- Reemplazar `getUserMedia` por el feed real de la webcam USB vía OpenCV/v4l2 cuando se pruebe en la Raspberry Pi.

---

## Sesión 2 — 10/09

### Objetivo
Terminar las pantallas que faltaban del flujo (04 a 07) y dejar la entrega
(QR + descarga de la foto) funcionando de verdad, no solo de mockup.

### Pantallas construidas
- ✅ **04 — Captura:** cuenta regresiva real (3→2→1), overlay de "spotlight" de recorte (`box-shadow: 0 0 0 9999px` para oscurecer todo lo que queda afuera del recuadro), contador "Foto X de 3" en modo tira. Al llegar a cero, compone el frame elegido sobre la foto y guarda el resultado.
- ✅ **05 — Preview:** arma la tira de impresión (1 o 3 celdas según el modo) con las fotos reales ya capturadas; mat bordó con el logo claro al pie, fiel al diseño de Figma. "Volver a intentarlo" repite toda la secuencia de tomas; "Sí, me gustó" avanza a fondo.
- ✅ **06 — Selección de fondo:** 3 fondos seleccionables, cada uno con el efecto de abanico de 2 tiras rotadas y oscurecidas/con sombra (igual que Figma), mat claro tipo polaroid real, un solo logo fijo abajo (no rota con las tiras).
- ✅ **07 — Entrega:** composición final (fondo elegido + tira), countdown real de 2 minutos sincronizado con el idle timer, y QR **funcional** que sirve para descargar la foto (ver Decisiones).

### Decisiones tomadas
- **Ratio de recorte de cámara confirmado: ~106:97** (casi cuadrado), consistente con las celdas de foto que ya usaban las otras pantallas del mockup — no un portrait alargado. La "verticalidad" del brief viene de apilar varias fotos + el pie de marca, no de que cada foto individual sea portrait.
- **Modo "tira" saca 3 fotos reales**, una por una con su propia cuenta regresiva (no la misma foto repetida 3 veces). El reintento desde Preview repite las 3 tomas.
- **El marco generativo elegido SÍ queda grabado en la foto capturada** (antes solo se veía como overlay visual en pantalla, pero `capturePhoto()` no lo dibujaba en el canvas). *Ojo:* los PNG de marco son anchos (1024×572, ~1.79) pensados para el preview panorámico completo; al recortarlos al ratio casi cuadrado del capture, parte de la decoración (que suele estar cerca de los bordes) puede quedar afuera. Aceptado como límite del MVP — la solución real es reexportar los marcos ya pensados para ese ratio.
- **QR real y funcional, con mini servidor local (`server.py`):** el QR ya no es una imagen decorativa — usa la librería `qrcodejs` (MIT, vendorizada en `js/vendor/`, sin depender de internet) para generar un código que apunta a la foto recién subida. `server.py` es un server de Python (solo stdlib, sin Flask) que sirve el sitio estático y expone `POST /api/upload-photo`, que guarda la imagen en `uploads/latest.png`.
- **La foto que se descarga por QR incluye el fondo elegido**, no son solo las fotos crudas: se compone en un canvas (fondo recortado a pantalla completa + mat blanco con la tira + logo claro al pie), simplificando el efecto de abanico rotado de la pantalla 6 (más directo de dibujar en canvas y mejor como recuerdo descargable).
- **Gotcha real de red para probar el QR:** si el kiosco se abre como `http://localhost:8080`, el QR queda con `localhost` codificado — inútil para otro celular, porque en ESE celular "localhost" es él mismo. Para probar de verdad hay que abrir el server por la IP de LAN de la compu (ej. `http://192.168.1.61:8080`).
- **Gotcha real de cámara vs. QR en desarrollo:** `getUserMedia` exige contexto seguro (HTTPS o `localhost`/`127.0.0.1`); una IP de LAN por HTTP plano no cuenta como seguro, así que ahí la cámara cae al fallback estático. Para probar cámara y QR juntos en una sola sesión de test hace falta el flag de Chrome `--unsafely-treat-insecure-origin-as-secure=http://<IP>:PUERTO` (solo para desarrollo local; en producción, en la Pi, el video no va a venir de `getUserMedia` sino del backend OpenCV/v4l2, así que este problema no existe en producción).

### Bugs encontrados y resueltos
1. **Accidente: sobreescribí `index.html` con contenido literal.** Intenté usar `$(bat --plain archivo)` como *contenido* de un `Write` en vez de leerlo primero — el placeholder quedó escrito tal cual y se perdió todo el archivo. Se reconstruyó completo a mano a partir del historial de la sesión (CSS y JS no se vieron afectados). Lección: nunca usar sustitución de comandos como contenido de una escritura — siempre `Read` primero.
2. **Idas y vueltas con el color del mat de la tira de impresión:** el pedido de "marco claro, logo abajo" era solo para las tarjetas de fondo (pantalla 6), no para Preview (pantalla 5) — ahí el diseño real de Figma es mat bordó con el logo claro adentro. Quedó así: bordó+logo-adentro en Preview, claro+logo-afuera-único en Selección de fondo.
3. **Simplifiqué de más el "efecto abanico" de Selección de fondo** en el primer intento (una sola tira derecha, sin rotación); el diseño real tiene 2 tiras superpuestas y rotadas (13.49° y -16.71°, una atrás oscurecida sin sombra, otra adelante a color con sombra). Se rehizo fiel al diseño.
4. **Logo duplicado en las tarjetas de fondo:** al principio cada una de las 2 tiras rotadas tenía su propio logo (2 por tarjeta). Se movió a un único logo fijo por tarjeta, que no rota con las tiras.

### Pendientes para la próxima sesión
- Definir contenido de la pantalla **08 — Agradecimiento** (sigue sin existir en el archivo de Figma).
- Reemplazar `getUserMedia` por el feed real de la webcam USB vía OpenCV/v4l2 en la Raspberry Pi — cuando eso pase, el problema de cámara-vs-QR en local deja de existir.
- Pensar la galería web pública real (hoy el QR apunta a un archivo servido por `server.py` en la red local, sirve para probar pero no es la galería con analytics que describe el brief para el tier Corporate).
- Evaluar comprimir `assets/img/bg-*.png` (pesan bastante para un Pi 3) y los marcos generativos, pensando en performance real en el hardware final.
- Correr `python3 server.py` (no `python3 -m http.server`) al retomar — reemplaza al server viejo y agrega el endpoint de subida de fotos.
