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

// Estado de la sesión de captura en curso (modo elegido, marco elegido, etc.)
const session = {
  mode: null, // "single" | "strip"
  frame: "assets/frames/frame-01.png",
  background: "bg-01",
};

function showScreen(name) {
  if (!SCREENS.includes(name)) {
    console.warn(`[FrameIt] Pantalla desconocida: "${name}"`);
    return;
  }
  document.querySelectorAll(".screen").forEach((section) => {
    section.classList.toggle("is-active", section.dataset.screen === name);
  });
  clearInterval(exportCountdownTimer); // se re-arma en el hook de "export" si corresponde
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
    CAMERA_VIDEO_IDS.forEach((id) => {
      document.getElementById(id).srcObject = stream;
    });
  } catch (err) {
    console.warn("[FrameIt] No se pudo acceder a la webcam:", err);
    showCameraFallback();
  }
}

function bindSelectionScreen() {
  const thumbs = document.querySelectorAll(".screen--selection .frame-thumb");
  const overlay = document.getElementById("frameOverlay");
  const captureBtn = document.querySelector(".screen--selection .capture-btn");

  thumbs.forEach((thumb) => {
    thumb.addEventListener("click", () => {
      session.frame = thumb.dataset.frame;
      overlay.src = session.frame;
      thumbs.forEach((t) => t.classList.toggle("is-selected", t === thumb));
    });
  });

  captureBtn.addEventListener("click", () => showScreen("capturing"));
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
function capturePhoto() {
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
  if (isLive) {
    // La webcam se muestra espejada (scaleX(-1) en CSS); la guardamos igual
    // a como la vio la persona en el preview.
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  drawCoverCrop(ctx, source, srcW, srcH, canvas.width, canvas.height);
  ctx.restore();

  // Marco generativo encima, sin espejar (es una decoración fija, no la cara
  // de la persona). Estirado a medida en vez de recortado (drawCoverCrop):
  // el marco tiene que verse completo, no cortado en los bordes.
  const frameImg = document.getElementById("captureFrameOverlay");
  if (frameImg.complete && frameImg.naturalWidth) {
    ctx.drawImage(frameImg, 0, 0, canvas.width, canvas.height);
  }

  return canvas.toDataURL("image/png");
}

// "single" saca 1 foto; "strip" saca 3, una toma por vez con su propia
// cuenta regresiva. session.capturedPhotos se reinicia en cada entrada a
// "capturing" (incluido el reintento desde Preview: se repiten las 3 tomas).
const SHOT_PAUSE_MS = 1200;

function startShotSequence() {
  session.capturedPhotos = [];
  takeNextShot();
}

function takeNextShot() {
  const totalShots = session.mode === "strip" ? 3 : 1;
  const shotNumber = session.capturedPhotos.length + 1;

  const counterEl = document.getElementById("shotCounter");
  counterEl.hidden = totalShots === 1;
  counterEl.textContent = `Foto ${shotNumber} de ${totalShots}`;

  startCountdown(() => {
    const photo = capturePhoto();
    if (photo) session.capturedPhotos.push(photo);

    if (session.capturedPhotos.length < totalShots) {
      const el = document.getElementById("countdownText");
      el.textContent = "¡Buenísimo!";
      setTimeout(takeNextShot, SHOT_PAUSE_MS);
    } else {
      showScreen("preview");
    }
  });
}

function startCountdown(onDone) {
  clearInterval(countdownTimer);

  const el = document.getElementById("countdownText");
  let n = 3;
  el.textContent = n;

  countdownTimer = setInterval(() => {
    n -= 1;
    if (n > 0) {
      el.textContent = n;
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
    : ["assets/img/booth-photo.png"];

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

function renderPrintStrip() {
  fillPrintStripPhotos(document.getElementById("printStripPhotos"));
}

function bindPreviewScreen() {
  document.getElementById("retryBtn").addEventListener("click", () => showScreen("capturing"));
  document.getElementById("confirmBtn").addEventListener("click", () => showScreen("background"));
}

function renderBackgroundSwatches() {
  document.querySelectorAll("[data-swatch-photos]").forEach(fillPrintStripPhotos);
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
  card.style.backgroundImage = `url('assets/img/${session.background}.png')`;
  document.querySelectorAll("[data-export-photos]").forEach(fillPrintStripPhotos);
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
// la de atrás). `darken`: tapa cada foto con un overlay negro al 69%
// (igual que el diseño original de Figma — no un filtro de brillo sobre
// toda la tira). `shadow`: sombra proyectada (solo la tira de adelante).
function drawRotatedStrip(ctx, photoImgs, cx, cy, w, deg, { matColor = "#ffffff", darken = false, shadow = false } = {}) {
  const pad = w * 0.075;
  const cellW = w - pad * 2;
  const cellH = cellW / CROP_RATIO;
  const gap = pad * 0.55;
  const h = pad * 2 + photoImgs.length * cellH + (photoImgs.length - 1) * gap;
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
  photoImgs.forEach((img) => {
    drawCoverCrop(ctx, img, img.naturalWidth || img.width, img.naturalHeight || img.height, cellW, cellH, -w / 2 + pad, y);
    if (darken) {
      ctx.fillStyle = "rgba(0,0,0,0.69)";
      ctx.fillRect(-w / 2 + pad, y, cellW, cellH);
    }
    y += cellH + gap;
  });

  ctx.restore();

  // bbox rotado: |w·cos(a)| + |h·sin(a)| de ancho, |w·sin(a)| + |h·cos(a)| de alto
  return Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
}

async function composeFinalImageBlob() {
  const photos = session.capturedPhotos;
  if (!photos?.length) return null;

  const [bgImg, logoImg, ...photoImgs] = await Promise.all([
    loadImage(`assets/img/${session.background}.png`),
    loadImage("assets/logo/isologo-light.svg"),
    ...photos.map(loadImage),
  ]);

  const canvas = document.createElement("canvas");
  canvas.width = EXPORT_W;
  canvas.height = EXPORT_H;
  const ctx = canvas.getContext("2d");

  drawCoverCrop(ctx, bgImg, bgImg.naturalWidth || bgImg.width, bgImg.naturalHeight || bgImg.height, EXPORT_W, EXPORT_H);

  const stripW = EXPORT_W * 0.48;
  const logoW = stripW * 0.65;
  const logoH = logoW * (42 / 113); // aspect ratio real de isologo-light.svg
  const logoGap = stripW * 0.1;

  // Alturas rotadas de ambas tiras (para saber cuál asoma más abajo) y
  // centrado del bloque completo (abanico + logo) en el canvas.
  const rad13 = (13.49 * Math.PI) / 180;
  const rad16 = (-16.71 * Math.PI) / 180;
  const padProbe = stripW * 0.075;
  const cellWProbe = stripW - padProbe * 2;
  const hProbe = padProbe * 2 + photoImgs.length * (cellWProbe / CROP_RATIO) + (photoImgs.length - 1) * padProbe * 0.55;
  const bbox13 = Math.abs(stripW * Math.sin(rad13)) + Math.abs(hProbe * Math.cos(rad13));
  const bbox16 = Math.abs(stripW * Math.sin(rad16)) + Math.abs(hProbe * Math.cos(rad16));
  const clusterH = Math.max(bbox13, bbox16);

  const cx = EXPORT_W / 2;

  // El logo ancla cerca del borde inferior (no centrado en todo el canvas)
  // pero respetando el margen que IG Stories tapa con su propia UI abajo
  // (~15% de la altura) — así nunca queda escondido detrás de esa barra.
  const bottomSafeMargin = EXPORT_H * 0.05;
  const logoY = EXPORT_H - bottomSafeMargin - logoH;
  const clusterCy = logoY - logoGap - clusterH / 2;

  // Atrás: mat bordó + overlay negro al 69% sobre cada foto (fiel al
  // diseño original). Adelante: mat blanco + sombra proyectada.
  drawRotatedStrip(ctx, photoImgs, cx, clusterCy, stripW, 13.49, { matColor: "#3d0303", darken: true });
  drawRotatedStrip(ctx, photoImgs, cx, clusterCy, stripW, -16.71, { shadow: true });

  ctx.drawImage(logoImg, (EXPORT_W - logoW) / 2, logoY, logoW, logoH);

  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

// Sube la foto compuesta al mini servidor local (ver server.py) y renderiza
// un QR real apuntando a esa URL. Si algo falla (sin fotos, servidor caído),
// deja un mensaje en vez de romper la pantalla.
async function uploadAndRenderQr() {
  const qrContainer = document.getElementById("exportQr");

  const blob = await composeFinalImageBlob();
  if (!blob) {
    qrContainer.textContent = "Sin foto para compartir";
    return;
  }

  try {
    const res = await fetch("/api/upload-photo", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: blob,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    qrContainer.innerHTML = "";
    // eslint-disable-next-line no-undef -- viene de js/vendor/qrcode.min.js
    new QRCode(qrContainer, {
      text: `${location.origin}${data.url}`,
      width: 175,
      height: 175,
      colorDark: "#3d0303",
      colorLight: "#ffdede",
    });
  } catch (err) {
    console.warn("[FrameIt] No se pudo subir la foto para el QR:", err);
    qrContainer.textContent = "No se pudo generar el QR";
  }
}

// Hooks que corren cada vez que se entra a una pantalla en particular.
const screenEnterHooks = {
  selection: () => {
    document.getElementById("frameOverlay").src = session.frame;
  },
  capturing: () => {
    // La pantalla de captura no elige marco: hereda el que se seleccionó antes.
    document.getElementById("captureFrameOverlay").src = session.frame;
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
  bindPreviewScreen();
  bindBackgroundScreen();
  bindIdleWatchers();
  showScreen("welcome");
  initCamera(); // pide permiso de entrada, para que ya esté lista al llegar a "selection"
}

document.addEventListener("DOMContentLoaded", init);
