# TaxFriend — Product Specification

Version: 0.x (pre-release)
Last updated: 2026-03-16

---

## 1. Product Vision

TaxFriend is a local-first, LLM-powered CRA tax assistant for Canadian individuals and couples filing a T1 General return. The user drops their tax documents into a folder (or uploads them through a browser UI), and TaxFriend extracts text, calls Claude via the `claude -p` CLI, and produces a structured report mapping every document to the correct T1 line numbers, flagging missing slips, generating actionable deduction advice, and providing a step-by-step TurboTax Canada fill guide. Because everything runs on the user's own machine and calls a locally-authenticated Claude installation, no tax data is transmitted to a third-party web service beyond what the local `claude` CLI itself handles — privacy is structural, not promised.

---

## 2. Current Features (v0.x)

### Backend (server.js + src/)

| Feature | Status | Notes |
|---------|--------|-------|
| Express HTTP server on port 9001 | Done | Static file serving + JSON API |
| File upload via multipart POST | Done | Up to 20 files per request; multer |
| ZIP extraction on upload | Done | Flattens directory structure (all files land in person root) |
| Recursive document scanner | Done | `scanner.js` — `.pdf .txt .csv .png .jpg .jpeg` |
| PDF text extraction | Done | `pdf-parse`; fails gracefully on scanned/encrypted PDFs |
| Image extraction | Placeholder | Returns `IMAGE_FILE: <name> — manual review required`; no OCR |
| Text/CSV pass-through | Done | Read as-is |
| LLM document classification | Done | Single `claude -p` call with all document text; JSON response |
| Document type recognition | Done | T4, T4A, T4E, T5, T5008, T3, T2202, RRSP, Donation, Medical, Tuition, PropertyTax, RentReceipt, ChildCare, HomeOffice, BusinessExpense, Other, Unknown |
| Field extraction per document | Done | CRA box numbers in `fields` object; accuracy depends on LLM |
| T1 line mapping | Done | LLM populates `t1_lines` keyed by CRA line number |
| Summary totals | Done | `total_income`, `total_deductions`, `total_credits` |
| Missing document detection | Done | LLM infers missing slips from taxpayer situation |
| Advice generation | Done | LLM provides deduction/credit recommendations |
| Fill guide generation | Done | TurboTax Canada navigation steps with real amounts from documents |
| Clarification request detection | Done | LLM flags unclear docs; questions injected into chat history |
| LLM fallback (graceful degradation) | Done | Falls back to deduction-guide.json tips if claude is unavailable |
| Markdown report generation | Done | `reporter.js` renders `report.md` |
| JSON report generation | Done | `reporter.js` writes full analysis as `report.json` |
| Dual output storage | Done | Written to both `output/(year)/(person)/` and `input/(year)/(person)/.taxfriend/` |
| Chat API | Done | Context-aware; last 10 exchanges sent; persisted to `chat.json` |
| Chat history persistence | Done | Loaded on person select; cleared via DELETE endpoint |
| File serve API | Done | `GET /api/files/:year/:person/:filename` with path traversal guard |
| Year/person discovery API | Done | `GET /api/years`, `GET /api/persons/:year` |
| Analysis retrieval API | Done | `GET /api/analysis/:year/:person` and `GET /api/report/:year/:person` |

### Frontend (public/)

| Feature | Status | Notes |
|---------|--------|-------|
| Year selector (dropdown + free-text) | Done | Hybrid: select existing or type new |
| Person selector (dropdown + free-text) | Done | Same hybrid pattern |
| Drag-and-drop file upload zone | Done | dragover / drop events |
| File queue with removal | Done | Per-file remove button; deduplication by name+size |
| Upload progress indicator | Done | Spinner + status message |
| Analyze button with 5-minute timeout | Done | AbortController |
| Report tab (Markdown rendered to HTML) | Done | Custom renderer: headings, tables, lists, bold, code, blockquote |
| Fill Guide tab | Done | Structured TurboTax navigation UI |
| Chat tab | Done | Persistent conversation; Ctrl+Enter to send |
| Raw JSON tab | Done | Pretty-printed analysis output |
| Advice bar | Done | Shown above tabs after analysis; missing docs + top advice |
| Status messages (info / success / warning / error) | Done | |
| Clarification messages in chat | Partial | Injected as assistant messages; no UI distinction from normal chat |

### Data Files

| File | Status | Notes |
|------|--------|-------|
| `data/tax-lines.json` | Done | 44 T1 line numbers with CRA descriptions |
| `data/deduction-guide.json` | Done | 14 deductions with required docs, deadlines, T1 lines |

---

## 3. Core Requirements (MVP)

### 3.1 Document Ingestion

**Requirement:** The system must accept tax documents through the browser UI and store them in the correct `input/(year)/(person)/` path.

Acceptance criteria:
- Accepts `.pdf`, `.txt`, `.csv`, `.png`, `.jpg`, `.jpeg` individually or in a `.zip` archive.
- ZIP files are extracted server-side; individual files within are placed in the person's folder.
- Up to 20 files per upload request.
- Upload target (year + person) is validated before files are accepted; missing year or person returns HTTP 400.
- Uploaded files are accessible via `GET /api/files/:year/:person/:filename` with path traversal protection.

**Gap:** ZIP extraction currently flattens directory structure — files nested inside ZIP subdirectories all land in the person root regardless of original layout. Sub-folder organization inside ZIPs is lost.

### 3.2 Document Classification

**Requirement:** Every uploaded document must be classified into a known slip type with an issuer name.

Supported types (must all be recognized):

| Type | CRA Slip | Description |
|------|----------|-------------|
| T4 | T4 | Employment income |
| T4A | T4A | Pension, retirement, other income |
| T4E | T4E | Employment Insurance |
| T5 | T5 | Investment income |
| T5008 | T5008 | Securities transactions / capital gains |
| T3 | T3 | Trust income (mutual funds, ETFs) |
| T2202 | T2202 | Tuition and Enrolment Certificate |
| RRSP | Various | RRSP contribution receipts |
| Donation | Various | Charitable donation receipts |
| Medical | Various | Medical expense receipts |
| Tuition | Various | Tuition receipts not on T2202 |
| PropertyTax | Various | Property tax statements |
| RentReceipt | Various | Landlord rent receipts |
| ChildCare | T778 / receipts | Child care expense receipts |
| HomeOffice | T2200 / bills | Home office expense documentation |
| BusinessExpense | T2125 / receipts | Self-employment expense documentation |
| Other | — | Recognized but uncategorized |
| Unknown | — | Unrecognized; flagged for clarification |

Acceptance criteria:
- Each document has a `document_type` from the list above.
- Each document has an `issuer` field (employer name, institution name, etc.) when determinable from content.
- Image files currently receive type `Unknown` with `needs_clarification: true` because no text can be extracted.
- Unclear documents trigger a clarification question stored in `chat.json`.

### 3.3 Field Extraction

**Requirement:** Key CRA box numbers must be extracted per document and stored in the `fields` object.

| Slip | Required Fields |
|------|----------------|
| T4 | Box 14 (employment income), Box 22 (tax deducted), Box 16 (CPP), Box 18 (EI), Box 44 (union dues), Box 52 (pension adjustment) |
| T4A | Box 16 (pension), Box 20 (self-employed commissions), Box 48 (fees for services) |
| T4E | Box 14 (benefits paid), Box 22 (tax deducted) |
| T5 | Box 10 (eligible dividends), Box 11 (dividends other), Box 13 (interest) |
| T5008 | Box 20 (proceeds), Box 21 (ACB), Box 30 (gain/loss) |
| T3 | Box 21 (capital gains), Box 26 (other income), Box 49 (eligible dividends) |
| T2202 | Box A (eligible tuition), Box B (months part-time), Box C (months full-time) |
| RRSP | Contribution amount, contribution date, institution name |
| Donation | Amount, charity name, CRA registration number |

Acceptance criteria:
- Field names use CRA box conventions (e.g., `box_14_employment_income`).
- Numeric fields are numbers, not strings.
- Missing boxes are omitted from `fields` rather than set to zero (zero means explicitly reported as zero).

### 3.4 T1 Line Mapping

**Requirement:** All extracted amounts must be mapped to the correct CRA T1 General line numbers.

Lines that must be populated when corresponding slips are present:

| Line | Source |
|------|--------|
| 10100 | T4 Box 14 |
| 10400 | Other employment income |
| 11300 | T4A(OAS) |
| 11400 | T4A(P) CPP benefits |
| 11900 | T4E benefits |
| 12000 | Taxable dividends (T5, T3) |
| 12100 | Interest income (T5) |
| 12700 | Taxable capital gains (T5008, T3) |
| 13500 | Business income (T2125) |
| 14300 | Total income (calculated) |
| 20800 | RRSP deduction |
| 21200 | Union/professional dues |
| 21400 | Child care expenses |
| 21900 | Moving expenses |
| 22100 | Carrying charges |
| 22900 | Other employment expenses (home office) |
| 23600 | Net income (calculated) |
| 26000 | Taxable income (calculated) |
| 30000 | Basic personal amount |
| 31200 | EI premiums |
| 31270 | First home buyers amount |
| 31600 | Disability amount |
| 32300 | Tuition |
| 33099 | Medical expenses |
| 34900 | Donations |
| 45350 | Canada Training Credit |

Acceptance criteria:
- `t1_lines` object keys are string CRA line numbers.
- Values are numeric dollar amounts (not strings).
- Calculated lines (14300, 23600, 26000) are populated by the LLM based on extracted amounts; they are not verified against CRA calculation rules in the current version.

### 3.5 Fill Guide

**Requirement:** The system must produce a TurboTax Canada navigation guide with specific values from the taxpayer's documents.

Acceptance criteria:
- Software name is "TurboTax Canada / Intuit TurboTax" (or the name returned by the LLM).
- Each section matches a real TurboTax Canada navigation path.
- Steps contain actual amounts and issuer names from the analyzed documents, not generic placeholders.
- Final steps include RRSP review and the Review & Optimize reminder.
- Rendered as a structured UI in the Fill Guide tab with a software badge per section.

### 3.6 Missing Document Detection

**Requirement:** The system must identify which common slips are absent given the taxpayer's apparent situation.

Acceptance criteria:
- Missing documents list is generated by the LLM from context (e.g., if a T4 is present but no T4 stub for CPP or no RRSP receipts, those are flagged).
- The list is shown in the Advice bar with a warning badge and in the report under "Missing Documents Checklist" as unchecked boxes.
- For employees: T4, T4A if applicable, RRSP contribution receipts, donation receipts.
- For investors: T5, T3, T5008 (if previous year had gains/losses).
- For students: T2202.
- For EI recipients: T4E.

### 3.7 Deduction Advice

**Requirement:** The system must provide actionable, personalized deduction and credit advice based on the taxpayer's specific documents and amounts.

Acceptance criteria:
- Advice items are specific to the taxpayer's situation, not generic.
- Advice references CRA line numbers and dollar thresholds where relevant (e.g., "Your medical expenses are $1,200 — you need $2,635 minimum for 2024 or 3% of net income").
- Up to 4 advice items shown in the Advice bar; full list in the report.
- `deduction-guide.json` is used as fallback advice when LLM is unavailable.

### 3.8 Chat Interface

**Requirement:** The user must be able to ask follow-up questions about their specific return in a persistent chat session.

Acceptance criteria:
- Chat context includes the full `analysis.json` (first 3,000 characters passed to LLM).
- Last 10 exchanges (20 messages) are included in each prompt for continuity.
- History is persisted to `chat.json` and reloaded when the person is selected.
- History can be cleared via the "Clear chat" button (calls DELETE endpoint).
- Ctrl+Enter submits the message.
- Chat works without a prior analysis run (but responses will be generic without document context).
- Clarification requests from the analysis run appear in chat history as assistant messages with `[CLARIFICATION_REQUEST]` role marker.

**Gap:** Clarification messages in chat have no visual distinction from regular assistant messages in the UI. The `[CLARIFICATION_REQUEST]` marker appears as raw text.

### 3.9 Multi-person Support

**Requirement:** The system must support multiple people per tax year in separate isolated namespaces.

Acceptance criteria:
- Each person has their own `input/(year)/(person)/` folder and `output/(year)/(person)/` folder.
- Year and person selectors are populated from the filesystem at startup.
- Switching person reloads chat history for that person.
- No data from one person's namespace is included in another's analysis.

**Gap:** There is no "couple" mode that links two people for income-splitting analysis or spousal credit calculation. Each person is independent.

### 3.10 Output Formats

**Requirement:** Analysis results must be available in multiple formats.

| Format | Location | Description |
|--------|----------|-------------|
| Markdown report | `output/(year)/(person)/report.md` | Human-readable; also in `.taxfriend/report.md` |
| JSON report | `output/(year)/(person)/report.json` | Full analysis; suitable for year-over-year diff |
| Analysis JSON | `input/(year)/(person)/.taxfriend/analysis.json` | Raw LLM output; used by chat API |
| Chat history | `input/(year)/(person)/.taxfriend/chat.json` | Message array with roles |

Acceptance criteria:
- JSON report includes `year`, `person`, `generatedAt` timestamp, plus all analysis fields.
- Markdown report renders correctly in the browser's custom renderer (headings, tables, lists, bold).
- Raw JSON is available in the browser via the Raw JSON tab.

---

## 4. Data Model

### Filesystem Layout

```
taxfriend/
  input/
    (year)/
      (person)/
        *.pdf, *.png, *.jpg, *.jpeg, *.txt, *.csv   <- source documents
        .taxfriend/
          analysis.json    <- full LLM analysis result
          report.md        <- human-readable markdown report (copy)
          chat.json        <- conversation history array
  output/
    (year)/
      (person)/
        report.md          <- primary output; also written to .taxfriend/
        report.json        <- full structured data for programmatic use
  data/
    deduction-guide.json   <- 14 deductions with docs/deadlines/notes
    tax-lines.json         <- 44 T1 line number descriptions
  src/
    scanner.js
    extractor.js
    analyzer.js
    reporter.js
  public/
    index.html
    css/style.css
    js/app.js
  server.js
  index.js                 <- CLI entry point (non-server usage)
  package.json
```

### analysis.json Schema

```json
{
  "documents": [
    {
      "file": "T4-employer.pdf",
      "document_type": "T4",
      "issuer": "Acme Corp",
      "fields": {
        "box_14_employment_income": 75000.00,
        "box_22_income_tax_deducted": 14500.00,
        "box_16_cpp_contributions": 3867.50,
        "box_18_ei_premiums": 1049.12,
        "box_44_union_dues": 450.00,
        "box_52_pension_adjustment": 0.00
      },
      "notes": "Single T4 from primary employer",
      "needs_clarification": false,
      "clarification_question": ""
    }
  ],
  "summary": {
    "total_income": 75000.00,
    "total_deductions": 5400.00,
    "total_credits": 2200.00
  },
  "t1_lines": {
    "10100": 75000.00,
    "14300": 75000.00,
    "20800": 5000.00,
    "21200": 450.00,
    "23600": 69550.00,
    "26000": 69550.00,
    "30000": 15705.00,
    "31200": 1049.12
  },
  "missing_documents": [
    "T5 — check if any bank accounts earned interest",
    "RRSP contribution receipt — did you contribute before March 3?"
  ],
  "advice": [
    "Your union dues of $450 are deductible on Line 21200 — confirm Box 44 matches your receipts.",
    "Consider an RRSP contribution before March 3 — your deduction limit may allow room."
  ],
  "fill_guide": {
    "software": "TurboTax Canada / Intuit TurboTax",
    "sections": [
      {
        "section": "Employment Income",
        "steps": [
          "Navigate to Income > Employment Income > T4 Slips",
          "Click Add a T4 slip",
          "Employer name: Acme Corp",
          "Box 14 (Employment income): 75,000.00",
          "Box 22 (Income tax deducted): 14,500.00",
          "Box 52 (Pension adjustment): 0.00"
        ]
      }
    ],
    "final_steps": [
      "Review your RRSP deduction limit in RRSP & Savings Plans",
      "Complete the Review & Optimize section before filing"
    ]
  },
  "llm_unavailable": false
}
```

### report.json Schema (superset of analysis.json)

`report.json` wraps the analysis with top-level metadata:

```json
{
  "year": "2024",
  "person": "alice",
  "generatedAt": "2026-03-16T10:00:00.000Z",
  ...all fields from analysis.json...
}
```

### chat.json Schema

```json
[
  {
    "role": "user",
    "content": "Can I deduct my home internet for home office?"
  },
  {
    "role": "assistant",
    "content": "Yes — under the detailed method using Form T2200..."
  },
  {
    "role": "assistant",
    "content": "[CLARIFICATION_REQUEST]",
    "clarification": {
      "file": "scan001.jpg",
      "question": "This image appears to be a T4 but the amounts are not readable. Can you confirm your employment income from this slip?"
    }
  }
]
```

---

## 5. Architecture

```
Browser (localhost:9001)
  |
  |  GET /api/years, /api/persons/:year       -- filesystem discovery
  |  POST /api/upload (multipart)             -- file ingestion
  |  POST /api/analyze (JSON)                 -- triggers full pipeline
  |  GET /api/report/:year/:person            -- retrieve saved report
  |  GET /api/analysis/:year/:person          -- retrieve raw analysis
  |  GET /api/chat/:year/:person              -- load chat history
  |  POST /api/chat (JSON)                    -- send chat message
  |  DELETE /api/chat/:year/:person           -- clear chat history
  |  GET /api/files/:year/:person/:filename   -- serve source document
  |
Express (server.js)
  |
  +-- scanner.js        Recursively enumerate supported files in input/(year)/(person)/
  |
  +-- extractor.js      pdf-parse for PDFs; readFile for text; placeholder for images
  |
  +-- analyzer.js       Build classify prompt → spawn `claude -p` → parse JSON response
  |           |
  |           +-- fallback: deduction-guide.json if claude unavailable
  |
  +-- reporter.js       Render report.md (Markdown) + report.json (structured)
  |
  +-- Filesystem
        input/(year)/(person)/*.{pdf,txt,csv,png,jpg,jpeg}
        input/(year)/(person)/.taxfriend/{analysis.json, report.md, chat.json}
        output/(year)/(person)/{report.md, report.json}
```

The CLI path (`index.js`) follows the same pipeline but prints to stdout/stderr directly without the HTTP layer.

---

## 6. Security and Privacy

| Property | Implementation |
|----------|---------------|
| All data local | No cloud storage; analysis runs entirely on the user's machine via local `claude` CLI |
| No authentication required | Server binds to all interfaces on port 9001; intended for localhost use only |
| No telemetry | No analytics, no external HTTP calls (except what the `claude` CLI itself makes) |
| Path traversal protection | `GET /api/files` resolves and checks that the resolved path starts with the expected input directory |
| Input validation | `year` and `person` are required for upload and analyze endpoints; missing returns HTTP 400 |
| No input sanitization on path params | Year and person values from URL/body are used directly to construct filesystem paths — no allowlist or character validation is applied (see Limitations) |

---

## 7. Limitations (Current)

| Limitation | Impact | Notes |
|------------|--------|-------|
| Images return placeholder text | Image-based slips (scanned T4s, photos of receipts) produce no extracted data; LLM receives only a filename string | Major gap for users who photograph documents |
| Scanned PDF extraction fails | `pdf-parse` extracts embedded text only; scanned-to-PDF documents yield empty or garbage text | Common for older slips or mobile-scanned documents |
| LLM latency 30–120 seconds | Analysis is not instantaneous; users must wait | Acceptable for single-person runs; compounds with many documents |
| No input sanitization on year/person path params | A crafted request with `..` in year or person could write to arbitrary paths; mitigated only at file-serve endpoint | Security risk for any non-localhost exposure |
| ZIP extraction flattens directory structure | Files organized in subfolders within the ZIP all land in the person root | Subdirectory organization is lost |
| No CRA NETFILE integration | Output is advisory only; user must re-enter values into tax software | No machine-readable filing output |
| No automated T1 line calculation validation | Totals (lines 14300, 23600, 26000) are LLM estimates; not verified against CRA arithmetic rules | Values may not cross-check correctly |
| No spousal/couple return mode | Two persons are independently analyzed; no income splitting, no spousal credit calculation | Couples must manually combine results |
| Markdown renderer is custom and partial | The inline renderer in `app.js` handles headings, tables, lists, bold, blockquote — but no italic, nested lists, links, or checkbox list items (`- [ ]`) | Missing document checklist checkbox syntax renders as plain text |
| No prior year carryforward | No mechanism to carry RRSP unused room, capital losses, or tuition credits forward from a prior year's analysis | Users must track this manually |
| Chat context truncated to 3,000 chars | `analysis.json` is truncated before being sent to the chat LLM | Large analyses may lose tail fields (fill guide, advice) from chat context |
| Duplicate helper functions | `escHtml` and `escapeHtml` coexist in `app.js` with identical logic | Minor code quality issue |
