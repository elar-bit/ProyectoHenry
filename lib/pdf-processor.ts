// Convert LATAM number format (1.234,56) to decimal (1234.56)
function parseLatamNumber(value: string): number {
  if (!value || typeof value !== 'string') return 0;

  value = value.trim();

  // Common OCR/statement placeholders
  if (
    value === '-' ||
    value === '\u2014' || // em dash
    value === '\u2013' || // en dash
    /^n\/a$/i.test(value) ||
    /^na$/i.test(value)
  ) {
    return 0;
  }

  // Negative numbers can appear as:
  // - accounting: (1.234,56)
  // - trailing minus: 3.50-
  // - leading minus: -3.50
  let isNegative = false;
  if (value.startsWith('-')) {
    isNegative = true;
    value = value.slice(1);
  }
  if (value.endsWith('-')) {
    isNegative = true;
    value = value.slice(0, -1);
  }

  // Accounting negatives: (1.234,56)
  const isNegativeAccounting = value.startsWith('(') && value.endsWith(')');
  if (isNegativeAccounting) isNegative = true;
  value = value.replace(/[()]/g, '');

  // Remove currency symbols/letters, keep digits and separators
  value = value.replace(/S\//gi, '');
  value = value.replace(/[$€£]/g, '');
  value = value.replace(/[^\d.,\-\s]/g, '');

  // Remove spaces
  value = value.replace(/\s+/g, '');

  const lastComma = value.lastIndexOf(',');
  const lastDot = value.lastIndexOf('.');

  // Both ',' and '.' exist -> decide decimal separator by the last one
  if (lastComma !== -1 && lastDot !== -1) {
    if (lastComma > lastDot) {
      // LATAM: 1.234,56
      value = value.replace(/\./g, '').replace(',', '.');
    } else {
      // US-ish: 1,234.56
      value = value.replace(/,/g, '');
    }
  } else if (lastComma !== -1) {
    // Only ',' exists -> maybe decimal or thousands
    const decimals = value.length - lastComma - 1;
    if (decimals === 3) {
      // 1,234 (thousands)
      value = value.replace(/,/g, '');
    } else {
      // 1.234,56 (decimal comma) or 123,45
      value = value.replace(/\./g, '').replace(',', '.');
    }
  } else if (lastDot !== -1) {
    // Only '.' exists -> maybe decimal or thousands
    const decimals = value.length - lastDot - 1;
    if (decimals === 3) {
      // 1.234 (thousands)
      value = value.replace(/\./g, '');
    }
    // else keep as-is (decimal dot)
  }

  const num = parseFloat(value);
  if (Number.isNaN(num)) return 0;
  return isNegative ? -num : num;
}

// Remove OCR noise and common header patterns
function cleanDescription(desc: string): string {
  if (!desc) return '';

  // Remove page numbers and headers
  desc = desc.replace(/^page\s+\d+/i, '').trim();

  // Remove ITF references
  desc = desc.replace(/ITF[:\s]+\d+/i, '').trim();

  // Remove repeated spaces
  desc = desc.replace(/\s+/g, ' ').trim();

  // Remove common OCR artifacts
  desc = desc.replace(/[|¡!]\s*$/g, '').trim();

  return desc;
}

// Extract account number from text
function extractAccountNumber(text: string): string | undefined {
  const accountMatch = text.match(
    /(?:account|cuenta|cuenta\s+no|a\/c)[\s:]*(\d{10,20})/i
  );
  return accountMatch ? accountMatch[1] : undefined;
}

// Extract initial and final balances
function extractBalances(
  text: string
): { initial?: number; final?: number } {
  const balances = { initial: undefined, final: undefined };

  // Look for opening/initial balance
  const initialMatch = text.match(
    /(?:opening|initial|anterior|saldo\s+inicial)[\s:]*([0-9.,\s]+)/i
  );
  if (initialMatch) {
    balances.initial = parseLatamNumber(initialMatch[1]);
  }

  // Look for closing/final balance
  const finalMatch = text.match(
    /(?:closing|final|final balance|saldo\s+final)[\s:]*([0-9.,\s]+)/i
  );
  if (finalMatch) {
    balances.final = parseLatamNumber(finalMatch[1]);
  }

  // BCP (Viabcp) sometimes prints only "SALDO" header + values at the end.
  // In that case, the statement includes three numbers near the last "SALDO":
  //   total debits, total credits, final balance
  if (balances.final === undefined) {
    const lower = text.toLowerCase();
    const lastSaldoIndex = lower.lastIndexOf('saldo');
    if (lastSaldoIndex !== -1) {
      const after = text.slice(lastSaldoIndex);
      const tokens = after.match(/\d[\d.,]*/g) || [];
      // Heuristic: keep currency-like tokens (usually have ',' thousands or '.' decimals).
      const currencyTokens = tokens.filter((t) => t.includes(',') || t.includes('.'));
      if (currencyTokens.length > 0) {
        const lastToken = currencyTokens[currencyTokens.length - 1];
        balances.final = parseLatamNumber(lastToken);
      }
    }
  }

  return balances;
}

export interface ParsedTransaction {
  fechaProc: string;
  fechaValor: string;
  description: string;
  debit: string;
  credit: string;
  raw?: string;
}

function detectTextAmountBoundary(lines: string[]): number | null {
  const debeCenters: number[] = [];
  const haberCenters: number[] = [];

  for (const line of lines) {
    const upper = line.toUpperCase();
    const idxCargos = upper.indexOf('CARGOS');
    const idxDebe = upper.indexOf('DEBE');
    const idxAbonos = upper.indexOf('ABONOS');
    const idxHaber = upper.indexOf('HABER');

    if (idxCargos >= 0) debeCenters.push(idxCargos + 'CARGOS'.length / 2);
    if (idxDebe >= 0) debeCenters.push(idxDebe + 'DEBE'.length / 2);
    if (idxAbonos >= 0) haberCenters.push(idxAbonos + 'ABONOS'.length / 2);
    if (idxHaber >= 0) haberCenters.push(idxHaber + 'HABER'.length / 2);
  }

  if (debeCenters.length === 0 || haberCenters.length === 0) return null;
  const avgDebe = debeCenters.reduce((a, b) => a + b, 0) / debeCenters.length;
  const avgHaber =
    haberCenters.reduce((a, b) => a + b, 0) / haberCenters.length;
  const lo = Math.min(avgDebe, avgHaber);
  const hi = Math.max(avgDebe, avgHaber);
  return (lo + hi) / 2;
}

// Parse transaction rows from PDF text
export function parseTransactions(text: string): ParsedTransaction[] {
  const transactions: ParsedTransaction[] = [];

  if (!text || text.trim().length === 0) {
    throw new Error('El PDF parece estar vacio o no legible');
  }

  // Split by lines
  const lines = text.split('\n');
  const textAmountBoundary = detectTextAmountBoundary(lines);

  // Strategy 1: BCP statement format as seen in your PDF:
  //   02FEB 02FEB <DESCRIPCION> [*] <MONTO>
  const monthMap: Record<string, string> = {
    JAN: '01',
    ENE: '01',
    FEB: '02',
    MAR: '03',
    ABR: '04',
    APR: '04',
    MAY: '05',
    JUN: '06',
    JUL: '07',
    AGO: '08',
    AUG: '08',
    SET: '09',
    SEP: '09',
    OCT: '10',
    NOV: '11',
    DIC: '12',
    DEC: '12',
  };

  const rangeYearMatch = text.match(/DEL\s+\d{2}\/\d{2}\/(\d{2})\s+AL\s+\d{2}\/\d{2}\/\d{2}/i);
  const inferredYear = rangeYearMatch ? 2000 + parseInt(rangeYearMatch[1], 10) : undefined;

  for (const originalLine of lines) {
    const line = originalLine.trim();
    if (!line) continue;

    // Example: "02FEB 02FEB Pago YAPE de 19107 50.50"
    const dateMatch = line.match(/^(\d{1,2})([A-Z]{3})\s+(\d{1,2})([A-Z]{3})\s+(.+)$/);
    if (!dateMatch) continue;

    const dayProcStr = dateMatch[1];
    const monthProcStr = dateMatch[2];
    const dayValorStr = dateMatch[3];
    const monthValorStr = dateMatch[4];
    const rest = dateMatch[5];

    // Use the tokens as they appear in the statement (e.g. "02FEB") for the Excel columns.
    const fechaProc = `${String(dayProcStr).padStart(2, '0')}${monthProcStr}`;
    const fechaValor = `${String(dayValorStr).padStart(2, '0')}${monthValorStr}`;

    // Keep the old month validation as a safety filter.
    if (!monthMap[monthProcStr] || !monthMap[monthValorStr]) continue;

    // Extract the last "amount" from the end of the line. OCR sometimes has a '*' before it.
    // Example: "ABON PLIN-... S * 40.00" or "IMPUESTO ITF * 0.05"
    // Take the last numeric token in the row (so we don't grab numbers inside the description).
    const numericRegex = /(?:\(?-?\d[\d,\.]*\d\)?|\.\d+|-?\.\d+)(?:-)?/g;
    const matches = Array.from(rest.matchAll(numericRegex));
    if (matches.length === 0) continue;
    const last = matches[matches.length - 1];
    const amountToken = last[0].trim();
    const descPart = rest.slice(0, last.index ?? rest.length).trim();
    const amount = parseLatamNumber(amountToken);

    // If we cannot parse a number, skip.
    if (Number.isNaN(amount)) continue;

    const descUpper = descPart.toUpperCase();

    const hasHK = descUpper.includes('.HK') || /\bHK\b/.test(descUpper);
    const hasBM = descUpper.includes('.BM') || /\bBM\b/.test(descUpper) || descUpper.includes('CMB');
    const hasCRZ = descUpper.includes('CRZ');

    const looksCredit =
      /\bABON\b/.test(descUpper) ||
      /\bABONO\b/.test(descUpper) ||
      /\bDEPOSITO\b/.test(descUpper) ||
      /\bDEP\.?EN\b/.test(descUpper) ||
      /\bDEP\.?\b/.test(descUpper) ||
      /INTERES/.test(descUpper) ||
      hasBM ||
      hasCRZ ||
      // In these BCP statements, "Pago YAPE" is typically shown under ABONOS/HABER.
      /\bPAGO\s+YAPE\b/.test(descUpper) ||
      /\bPAGO\b/.test(descUpper);

    const looksDebit =
      /\bRET\./.test(descUpper) ||
      /\bIMPUESTO\b/.test(descUpper) ||
      /\bITF\b/.test(descUpper) ||
      /\bTRANSF\b/.test(descUpper) ||
      /\bTRANSFER\b/.test(descUpper) ||
      /MANT/i.test(descUpper) ||
      /\bOPE\.?VENTANILLA\b/.test(descUpper) ||
      hasHK;

    let debitStr = '';
    let creditStr = '';

    const amountStart = line.lastIndexOf(amountToken);
    if (textAmountBoundary !== null && amountStart >= 0) {
      if (amountStart >= textAmountBoundary) {
        creditStr = amountToken;
      } else {
        debitStr = amountToken;
      }
    } else if (looksCredit && !looksDebit) {
      creditStr = amountToken;
    } else if (looksDebit && !looksCredit) {
      debitStr = amountToken;
    } else {
      // If both heuristics trigger (rare), use HK/BM hints.
      if (hasHK && !hasBM) {
        debitStr = amountToken;
      } else if (hasBM && !hasHK) {
        creditStr = amountToken;
      } else {
        // Default: abono (credit) to match the statement majority.
        creditStr = amountToken;
      }
    }

    transactions.push({
      description: cleanDescription(descPart),
      fechaProc,
      fechaValor,
      debit: debitStr,
      credit: creditStr,
      raw: line,
    });
  }

  // If we successfully parsed BCP transactions, return them.
  if (transactions.length > 0) {
    return transactions;
  }

  // Strategy 1.5: Another BCP layout where dates look like "02-01" (DD-MM)
  // and the amount appears at the end of each row.
  // Example:
  //   02-01 Pago YAPE de 19110 ... 23.00
  //   02-01 IMPUESTO ITF ... .85-
  {
    const yearMatch = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    const inferredYear = yearMatch ? parseInt(yearMatch[3], 10) : undefined;

    if (inferredYear !== undefined) {
      const dmRegex = /^(\d{1,2})-(\d{1,2})\s+(.+)$/;

      for (const originalLine of lines) {
        const line = originalLine.trim();
        if (!line) continue;

        const dmMatch = line.match(dmRegex);
        if (!dmMatch) continue;

        const dayNum = parseInt(dmMatch[1], 10);
        const monthNum = parseInt(dmMatch[2], 10);
        const rest = dmMatch[3];

        if (Number.isNaN(dayNum) || Number.isNaN(monthNum)) continue;
        if (monthNum < 1 || monthNum > 12) continue;

        const fecha = `${String(dayNum).padStart(2, '0')}-${String(
          monthNum
        ).padStart(2, '0')}`;

        // Amount = last numeric token in the line (can be "3.50-" for negative)
        // Amount can appear as "23.00" or ".85-" depending on OCR.
        const amountMatch = rest.match(
          /((?:\d[\d.,]*\d|\.\d+)(?:-)?)(?:\s*)$/
        );
        if (!amountMatch) continue;

        const amountTokenRaw = amountMatch[1].trim();
        const amountTokenClean = amountTokenRaw.replace(/-$/, '');
        const amountValue = parseLatamNumber(amountTokenRaw);
        if (Number.isNaN(amountValue)) continue;

        const descPart = rest.slice(0, rest.length - amountTokenRaw.length).trim();
        const descUpper = descPart.toUpperCase();

        const looksCredit =
          /\bABON\b/.test(descUpper) ||
          /\bABONO\b/.test(descUpper) ||
          /\bDEPOSITO\b/.test(descUpper) ||
          /\bDEP\.?EN\b/.test(descUpper) ||
          /\bINTERES/.test(descUpper) ||
          /\bGANADO\b/.test(descUpper) ||
          /\bPAGO\s+YAPE\b/.test(descUpper) ||
          /\bPAGO\b/.test(descUpper);

        const looksDebit =
          /\bRET\./.test(descUpper) ||
          /\bIMPUESTO\b/.test(descUpper) ||
          /\bITF\b/.test(descUpper) ||
          /\bTRANSF\b/.test(descUpper) ||
          /\bTRANSFER\b/.test(descUpper) ||
          /\bOPE\.?VENTANILLA\b/.test(descUpper) ||
          /\bMANT\b/.test(descUpper);

        const isTrailingNegative = amountTokenRaw.endsWith('-');

        let debitStr = '';
        let creditStr = '';

        // If the PDF encodes negatives via "X.XX-", treat them as debits.
        const amountStart = line.lastIndexOf(amountTokenRaw);
        if (isTrailingNegative) {
          debitStr = amountTokenClean;
        } else if (textAmountBoundary !== null && amountStart >= 0) {
          if (amountStart >= textAmountBoundary) {
            creditStr = amountTokenClean;
          } else {
            debitStr = amountTokenClean;
          }
        } else if (looksCredit && !looksDebit) {
          creditStr = amountTokenClean;
        } else if (looksDebit && !looksCredit) {
          debitStr = amountTokenClean;
        } else {
          // Default: abono (credit) for ambiguous cases
          creditStr = amountTokenClean;
        }

        transactions.push({
          fechaProc: fecha,
          fechaValor: fecha,
          description: cleanDescription(descPart),
          debit: debitStr,
          credit: creditStr,
          raw: line,
        });
      }

      if (transactions.length > 0) {
        return transactions;
      }
    }
  }

  // Strategy 2: generic "DD/MM/YYYY <desc> <debit> <credit> <balance>" format
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // Transaction line pattern: DATE DESCRIPTION DEBIT CREDIT BALANCE
    // Date format: DD/MM/YYYY or DD-MM-YYYY
    const transactionMatch = line.match(
      /^(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4})\s+(.+?)\s+([\d.,\s\-\(\)]+)\s+([\d.,\s\-\(\)]+)\s+([\d.,\s\-\(\)]+)\s*$/
    );

    if (transactionMatch) {
      const [, date, desc, debit, credit] = transactionMatch;

      // Validate date format
      if (!isValidDate(date)) {
        i++;
        continue;
      }

      // Validate numeric fields
      const debitNum = parseLatamNumber(debit);
      const creditNum = parseLatamNumber(credit);

      if (isNaN(debitNum) || isNaN(creditNum)) {
        i++;
        continue;
      }

      // Consolidate multi-line descriptions
      let fullDescription = desc;
      let j = i + 1;
      while (
        j < lines.length &&
        !lines[j].trim().match(/^\d{1,2}[\/\-\.]/)
      ) {
        const nextLine = lines[j].trim();
        if (
          nextLine &&
          !nextLine.match(/^[\d.,\s\-\(\)]+$/)
        ) {
          fullDescription += ' ' + nextLine;
        }
        j++;
      }

      transactions.push({
        fechaProc: date,
        fechaValor: date,
        description: cleanDescription(fullDescription),
        debit: debit.trim(),
        credit: credit.trim(),
        raw: line,
      });

      i = j;
    } else {
      i++;
    }
  }

  if (transactions.length === 0) {
    throw new Error(
      'No se encontraron transacciones en el PDF. Asegurate de que sea un estado de cuenta en formato Estado de cuenta PDF.'
    );
  }

  return transactions;
}

// Validate date format
function isValidDate(dateStr: string): boolean {
  const dateMatch = dateStr.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (!dateMatch) return false;

  const [, dayStr, monthStr, yearStr] = dateMatch;
  const day = parseInt(dayStr);
  const month = parseInt(monthStr);
  const year = parseInt(yearStr);

  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (year < 1900 || year > 2100) return false;

  return true;
}

// Clean transaction data and validate
export function cleanAndValidateData(
  transactions: ParsedTransaction[],
  fullText: string
) {
  // Extract additional info from full text
  const accountNumber = extractAccountNumber(fullText);
  const balances = extractBalances(fullText);

  // Ensure the Excel starts with the same "SALDO ANTERIOR" line shown in the statement.
  // Per requirement: do not calculate anything; only extract and place values.
  const initialBalance = balances.initial;
  const finalBalance = balances.final;

  const cleanedTransactions = [
    {
      fechaProc: '',
      fechaValor: '',
      description: 'SALDO ANTERIOR',
      debit: 0,
      credit: typeof initialBalance === 'number' ? initialBalance : 0,
    },
    ...transactions.map((tx) => ({
      fechaProc: tx.fechaProc,
      fechaValor: tx.fechaValor,
      description: tx.description,
      debit: parseLatamNumber(tx.debit),
      credit: parseLatamNumber(tx.credit),
    })),
  ];

  // Validate transaction consistency (no calculations: only sanity checks)
  validateTransactionConsistency(cleanedTransactions);

  // Use extracted balances only (no running/calc)
  const reportBalance =
    typeof finalBalance === 'number' ? finalBalance : initialBalance;
  const calculatedBalance = reportBalance;
  const balanceValid = true;

  return {
    transactions: cleanedTransactions,
    accountInfo: {
      accountNumber,
      reportBalance,
      calculatedBalance,
      // Totals are not calculated; summary will be blank/unknown if not provided by the PDF.
      totalDebits: undefined,
      totalCredits: undefined,
      balanceValid,
    },
  };
}

// Validate transaction consistency
function validateTransactionConsistency(
  transactions: Array<{
    fechaProc: string;
    fechaValor: string;
    debit: number;
    credit: number;
  }>
): void {
  if (transactions.length === 0) {
    throw new Error('No se encontraron transacciones');
  }

  // Check that debit and credit are not both populated
  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    if (tx.debit > 0.01 && tx.credit > 0.01) {
      console.warn(
        `Transaccion ${i + 1}: Ambos (debito y credito) estan completos. Esto podria indicar un error de parseo.`
      );
    }
  }

  // Check for negative values (should not occur in bank statements)
  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    if (tx.debit < 0 || tx.credit < 0) {
      console.warn(
        `Transaccion ${i + 1}: Se detecto un debito o credito negativo. Esto podria indicar un error de parseo.`
      );
    }
  }
}
