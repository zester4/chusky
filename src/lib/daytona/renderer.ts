import { Image } from "@daytona/sdk";

// Build dependencies before starting the renderer: no runtime sudo or apt locks.
export function artifactRendererImage(): Image {
  return Image.base("python:3.12-slim-bookworm").dockerfileCommands([
    "RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libreoffice-writer libreoffice-calc libreoffice-impress poppler-utils fonts-dejavu-core fonts-liberation fonts-noto-core && rm -rf /var/lib/apt/lists/*",
    "RUN python3 --version && pdfinfo -v && pdftoppm -v && libreoffice --version",
  ]);
}
