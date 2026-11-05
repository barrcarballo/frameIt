#!/usr/bin/env python3
"""
FrameIt — webcam WebRTC relay.

La webcam USB está conectada físicamente a la Pi, pero el kiosco ahora
corre en la iPad por Safari directo vía HTTPS (ver start_https_server en
server.py y BITACORA.md) — sin VNC, para eliminar el lag de renderizar
Chromium + codificar video al mismo tiempo. El problema: getUserMedia en
la iPad solo puede ver las cámaras DE LA IPAD, nunca un dispositivo USB
enchufado en otra máquina de la red. Este relay resuelve eso: la Pi abre
la webcam por v4l2 y la transmite en vivo por WebRTC; la iPad la recibe
como un MediaStream normal (ver getCameraStream en js/app.js) — el resto
de la app (filtros, captura, Live Photo) no se entera de la diferencia,
porque sigue siendo un MediaStream como cualquier otro.

Corre en un proceso y puerto aparte de server.py (asyncio vs. threading,
no mezclan bien en el mismo proceso). Usa el mismo certificado HTTPS que
server.py (ver ssl/cert.pem) — necesario porque index.html ya se sirve
por HTTPS, y un fetch a un endpoint HTTP sería "mixed content", bloqueado
por el navegador.

Dependencias (aiortc, aiohttp) NO son stdlib — único quiebre de la regla
"sin frameworks pesados" del resto del proyecto, justificado porque
reimplementar WebRTC a mano no es viable. Instalar en un venv aparte:
    python3 -m venv .venv-webrtc
    source .venv-webrtc/bin/activate
    pip install aiortc aiohttp
Correr con ese venv activado: python3 webcam_relay.py
"""

import pathlib
import ssl

from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.media import MediaPlayer

ROOT = pathlib.Path(__file__).resolve().parent
SSL_CERT = ROOT / "ssl" / "cert.pem"
SSL_KEY = ROOT / "ssl" / "key.pem"
WEBRTC_PORT = 8444

VIDEO_DEVICE = "/dev/video0"
VIDEO_SIZE = "960x720"  # 1280x720 seguía casi saturando el CPU (281%)
VIDEO_FRAMERATE = "24"  # 30 saturaba la Pi (316% CPU, delay por backlog)

# Un solo viewer esperado (el kiosco) — se guarda la conexión activa para
# cerrarla antes de abrir una nueva. /dev/video0 es de acceso exclusivo:
# dos MediaPlayer abiertos a la vez sobre la misma webcam fallan.
_active_pc = None
_active_player = None


async def _close_active():
    global _active_pc, _active_player
    if _active_pc is not None:
        await _active_pc.close()
        _active_pc = None
    if _active_player is not None:
        if _active_player.video:
            _active_player.video.stop()
        _active_player = None


async def offer(request):
    global _active_pc, _active_player

    params = await request.json()
    offer_desc = RTCSessionDescription(sdp=params["sdp"], type=params["type"])

    await _close_active()

    player = MediaPlayer(
        VIDEO_DEVICE,
        format="v4l2",
        # Sin "input_format" explícito, v4l2 abre la webcam en YUYV (crudo)
        # por default — y a 1280x720 esa webcam solo soporta hasta 10fps en
        # YUYV (confirmado con v4l2-ctl --list-formats-ext), por eso la
        # imagen se veía mal/entrecortada. En MJPG (comprimido en la propia
        # cámara) sí soporta 1280x720 a 30fps completos.
        options={
            "input_format": "mjpeg",
            "video_size": VIDEO_SIZE,
            "framerate": VIDEO_FRAMERATE,
        },
    )
    pc = RTCPeerConnection()
    _active_pc = pc
    _active_player = player

    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        if pc.connectionState in ("failed", "closed", "disconnected"):
            await _close_active()

    pc.addTrack(player.video)

    await pc.setRemoteDescription(offer_desc)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    return web.json_response({
        "sdp": pc.localDescription.sdp,
        "type": pc.localDescription.type,
    })


@web.middleware
async def cors_middleware(request, handler):
    # La página (puerto 8443) y este relay (8444) son orígenes distintos
    # para el navegador (mismo host, puerto diferente) — hace falta CORS,
    # incluido el preflight OPTIONS que manda el fetch con JSON.
    if request.method == "OPTIONS":
        response = web.Response()
    else:
        response = await handler(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


def main():
    app = web.Application(middlewares=[cors_middleware])
    app.router.add_post("/offer", offer)

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile=str(SSL_CERT), keyfile=str(SSL_KEY))

    print(f"[FrameIt] Webcam WebRTC relay en https://0.0.0.0:{WEBRTC_PORT}/offer")
    web.run_app(app, port=WEBRTC_PORT, ssl_context=context)


if __name__ == "__main__":
    main()
