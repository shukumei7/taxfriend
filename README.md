# TaxFriend

A local CRA tax filing assistant for Canada. Drop your tax documents into a folder, run one command, and get a structured report mapping your documents to T1 General lines, flagging missing slips, and advising on deductions and credits you may have missed.

Analysis is performed by Claude Code CLI (`claude -p`) running locally — no data is sent to a third-party web service beyond what your local `claude` installation handles.

---

## Prerequisites

- **Node.js 18+**
- **Claude Code CLI** — `claude` must be on your PATH and authenticated
- **Dependencies** — run `npm install` once after cloning

```bash
npm install
```

---

## Directory Structure

Place documents under `input/(year)/(person)/`. Person names become folder names — use lowercase with no spaces or use hyphens.

```
taxfriend/
  input/
    2024/
      alice/
        T4-employer.pdf
        T5-bank.pdf
        RRSP-receipt.pdf
      bob/
        T4-main-job.pdf
        T4-side-job.pdf
        T4E-ei.pdf
    2025/
      alice/
        T4-employer.pdf
  output/          <- generated, do not edit
  data/
    deduction-guide.json
    tax-lines.json
  src/
    scanner.js
    extractor.js
    analyzer.js
    reporter.js
  index.js
  package.json
```

Subdirectories within a person's folder are scanned recursively, so you can organize documents however you like.

---

## Supported Document Types

| Extension | How it is processed |
|-----------|---------------------|
| `.pdf` | Text extracted via `pdf-parse` |
| `.txt` | Read as-is |
| `.csv` | Read as-is |
| `.png`, `.jpg`, `.jpeg` | Flagged for manual review — text is not extracted from images |

### Recognized tax slip types

The analyzer identifies these document types:

`T4`, `T4A`, `T4E`, `T5`, `T5008`, `T3`, `T2202`, `RRSP`, `Donation`, `Medical`, `Tuition`, `PropertyTax`, `RentReceipt`, `ChildCare`, `HomeOffice`, `BusinessExpense`, `Other`, `Unknown`

---

## Usage

All three invocation modes produce the same report format. Progress messages go to stderr; the final report markdown goes to stdout.

**Process every person across all years:**
```bash
node index.js
```

**Process all persons for a specific year:**
```bash
node index.js 2024
```

**Process a specific person in a specific year:**
```bash
node index.js 2024 alice
```

`npm start` is an alias for `node index.js` (no arguments).

---

## Output

Reports are written to `output/(year)/(person)/`:

```
output/
  2024/
    alice/
      report.md    <- human-readable Markdown
      report.json  <- full structured data for programmatic use
```

The Markdown report is also printed to stdout as each person is processed.

### What the report contains

| Section | Contents |
|---------|----------|
| **Document Summary** | Table of every file: detected type, issuer, key extracted amounts, and any warnings |
| **Totals** | Summed total income, total deductions, total credits |
| **T1 Line Summary** | Table mapping T1 line numbers to CRA descriptions and dollar values |
| **Deductions & Credits Found** | Lines 20000-39999 that were populated |
| **Missing Documents Checklist** | Checkboxes for commonly needed slips not found in the folder |
| **Advice** | Actionable recommendations for deductions or credits to investigate |

The `report.json` file contains the full raw analysis object including all document fields, T1 line values, missing documents, and advice — suitable for further processing or diffing year-over-year.

---

## How It Works

```
input/(year)/(person)/
        |
    [scanner.js]          Recursively find .pdf, .txt, .csv, .png, .jpg, .jpeg files
        |
    [extractor.js]        Extract text — pdf-parse for PDFs, direct read for text files,
                          placeholder for images
        |
    [analyzer.js]         Build a prompt with all extracted text and call:
                          claude -p "<prompt>" --system-prompt "<CRA expert system>"
                          Parse the JSON response into documents, T1 lines, missing docs, advice
        |
    [reporter.js]         Render report.md and report.json using tax-lines.json for
                          line number descriptions
        |
output/(year)/(person)/report.md + report.json
```

If the `claude` CLI is unavailable or returns invalid JSON, the analyzer falls back gracefully: raw text is still extracted and the report is generated with a notice to review manually, along with the top deductions from `deduction-guide.json` as generic advice.

---

## Common Tax Slips — Quick Reference

| Slip | Description |
|------|-------------|
| T4 | Employment income — from every employer |
| T4A | Pension, retirement, annuity, and other income |
| T4A(OAS) | Old Age Security pension |
| T4A(P) | Canada Pension Plan benefits |
| T4E | Employment Insurance benefits |
| T4RSP | RRSP income (withdrawals) |
| T4RIF | Registered Retirement Income Fund |
| T5 | Statement of investment income (dividends, interest) |
| T5008 | Statement of Securities Transactions (capital gains) |
| T3 | Statement of Trust Income (mutual funds, ETFs) |
| T2202 | Tuition and Enrolment Certificate |
| T778 | Child Care Expenses Deduction |
| RC62 | Universal Child Care Benefit statement |
| T10 | Pension Adjustment Reversal |

---

## Deductions Covered

The advisor checks for and provides guidance on:

- RRSP Contributions (Line 20800) — 60-day deadline after Dec 31
- Child Care Expenses (Line 21400) — claimed by lower-income spouse, requires provider SIN/BN
- Moving Expenses (Line 21900) — 40+ km rule, Form T1-M
- Medical Expenses (Line 33099) — must exceed 3% of net income or $2,635 (2024 threshold)
- Charitable Donations (Line 34900) — 15% on first $200, 29% above
- Tuition Fees (Line 32300) — T2202 from institution's student portal
- Home Office Expenses (Line 22900) — T2200 required; flat rate method ended after 2022
- Employment Expenses (Line 22900) — T2200 signed by employer
- Investment Carrying Charges (Line 22100) — interest on investment loans
- Capital Gains / Losses (Line 12700) — T5008 plus ACB records, Schedule 3
- Disability Tax Credit (Line 31600) — Form T2201, one-time CRA approval
- First Home Buyers Amount (Line 31270) — $10,000 credit
- Canada Training Credit (Line 45350) — refundable, $250/year accumulation
- Union / Professional Dues (Line 21200) — usually on T4 Box 44

---

## Disclaimer

TaxFriend is not professional tax advice. All figures and recommendations must be verified against your actual documents and current CRA guidelines before filing. Consult a qualified tax professional if you are uncertain about any amount or eligibility.
