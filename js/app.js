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
  // de la persona) y recortado con el mismo criterio de centrado.
  const frameImg = document.getElementById("captureFrameOverlay");
  if (frameImg.complete && frameImg.naturalWidth) {
    drawCoverCrop(ctx, frameImg, frameImg.naturalWidth, frameImg.naturalHeight, canvas.width, canvas.height);
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

// Compone la foto final para descargar: fondo elegido + mat blanco con la
// tira de fotos (1 o 3) + logo claro al pie — el mismo criterio visual que
// la tarjeta de "Entrega", pero sin el abanico rotado (más simple de
// dibujar en canvas, y el resultado se ve mejor como recuerdo descargable).
const EXPORT_W = 640;
const EXPORT_H = 1138; // ~9:16, coherente con los fondos (retrato)

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

  const matW = EXPORT_W * 0.44;
  const matPad = matW * 0.06;
  const cellW = matW - matPad * 2;
  const cellH = cellW / CROP_RATIO;
  const gap = matPad * 0.7;
  // Alto del mat SOLO (fotos + padding) — el logo va afuera, no reservado
  // adentro de esta altura (ese era el bug: quedaba montado sobre el mat).
  const matH = matPad * 2 + photoImgs.length * cellH + (photoImgs.length - 1) * gap;
  const matX = (EXPORT_W - matW) / 2;

  const logoW = matW * 0.55;
  const logoH = logoW * (42 / 113); // aspect ratio real de isologo-light.svg
  const logoGap = matPad * 1.3; // separación entre el mat y el logo

  // Centra el bloque completo (mat + logo) en el canvas, no solo el mat.
  const blockH = matH + logoGap + logoH;
  const matY = (EXPORT_H - blockH) / 2;

  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.roundRect(matX, matY, matW, matH, matW * 0.04);
  ctx.fill();

  let cy = matY + matPad;
  photoImgs.forEach((img) => {
    drawCoverCrop(ctx, img, img.naturalWidth || img.width, img.naturalHeight || img.height, cellW, cellH, matX + matPad, cy);
    cy += cellH + gap;
  });

  ctx.drawImage(logoImg, (EXPORT_W - logoW) / 2, matY + matH + logoGap, logoW, logoH);

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
