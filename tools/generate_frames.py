#!/usr/bin/env python3
"""
FrameIt — generador de marcos por IA (admin tool, NO corre en el kiosco).

Lee los prompts guardados en tools/frame-prompts.json (uno por temática) y
genera los PNG de marco con fondo transparente vía la API de imágenes de
OpenAI, dejándolos listos en assets/frames/ exactamente como los que usa
hoy la UI (frame-01.png .. frame-06.png) — no hace falta tocar index.html,
css ni app.js.

Por qué offline y no en vivo: se decidió correr esto UNA vez antes del
evento, no durante. Así la cabina sigue funcionando sin depender de
internet estable mientras la gente la usa, y no hay costo de API por cada
foto que se saca.

Uso:
    export OPENAI_API_KEY="sk-..."
    pip install openai
    python3 tools/generate_frames.py                  # set "default" -> assets/frames/
    python3 tools/generate_frames.py --theme boda      # set "boda"    -> assets/frames/boda/
    python3 tools/generate_frames.py --theme boda --apply
        # --apply además copia ese set a assets/frames/ (el que usa la UI hoy)

La API key nunca toca el frontend ni el kiosco: este script se corre a mano,
una vez, desde tu compu, antes del evento.
"""

import argparse
import base64
import json
import pathlib
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PROMPTS_FILE = ROOT / "tools" / "frame-prompts.json"
FRAMES_DIR = ROOT / "assets" / "frames"

MODEL = "gpt-image-2.5-sunburst"  # si OpenAI vuelve a renombrar el modelo, cambiar solo acá
SIZE = "1536x1024"  # landscape, el más cercano a la proporción real del preview (934:544 ~ 1.72)


def load_prompts(theme: str) -> list[dict]:
    data = json.loads(PROMPTS_FILE.read_text(encoding="utf-8"))
    if theme not in data:
        available = [k for k in data if not k.startswith("_")]
        sys.exit(f"Temática '{theme}' no existe en {PROMPTS_FILE.name}. Disponibles: {available}")
    return data[theme]


def generate_one(client, prompt: str) -> bytes:
    result = client.images.generate(
        model=MODEL,
        prompt=prompt,
        background="transparent",
        output_format="png",
        size=SIZE,
    )
    return base64.b64decode(result.data[0].b64_json)


def main():
    parser = argparse.ArgumentParser(description="Genera marcos de FrameIt por IA a partir de prompts guardados.")
    parser.add_argument("--theme", default="default", help="Nombre del set en frame-prompts.json (default: 'default')")
    parser.add_argument("--apply", action="store_true", help="Copiar el resultado a assets/frames/ (lo que usa la UI hoy)")
    args = parser.parse_args()

    try:
        from openai import OpenAI
    except ImportError:
        sys.exit("Falta el paquete 'openai'. Instalalo con: pip install openai")

    client = OpenAI()  # usa OPENAI_API_KEY del entorno

    prompts = load_prompts(args.theme)
    out_dir = FRAMES_DIR if args.theme == "default" else FRAMES_DIR / args.theme
    out_dir.mkdir(parents=True, exist_ok=True)

    for entry in prompts:
        dest = out_dir / f"{entry['id']}.png"
        print(f"Generando {dest.relative_to(ROOT)} ...")
        png_bytes = generate_one(client, entry["prompt"])
        dest.write_bytes(png_bytes)

    print(f"\nListo: {len(prompts)} marcos generados en {out_dir.relative_to(ROOT)}/")

    if args.apply and args.theme != "default":
        for entry in prompts:
            shutil.copy(out_dir / f"{entry['id']}.png", FRAMES_DIR / f"{entry['id']}.png")
        print(f"Copiados a {FRAMES_DIR.relative_to(ROOT)}/ (la UI ya los usa).")


if __name__ == "__main__":
    main()
