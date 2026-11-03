#!/usr/bin/env python3
"""
FrameIt — mini local server.

Serves the static frontend (same as `python3 -m http.server`) and adds:
- POST /api/upload-photo: recibe la foto final compuesta desde el navegador
  y la guarda en uploads/latest.png.
- POST /api/upload-video: recibe la Live Photo final (~10s, ver
  composeFinalVideoBlob en app.js) y la guarda en uploads/latest-live.webm.
  Mismo contrato que upload-photo: devuelve la URL pública cruda del
  archivo subido ({"url": "/uploads/..."}) — el frontend la combina con la
  de la foto para armar el link de /galeria.html (ver uploadAndRenderQr).
- /galeria.html (archivo estático en la raíz, servido por el handler
  default de abajo, igual que en el deploy de Vercel): toma ?photo=...
  y, si está, &video=... para mostrar el toggle Foto/Live con el botón de
  "Compartir" (Web Share API, abre el selector nativo del celular, con
  Instagram como una de las apps disponibles) más descarga directa como
  fallback. El QR de la pantalla "Entrega" apunta ahí. Lleva headers
  Cross-Origin-Opener-Policy/Cross-Origin-Embedder-Policy (ver
  end_headers) para habilitar el build multi-thread de ffmpeg.wasm que
  convierte el Live a MP4 — bastante más rápido que el single-thread, ver
  galeria.html. Si el navegador no soporta ese aislamiento, la página cae
  sola al modo simple (no rompe nada, ver self.crossOriginIsolated ahí).

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

UPLOAD_ROUTES = {
    "/api/upload-photo": ("latest.png", "/uploads/latest.png"),
    "/api/upload-video": ("latest-live.webm", "/uploads/latest-live.webm"),
}


class FrameItHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # Solo en /galeria.html: habilita el aislamiento cross-origin que
        # pide ffmpeg.wasm para correr multi-thread (varios núcleos en vez
        # de uno solo) al convertir el Live a MP4 — "credentialless" en vez
        # de "require-corp" porque la página carga <img>/<video> desde
        # Vercel Blob (cross-origin) sin control sobre sus headers; con
        # "require-corp" esas cargas se romperían si Vercel Blob no manda
        # Cross-Origin-Resource-Policy.
        if self.path.split("?", 1)[0] == "/galeria.html":
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        super().end_headers()

    def do_POST(self):
        route = UPLOAD_ROUTES.get(self.path)
        if route is None:
            self.send_error(404, "Not found")
            return

        filename, public_url = route
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            self.send_error(400, "Empty body")
            return

        body = self.rfile.read(length)
        (UPLOADS_DIR / filename).write_bytes(body)

        payload = f'{{"url": "{public_url}"}}'.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):
        # Un poco más silencioso que el default; igual muestra errores.
        if "POST" in args[0] or "GET" in args[0]:
            super().log_message(format, *args)


if __name__ == "__main__":
    with socketserver.TCPServer(("", PORT), FrameItHandler) as httpd:
        print(f"FrameIt server corriendo en http://localhost:{PORT}")
        print(f"Fotos/videos subidos quedan en: {UPLOADS_DIR}")
        httpd.serve_forever()
