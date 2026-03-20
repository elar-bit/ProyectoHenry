#!/usr/bin/env python3
"""
Extracción de movimientos BCP / estado de cuenta usando pdfplumber.

- Encuentra posiciones X de encabezados CARGOS/DEBE y ABONOS/HABER.
- Delimita columnas de montos por la frontera media entre ambos centros.
- Nueva transacción cuando hay fecha a la izquierda (DDMMM o DD + mes).
- Intenta primero tablas explícitas; si no hay líneas útiles, usa palabras con coordenadas.

Salida: JSON en stdout { "transactions": [...] }
Entrada: PDF binario por stdin.
"""
from __future__ import annotations

import io
import json
import re
import sys
from typing import Any

try:
    import pdfplumber
except ImportError:
    print(json.dumps({"transactions": [], "error": "pdfplumber_no_instalado"}))
    sys.exit(0)

MONTHS = {
    "ENE",
    "JAN",
    "FEB",
    "MAR",
    "ABR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AGO",
    "AUG",
    "SEP",
    "OCT",
    "SET",
    "NOV",
    "DIC",
    "DEC",
}


def word_center(w: dict[str, Any]) -> float:
    return (float(w["x0"]) + float(w["x1"])) / 2.0


def is_header_token(t: str) -> bool:
    u = t.upper()
    return any(
        k in u
        for k in (
            "FECHA",
            "PROC",
            "VALOR",
            "DESCRIPCION",
            "DESCRIPCIÓN",
            "CARGOS",
            "ABONOS",
            "DEBE",
            "HABER",
            "SALDO",
            "MOVIMIENTOS",
        )
    )


def is_amount_text(s: str) -> bool:
    t = s.strip()
    if "." not in t and "," not in t:
        return False
    t2 = re.sub(r"^[S$€£s/]+\s*", "", t, flags=re.I)
    t2 = t2.replace(" ", "").rstrip("-")
    if re.match(r"^-?[\d,]+\.\d{2}-?$", t2):
        return True
    if re.match(r"^-?[\d.]+,\d{2}-?$", t2):
        return True
    if re.match(r"^-?\d[\d,]*\.\d+-?$", t2):
        return True
    return False


def normalize_amount(s: str) -> str:
    t = s.strip().rstrip("-")
    t = re.sub(r"^[S$€£s/]+\s*", "", t, flags=re.I)
    return t.strip()


def parse_combined_fecha(text: str) -> str | None:
    m = re.match(r"^(\d{1,2})([A-Za-z]{3})$", text.strip())
    if not m:
        return None
    mo = m.group(2).upper()
    if mo not in MONTHS:
        return None
    return f"{int(m.group(1)):02d}{mo}"


def extract_fechas_from_words(sorted_words: list[dict[str, Any]], cutoff_x: float):
    fechas: list[str] = []
    i = 0
    while i < len(sorted_words):
        w = sorted_words[i]
        if float(w["x0"]) > cutoff_x:
            break
        t = w["text"].strip()
        cf = parse_combined_fecha(t)
        if cf:
            fechas.append(cf)
            i += 1
            continue
        if re.match(r"^\d{1,2}$", t) and i + 1 < len(sorted_words):
            nxt = sorted_words[i + 1]
            if float(nxt["x0"]) > cutoff_x:
                i += 1
                continue
            mo = nxt["text"].strip().upper()
            if mo in MONTHS:
                fechas.append(f"{int(t):02d}{mo}")
                i += 2
                continue
        i += 1
    return fechas


def detect_amount_columns(words: list[dict[str, Any]]):
    """Retorna (center_debe, center_haber, boundary) o (None, None, None)."""
    debe_xs: list[float] = []
    haber_xs: list[float] = []
    for w in words:
        t = w["text"].strip().upper()
        xc = word_center(w)
        if re.search(r"\b(DEBE|CARGOS)\b", t) or t in ("DEBE", "CARGOS"):
            debe_xs.append(xc)
        if re.search(r"\b(HABER|ABONOS)\b", t) or t in ("HABER", "ABONOS"):
            haber_xs.append(xc)
    if not debe_xs or not haber_xs:
        return None, None, None
    c_debe = sum(debe_xs) / len(debe_xs)
    c_haber = sum(haber_xs) / len(haber_xs)
    lo, hi = (c_debe, c_haber) if c_debe < c_haber else (c_haber, c_debe)
    boundary = (lo + hi) / 2.0
    return lo, hi, boundary


def group_words_into_lines(words: list[dict[str, Any]], tol: float = 3.0):
    buckets: dict[float, list[dict[str, Any]]] = {}
    for w in words:
        top = float(w["top"])
        key = None
        for k in buckets:
            if abs(k - top) <= tol:
                key = k
                break
        if key is None:
            key = top
            buckets[key] = []
        buckets[key].append(w)
    lines = []
    for top in sorted(buckets.keys()):
        line_words = sorted(buckets[top], key=lambda x: float(x["x0"]))
        lines.append((top, line_words))
    return lines


def amount_zone_assignment(xc: float, boundary: float, lo: float, hi: float) -> str:
    """'debit' = Cargo (columna más cercana a lo), 'credit' = Abono (más cercana a hi)."""
    if xc < boundary:
        return "debit"
    return "credit"


def line_amount_tokens(line_words: list[dict[str, Any]], fecha_cutoff: float):
    cands = []
    for w in line_words:
        if float(w["x0"]) < fecha_cutoff + 40:
            continue
        if not is_amount_text(w["text"]):
            continue
        cands.append(w)
    return sorted(cands, key=lambda w: float(w["x1"]), reverse=True)


def parse_page_lines(page, lo: float, hi: float, boundary: float):
    words = page.extract_words(
        use_text_flow=False,
        keep_blank_chars=False,
        extra_attrs=["size"],
    )
    h = float(page.height)
    # Ignorar zona inferior (leyendas "Mensaje al cliente", etc.)
    words = [w for w in words if float(w["top"]) < h * 0.92]

    fecha_cutoff = max(0.0, lo - 120.0)

    lines = group_words_into_lines(words, tol=3.5)
    transactions: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    for _top, line_words in lines:
        if not line_words:
            continue
        line_text_upper = " ".join(w["text"].upper() for w in line_words)
        if "FECHA" in line_text_upper and "VALOR" in line_text_upper:
            continue

        sorted_x = sorted(line_words, key=lambda w: float(w["x0"]))
        fechas = extract_fechas_from_words(sorted_x, cutoff_x=fecha_cutoff)

        desc_parts: list[str] = []
        for w in sorted_x:
            xc = word_center(w)
            t = w["text"].strip()
            if float(w["x0"]) <= fecha_cutoff + 0.5 and (
                parse_combined_fecha(t)
                or t.upper() in MONTHS
                or re.match(r"^\d{1,2}$", t)
            ):
                continue
            if is_amount_text(t):
                continue
            if xc >= lo - 8:
                # En zona de montos no mezclar texto suelto
                continue
            if is_header_token(t) and len(t) <= 18:
                continue
            desc_parts.append(t)

        description = re.sub(r"\s+", " ", " ".join(desc_parts)).strip()

        amounts = line_amount_tokens(sorted_x, fecha_cutoff)
        debit_val = "0"
        credit_val = "0"
        if amounts:
            pick = amounts[0]
            amt = normalize_amount(pick["text"])
            xc = word_center(pick)
            side = amount_zone_assignment(xc, boundary, lo, hi)
            if side == "debit":
                debit_val = amt
            else:
                credit_val = amt

        if fechas:
            if current:
                transactions.append(current)
            current = {
                "fechaProc": fechas[0],
                "fechaValor": fechas[1] if len(fechas) > 1 else fechas[0],
                "description": description,
                "debit": debit_val,
                "credit": credit_val,
                "raw": "",
            }
        elif current is not None:
            if description:
                prev = current.get("description") or ""
                current["description"] = (prev + " " + description).strip()
            if amounts:
                if current.get("debit") == "0" and current.get("credit") == "0":
                    pick = amounts[0]
                    amt = normalize_amount(pick["text"])
                    xc = word_center(pick)
                    side = amount_zone_assignment(xc, boundary, lo, hi)
                    if side == "debit":
                        current["debit"] = amt
                    else:
                        current["credit"] = amt
                else:
                    # Segunda línea con monto: solo si aún no hay en esa columna
                    pick = amounts[0]
                    amt = normalize_amount(pick["text"])
                    xc = word_center(pick)
                    side = amount_zone_assignment(xc, boundary, lo, hi)
                    if side == "debit" and current.get("debit") == "0":
                        current["debit"] = amt
                    elif side == "credit" and current.get("credit") == "0":
                        current["credit"] = amt

    if current:
        transactions.append(current)

    out = []
    for tx in transactions:
        if not tx.get("description"):
            continue
        if tx.get("debit") == "0" and tx.get("credit") == "0":
            continue
        du = tx["description"].upper()
        if "MENSAJE AL CLIENTE" in du:
            continue
        out.append(tx)
    return out


def try_tables_first(page) -> list[dict[str, Any]]:
    """
    Usa pdfplumber.find_tables() + extract(): filas de 5 columnas alineadas al PDF.
    Columnas: Fecha Proc., Fecha Valor, Descripción, Cargos/Debe, Abonos/Haber.
    """
    found: list[dict[str, Any]] = []
    try:
        for table in page.find_tables() or []:
            for row in table.extract() or []:
                cells = [re.sub(r"\s+", " ", str(c or "").strip()) for c in row]
                while cells and not cells[-1]:
                    cells.pop()
                if len(cells) < 5:
                    continue
                fp, fv, desc = cells[0], cells[1], cells[2]
                joined = " ".join(cells).upper()
                # Solo descartar filas de encabezado del grilla (no usar DEBE/HABER
                # sueltos: pueden aparecer dentro de la descripción).
                if "FECHA" in joined and ("PROC" in joined or "VALOR" in joined):
                    continue
                if fp.upper().startswith("FECHA") and "VALOR" in joined:
                    continue
                debe_s, haber_s = cells[3], cells[4]
                line = " | ".join(cells)

                probe = [
                    {"x0": 0.0, "x1": 80.0, "text": fp},
                    {"x0": 90.0, "x1": 170.0, "text": fv},
                ]
                fechas = extract_fechas_from_words(
                    sorted(probe, key=lambda w: float(w["x0"])), cutoff_x=1000.0
                )
                if not fechas:
                    continue

                debit_val, credit_val = "0", "0"
                if is_amount_text(debe_s):
                    debit_val = normalize_amount(debe_s)
                if is_amount_text(haber_s):
                    credit_val = normalize_amount(haber_s)

                if debit_val == "0" and credit_val == "0":
                    continue

                found.append(
                    {
                        "fechaProc": fechas[0],
                        "fechaValor": fechas[1] if len(fechas) > 1 else fechas[0],
                        "description": desc.strip() or line,
                        "debit": debit_val,
                        "credit": credit_val,
                        "raw": line,
                    }
                )
    except Exception:
        return []

    return found


def extract_pdf(buffer: bytes) -> list[dict[str, Any]]:
    out_all: list[dict[str, Any]] = []
    last_geom: tuple[float, float, float] | None = None
    with pdfplumber.open(io.BytesIO(buffer)) as pdf:
        for page in pdf.pages:
            words = page.extract_words()
            lo, hi, boundary = detect_amount_columns(words)
            if lo is None:
                if last_geom is None:
                    continue
                lo, hi, boundary = last_geom
            else:
                last_geom = (lo, hi, boundary)

            table_rows = try_tables_first(page)
            if len(table_rows) >= 3:
                page_tx = table_rows
            else:
                page_tx = parse_page_lines(page, lo, hi, boundary)

            out_all.extend(page_tx)

    # Dedup exactas consecutivas
    deduped: list[dict[str, Any]] = []
    for tx in out_all:
        if deduped and deduped[-1] == tx:
            continue
        deduped.append(tx)
    return deduped


def main():
    data = sys.stdin.buffer.read()
    if not data:
        print(json.dumps({"transactions": [], "error": "sin_datos"}))
        return
    try:
        txs = extract_pdf(data)
        print(json.dumps({"transactions": txs}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"transactions": [], "error": str(e)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
