#!/usr/bin/env python3
"""
FrameIt — mini local server.

Serves the static frontend (same as `python3 -m http.server`) and adds:
- GET /api/host-info: devuelve la IP LAN real de la Pi (no "localhost").
  El kiosco navega a localhost:8080 (lo necesita getUserMedia), pero el
  QR final tiene que apuntar a algo que el celular de un invitado pueda
  resolver — ver renderExportQr/getGalleryOrigin en app.js.
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
- HTTPS en paralelo (puerto 8443, ver start_https_server): solo para que
  la propia iPad del kiosco entre por Safari directo a index.html con
  contexto seguro real (getUserMedia lo exige), sin pasar por VNC/Chromium
  local. Usa un certificado propio por dispositivo en ssl/cert.pem +
  ssl/key.pem (gitignored, generados a mano con openssl, uno por Pi — ver
  BITACORA.md). Si no existe el certificado, este listener simplemente no
  arranca; el HTTP de siempre sigue andando igual. GET /cert.pem sirve el
  certificado (no la clave) para instalarlo como perfil de confianza en
  esa iPad específica — los invitados (QR, /galeria.html) nunca lo tocan,
  siguen entrando por HTTP plano como siempre.

Stdlib only — no Flask/FastAPI, consistent with the "vanilla, sin frameworks
pesados" approach of the rest of the project. On the Raspberry Pi this runs
as: python3 server.py  (instead of `python3 -m http.server`). Necesita
`ffmpeg` en el PATH para la conversión rápida del Live — sin eso sigue
funcionando, solo más lento (conversión en el celular de quien comparte).
"""

import http.server
import json
import os
import pathlib
import re
import shutil
import socket
import ssl
import subprocess
import threading

PORT = 8080
# Servidor HTTPS en paralelo, solo para que la propia iPad del kiosco entre
# por Safari directo (sin VNC) con contexto seguro real — ver SSL_CERT/
# SSL_KEY más abajo. Los invitados (QR, /galeria.html) siguen por HTTP
# normal en PORT, sin cambios.
HTTPS_PORT = 8443
ROOT = pathlib.Path(__file__).resolve().parent
UPLOADS_DIR = ROOT / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)

SSL_DIR = ROOT / "ssl"
SSL_CERT = SSL_DIR / "cert.pem"
SSL_KEY = SSL_DIR / "key.pem"

# Debe coincidir con EXPORT_VIDEO_FPS en js/app.js — ver el comentario en
# convert_webm_to_mp4 sobre por qué forzar esto importa.
LIVE_VIDEO_FPS = 20

FFMPEG_BIN = shutil.which("ffmpeg")


def get_lan_ip():
    # Trick estándar: un socket UDP "conectado" no manda nada por la red,
    # solo le pregunta al SO qué interfaz usaría para llegar a esa IP — así
    # se consigue la IP LAN real sin depender de hostname/mDNS.
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


LAN_IP = get_lan_ip()


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
            # El webm que graba MediaRecorder desde un canvas (ver
            # composeFinalVideoBlob en app.js) trae un timing de frames
            # medio berreta — sin esto, ffmpeg heredaba un r_frame_rate
            # absurdo (~2000fps vistos en un caso real) y elegía un H.264
            # Level altísimo (Level 6.0, pensado para 8K) que el decoder
            # de hardware de iPhone/iPad no soporta: el archivo quedaba
            # perfecto pero Safari se negaba a reproducirlo en <video>
            # (aunque sí abría bien desde Fotos). Forzar el fps real acá
            # arregla el Level de raíz.
            "-r", str(LIVE_VIDEO_FPS),
            "-movflags", "+faststart",
            str(mp4_path),
        ],
        check=True,
        capture_output=True,
    )


class FrameItHandler(http.server.SimpleHTTPRequestHandler):
    # HTTP/1.1 + keep-alive: index.html pide ~70 assets propios, con
    # HTTP/1.0 (el default) cada uno abre una conexión TCP nueva — en la
    # Pi, por Wi-Fi, eso pesaba mucho más que el tamaño de los archivos.
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_head(self):
        # do_HEAD() de la clase base llama a send_head() directo, sin pasar
        # por do_GET() — así que la protección de /ssl/ (clave privada) de
        # ahí no alcanza acá. Se repite el chequeo para que ni un HEAD
        # confirme que el archivo existe.
        if self.path.split("?", 1)[0].startswith("/ssl/"):
            self.send_error(404, "Not found")
            return None

        # SimpleHTTPRequestHandler ignora el header Range y siempre manda
        # el archivo entero — Safari (y la mayoría de los navegadores) lo
        # necesita para reproducir <video>: pide el archivo en pedazos, no
        # de una sola vez como una descarga. Sin esto, el Live se descarga
        # bien pero no se ve en la preview de /galeria.html.
        range_header = self.headers.get("Range")
        if not range_header:
            return super().send_head()

        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().send_head()

        return self._send_range(path, range_header)

    def _reject_range(self, size):
        # Bajo HTTP/1.1 con keep-alive, una respuesta sin Content-Length (ni
        # "Connection: close") deja al cliente esperando para siempre — acá
        # mandaba el 416 sin ese header y colgaba cualquier request mal
        # formado (confirmado probando "bytes=-500" localmente).
        self.send_response(416)
        self.send_header("Content-Range", f"bytes */{size}")
        self.send_header("Content-Length", "0")
        self.end_headers()
        return None

    def _send_range(self, path, range_header):
        size = os.path.getsize(path)
        match = re.match(r"bytes=(\d*)-(\d*)", range_header)
        if not match or not (match.group(1) or match.group(2)):
            return self._reject_range(size)

        start_str, end_str = match.groups()
        if start_str == "":
            # "bytes=-500" (sufijo RFC 7233): los últimos 500 bytes, NO
            # "hasta el byte 500" — confundir esto fue el bug original.
            start = max(size - int(end_str), 0)
            end = size - 1
        else:
            start = int(start_str)
            end = int(end_str) if end_str else size - 1
            end = min(end, size - 1)
        if start > end or start < 0:
            return self._reject_range(size)

        length = end - start + 1
        self.send_response(206)
        self.send_header("Content-type", self.guess_type(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(length))
        self.end_headers()
        if self.command == "HEAD":
            return None
        # Se escribe el cuerpo acá mismo y se devuelve None (en vez de un
        # file object) — do_GET()/copyfile() de la clase base no saben de
        # rangos y copiarían hasta el final real del archivo, no hasta
        # `end`, rompiendo el Content-Length ya mandado.
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            chunk_size = 64 * 1024
            while remaining > 0:
                chunk = f.read(min(chunk_size, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)
        return None

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

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/host-info":
            self._handle_host_info()
        elif path == "/cert.pem":
            # Única forma de bajar el certificado — la carpeta ssl/ (con
            # la clave privada adentro) está bloqueada en send_head().
            # iOS/Safari solo ofrece "Instalar perfil" para este MIME type
            # específico — con "application/x-pem-file" lo trata como un
            # archivo cualquiera en vez de un certificado instalable.
            self._send_file(SSL_CERT, "application/x-x509-ca-cert")
        else:
            super().do_GET()

    def _send_file(self, path, content_type):
        if not path.is_file():
            self.send_error(404, "Not found")
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

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

    def _respond_json(self, obj):
        payload = json.dumps(obj).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _handle_host_info(self):
        # El kiosco accede a localhost (lo necesita getUserMedia, que solo
        # funciona en "contexto seguro"), pero el QR tiene que apuntar a
        # algo que el celular de un invitado pueda resolver — localhost ahí
        # sería su propio loopback, no la Pi. app.js usa esto para armar el
        # QR en vez de location.origin.
        self._respond_json({"origin": f"http://{LAN_IP}:{PORT}"})

    def _handle_upload_photo(self):
        body = self._read_body()
        if body is None:
            self.send_error(400, "Empty body")
            return
        (UPLOADS_DIR / "latest.png").write_bytes(body)
        self._respond_json({"url": "/uploads/latest.png"})

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
                self._respond_json({"url": "/uploads/latest-live.mp4"})
                return
            except subprocess.CalledProcessError as err:
                mp4_path.unlink(missing_ok=True)  # puede haber quedado a medio escribir
                stderr = err.stderr.decode("utf-8", "replace") if err.stderr else ""
                print(f"[FrameIt] ffmpeg falló convirtiendo el Live a MP4, se sirve el webm crudo:\n{stderr}")

        # Sin ffmpeg instalado, o si la conversión falló: se sirve el webm
        # crudo — /galeria.html detecta la extensión y cae sola a convertir
        # con ffmpeg.wasm en el celular (más lento, pero sigue andando).
        self._respond_json({"url": "/uploads/latest-live.webm"})

    def log_message(self, format, *args):
        # Un poco más silencioso que el default — pero en un error (404,
        # etc.) send_error() llama a esto con args[0] = HTTPStatus, no un
        # string, y "POST" in args[0] explota. Esos errores sí se loguean
        # (son justo los que importa ver), solo se filtran las líneas de
        # request normales.
        if not isinstance(args[0], str) or "POST" in args[0] or "GET" in args[0]:
            super().log_message(format, *args)


def start_https_server():
    # Servidor HTTPS aparte, en su propio thread — así la iPad del kiosco
    # puede entrar por Safari directo con contexto seguro real (sin esto,
    # getUserMedia no funciona fuera de localhost), sin tener que correr
    # Chromium en la Pi y mandar la pantalla por VNC. Si no hay certificado
    # generado (ver ssl/cert.pem, ssl/key.pem — no se versionan en git, son
    # por dispositivo), se omite en silencio: el HTTP de siempre sigue
    # andando igual para desarrollo local / invitados.
    if not (SSL_CERT.is_file() and SSL_KEY.is_file()):
        print("[FrameIt] Sin ssl/cert.pem — HTTPS deshabilitado (solo HTTP).")
        return

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile=str(SSL_CERT), keyfile=str(SSL_KEY))

    httpd = http.server.ThreadingHTTPServer(("", HTTPS_PORT), FrameItHandler)
    httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
    print(f"FrameIt HTTPS corriendo en https://{LAN_IP}:{HTTPS_PORT} (certificado propio)")
    httpd.serve_forever()


if __name__ == "__main__":
    if not FFMPEG_BIN:
        print("[FrameIt] AVISO: no se encontró ffmpeg en el PATH — el Live se va a convertir en el")
        print("          celular de quien comparte (más lento). Instalar con: brew install ffmpeg")
        print("          (Mac) o sudo apt install ffmpeg (Raspberry Pi / Linux).")

    threading.Thread(target=start_https_server, daemon=True).start()

    # ThreadingHTTPServer (no TCPServer a secas): atiende varias conexiones
    # en paralelo — con una sola a la vez, el navegador pedía los ~70
    # assets de index.html en fila, uno por uno.
    with http.server.ThreadingHTTPServer(("", PORT), FrameItHandler) as httpd:
        print(f"FrameIt server corriendo en http://localhost:{PORT}")
        print(f"Fotos/videos subidos quedan en: {UPLOADS_DIR}")
        httpd.serve_forever()
