// FrameIt — endpoint de subida de la Live Photo final (video) para Vercel.
//
// Mismo criterio que api/upload-photo.js: se guarda en Vercel Blob (no hay
// filesystem persistente entre pedidos) y se devuelve la URL pública cruda
// — el frontend (js/app.js) la combina con la de la foto para armar el
// link de /galeria.html?photo=...&video=....

import { put } from "@vercel/blob";

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

    const blob = await put("frameit/latest-live.webm", body, {
      access: "public",
      addRandomSuffix: true,
      contentType: "video/webm",
    });

    res.status(200).json({ url: blob.url });
  } catch (err) {
    console.error("[FrameIt] upload-video error:", err);
    res.status(500).json({ error: "No se pudo subir la Live Photo" });
  }
}
