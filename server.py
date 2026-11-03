#!/usr/bin/env python3
"""
FrameIt — mini local server.

Serves the static frontend (same as `python3 -m http.server`) and adds:
- POST /api/upload-photo: recibe la foto final compuesta desde el navegador
  y la guarda en uploads/latest.png.
- POST /api/upload-video: recibe la Live Photo final (~10s, ver
  composeFinalVideoBlob en app.js) y la guarda en uploads/latest-live.webm.
  Si hay `ffmpeg` instalado (brew/apt install ffmpeg), la convierte ACÁ, una
  sola vez, a uploads/latest-live.mp4 y devuelve esa URL — así nadie tiene
  que esperar una conversión en su celular al compartir/descargar (eso era
  lento incluso con ffmpeg.wasm multi-thread, ver galeria.html). Si no hay
  `ffmpeg` o la conversión falla, cae al webm crudo: /galeria.html detecta
  la extensión y convierte con ffmpeg.wasm en el navegador como antes —
  más lento, pero nunca rompe el flujo.
- /galeria.html (archivo estático en la raíz, servido por el handler
  default de abajo, igual que en el deploy de Vercel): toma ?photo=...
  y, si está, &video=... para mostrar el toggle Foto/Live con el botón de
  "Compartir" (Web Share API, abre el selector nativo del celular, con
  Instagram como una de las apps disponibles) más descarga directa como
  fallback. El QR de la pantalla "Entrega" apunta ahí. Lleva headers
  Cross-Origin-Opener-Policy/Cross-Origin-Embedder-Policy (ver
  end_headers) para habilitar el build multi-thread de ffmpeg.wasm (el
  fallback de arriba). Si el navegador no soporta ese aislamiento, la
  página cae sola al modo simple (no rompe nada, ver self.crossOriginIsolated
  en galeria.html).

Stdlib only — no Flask/FastAPI, consistent with the "vanilla, sin frameworks
pesados" approach of the rest of the project. On the Raspberry Pi this runs
as: python3 server.py  (instead of `python3 -m http.server`). Necesita
`ffmpeg` en el PATH para la conversión rápida del Live — sin eso sigue
funcionando, solo más lento (conversión en el celular de quien comparte).
"""

import http.server
import socketserver
import pathlib
import shutil
import subprocess

PORT = 8080
ROOT = pathlib.Path(__file__).resolve().parent
UPLOADS_DIR = ROOT / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)

FFMPEG_BIN = shutil.which("ffmpeg")


def convert_webm_to_mp4(webm_path, mp4_path):
    subprocess.run(
        [
            FFMPEG_BIN,
            "-y",
            "-i", str(webm_path),
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "23",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            str(mp4_path),
        ],
        check=True,
        capture_output=True,
    )


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
        if self.path == "/api/upload-photo":
            self._handle_upload_photo()
        elif self.path == "/api/upload-video":
            self._handle_upload_video()
        else:
            self.send_error(404, "Not found")

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            return None
        return self.rfile.read(length)

    def _respond_json(self, url):
        payload = f'{{"url": "{url}"}}'.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _handle_upload_photo(self):
        body = self._read_body()
        if body is None:
            self.send_error(400, "Empty body")
            return
        (UPLOADS_DIR / "latest.png").write_bytes(body)
        self._respond_json("/uploads/latest.png")

    def _handle_upload_video(self):
        body = self._read_body()
        if body is None:
            self.send_error(400, "Empty body")
            return

        webm_path = UPLOADS_DIR / "latest-live.webm"
        webm_path.write_bytes(body)

        if FFMPEG_BIN:
            mp4_path = UPLOADS_DIR / "latest-live.mp4"
            try:
                convert_webm_to_mp4(webm_path, mp4_path)
                self._respond_json("/uploads/latest-live.mp4")
                return
            except subprocess.CalledProcessError as err:
                mp4_path.unlink(missing_ok=True)  # puede haber quedado a medio escribir
                stderr = err.stderr.decode("utf-8", "replace") if err.stderr else ""
                print(f"[FrameIt] ffmpeg falló convirtiendo el Live a MP4, se sirve el webm crudo:\n{stderr}")

        # Sin ffmpeg instalado, o si la conversión falló: se sirve el webm
        # crudo — /galeria.html detecta la extensión y cae sola a convertir
        # con ffmpeg.wasm en el celular (más lento, pero sigue andando).
        self._respond_json("/uploads/latest-live.webm")

    def log_message(self, format, *args):
        # Un poco más silencioso que el default; igual muestra errores.
        if "POST" in args[0] or "GET" in args[0]:
            super().log_message(format, *args)


if __name__ == "__main__":
    if not FFMPEG_BIN:
        print("[FrameIt] AVISO: no se encontró ffmpeg en el PATH — el Live se va a convertir en el")
        print("          celular de quien comparte (más lento). Instalar con: brew install ffmpeg")
        print("          (Mac) o sudo apt install ffmpeg (Raspberry Pi / Linux).")

    with socketserver.TCPServer(("", PORT), FrameItHandler) as httpd:
        print(f"FrameIt server corriendo en http://localhost:{PORT}")
        print(f"Fotos/videos subidos quedan en: {UPLOADS_DIR}")
        httpd.serve_forever()
