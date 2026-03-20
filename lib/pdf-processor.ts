// Convert LATAM number format (1.234,56) to decimal (1234.56)
function parseLatamNumber(value: string): number {
  if (!value || typeof value !== 'string') return 0;

  // Remove spaces
  value = value.trim();

  // If it has comma, it's decimal separator in LATAM format
  if (value.includes(',')) {
    // Replace thousands separator (.) with nothing
    value = value.replace(/\./g, '');
    // Replace decimal separator (,) with .
    value = value.replace(',', '.');
  } else if (value.includes('.')) {
    // If only dots, could be thousands separator
    // Keep as is if it looks like 1.234 (thousands)
  }

  return parseFloat(value) || 0;
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
    throw new Error('PDF appears to be empty or unreadable');
  }

  // Split by lines
  const lines = text.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // Transaction line pattern: DATE DESCRIPTION DEBIT CREDIT BALANCE
    // Date format: DD/MM/YYYY or DD-MM-YYYY
    const transactionMatch = line.match(
      /^(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})\s+(.+?)\s+([\d.,\s]+)\s+([\d.,\s]+)\s+([\d.,\s]+)\s*$/
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
        !lines[j].trim().match(/^\d{1,2}[\/\-]/)
      ) {
        const nextLine = lines[j].trim();
        if (
          nextLine &&
          !nextLine.match(/^[\d.,\s]+$/) // Skip lines that are just numbers
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
      'No transactions found in PDF. Please ensure it is a valid BCP format statement.'
    );
  }

  return transactions;
}

// Validate date format
function isValidDate(dateStr: string): boolean {
  const dateMatch = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
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
    throw new Error('No transactions found');
  }

  // Check that debit and credit are not both populated
  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    if (tx.debit > 0.01 && tx.credit > 0.01) {
      console.warn(
        `Transaction ${i + 1}: Both debit and credit are populated. This may indicate a parsing error.`
      );
    }
  }

  // Check for negative values (should not occur in bank statements)
  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    if (tx.debit < 0 || tx.credit < 0) {
      console.warn(
        `Transaction ${i + 1}: Negative debit or credit detected. This may indicate a parsing error.`
      );
    }
  }
}
