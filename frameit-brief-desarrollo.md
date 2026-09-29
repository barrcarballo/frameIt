# FrameIt — Brief de desarrollo frontend (interfaz táctil)

## Contexto del proyecto

FrameIt es una cabina de fotos portátil y autónoma para eventos (bodas, cumpleaños, corporativo, festivales). Proyecto académico (Senior Project, tipología Instalación/Intervención), desarrollado en solitario, con colaboración puntual de Barbara Carballo en la parte de hardware/networking.

## Objetivo de esta etapa

Desarrollar el frontend de la interfaz táctil (HTML/CSS/JS) que corre en un Raspberry Pi 3 y se muestra en un iPad Air 1ra gen vía noVNC, en **modo kiosco** (Chromium fullscreen).

## Especificaciones técnicas

- **Resolución de pantalla**: 1024 × 768 px, **orientación horizontal**
- **Hardware**: Raspberry Pi 3 + iPad Air 1ra gen (solo como monitor táctil vía VNC) + webcam USB Gadnic Full HD 1080p (UVC, vía OpenCV/v4l2 — no picamera2)
- **Stack sugerido**: HTML/CSS/JS vanilla (sin frameworks pesados, considerando las limitaciones de hardware del Pi 3), servido localmente y abierto en Chromium `--kiosk`
- **Desarrollo**: local en la compu (navegador de escritorio), luego deploy a la Pi vía SSH/SCP a `miniphotobooth.local`

## Decisión clave: crop vertical sobre pantalla horizontal

La pantalla es horizontal (1024×768) pero la **impresión final es vertical** (tipo tira/strip clásico). Esto implica:

- En la pantalla de **Captura**, el preview de la cámara (horizontal) debe mostrar una **guía de crop vertical superpuesta** (overlay), indicando el área exacta que se va a recortar e imprimir.
- En **Vista previa**, mostrar la imagen ya recortada en su proporción vertical final (no el frame crudo horizontal de la cámara).
- Los **marcos generativos** deben diseñarse directamente en proporción vertical (no recortarse después de aplicados).

## Identidad de marca (para aplicar en la UI)

**Colores:**
| Color | Hex | Uso |
|---|---|---|
| Vinotinto profundo | `#3D0A05` | Texto "Frame", elementos de mayor jerarquía |
| Rojo FrameIt | `#A30F0A` | Texto "it", corchetes de encuadre, color principal |
| Rosa pastel | `#F5DCDC` | Fondos institucionales |
| Blanco | `#FFFFFF` | Fondos alternativos |

**Tipografías:**
- **Momo Trust Display** → uso exclusivo del isologo (nunca para texto de UI)
- **Alumni Sans Pinstripe** → toda la tipografía de interfaz y contenido (pesos: Regular, Semibold, Bold)

**Isologo**: unidad indivisible (ícono de corchetes de encuadre + texto "Frame it"), con el punto de la "i" integrado al corchete. No separar, rotar, ni recolorear fuera de la normativa.

## Flujo de pantallas (8 pantallas)

1. **Bienvenida** — loop de marca, "Tocá para comenzar" (idle, vuelve acá por timeout)
2. **Selección de modo** — Foto individual / Foto tira (strip)
3. **Selección de marco** — marcos generativos, carrusel de thumbnails, formato vertical
4. **Captura** — cuenta regresiva (3...2...1...), preview horizontal + guía de crop vertical overlay. *(Nota: necesita título propio, no heredar "¡Elegí tu marco!" de la pantalla anterior)*
5. **Vista previa** — imagen ya recortada (vertical), opciones "Volver a intentar" / "Sí, me gustó" — loop de reintento vuelve a Captura
6. **Selección de fondo** — color/patrón de fondo para el print final
7. **Entrega** — impresión física + QR que lleva a la galería web pública (no directo a Instagram, para preservar tracking de analytics). Copy: "¡Tu foto está lista!" / "Escaneá el código para descargarla y compartirla" / CTA de Instagram con @frameit
8. **Agradecimiento** — mensaje de cierre, vuelve automáticamente a Bienvenida en 2 minutos

**Timeout general**: 60 segundos de inactividad en pantallas intermedias (2-6) vuelve a Bienvenida. La pantalla de Entrega/Agradecimiento usa 2 minutos (el usuario puede estar escaneando el QR).

## Diferenciadores de producto a tener en cuenta en la UI

- Marcos generativos (varían según evento/temática)
- Modo photo strip además de foto individual
- Galería pública vía QR (no Instagram directo) — preserva datos para dashboard de analytics del tier Corporate
- 3 tiers de servicio: Standard / Premium / Corporate

## Restricciones de marca a respetar en el código

- Nunca usar Momo Trust Display fuera del isologo
- Nunca separar el isologo en ícono + texto sueltos
- Mantener siempre el corner-bracket motif como elemento decorativo consistente (ya aparece en las pantallas: marco de foto, contador, etc.)
- Paleta de color restringida a la definida arriba — no introducir colores nuevos sin actualizar la normativa cromática del brandbook
