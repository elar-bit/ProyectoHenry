# PDF a Excel | Henry Gomez

## Extracción con pdfplumber (recomendado en local)

La ruta `/api/parse-pdf` intenta primero **`pdfplumber` en Python** (tablas + palabras con coordenadas y frontera DEBE/HABER). En entornos sin Python (p. ej. algunos despliegues serverless) se usa el extractor con **pdfjs-dist** en TypeScript.

```bash
# macOS / Linux (recomendado; evita "command not found: pip")
python3 -m pip install -r requirements.txt
```

Si `python3` no existe, instálalo (por ejemplo: [python.org](https://www.python.org/downloads/) o `brew install python`).

Asegúrate de tener `python3` en el `PATH`. Si no instalas `pdfplumber`, la app seguirá funcionando con el fallback en TypeScript (pdfjs).

## Desarrollo

```bash
npm install
npm run dev
```
