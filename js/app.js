/**
 * FrameIt — Kiosk screen manager.
 * Single-page app: every screen is a <section data-screen="..."> inside #app,
 * only one carries .is-active at a time. Chromium runs this in --kiosk mode.
 */

const SCREENS = [
  "welcome",
  "mode",
  "selection",
  "capturing",
  "preview",
  "background",
  "export",
  "thanks",
];

const IDLE_TIMEOUT_MS = 60 * 1000; // pantallas intermedias (2-6)
const DELIVERY_TIMEOUT_MS = 2 * 60 * 1000; // entrega / agradecimiento

let currentScreen = "welcome";
let idleTimer = null;
let idleDeadline = null; // timestamp (ms) en que el idle timer actual dispara
let welcomeLoopTimer = null;
let cameraStream = null; // MediaStream compartido, lo usa initCamera() y la Live Photo

// Estado de la sesión de captura en curso (modo elegido, marco elegido, etc.)
const session = {
  mode: null, // "single" | "strip"
  frame: "assets/frames/frame-01.png",
  filter: "", // "" (sin filtro) | "bw" | "sepia" | "vintage" | "analog" — ver FILTERS
  background: "bg-01",
  liveUrls: [], // object URLs de las Live Photos, una por toma y en el mismo orden que capturedPhotos
};

// bg-01/bg-02 se re-encodaron a JPEG (compresión con pérdida, mucho más
// liviana para fotos/texturas que PNG) — bg-03 es un patrón de pocos
// colores con bordes duros donde JPEG pesa más que PNG, así que se queda
// en PNG. Pensado para la Pi 3, que sirve estos assets desde una SD card.
const BACKGROUND_EXT = { "bg-01": "jpg", "bg-02": "jpg", "bg-03": "png" };
function backgroundSrc(id) {
  return `assets/img/${id}.${BACKGROUND_EXT[id] || "png"}`;
}

function showScreen(name) {
  if (!SCREENS.includes(name)) {
    console.warn(`[FrameIt] Pantalla desconocida: "${name}"`);
    return;
  }
  document.querySelectorAll(".screen").forEach((section) => {
    section.classList.toggle("is-active", section.dataset.screen === name);
  });
  clearInterval(exportCountdownTimer); // se re-arma en el hook de "export" si corresponde
  clearInterval(welcomeLoopTimer); // se re-arma en el hook de "welcome" si corresponde
  currentScreen = name;
  resetIdleTimer();
  screenEnterHooks[name]?.();
}

function resetIdleTimer() {
  clearTimeout(idleTimer);

  // Bienvenida no tiene timeout propio; entrega/agradecimiento usan 2 minutos.
  if (currentScreen === "welcome") return;

  const isDelivery = currentScreen === "export" || currentScreen === "thanks";
  const timeout = isDelivery ? DELIVERY_TIMEOUT_MS : IDLE_TIMEOUT_MS;

  idleDeadline = Date.now() + timeout;
  idleTimer = setTimeout(() => showScreen("welcome"), timeout);
}

function bindIdleWatchers() {
  ["pointerdown", "touchstart"].forEach((evt) => {
    document.addEventListener(evt, resetIdleTimer, { passive: true });
  });
}

function bindWelcomeScreen() {
  const welcome = document.querySelector('[data-screen="welcome"]');
  welcome.addEventListener("click", () => showScreen("mode"));
}

function bindModeScreen() {
  const cards = document.querySelectorAll(".mode-card");
  cards.forEach((card) => {
    card.addEventListener("click", () => {
      session.mode = card.dataset.mode;
      showScreen("selection");
    });
  });
}

// Las pantallas 3 y 4 muestran el mismo feed en vivo, cada una en su propio
// <video>. Un solo getUserMedia, el mismo MediaStream se asigna a ambos.
const CAMERA_VIDEO_IDS = ["cameraFeed", "captureFeed"];
const CAMERA_FALLBACK_IDS = ["cameraFallback", "captureFallback"];

function showCameraFallback() {
  CAMERA_VIDEO_IDS.forEach((id) => {
    document.getElementById(id).hidden = true;
  });
  CAMERA_FALLBACK_IDS.forEach((id) => {
    document.getElementById(id).hidden = false;
  });
}

async function initCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    console.warn("[FrameIt] getUserMedia no disponible, uso foto de referencia.");
    showCameraFallback();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
      audio: false,
    });
    cameraStream = stream; // guardado global: lo necesita la Live Photo (MediaRecorder)
    CAMERA_VIDEO_IDS.forEach((id) => {
      document.getElementById(id).srcObject = stream;
    });
    // Las miniaturas de filtro y de marco también muestran el feed en vivo
    // (cada una con su propio CSS filter / marco encima), igual criterio
    // que los <video> grandes de arriba.
    document.querySelectorAll(".filter-thumb-video, .frame-thumb-photo").forEach((el) => {
      el.srcObject = stream;
    });
  } catch (err) {
    console.warn("[FrameIt] No se pudo acceder a la webcam:", err);
    showCameraFallback();
  }
}

// session.frame puede ser "" ("Sin marco") — en ese caso el <img> overlay
// se oculta en vez de quedar con un src vacío (ícono de imagen rota).
function setFrameOverlay(imgEl, framePath) {
  imgEl.hidden = !framePath;
  if (framePath) imgEl.src = framePath;
}

function bindSelectionScreen() {
  const thumbs = document.querySelectorAll(".screen--selection .frame-thumb");
  const overlay = document.getElementById("frameOverlay");
  const captureBtn = document.querySelector(".screen--selection .capture-btn");

  thumbs.forEach((thumb) => {
    thumb.addEventListener("click", () => {
      session.frame = thumb.dataset.frame;
      setFrameOverlay(overlay, session.frame);
      thumbs.forEach((t) => t.classList.toggle("is-selected", t === thumb));
    });
  });

  captureBtn.addEventListener("click", () => showScreen("capturing"));
}

// Mismo string de filter CSS reusado en 3 lugares: los circulitos de
// preview, el <video> grande (pantallas 3 y 4), y ctx.filter en el canvas
// al componer la foto final — el canvas 2D acepta exactamente la misma
// sintaxis que el CSS "filter".
const FILTERS = {
  "": "none",
  bw: "grayscale(1)",
  sepia: "sepia(0.9) contrast(1.05)",
  vintage: "sepia(0.2) saturate(1.2) contrast(0.85) brightness(1.1)",
  analog: "saturate(1.6) contrast(1.1) brightness(0.92) sepia(0.15) hue-rotate(-6deg)",
};

function applySessionFilter() {
  const css = FILTERS[session.filter] ?? "none";
  ["cameraFeed", "captureFeed"].forEach((id) => {
    document.getElementById(id).style.filter = css;
  });
}

function bindFilterPicker() {
  const thumbs = document.querySelectorAll(".filter-thumb");
  thumbs.forEach((thumb) => {
    const video = thumb.querySelector(".filter-thumb-video");
    video.style.filter = FILTERS[thumb.dataset.filter] ?? "none";

    thumb.addEventListener("click", () => {
      session.filter = thumb.dataset.filter;
      thumbs.forEach((t) => t.classList.toggle("is-selected", t === thumb));
      applySessionFilter();
    });
  });
}

// Pestañas "Marcos" / "Filtros": alternan qué fila de miniaturas se ve,
// reusando el mismo lugar en la pantalla en vez de sumar uno nuevo.
function bindPickerTabs() {
  const tabs = document.querySelectorAll(".picker-tab");
  const panels = {
    frames: document.querySelector('[data-panel="frames"]'),
    filters: document.querySelector('[data-panel="filters"]'),
  };

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.toggle("is-active", t === tab));
      Object.entries(panels).forEach(([name, panel]) => {
        panel.hidden = name !== tab.dataset.tab;
      });
    });
  });
}

const CROP_RATIO = 106 / 97; // mismo ratio que .crop-guide y las celdas de foto del resto de la UI
let countdownTimer = null;

// Dibuja `source` recortado centrado a la proporción de destW:destH (mismo
// criterio que object-fit:cover en CSS), en (destX,destY).
function drawCoverCrop(ctx, source, srcW, srcH, destW, destH, destX = 0, destY = 0) {
  const targetRatio = destW / destH;
  let cropW = srcH * targetRatio;
  let cropH = srcH;
  if (cropW > srcW) {
    cropW = srcW;
    cropH = srcW / targetRatio;
  }
  const sx = (srcW - cropW) / 2;
  const sy = (srcH - cropH) / 2;
  ctx.drawImage(source, sx, sy, cropW, cropH, destX, destY, destW, destH);
}

// Toma el frame actual del <video> (o el fallback si la cámara no está
// disponible), lo recorta centrado a CROP_RATIO y le compone encima el
// marco generativo elegido. Devuelve el data URL; quien llama decide dónde
// guardarlo (ver startShotSequence).
//
// Dos sets de marco distintos a propósito:
// - assets/frames/*.png (landscape, ~1024x683): se ve en la vista previa
//   grande de las pantallas 3/4 (.camera-frame-overlay), que es panorámica.
// - assets/frames/square/*.png (1:1): se compone acá, sobre el recorte
//   final casi cuadrado (CROP_RATIO ~106:97) — así no hace falta estirar
//   ninguno de los dos para que calcen.
const squareFrameCache = {};

function squareFramePath(framePath) {
  return framePath.replace("assets/frames/", "assets/frames/square/");
}

// Dispara la carga del marco cuadrado apenas se sabe cuál es (al entrar a
// "capturing"), para que ya esté en caché cuando capturePhoto() lo necesite
// unos segundos después, al final de la cuenta regresiva.
function preloadSquareFrame(framePath) {
  const path = squareFramePath(framePath);
  if (!squareFrameCache[path]) {
    squareFrameCache[path] = loadImage(path);
  }
  return squareFrameCache[path];
}

async function capturePhoto() {
  const video = document.getElementById("captureFeed");
  const fallback = document.getElementById("captureFallback");
  const isLive = !video.hidden && video.videoWidth > 0;
  const source = isLive ? video : fallback;
  const srcW = isLive ? video.videoWidth : fallback.naturalWidth;
  const srcH = isLive ? video.videoHeight : fallback.naturalHeight;

  if (!srcW || !srcH) {
    console.warn("[FrameIt] No hay fuente de imagen lista para capturar.");
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = Math.round(640 / CROP_RATIO);
  const ctx = canvas.getContext("2d");

  ctx.save();
  // ctx.filter acepta la misma sintaxis que el CSS "filter" — mismo string
  // que ya se ve en el preview en vivo, aplicado SOLO a la foto (no al
  // marco, que se dibuja después con el filter reseteado).
  ctx.filter = FILTERS[session.filter] ?? "none";
  if (isLive) {
    // La webcam se muestra espejada (scaleX(-1) en CSS); la guardamos igual
    // a como la vio la persona en el preview.
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  drawCoverCrop(ctx, source, srcW, srcH, canvas.width, canvas.height);
  ctx.restore();

  // Marco generativo encima, sin espejar (es una decoración fija, no la
  // cara de la persona) — versión cuadrada, dibujada 1:1 sin recortar ni
  // estirar (su proporción ya es casi igual a la del canvas final).
  // session.frame === "" significa "Sin marco": no se compone nada encima.
  if (session.frame) {
    try {
      const frameImg = await preloadSquareFrame(session.frame);
      ctx.drawImage(frameImg, 0, 0, canvas.width, canvas.height);
    } catch (err) {
      console.warn("[FrameIt] No se pudo cargar el marco cuadrado:", err);
    }
  }

  return canvas.toDataURL("image/png");
}

// Live Photo (como en iPhone): un clip natural de ~1s antes + ~1s después
// del flash, SIN rebote/reversa como un boomerang — se graba derecho con
// MediaRecorder directo sobre el stream de la cámara. Mucho más liviano
// que procesar frame a frame (nada de canvas ni recodificar), buena señal
// para la Pi 3 también.
const LIVE_PHOTO_AFTER_MS = 1000;

let liveRecorder = null;
let liveChunks = [];

function pickLiveMimeType() {
  const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || "video/webm";
}

// Se llama ~1s ANTES de CADA flash (ver el onTick de startCountdown en
// takeNextShot), así cada clip arranca un poco antes del momento de su
// propia foto — una grabación por toma, nunca dos al mismo tiempo (la
// anterior ya se cerró antes de que arranque la cuenta regresiva siguiente).
function startLiveRecording() {
  if (!cameraStream || typeof MediaRecorder === "undefined") return;
  liveChunks = [];
  try {
    liveRecorder = new MediaRecorder(cameraStream, { mimeType: pickLiveMimeType() });
    liveRecorder.ondataavailable = (e) => {
      if (e.data.size) liveChunks.push(e.data);
    };
    liveRecorder.start();
  } catch (err) {
    console.warn("[FrameIt] No se pudo empezar a grabar la Live Photo:", err);
    liveRecorder = null;
  }
}

// Se llama ~1s DESPUÉS del flash de esa misma toma — cierra el clip y lo
// agrega a session.liveUrls en el mismo orden que capturedPhotos
// (updatePreviewLiveToggle habilita el toggle "Live" cuando ya están
// todas, puede terminar de completarse un instante después de llegar a
// Preview si era la última toma).
function stopLiveRecording() {
  if (!liveRecorder || liveRecorder.state === "inactive") return;
  const recorder = liveRecorder;
  recorder.onstop = () => {
    const blob = new Blob(liveChunks, { type: recorder.mimeType });
    session.liveUrls.push(URL.createObjectURL(blob));
    updatePreviewLiveToggle();
  };
  recorder.stop();
}

// "single" saca 1 foto; "strip" saca 3, una toma por vez con su propia
// cuenta regresiva. session.capturedPhotos se reinicia en cada entrada a
// "capturing" (incluido el reintento desde Preview: se repiten las 3 tomas).
const SHOT_PAUSE_MS = 1200;

function startShotSequence() {
  session.capturedPhotos = [];
  session.liveUrls.forEach((url) => URL.revokeObjectURL(url));
  session.liveUrls = [];
  takeNextShot();
}

function takeNextShot() {
  const totalShots = session.mode === "strip" ? 3 : 1;
  const shotNumber = session.capturedPhotos.length + 1;

  const counterEl = document.getElementById("shotCounter");
  counterEl.hidden = totalShots === 1;
  counterEl.textContent = `Foto ${shotNumber} de ${totalShots}`;

  startCountdown(
    async () => {
      const photo = await capturePhoto();
      if (photo) session.capturedPhotos.push(photo);
      setTimeout(stopLiveRecording, LIVE_PHOTO_AFTER_MS); // ~1s más de clip después del flash de ESTA toma

      if (session.capturedPhotos.length < totalShots) {
        const el = document.getElementById("countdownText");
        el.textContent = "¡Buenísimo!";
        setTimeout(takeNextShot, SHOT_PAUSE_MS);
      } else {
        showScreen("preview");
      }
    },
    // Arranca a grabar 1s antes del flash de CADA toma — así cada Live
    // Photo tiene su propio "antes" y "después", correspondiente a su foto.
    (n) => {
      if (n === 1) startLiveRecording();
    }
  );
}

function startCountdown(onDone, onTick) {
  clearInterval(countdownTimer);

  const el = document.getElementById("countdownText");
  let n = 5;
  el.textContent = n;

  countdownTimer = setInterval(() => {
    n -= 1;
    if (n > 0) {
      el.textContent = n;
      onTick?.(n);
      return;
    }
    clearInterval(countdownTimer);
    onDone();
  }, 1000);
}

// Llena cualquier contenedor de celdas (la tira grande de Preview, o las
// miniaturas dentro de cada swatch de fondo) con las fotos ya capturadas.
function fillPrintStripPhotos(container) {
  const photos = session.capturedPhotos?.length
    ? session.capturedPhotos
    : ["assets/img/booth-photo.jpg"];

  container.innerHTML = "";
  photos.forEach((src) => {
    const cell = document.createElement("div");
    cell.className = "print-strip__cell";
    const img = document.createElement("img");
    img.src = src;
    img.alt = "";
    cell.appendChild(img);
    container.appendChild(cell);
  });
}

// Mismo marco/mat/logo que fillPrintStripPhotos, pero cada celda es un
// <video> en loop en vez de la imagen fija — cada uno con el clip
// correspondiente a esa toma (session.liveUrls está en el mismo orden que
// capturedPhotos). Como el clip grabado no tiene el marco ni el filtro
// "horneados" (eso solo pasa al componer la foto fija en capturePhoto), se
// los superpone acá en vivo: el marco como <img> encima, el filtro como
// CSS filter sobre el propio <video>.
function fillPrintStripLive(container) {
  if (!session.liveUrls.length) return;

  const filterCss = FILTERS[session.filter] ?? "none";

  container.innerHTML = "";
  session.liveUrls.forEach((url) => {
    const cell = document.createElement("div");
    cell.className = "print-strip__cell";

    const video = document.createElement("video");
    video.src = url;
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.style.filter = filterCss;
    cell.appendChild(video);

    if (session.frame) {
      const frameImg = document.createElement("img");
      frameImg.className = "print-strip__cell-frame";
      frameImg.src = squareFramePath(session.frame);
      frameImg.alt = "";
      cell.appendChild(frameImg);
    }

    container.appendChild(cell);
  });
}

function renderPrintStrip() {
  // En modo "single" la tarjeta tiene 1 sola foto — se agranda para
  // aprovechar el espacio (la tarjeta chica está pensada para 3 celdas).
  document.getElementById("printStrip").classList.toggle("print-strip--single", session.mode === "single");

  setPreviewView("photo"); // siempre arranca en la foto, nunca heredado de una visita anterior (esto ya llena las celdas)
  updatePreviewLiveToggle();
}

// Foto (tira estática) vs Live (clip en loop, como una Live Photo) — mismo
// recuadro, se togglean, nunca los dos a la vez.
function setPreviewView(view) {
  const container = document.getElementById("printStripPhotos");
  if (view === "live" && session.liveUrls.length) {
    fillPrintStripLive(container);
  } else {
    fillPrintStripPhotos(container);
  }

  document.querySelectorAll("#previewViewTabs .picker-tab").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.view === view);
  });
}

// La Live Photo de cada toma se graba en background (startLiveRecording/
// stopLiveRecording) — esto muestra el toggle solo cuando TODAS las tomas
// ya tienen su clip listo (si no, se vería una tira Live incompleta).
function updatePreviewLiveToggle() {
  const hasLive =
    session.capturedPhotos.length > 0 && session.liveUrls.length === session.capturedPhotos.length;
  document.getElementById("previewViewTabs").hidden = !hasLive;
  if (!hasLive) setPreviewView("photo");
}

function bindPreviewViewTabs() {
  document.querySelectorAll("#previewViewTabs .picker-tab").forEach((tab) => {
    tab.addEventListener("click", () => setPreviewView(tab.dataset.view));
  });
}

function bindPreviewScreen() {
  document.getElementById("retryBtn").addEventListener("click", () => showScreen("capturing"));
  document.getElementById("confirmBtn").addEventListener("click", () => showScreen("background"));
  bindPreviewViewTabs();
}

// Mismo criterio que en Preview: en modo "single" la tarjeta de 1 foto se
// agranda (la chica está pensada para 3 celdas). Afecta a .swatch-strip,
// compartida por las tarjetas de fondo (pantalla 6) y la de Entrega (7).
function applySingleModeSizing() {
  const isSingle = session.mode === "single";
  document.querySelectorAll(".swatch-strip").forEach((el) => {
    el.classList.toggle("swatch-strip--single", isSingle);
  });
}

function renderBackgroundSwatches() {
  document.querySelectorAll("[data-swatch-photos]").forEach(fillPrintStripPhotos);
  applySingleModeSizing();
}

function bindBackgroundScreen() {
  const swatches = document.querySelectorAll(".bg-swatch");
  swatches.forEach((swatch) => {
    swatch.addEventListener("click", () => {
      session.background = swatch.dataset.bg;
      swatches.forEach((s) => s.classList.toggle("is-selected", s === swatch));
    });
  });

  document.getElementById("bgNextBtn").addEventListener("click", () => showScreen("export"));
}

let exportCountdownTimer = null;

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} segundos`;
  return `${minutes} min ${seconds}s`;
}

// Refleja en vivo el mismo idleDeadline que ya maneja resetIdleTimer, así
// no hay dos relojes desincronizados.
function startExportCountdown() {
  clearInterval(exportCountdownTimer);
  const el = document.getElementById("exportCountdown");

  const tick = () => {
    el.textContent = `Volviendo a pantalla principal en: ${formatCountdown(idleDeadline - Date.now())}`;
  };
  tick();
  exportCountdownTimer = setInterval(tick, 1000);
}

function renderExportPrint() {
  const card = document.getElementById("exportPrint");
  card.style.backgroundImage = `url('${backgroundSrc(session.background)}')`;
  document.querySelectorAll("[data-export-photos]").forEach(fillPrintStripPhotos);
  applySingleModeSizing();
  startExportCountdown();
  uploadAndRenderQr();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Compone la foto final para descargar: fondo elegido + 2 tiras blancas en
// abanico (misma rotación que .swatch-strip en CSS: 13.49° atrás
// oscurecida sin sombra, -16.71° adelante a color con sombra) + logo claro
// único al pie del conjunto. Mismo criterio visual que la tarjeta de
// "Entrega" en pantalla, pero dibujado en canvas para poder subirlo.
const EXPORT_W = 1080;
const EXPORT_H = 1920; // resolución real de IG Stories (9:16) — antes 640x1138 se veía pixelado a pantalla completa

// Dibuja una tira (mat + celdas) rotada `deg` grados alrededor de (cx,cy).
// `matColor`: color del mat (blanco para la tira de adelante, bordó para
// la de atrás). `darken`: tapa cada celda con un overlay negro al 69%
// (igual que el diseño original de Figma — no un filtro de brillo sobre
// toda la tira). `shadow`: sombra proyectada (solo la tira de adelante).
// `mediaEls` acepta tanto <img> (fotos, ya tienen marco/filtro horneados
// en capturePhoto) como <video> (Live Photo: ver composeFinalVideoBlob) —
// para estas últimas `filterCss` y `frameImg` se aplican acá porque el
// clip crudo no los tiene, y se espejan porque MediaRecorder grabó el
// stream crudo de la cámara (no la versión espejada que se ve en pantalla).
function drawRotatedStrip(ctx, mediaEls, cx, cy, w, deg, { matColor = "#ffffff", darken = false, shadow = false, bottomPad, filterCss, frameImg } = {}) {
  const pad = w * 0.075;
  const padBottom = bottomPad ?? pad; // más grueso en modo "single" — silueta de polaroid real
  const cellW = w - pad * 2;
  const cellH = cellW / CROP_RATIO;
  const gap = pad * 0.55;
  const h = pad + mediaEls.length * cellH + (mediaEls.length - 1) * gap + padBottom;
  const rad = (deg * Math.PI) / 180;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rad);

  if (shadow) {
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = w * 0.05;
    ctx.shadowOffsetX = -w * 0.045;
    ctx.shadowOffsetY = w * 0.07;
  }

  ctx.fillStyle = matColor;
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2, w, h, w * 0.04);
  ctx.fill();

  ctx.shadowColor = "transparent";

  let y = -h / 2 + pad;
  mediaEls.forEach((media) => {
    const isVideo = media.tagName === "VIDEO";
    const mw = isVideo ? media.videoWidth : media.naturalWidth || media.width;
    const mh = isVideo ? media.videoHeight : media.naturalHeight || media.height;

    if (filterCss) ctx.filter = filterCss;
    if (isVideo) {
      ctx.save();
      ctx.translate(-w / 2 + pad + cellW, 0);
      ctx.scale(-1, 1);
      drawCoverCrop(ctx, media, mw, mh, cellW, cellH, 0, y);
      ctx.restore();
    } else {
      drawCoverCrop(ctx, media, mw, mh, cellW, cellH, -w / 2 + pad, y);
    }
    if (filterCss) ctx.filter = "none";

    if (darken) {
      ctx.fillStyle = "rgba(0,0,0,0.69)";
      ctx.fillRect(-w / 2 + pad, y, cellW, cellH);
    }
    if (frameImg) {
      ctx.drawImage(frameImg, -w / 2 + pad, y, cellW, cellH);
    }
    y += cellH + gap;
  });

  ctx.restore();

  // bbox rotado: |w·cos(a)| + |h·sin(a)| de ancho, |w·sin(a)| + |h·cos(a)| de alto
  return Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
}

// Geometría del abanico + logo, compartida entre la foto final (imagen) y
// la Live Photo final (video) — mismo layout exacto en los dos casos (son
// puras fracciones de canvasW/canvasH, por eso sirve aunque el video use un
// canvas más chico que la foto — ver EXPORT_VIDEO_W/H), calculado una sola
// vez en función de cuántas celdas hay.
function computeExportLayout(mediaCount, canvasW = EXPORT_W, canvasH = EXPORT_H) {
  // En modo "single" la tira tiene 1 sola celda, no 3 — se agranda (logo y
  // separaciones escalan solos porque están definidos en función de stripW).
  const stripW = canvasW * (session.mode === "single" ? 0.62 : 0.48);
  const logoW = stripW * 0.65;
  const logoH = logoW * (42 / 113); // aspect ratio real de isologo-light.svg
  const logoGap = stripW * 0.1;

  // En modo "single" el mat lleva un margen inferior grueso (silueta de
  // polaroid real), no el parejo que usa la tira de 3 celdas.
  const isSingle = session.mode === "single";
  const bottomPad = isSingle ? stripW * 0.22 : undefined;

  // Alturas rotadas de ambas tiras (para saber cuál asoma más abajo) y
  // centrado del bloque completo (abanico + logo) en el canvas.
  const rad13 = (13.49 * Math.PI) / 180;
  const rad16 = (-16.71 * Math.PI) / 180;
  const padProbe = stripW * 0.075;
  const cellWProbe = stripW - padProbe * 2;
  const hProbe = padProbe + mediaCount * (cellWProbe / CROP_RATIO) + (mediaCount - 1) * padProbe * 0.55 + (bottomPad ?? padProbe);
  const bbox13 = Math.abs(stripW * Math.sin(rad13)) + Math.abs(hProbe * Math.cos(rad13));
  const bbox16 = Math.abs(stripW * Math.sin(rad16)) + Math.abs(hProbe * Math.cos(rad16));
  const clusterH = Math.max(bbox13, bbox16);

  const cx = canvasW / 2;

  // El logo ancla cerca del borde inferior (no centrado en todo el canvas)
  // pero respetando el margen que IG Stories tapa con su propia UI abajo
  // (~15% de la altura) — así nunca queda escondido detrás de esa barra.
  const bottomSafeMargin = canvasH * 0.05;
  const logoY = canvasH - bottomSafeMargin - logoH;
  const clusterCy = logoY - logoGap - clusterH / 2;

  return { stripW, logoW, logoH, bottomPad, cx, clusterCy, logoY };
}

async function composeFinalImageBlob() {
  const photos = session.capturedPhotos;
  if (!photos?.length) return null;

  const [bgImg, logoImg, ...photoImgs] = await Promise.all([
    loadImage(backgroundSrc(session.background)),
    loadImage("assets/logo/isologo-light.svg"),
    ...photos.map(loadImage),
  ]);

  const canvas = document.createElement("canvas");
  canvas.width = EXPORT_W;
  canvas.height = EXPORT_H;
  const ctx = canvas.getContext("2d");

  drawCoverCrop(ctx, bgImg, bgImg.naturalWidth || bgImg.width, bgImg.naturalHeight || bgImg.height, EXPORT_W, EXPORT_H);

  const layout = computeExportLayout(photoImgs.length);

  // Atrás: mat bordó + overlay negro al 69% sobre cada foto (fiel al
  // diseño original). Adelante: mat blanco + sombra proyectada.
  drawRotatedStrip(ctx, photoImgs, layout.cx, layout.clusterCy, layout.stripW, 13.49, { matColor: "#3d0303", darken: true, bottomPad: layout.bottomPad });
  drawRotatedStrip(ctx, photoImgs, layout.cx, layout.clusterCy, layout.stripW, -16.71, { shadow: true, bottomPad: layout.bottomPad });

  ctx.drawImage(logoImg, (EXPORT_W - layout.logoW) / 2, layout.logoY, layout.logoW, layout.logoH);

  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

// Mismo look que composeFinalImageBlob (fondo + abanico + logo), pero
// animado: cada celda muestra su clip Live en loop, grabado en vivo sobre
// un canvas con MediaRecorder durante EXPORT_VIDEO_MS (los clips originales
// duran ~2s, se loopean para completar los 10s reales del archivo
// compartido). Pensado solo para compartir (QR → /galeria), no se reproduce
// dentro de la app.
//
// Canvas más chico que el de la foto (EXPORT_W x EXPORT_H) y menos fps a
// propósito: /galeria convierte este webm a MP4 con ffmpeg.wasm en el
// celular de quien comparte (ver webmToMp4), y ese paso es MUY sensible a
// la cantidad de píxeles por frame — en un iPhone 14 Pro Max, 1080x1920 a
// 24fps tardaba demasiado. Mantiene el mismo 9:16 que la foto, solo con
// menos resolución (de sobra para compartir a Instagram, no para imprimir).
const EXPORT_VIDEO_MS = 10000;
const EXPORT_VIDEO_W = 720;
const EXPORT_VIDEO_H = 1280;
const EXPORT_VIDEO_FPS = 20;

async function composeFinalVideoBlob() {
  if (!session.liveUrls.length || session.liveUrls.length !== session.capturedPhotos.length) return null;
  if (typeof MediaRecorder === "undefined") return null;

  const [bgImg, logoImg, frameImg] = await Promise.all([
    loadImage(backgroundSrc(session.background)),
    loadImage("assets/logo/isologo-light.svg"),
    session.frame ? preloadSquareFrame(session.frame) : Promise.resolve(null),
  ]);

  const videos = await Promise.all(
    session.liveUrls.map(
      (url) =>
        new Promise((resolve) => {
          const video = document.createElement("video");
          video.muted = true;
          video.loop = true;
          video.playsInline = true;
          video.addEventListener("loadeddata", () => {
            video.play().catch(() => {});
            resolve(video);
          });
          video.src = url;
        })
    )
  );

  const canvas = document.createElement("canvas");
  canvas.width = EXPORT_VIDEO_W;
  canvas.height = EXPORT_VIDEO_H;
  const ctx = canvas.getContext("2d");

  const layout = computeExportLayout(videos.length, EXPORT_VIDEO_W, EXPORT_VIDEO_H);
  const filterCss = FILTERS[session.filter] ?? "none";

  let recorder;
  try {
    recorder = new MediaRecorder(canvas.captureStream(EXPORT_VIDEO_FPS), { mimeType: pickLiveMimeType() });
  } catch (err) {
    console.warn("[FrameIt] No se pudo armar el video final de la Live Photo:", err);
    return null;
  }

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };

  return new Promise((resolve) => {
    let rafId;
    const draw = () => {
      drawCoverCrop(ctx, bgImg, bgImg.naturalWidth || bgImg.width, bgImg.naturalHeight || bgImg.height, EXPORT_VIDEO_W, EXPORT_VIDEO_H);
      drawRotatedStrip(ctx, videos, layout.cx, layout.clusterCy, layout.stripW, 13.49, {
        matColor: "#3d0303",
        darken: true,
        bottomPad: layout.bottomPad,
        filterCss,
        frameImg,
      });
      drawRotatedStrip(ctx, videos, layout.cx, layout.clusterCy, layout.stripW, -16.71, {
        shadow: true,
        bottomPad: layout.bottomPad,
        filterCss,
        frameImg,
      });
      ctx.drawImage(logoImg, (EXPORT_VIDEO_W - layout.logoW) / 2, layout.logoY, layout.logoW, layout.logoH);
      rafId = requestAnimationFrame(draw);
    };

    recorder.onstop = () => {
      cancelAnimationFrame(rafId);
      videos.forEach((video) => video.pause());
      resolve(new Blob(chunks, { type: recorder.mimeType }));
    };

    recorder.start();
    draw();
    setTimeout(() => recorder.stop(), EXPORT_VIDEO_MS);
  });
}

// Sube un blob (foto o video) al backend correspondiente (ver server.py y
// api/upload-*.js) y devuelve la URL pública del archivo subido.
async function uploadAsset(endpoint, blob, contentType) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: blob,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.url;
}

function renderExportQr(container, galleryQuery) {
  container.innerHTML = "";
  // eslint-disable-next-line no-undef -- viene de js/vendor/qrcode.min.js
  new QRCode(container, {
    text: `${location.origin}/galeria.html?${galleryQuery}`,
    width: 175,
    height: 175,
    colorDark: "#3d0303",
    colorLight: "#ffdede",
  });
}

// Compone y sube la foto final y la Live Photo final (~10s, ver
// composeFinalVideoBlob), y recién ahí renderiza el QR — ya con las dos
// opciones adentro, para que en /galeria el toggle Foto/Live esté siempre
// disponible apenas se escanea (nunca hay que volver a escanear). Mientras
// tanto deja un indicador en el lugar del QR; si algo falla (sin fotos,
// servidor caído), deja un mensaje de error en vez de romper la pantalla.
async function uploadAndRenderQr() {
  const qrContainer = document.getElementById("exportQr");
  qrContainer.textContent = "Preparando QR...";

  const photoBlob = await composeFinalImageBlob();
  if (!photoBlob) {
    qrContainer.textContent = "Sin foto para compartir";
    return;
  }

  let photoUrl;
  try {
    photoUrl = await uploadAsset("/api/upload-photo", photoBlob, "image/png");
  } catch (err) {
    console.warn("[FrameIt] No se pudo subir la foto para el QR:", err);
    qrContainer.textContent = "No se pudo generar el QR";
    return;
  }

  // Si la Live Photo falla (clips incompletos, sin soporte de MediaRecorder,
  // servidor caído), no se rompe el QR — se comparte solo la foto.
  let videoUrl = null;
  try {
    const videoBlob = await composeFinalVideoBlob();
    if (videoBlob) videoUrl = await uploadAsset("/api/upload-video", videoBlob, "video/webm");
  } catch (err) {
    console.warn("[FrameIt] No se pudo subir la Live Photo (se comparte solo la foto):", err);
  }

  let query = `photo=${encodeURIComponent(photoUrl)}`;
  if (videoUrl) query += `&video=${encodeURIComponent(videoUrl)}`;
  renderExportQr(qrContainer, query);
}

const WELCOME_LOOP_MS = 3000;

// "Loop de marca" de la pantalla de bienvenida: alterna cada 4s entre la
// variante rosa (logo bicolor) y la bordó (logo claro) — dos versiones del
// mismo diseño de Figma.
function startWelcomeLoop() {
  clearInterval(welcomeLoopTimer);
  const screen = document.getElementById("welcomeScreen");
  const logo = document.getElementById("welcomeLogo");

  // Siempre arranca en la variante rosa, nunca heredada de la visita anterior.
  screen.classList.remove("is-alt");
  logo.src = "assets/logo/isologo.svg";

  welcomeLoopTimer = setInterval(() => {
    const isAlt = screen.classList.toggle("is-alt");
    logo.src = isAlt ? "assets/logo/isologo-light.svg" : "assets/logo/isologo.svg";
  }, WELCOME_LOOP_MS);
}

// Hooks que corren cada vez que se entra a una pantalla en particular.
const screenEnterHooks = {
  welcome: startWelcomeLoop,
  selection: () => {
    setFrameOverlay(document.getElementById("frameOverlay"), session.frame);
  },
  capturing: () => {
    // La pantalla de captura no elige marco: hereda el que se seleccionó antes.
    setFrameOverlay(document.getElementById("captureFrameOverlay"), session.frame);
    if (session.frame) preloadSquareFrame(session.frame); // listo en caché antes de que termine la cuenta regresiva
    startShotSequence();
  },
  preview: renderPrintStrip,
  background: renderBackgroundSwatches,
  export: renderExportPrint,
};

function init() {
  bindWelcomeScreen();
  bindModeScreen();
  bindSelectionScreen();
  bindFilterPicker();
  bindPickerTabs();
  bindPreviewScreen();
  bindBackgroundScreen();
  bindIdleWatchers();
  showScreen("welcome");
  initCamera(); // pide permiso de entrada, para que ya esté lista al llegar a "selection"
}

document.addEventListener("DOMContentLoaded", init);
