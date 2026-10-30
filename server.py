#!/usr/bin/env python3
"""
FrameIt — mini local server.

Serves the static frontend (same as `python3 -m http.server`) and adds:
- POST /api/upload-photo: recibe la foto final compuesta desde el navegador
  y la guarda en uploads/latest.png.
- GET /galeria: página mínima de galería — muestra la foto y un botón de
  "Compartir" que usa la Web Share API (abre el selector nativo del
  celular, con Instagram como una de las apps disponibles) más un link de
  descarga directa como fallback. El QR de la pantalla "Entrega" apunta acá
  (no directo a la imagen), que es justo lo que pide el brief: galería
  pública primero, de ahí recién a Instagram — preserva el funnel para
  analytics en vez de un deep-link directo a Stories.

Stdlib only — no Flask/FastAPI, consistent with the "vanilla, sin frameworks
pesados" approach of the rest of the project. On the Raspberry Pi this runs
as: python3 server.py  (instead of `python3 -m http.server`).
"""

import http.server
import socketserver
import pathlib

PORT = 8080
ROOT = pathlib.Path(__file__).resolve().parent
UPLOADS_DIR = ROOT / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)

GALLERY_HTML = """<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Tu foto — FrameIt</title>
<style>
  body { margin:0; min-height:100vh; display:flex; flex-direction:column; align-items:center;
         justify-content:center; gap:20px; padding:24px; box-sizing:border-box;
         background:#ffdede; font-family:-apple-system,system-ui,sans-serif; }
  img { max-width:min(90vw,360px); width:100%; border-radius:16px; box-shadow:0 8px 24px rgba(61,3,3,.25); }
  button, a.download {
    font:inherit; font-size:18px; font-weight:600; border:none; border-radius:20px;
    padding:14px 28px; cursor:pointer; text-decoration:none; text-align:center; width:min(90vw,320px);
    box-sizing:border-box;
  }
  button { background:#3d0303; color:#ffdede; }
  a.download { background:#950606; color:#ffdede; }
  p.hint { font-size:14px; color:#3d0303; text-align:center; max-width:320px; margin:0; }
</style>
</head>
<body>
  <img src="/uploads/latest.png" alt="Tu foto de FrameIt" />
  <button id="shareBtn" onclick="sharePhoto()">Compartir</button>
  <a class="download" href="/uploads/latest.png" download="frameit.png">Descargar foto</a>
  <p class="hint" id="hint"></p>

  <script>
    async function sharePhoto() {
      const hint = document.getElementById("hint");
      try {
        const res = await fetch("/uploads/latest.png");
        const blob = await res.blob();
        const file = new File([blob], "frameit.png", { type: "image/png" });

        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({
            files: [file],
            title: "FrameIt",
            text: "¡Mirá mi foto de FrameIt! @frameit",
          });
          return;
        }
      } catch (err) {
        if (err.name === "AbortError") return; // el usuario canceló, no es un error
        console.warn("[FrameIt] No se pudo compartir:", err);
      }
      hint.textContent =
        "Tu navegador no soporta compartir directo: mantené presionada la foto para guardarla y compartila desde tu galería.";
    }
  </script>
</body>
</html>
"""


class FrameItHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        if self.path in ("/galeria", "/galeria/"):
            body = GALLERY_HTML.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def do_POST(self):
        if self.path != "/api/upload-photo":
            self.send_error(404, "Not found")
            return

        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            self.send_error(400, "Empty body")
            return

        body = self.rfile.read(length)
        (UPLOADS_DIR / "latest.png").write_bytes(body)

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"url": "/galeria"}')

    def log_message(self, format, *args):
        # Un poco más silencioso que el default; igual muestra errores.
        if "POST" in args[0] or "GET" in args[0]:
            super().log_message(format, *args)


if __name__ == "__main__":
    with socketserver.TCPServer(("", PORT), FrameItHandler) as httpd:
        print(f"FrameIt server corriendo en http://localhost:{PORT}")
        print(f"Fotos subidas quedan en: {UPLOADS_DIR}")
        httpd.serve_forever()
