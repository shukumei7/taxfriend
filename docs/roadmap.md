# TaxFriend — Product Roadmap

Last updated: 2026-03-16

This roadmap describes what needs to be built to make TaxFriend a complete, polished product. Phases are ordered by priority and dependency. Each item is actionable and scoped to a single deliverable.

---

## Phase 1 — Foundation (current / complete)

These items are implemented as of v0.x.

- [x] Express server on port 9001 with static file serving
- [x] Multipart file upload with multer (up to 20 files)
- [x] ZIP extraction on upload via adm-zip
- [x] Recursive document scanner for .pdf .txt .csv .png .jpg .jpeg
- [x] PDF text extraction via pdf-parse
- [x] Single LLM call (claude -p) for document classification, field extraction, T1 line mapping, fill guide, advice
- [x] Graceful fallback to deduction-guide.json when LLM unavailable
- [x] Markdown report generation (reporter.js)
- [x] JSON report generation
- [x] Dual write: output/(year)/(person)/ and input/(year)/(person)/.taxfriend/
- [x] Context-aware chat API (claude -p) with history persistence
- [x] Clarification requests injected into chat on analysis completion
- [x] Browser UI: year/person selectors, drag-and-drop upload, report/fill guide/chat/JSON tabs
- [x] Advice bar above tabs: missing documents + top advice items
- [x] CLI entry point (index.js) for headless / scripted usage
- [x] tax-lines.json (44 CRA line descriptions)
- [x] deduction-guide.json (14 deductions with docs, deadlines, notes)

---

## Phase 2 — Document Intelligence

Goal: Extract real data from all document types users actually have, including scanned and photographed slips.

### 2.1 OCR for images and scanned PDFs

**Problem:** Image files (.png, .jpg, .jpeg) and scanned-to-PDF documents currently return placeholder text. This is the single largest accuracy gap — many users scan or photograph slips rather than downloading the digital version.

**Deliverable:** Integrate Tesseract.js (local, no network) as the OCR backend.

- Run Tesseract on image files instead of returning the placeholder string
- Detect scanned PDFs (low or zero text yield from pdf-parse) and re-process the PDF pages through Tesseract
- Return OCR'd text in the same `{ file, type, text }` shape as other extractors — no downstream changes required
- Add `ocr: true` flag to the extraction result for transparency in the report

**Decision required:** Tesseract.js (local, WASM, slower) vs calling a local vision LLM (faster, but introduces a second claude/ollama dependency). See Open Questions.

### 2.2 Confidence scores per extracted field

**Problem:** The LLM silently makes incorrect extractions, especially from low-quality PDFs. There is no signal to the user that a field value is uncertain.

**Deliverable:**

- Add a `confidence` field (0.0–1.0) per document in the analysis JSON (LLM-provided)
- Display confidence indicator in the Document Summary table (e.g., low confidence row highlighted in yellow)
- Flag documents with confidence < 0.7 as needing clarification automatically

### 2.3 Automatic document year detection

**Problem:** Users sometimes upload documents from the wrong tax year. The system uses the folder year but does not cross-check against the year stated on the slip.

**Deliverable:**

- LLM extracts `document_year` field per document
- If `document_year` != the folder year, add a warning to `notes` and flag `needs_clarification: true` with a specific question
- Show a mismatch warning in the Document Summary table

### 2.4 Additional slip type support

Add the following slip types to the recognized set (currently absent or lumped into Other):

| Slip | Description | Key Fields |
|------|-------------|------------|
| T4RSP | RRSP income (withdrawals) | Box 22 (amount withdrawn), Box 30 (tax deducted) |
| T4RIF | RRIF income | Box 16 (taxable amount), Box 30 (tax deducted) |
| T4A(OAS) | Old Age Security | Box 18 (gross OAS), Box 22 (tax deducted) |
| T4A(P) | CPP benefits | Box 20 (CPP benefit), Box 22 (tax deducted) |
| RC62 | Universal Child Care Benefit | Box 10 (UCCB amount) |
| T10 | Pension Adjustment Reversal | Box 20 (PAR amount) |
| T2125 | Business/professional income statement | Gross income, allowable expenses, net income |

### 2.5 Bulk import from folder path

**Problem:** Power users with many documents would rather point to an existing folder than upload through the browser.

**Deliverable:**

- `POST /api/import-folder` endpoint that accepts a local filesystem path and copies/links all supported files into `input/(year)/(person)/`
- Add a "Import from folder" option in the UI alongside the drop zone (localhost only; validate that path stays within a configurable allowed root)

---

## Phase 3 — Tax Logic Engine

Goal: Add deterministic CRA rule validation on top of the LLM output, and support more complex taxpayer situations.

### 3.1 CRA arithmetic validation

**Problem:** The LLM populates calculated lines (14300 total income, 23600 net income, 26000 taxable income) with estimates that may not match the actual sum of source lines.

**Deliverable:**

- Post-process the LLM analysis result with a deterministic `validator.js` module
- Re-calculate lines 14300, 23600, and 26000 from constituent lines in `t1_lines`
- If LLM value differs from calculated value by more than $1, overwrite with calculated value and add a warning to `analysis.warnings[]`
- Report discrepancies in the report under a new "Validation Notes" section

### 3.2 CRA rule checks

**Problem:** LLM advice is generic; it does not check specific 2024 CRA thresholds.

**Deliverable:** A `rules.js` module that validates extracted amounts against known CRA rules for the relevant tax year:

| Rule | Check |
|------|-------|
| RRSP deduction limit | Warn if line 20800 exceeds 18% of prior year earned income (requires prior year input) |
| Medical expense threshold | Warn if line 33099 < 3% of line 23600 or < $2,635 (2024) — credit won't apply |
| Donation credit rates | Confirm first $200 @ 15% and remainder @ 29%; flag amounts > 75% of net income |
| Basic personal amount | Auto-populate line 30000 with the correct 2024 federal amount ($15,705) if absent |
| EI premium | Auto-populate line 31200 from T4 Box 18 if LLM missed it |
| CPP contribution | Verify line 30800 (CPP employee premiums) matches T4 Box 16 |

### 3.3 Spousal / couple return support

**Problem:** Couples cannot currently link their two independent analyses. Income splitting, the spousal amount (Line 30300), and child care expense attribution (must go to lower-income spouse) require cross-person data.

**Deliverable:**

- Add a "Link as couple" concept in the UI: select two persons in the same year as Person A and Person B
- `POST /api/couple-analysis` endpoint: runs individual analyses if not already done, then calls LLM with both analyses for a joint summary
- Joint summary output:
  - Who should claim child care expenses (lower-income spouse)
  - Whether Person A can claim the spousal amount (Line 30300)
  - RRSP income-splitting eligibility (pension splitting, Line 21000)
  - Combined household total income, deductions, estimated refund/balance

### 3.4 Prior year carryforwards

**Problem:** Capital loss carryforwards, unused RRSP room, and unclaimed tuition credits from prior years affect the current year's return. TaxFriend currently ignores these.

**Deliverable:**

- Add a `carryforwards.json` per person per year: `{ rrsp_unused_room, capital_loss_carryforward, tuition_credit_unused, training_credit_balance }`
- User can manually enter carryforward values in the UI (new "Carryforwards" panel)
- Analysis prompt includes carryforward context so LLM advice accounts for them
- Report includes a "Carryforwards" section showing what was applied and what remains

### 3.5 Self-employment schedule (T2125)

**Problem:** Self-employed persons have income, expenses, and home-office deductions not covered by T4-style extraction.

**Deliverable:**

- Recognize T2125 document type and extract: gross business income, each expense category, net business income
- Map to lines 13500 (business income), 22900 (home office portion), 44800 (CPP on self-employment)
- Fill guide includes the T2125 section in TurboTax Canada
- Advice checks for common missed expenses (phone/internet portion, vehicle, professional development)

### 3.6 Rental income schedule (T776)

**Deliverable:**

- Recognize rental income documents (leases, rental statements)
- Map gross rental income and allowable expenses to T776 equivalent fields
- Line 12600 (rental income) populated in t1_lines
- Advice covers CCA (depreciation) considerations and common rental deductions

### 3.7 Quebec provincial return (TP-1)

**Problem:** Quebec residents must file both a federal T1 and a provincial TP-1. TaxFriend currently ignores provincial tax.

**Deliverable:**

- Add `province` field to person context (user-selectable)
- For Quebec, generate a parallel `tp1_lines` object in the analysis
- Fill guide includes a Revenu Québec / TurboTax Quebec section
- Note: this is complex; defer to a dedicated sub-phase after federal return is solid

---

## Phase 4 — Fill Guide and Export

Goal: Move from advisory output to machine-usable output that reduces manual re-entry.

### 4.1 NETFILE-compatible XML export

**Problem:** Users currently read TaxFriend output and re-enter values into tax software manually. NETFILE XML would allow direct import into CRA-certified software.

**Deliverable:**

- `GET /api/export/netfile/:year/:person` endpoint that generates a CRA NETFILE XML document from the `t1_lines` object
- XML schema: CRA NETFILE 2024 T1 specification (public documentation)
- Include only lines with values; omit zeros
- Clearly disclaim that the XML must be reviewed before submission

**Risk:** CRA NETFILE XML format changes annually; this requires maintenance each tax year.

### 4.2 PDF-fillable T1 General form auto-population

**Deliverable:**

- Use a PDF form library (pdf-lib) to fill a CRA T1 General PDF form with values from `t1_lines`
- Produce a filled PDF available via `GET /api/export/t1-pdf/:year/:person`
- Read-only output; user prints or reviews in PDF viewer

### 4.3 Prior year vs current year comparison

**Deliverable:**

- `GET /api/compare/:year/:person` that loads the current and prior year's `report.json` and produces a diff
- Highlighted line-by-line comparison: which T1 lines changed, by how much
- New documents this year vs last year
- Rendered as a new "Compare" tab in the UI

### 4.4 TurboTax Online import

- Research whether TurboTax Canada exposes an import API or file format
- If available: generate a TurboTax-importable file from `t1_lines`
- If not available: keep the fill guide as the primary integration path

---

## Phase 5 — UX Polish

Goal: Make TaxFriend feel complete and professional for non-technical users.

### 5.1 Dashboard view

**Deliverable:**

- Landing page shows cards for each discovered (year, person) combination
- Each card shows: year, person name, number of documents, analysis status (not run / complete / stale), estimated refund/balance if available
- "Run analysis" and "View report" actions per card
- Replace the current single-context setup panel with the dashboard as the default view

### 5.2 Document progress tracker

**Deliverable:**

- Per-person panel showing "X of Y expected documents uploaded"
- Expected document list is based on taxpayer situation (employed, student, investor, etc.) inferred from the analysis or user-specified
- Each expected document shows status: found / missing / needs clarification

### 5.3 Document status badges

**Deliverable:**

- In the Document Summary table, show a status badge per document:
  - Extracted (green checkmark)
  - Needs clarification (yellow warning)
  - OCR'd (blue — text came from OCR, lower confidence)
  - Image placeholder (red — no extraction possible)
- Clicking "Needs clarification" badge opens the chat tab with the clarification question pre-filled

### 5.4 Clarification request UI in chat

**Problem:** Clarification messages posted by the analysis run appear as raw `[CLARIFICATION_REQUEST]` text with no visual distinction.

**Deliverable:**

- Detect messages with `role === 'assistant'` and `content === '[CLARIFICATION_REQUEST]'` in the chat renderer
- Render them as a distinct card style: document filename, preview thumbnail (if image), and the clarification question as a quoted block
- Include a "Reply" button that pre-fills the chat input with context about the file

### 5.5 Dark mode

**Deliverable:**

- CSS custom properties for all colors in `style.css`
- `prefers-color-scheme: dark` media query switches to a dark palette
- Manual toggle button in the header

### 5.6 Mobile-responsive layout

**Deliverable:**

- Collapse the two-column layout (setup panel left, report panel right) to single-column on viewports < 768px
- Tab bar scrolls horizontally on narrow screens
- Chat input grows to fill available width

### 5.7 Person management

**Deliverable:**

- Rename person folder via `POST /api/rename-person { year, oldName, newName }`
- Delete person (with confirmation) via `DELETE /api/person/:year/:person`
- These operations rename/delete the `input/(year)/(person)/` and `output/(year)/(person)/` directories

---

## Phase 6 — Advanced

Goal: Higher-value features that require more complex logic or integrations.

### 6.1 Audit risk score

**Deliverable:**

- Post-analysis module that scores each return 0–100 for audit risk based on:
  - Unusually high deductions relative to income
  - Missing common slips for the taxpayer's apparent situation
  - Amounts that exceed known CRA thresholds without explanation
- Risk score and contributing factors shown in the report and advice bar
- Not a guarantee of audit safety; clearly disclaimed

### 6.2 RRSP contribution calculator

**Deliverable:**

- Input panel: prior year net income, existing RRSP balance, pension adjustment from T4
- Calculate: contribution room, optimal contribution to reach 0 taxable income (or a target bracket)
- Integrated with carryforward tracking (Phase 3.4)

### 6.3 Deadline calendar

**Deliverable:**

- Per-year calendar of key CRA deadlines derived from tax year:
  - RRSP contribution deadline (60 days after Dec 31)
  - T1 filing deadline (April 30, or June 15 for self-employed)
  - Balance owing payment deadline (April 30)
  - Instalment due dates (quarterly)
- Shown in a "Deadlines" sidebar or modal
- Exportable as .ics calendar file

### 6.4 CRA My Account integration

CRA My Account exposes NOA (Notice of Assessment) data, RRSP room, and benefit amounts. Direct API integration requires a CRA developer account (not publicly available). Two alternative approaches:

- **Browser extension approach:** A companion browser extension captures NOA data from the user's CRA My Account session and posts it to TaxFriend's local API. Requires a separate extension codebase.
- **Manual copy-paste approach:** A guided flow walks the user through finding specific values on CRA My Account (RRSP room, prior year income) and pasting them into TaxFriend fields. No automation, but no extension required.

### 6.5 Encrypted local storage

**Problem:** Tax documents are sensitive. Currently stored as plaintext files accessible to any process on the machine.

**Deliverable:**

- Optional encryption at rest for `input/(year)/(person)/` and `output/(year)/(person)/`
- User provides a passphrase on server startup; files are encrypted/decrypted transparently
- Use Node.js `crypto` module (AES-256-GCM); no external dependencies
- Passphrase is never stored; lost passphrase = lost data (document this clearly)

---

## Known Issues and Technical Debt

| Issue | Severity | Location | Description |
|-------|----------|----------|-------------|
| No input sanitization on year/person path params | High | server.js | `year` and `person` values from request body/params are used directly in `join()` path construction. A crafted value like `../../etc` could escape the input directory. Needs allowlist (alphanumeric, hyphens, underscores only). |
| ZIP extraction flattens directory structure | Medium | server.js POST /api/upload | `entry.entryName.replace(/^.*[\\/]/, '')` strips all path components. Files in ZIP subdirectories collide with each other if they share names, and user-organized subfolders are lost. |
| Chat analysis context truncated to 3,000 chars | Medium | server.js POST /api/chat | `analysisContext = raw.slice(0, 3000)` truncates the JSON mid-field for large analyses, potentially sending malformed context to the LLM. Should either parse and re-serialize a summary, or increase the limit. |
| Clarification request messages render as raw text | Medium | public/js/app.js renderChatHistory | Messages with `content: '[CLARIFICATION_REQUEST]'` appear as plain text in the chat; the `clarification` sub-object is ignored. Needs a dedicated render path. |
| Duplicate escHtml / escapeHtml functions | Low | public/js/app.js | Two functions with identical logic (`escHtml` and `escapeHtml`) coexist in app.js. One should be removed. |
| Markdown renderer does not handle checkbox list items | Low | public/js/app.js renderMarkdown | `- [ ] item` syntax (used in Missing Documents Checklist) is not recognized; renders as a plain list item without the checkbox. |
| Markdown renderer does not handle italic | Low | public/js/app.js inlineMarkdown | `*italic*` and `_italic_` pass through unchanged. |
| No multer file size limit | Medium | server.js | `multer({ dest: 'uploads/' })` has no `limits` option. A large file upload could exhaust disk space or memory. |
| uploads/ temp directory not cleaned on startup | Low | server.js | If the server crashes mid-upload, multer temp files are left in `uploads/`. No cleanup on startup. |
| No error boundary for failed readdir in years/persons endpoints | Low | server.js GET /api/years | If `input/` contains a file (not a directory) at the year level, `stat` is called but the path is still accepted as a year if it's a directory. Works correctly, but is fragile to symlinks. |
| Port 9001 is hardcoded | Low | server.js | Should be configurable via `PORT` environment variable. |
| index.js CLI entry point not documented in current README | Low | index.js | The CLI mode (node index.js, node index.js 2024, node index.js 2024 alice) is documented in README but index.js itself is not reviewed here — verify it still matches the server module exports. |

---

## Open Questions

These product decisions are unresolved and need explicit answers before the relevant phase begins.

| # | Question | Options | Notes |
|---|----------|---------|-------|
| 1 | Should multi-person returns be linked or remain independent? | (a) Always independent; user compares manually. (b) Optional couple mode via a UI link action. | Option (b) enables spousal amount and child care attribution; required for Phase 3.3. |
| 2 | Should there be a dedicated "couple" mode with shared context? | (a) Yes — couple analysis is a first-class mode with its own UI flow. (b) No — just show two persons side-by-side. | Affects data model: couple mode would need a `couples.json` linking two person names. |
| 3 | Which OCR backend for Phase 2.1? | (a) Tesseract.js — WASM, local, no extra deps, slower (~5s/page). (b) Vision LLM (e.g., claude with vision) — faster, better accuracy, but requires image data to leave the machine. (c) Local Ollama vision model — local but requires Ollama + a vision model installed. | Privacy-first choice is (a). Accuracy-first choice is (b). |
| 4 | Where should output go — output/ subdirectory, input/.taxfriend/, or both? | Currently both. | Dual-write creates duplication. Could simplify to input/.taxfriend/ only, since that keeps data co-located with source documents. Output/ could be kept for "export" artifacts only (PDFs, XML). |
| 5 | How to handle Quebec residents? | (a) Quebec TP-1 in Phase 3.7 (deferred). (b) Add province selector now and stub the TP-1 section. (c) Ignore Quebec for v1.0. | TP-1 adds significant complexity. Recommend option (a) with a clear "Quebec support coming" note in v1.0. |
| 6 | Should the server bind to localhost only or all interfaces? | Currently `app.listen(PORT)` binds to all interfaces. | Binding to `127.0.0.1` only would prevent network exposure; add a `--host` flag or environment variable for users who want LAN access. |
| 7 | Should year/person names be restricted to a safe character set? | (a) Allowlist: `^[a-z0-9_-]+$` for person, `^\d{4}$` for year. (b) Sanitize by stripping unsafe chars. | Option (a) is simpler and safer. Affects upload, analyze, and chat endpoints. |
| 8 | Should TaxFriend support tax years before 2024? | Deduction thresholds (medical expense minimum, basic personal amount, etc.) change annually. | Either accept any year and use LLM knowledge of that year, or require a `rules/(year).json` data file per year. |
| 9 | Should chat history be included in the exported report? | Currently chat is separate from the report. | Including a chat transcript in `report.md` would give users a complete record in one document. |
| 10 | What is the maximum document count per analysis call? | Currently no limit. A large batch means a very long prompt. | Consider batching: analyze documents in groups of 10, then synthesize. Affects analyzer.js prompt construction. |
