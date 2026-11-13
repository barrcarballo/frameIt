// FrameIt — endpoint de subida de la Live Photo final (video) para Vercel.
//
// Mismo criterio que api/upload-photo.js: se guarda en Vercel Blob (no hay
// filesystem persistente entre pedidos) y se devuelve la URL pública cruda
// — el frontend (js/app.js) la combina con la de la foto para armar el
// link de /galeria.html?photo=...&video=....
//
// Lo sube acá tanto el navegador (siempre webm crudo, ver
// composeFinalVideoBlob en app.js) como server.py reenviando un archivo ya
// convertido a MP4 por ffmpeg en la Pi (ver upload_to_vercel en server.py,
// parte del modo "subir a la nube" para que el QR funcione sin que el
// invitado esté en la red de la Pi). El Content-Type y la extensión del
// archivo en Blob dependen de lo que realmente llega, no quedan fijos en
// webm — galeria.html decide si hace falta convertir mirando la extensión
// de la URL (videoIsMp4), así que si quedara fija en ".webm" un MP4 ya
// convertido se re-convertiría al pedo en el celular de quien comparte.

import { put } from "@vercel/blob";

const EXT_BY_CONTENT_TYPE = {
  "video/webm": "webm",
  "video/mp4": "mp4",
};

async function readBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (req.body && req.body.length) return Buffer.from(req.body);

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const body = await readBody(req);
    if (!body.length) {
      res.status(400).json({ error: "Empty body" });
      return;
    }

    const contentType = req.headers["content-type"] || "video/webm";
    const ext = EXT_BY_CONTENT_TYPE[contentType] || "webm";

    const blob = await put(`frameit/latest-live.${ext}`, body, {
      access: "public",
      addRandomSuffix: true,
      contentType,
    });

    res.status(200).json({ url: blob.url });
  } catch (err) {
    console.error("[FrameIt] upload-video error:", err);
    res.status(500).json({ error: "No se pudo subir la Live Photo" });
  }
}
