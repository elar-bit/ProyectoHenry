// Convert LATAM number format (1.234,56) to decimal (1234.56)
function parseLatamNumber(value: string): number {
  if (!value || typeof value !== 'string') return 0;

  value = value.trim();

  // Common OCR/statement placeholders
  if (
    value === '-' ||
    value === '—' ||
    value === '–' ||
    /^n\/a$/i.test(value) ||
    /^na$/i.test(value)
  ) {
    return 0;
  }

  // Accounting negatives: (1.234,56)
  const isNegativeAccounting = value.startsWith('(') && value.endsWith(')');
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
  return isNegativeAccounting ? -num : num;
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

  return balances;
}

export interface ParsedTransaction {
  date: string;
  description: string;
  debit: string;
  credit: string;
  balance: string;
  raw?: string;
}

// Parse transaction rows from PDF text
export function parseTransactions(text: string): ParsedTransaction[] {
  const transactions: ParsedTransaction[] = [];

  if (!text || text.trim().length === 0) {
    throw new Error('El PDF parece estar vacio o no legible');
  }

  // Split by lines
  const lines = text.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // Transaction line pattern: DATE DESCRIPTION DEBIT CREDIT BALANCE
    // Date format: DD/MM/YYYY, DD-MM-YYYY or DD.MM.YYYY
    const normalizedLine = line
      // Common currency tokens that may appear glued to numbers
      .replace(/S\//gi, '')
      .replace(/[$€£]/g, '')
      .replace(/\b(USD|PEN|MXN|DOLARES|SOLES)\b/gi, '');

    const transactionMatch = normalizedLine.match(
      /^(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4})\s+(.+?)\s+([\d.,\s\-\(\)]+)\s+([\d.,\s\-\(\)]+)\s+([\d.,\s\-\(\)]+)\s*$/
    );

    if (transactionMatch) {
      const [, date, desc, debit, credit, balance] = transactionMatch;

      // Validate date format
      if (!isValidDate(date)) {
        i++;
        continue;
      }

      // Validate numeric fields
      const debitNum = parseLatamNumber(debit);
      const creditNum = parseLatamNumber(credit);
      const balanceNum = parseLatamNumber(balance);

      if (isNaN(debitNum) || isNaN(creditNum) || isNaN(balanceNum)) {
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
          !nextLine.match(/^[\d.,\s\-\(\)]+$/) // Skip lines that are just numbers
        ) {
          fullDescription += ' ' + nextLine;
        }
        j++;
      }

      transactions.push({
        date,
        description: cleanDescription(fullDescription),
        debit: debit.trim(),
        credit: credit.trim(),
        balance: balance.trim(),
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

  // Clean and convert transaction data
  const cleanedTransactions = transactions.map((tx) => ({
    date: tx.date,
    description: tx.description,
    debit: parseLatamNumber(tx.debit),
    credit: parseLatamNumber(tx.credit),
    balance: parseLatamNumber(tx.balance),
  }));

  // Validate transaction consistency
  validateTransactionConsistency(cleanedTransactions);

  // Calculate totals for validation
  let totalDebits = 0;
  let totalCredits = 0;
  let calculatedBalance =
    cleanedTransactions.length > 0 ? cleanedTransactions[0].balance : 0;

  for (const tx of cleanedTransactions) {
    if (tx.debit > 0) totalDebits += tx.debit;
    if (tx.credit > 0) totalCredits += tx.credit;
  }

  // Set calculated final balance
  if (cleanedTransactions.length > 0) {
    calculatedBalance = cleanedTransactions[cleanedTransactions.length - 1].balance;
  }

  const reportBalance = balances.final || calculatedBalance;

  // Check for balance mismatch
  const balanceMatch =
    Math.abs(reportBalance - calculatedBalance) < 0.01; // Allow for rounding

  return {
    transactions: cleanedTransactions,
    accountInfo: {
      accountNumber,
      reportBalance,
      calculatedBalance,
      totalDebits,
      totalCredits,
      balanceValid: balanceMatch,
    },
  };
}

// Validate transaction consistency
function validateTransactionConsistency(
  transactions: Array<{
    date: string;
    debit: number;
    credit: number;
    balance: number;
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
