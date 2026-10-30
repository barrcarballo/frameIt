// FrameIt — endpoint de subida de fotos para el deploy en Vercel.
//
// Hace lo mismo que POST /api/upload-photo en server.py (desarrollo local),
// pero en Vercel el filesystem de las funciones no persiste entre pedidos,
// así que acá la foto se guarda en Vercel Blob (storage nativo) en vez de
// disco local. Requiere tener un Blob store creado en el proyecto de
// Vercel (Project → Storage → Create Database → Blob) — eso agrega solo
// la env var BLOB_READ_WRITE_TOKEN, el SDK la usa automático.
//
// El frontend (js/app.js) no sabe ni le importa si está hablando con esto
// o con server.py: en los dos casos hace POST a /api/upload-photo y arma
// la URL del QR con el campo "url" que le devuelva.

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

    const blob = await put("frameit/latest.png", body, {
      access: "public",
      addRandomSuffix: true,
      contentType: "image/png",
    });

    res.status(200).json({
      url: `/galeria.html?photo=${encodeURIComponent(blob.url)}`,
    });
  } catch (err) {
    console.error("[FrameIt] upload-photo error:", err);
    res.status(500).json({ error: "No se pudo subir la foto" });
  }
}
