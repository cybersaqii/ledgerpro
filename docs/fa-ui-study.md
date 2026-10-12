# Fast Accounts UI Study (2026-10-12, live read-only research)

Company: "Ihsan Electronics & Solar System" (user Zia Ullah). No data created/modified.

## App chrome
- Dark-blue top bar: "FAST ACCOUNTS" logo, hamburger, company dropdown, My Tasks, Support, gear icon
- Left sidebar: Dashboard, Bank ▾, Sales ▾, Purchases ▾, Inventory ▾, Reports, Analytical Reports
- Palette: bright blue (#1E9EED-ish) top bar + table headers (white text); green pill buttons (Add New/Approve); blue-outline pill buttons (Cancel/Clear); blue text links; red delete icons; white cards on light-gray bg
- Body ~12–14px, headings ~16–20px, compact list pages

## A. Dashboard
- Title "Fast Accounts", no breadcrumb. Tabs: "What's New" (active) / "Business Overview". "Welcome Zia Ullah"
- Quick Actions card: "Add Sales Invoice", "Add Supplier Bill" buttons
- Updates card: 3 dated entries (2026-10-10/09/08), text + blue "View" button each
- Business Overview cards: (1) Account Receivable Summary — Total Receivable PKR 3,072,520.25; aging table "Unpaid Invoices | Balance": Older 96, Current 0, 1-7/8-14/15-21/22-28/Future 0; "View Report" link. (2) Account Payable Summary — Total Payable PKR 3,729,639.71; "Unpaid Bills | Balance": Older 44, Current 0, 1-7/8-14/15-21/22-28 0, Future 2. (3) Bank Balances — light-blue header "Bank | Balance"; 7 rows with codes. (4) Bank Cash Flow All — bar chart Nov-25..Oct-26; "12 Months" dropdown (3/6/12/18/24 Months). (5) Products — "Products / Quantity": Low Stock 13, Out of Stock 229, Oversold 6, In Stock 44. (6) Sales — 30,337,917.90, line chart Jul–Oct; period dropdown (This Financial Year/Week/Month, Last Week/Month, Quarter1-4). (7) Expenses — 29,430,415.76, donut; legend: Supplies and materials, Rent, Staff Salaries, Petrol Allowance, Motor Expenses. (8) Profit & Loss — Net Profit 849,659.30; Total Income 30,280,075.06; Total Expenses 29,430,415.76; "View Report". (9) AR Top 10 — "Name | Balance". (10) AR Watchlist — empty. (11) Bank Balances Watchlist — "Name | Balance". (12) AP Top 10. (13) AP Watchlist — empty. (14) Monthly Bank Balance All (12M). (15) Monthly Bank Balance Watchlist. (16) Bank Cash Flow Watchlist.
- Viewport: "What's New" fits one 1080p viewport; Business Overview ~3 screens scroll; airy cards, compact inner tables

## B. Bank → Account Balances
- Breadcrumb Home / Bank / Account Balances. Title "Account Balances". Green "+ New Account" top-right
- Filters: "Show [25] entries" (10/25/50/100), "Search:" textbox
- Table (bright blue headers): Bank | Code | Reconcile Date | Balance. Bank names = blue links. Bold Total row
- Pagination: "Showing 1 to 7 of 7 entries", ‹ 1 ›
- "+ New Account" dialog "Bank Account New": Bank Account * (text), Code (disabled), Description (text); "Cancel" (blue outline left), "Save and Close" (green right)
- Fits one viewport; compact

## C. Bank → Bank Payments
- List: Breadcrumb Home / Bank / Bank Payments. Heading "Bank Payments". Green "Add New ▾" → options "Bank Payments", "WHT Payments"
- Filters: Bank (Select), Nominals (Select), Date Range "All Dates" (26 options: All Dates, Custom, Today, This Week, This Week-to-date, This Month, This Month-to-date, Current Financial Year, ...-to-date, ...-to-last-month, Yesterday, Last Week(+to-date), Last Month(+to-date), Last Financial Year(+to-date), Since 30/60/90/365 Days Ago, Next Week, Next 4 Weeks, Next Month, Next Financial Year, Quarter 1–4), expand icon, "Clear" (blue outline)
- Top-right: Excel icon, print icon, red delete icon; "Show [25] entries"
- Table: (checkbox) | V. No. | Date | Bank | Nominal Account | Ref. No. | Details | Amount | Action. V. No. blue link; Date blue; Action: blue "View" + chevron → "Copy", "Delete"
- Pagination: "Showing 1 to 25 of 876 entries", ‹ 1 2 3 4 5 ... 36 ›
- Form "Add Bank Payments": Breadcrumb Home / Bank Payments / Add Bank Payments. "Bank" label + dropdown (7 banks). Blue table header: Date * | Ref. No. | Mode | Nominal Account * | Details | Amount * | (trash). Row: Date 12/10/2026, Ref No textbox, Mode dropdown, Nominal dropdown, Details textbox, Amount 0.00, trash. Bold "Total 0.00" row. "+ Add More" blue-outline pill. Bottom: "Cancel" (blue outline left); "Approve and Close" green split + chevron (right)
- List + form each fit one viewport; compact

## D. Bank → Bank Receipts
- Same as C. Green "Add New" goes straight to form. Form "Add Bank Receipts": identical structure
- Fits one viewport; compact

## E. Bank → Transfers
- List: Breadcrumb Home / Bank / Transfers. "Add New ▾" → single option "Transfers". Filters: From Bank, To Bank, Date Range, "Clear"
- Table: (checkbox) | V. No. | Date | From Bank | To Bank | Ref. No. | Details | From Amount | To Amount | Action
- Form "Add Transfers": single-row table, blue header: Date * | From Bank * | Ref. No. | Mode | To Bank * | Details | Amount * | (trash). "Total 0.00"; "+ Add More"; Cancel left; "Approve and Close" green split + chevron right
- Fits one viewport; compact

## F. Sales → Invoices
- Breadcrumb Home / Sales / Invoices. Heading "Invoices". Green "Add New ▾" → "Invoices (SI)", "Credit Note (SC)", "Batch Invoices (SI)", "Bulk Invoices (SI)"
- Filters: Type (All/Invoice/Credit), Customers (Select), Date Range, expand, "Clear". Top-right: Excel, print, red delete; "Show [25] entries" (10/25/50/100/200/300/400/500)
- Table: (checkbox) | Date | A/C No. | Customer | Type | Inv. No. | Name Cash | Cash Customer Number | Total | Balance | Payment Status | Action. Customer = blue link. Payment Status badges: "Fully Paid" (green), "Overdue N Days" (red), "Part Paid" (gray). Action: "View Invoice"/"View Credit"/"Receive Payment" + chevron → Copy, Return, Print, Send Email, Print Journal, Delivery Note, Add Task, Delete
- Pagination: "Showing 1 to 25 of 1,602 entries", ‹ 1 2 3 4 5 ... 65 ›
- 25 rows + filters + pagination fit one 1080p viewport; compact

## G. Add Invoice Form
- Title "Add Invoices"; Breadcrumb Home / Sales / Add Invoices
- "Customer Details" (collapsible, expanded): Row1: "Customer *" (Select..; options "+ Add New", "Walking Customer (1001)", customers) | "Date *" (12/10/2026) | "Credit Limit" (0.00). Row2: "Address" (tall textarea left) | "Term Days" (0) | "Balance" (0.00). Row3: "Due Date *" (12/10/2026). Row4: "Doc No." (placeholder "Doc No.") | "Mobile No" (placeholder "Smart Doc No 1")
- "Products Details" (expanded): blue header Product / Services | Description | Unit | Qty | Rate | Amount | (trash) | Last Rate. Row: Qty 1, Rate 0, Amount 0.00, eye icon. Bold "Total" row. "+ Add More" blue-outline pill
- Below: "Notes" textarea (left); middle: "Discount (%)" 0.00, "GST Rate" (No Tax; options No Tax, PB - 18%, PB - 16%), blue "Move Down ⇅" link; right: Sub Total 0.00, Discount Amount -0.00, GST 0.00, "Total" 0.00 (bold larger)
- "Add Receipt" (expanded): blue header Date | Bank | Mode | Ref. No. | Amount; row: Date 12/10/2026, Bank (Select Bank), Mode (Select; options Cash, Cheque, Credit Card, Offset, Online, Pay Order), Ref No empty, Amount 0.00
- Bottom: "Cancel" (blue outline left); right: "Thermal Print" dropdown (blue outline; options Thermal Print, SI English), "Approve and Print" (green), "Approve and Close" + chevron (green)
- ENTIRE form fits one 1080p viewport, no scroll; compact tightly packed

## H. Sales → Receipts
- Breadcrumb Home / Sales / Receipts. Green "Add New ▾" → "Receipts (SR)", "Payment (SCP)", "Return Receipts (RSR)", "Return Payment (RSCP)". Green "Batch ▾" → "Invoices Receipts (SR)", "Receipts (SR)", "Payments (SCP)", "Combined Accounts Offset", "All Combined Accounts Offset"
- Filters: Type (All/Receipt/Payment/Return Receipt/Return Payment), Customers, Date Range, "Clear"
- Table: (checkbox) | V. No. | Date | A/C No. | Customer | Ref No. | Type | Amount | Total | Balance | Action. 2,473 entries; ‹ 1 2 3 4 5 ... 99 ›. Action: "View" + chevron
- ~26 rows fit one viewport; compact

## I. Sales → Customers
- Breadcrumb Home / Sales / Customers. Buttons: "Open Bal." (white pill), "Batch ▾" → Field1 Update, FieldA Update, Add Customers Products, Edit Customers Products, Update Customers Tax Info, Update Customer Credit Limit; "+ Add New" (green), red trash, green export
- Filters: "Account No." (textbox), listbox "Select", combobox "Select", "Status" (Active/Archived/All = Active), expand, "Clear"
- Table: (checkbox) | Customer Name | Account No. | Contact | Email | Mobile | Balance | Action. Name = blue link; Action "View" + chevron
- ~25 rows one viewport; compact

## J. Purchases → Bills
- Breadcrumb Home / Purchases / Bills. Green "Add New ▾" → "Bills (VI)", "Credit Note (VC)", "Batch Bills (VI)"
- Filters: Type (All/Bill/Credit), Suppliers, Date Range, "Clear"
- Table: (checkbox) | Date | A/C No. | Supplier | Type | Bill ID | Bill No. | Total | Balance | Payment Status | Action. 757 entries; ‹ 1 2 3 4 5 ... 31 ›. Action: "Make Payment" / "View Bill" / "Credit Offset" + chevron
- 25 rows one viewport; compact

## K. Add Bill Form
- Title "Add Bills"; Breadcrumb Home / Purchases / Add Bills
- "Supplier Details" (expanded): Row1: "Supplier *" (Select..) | "Bill No." (textbox right). Row2: "Address" (tall textarea left) | "Date *" (12/10/2026). Row3: "Term Days" (0) | "Due Date *" (12/10/2026)
- "Expenses Details" (expanded): blue header Expense | Description | Amount | (trash); one row; "+ Add More"
- "Products Details" (expanded): blue header Product / Services | Description | Unit | Qty | Rate | Amount | (trash); row Qty 1/Rate 0/Amount 0.00; bold "Total" row; "+ Add More"
- Below: "Notes" (left); middle "Discount (%)" 0.00, "GST Rate" (No Tax); right Sub Total 0.00, Discount Amount -0.00, GST 0.00, "Total" 0.00 bold
- "Add Payment" (expanded): blue header Date | Bank | Mode | Ref. No. | Amount; row Date 12/10/2026, Bank (Select Bank), Mode (Select), Ref No, Amount 0.00
- Bottom: "Cancel" (blue outline left); right: "Bill" dropdown (blue outline chevron), "Approve and Print" (green), "Approve and Close" + chevron (green)
- Does NOT fit one viewport — Add Payment + buttons need ~1.5 screens scroll; compact rows

## L. Purchases → Payments
- Breadcrumb Home / Purchases / Payments. Green "Add New ▾" → "Payments (VP)", "Receipt (VCR)", "Return Payments (RVP)", "Return Receipt (RVCR)". Green "Batch ▾"
- Filters: Type (All/Payment/Receipt/Return Payment/Return Receipt), Suppliers, Date Range, "Clear"
- Table: (checkbox) | V. No. | Date | A/C No. | Supplier | Type | Ref No. | Amount | Total | Balance | Action. Action "View" + chevron
- ~26 rows one viewport; compact

## M. Purchases → Suppliers
- Like I. Buttons: "Open Bal." (white pill), "+ Add New" (green), red trash, green export
- Filters: "Account No." (textbox), Suppliers (Select), "Status" (Active/Archived/All), expand, "Clear"
- Table: (checkbox) | Supplier Name | Account No. | Contact | Email | Mobile | Balance | Action
- ~25 rows one viewport; compact

## N. Inventory → Products
- Breadcrumb Home / Products. Buttons: "More ▾" → Update Products, Update Products FBR Data, Update Products Fields, Convert Stock to Nonstock Products, Bulk Actions, Update Categories, Update Units; "Add New ▾" → Non-Stock Products, Stock Products, Bundle
- Filters: Type (All/Stock/Non Stock/Bundle), "Name" (textbox), "Code" (textbox), "Status" (All/Active/Archived = Active), expand, "Clear"
- Table: (checkbox) | Code | Name | Type | Category | Sale Price | Qty. on Hand | Low Stock | Action. 283 entries; ‹ 1 2 3 4 5 ... 12 ›. Action "View" + chevron
- One viewport; compact

## O. Inventory → Stock Adjustment
- Breadcrumb Home / Stock Adjustment. Green "Add New ▾" → "Out Adjustment (ADO)", "In Adjustment (ADI)". "Filter" link; "Show [25] entries"; "Search:" box
- Table: Date | Nominal Account | Type | Inv. ID | Doc No. | Total | Action. Type = "In"/"Out"; Action "View Adjustment" + chevron. "Showing 1 to 11 of 11 entries"; ‹ 1 ›
- Short table, fits easily; compact rows

## P. Reports
- Breadcrumb Home / Reports. "Search Reports" textbox (right). Category tabs: Favorites (active), Bank, Financial, Assembly, Projects, Taxes, Budget, Fixed Assets, Consolidation. Left accordion: Sales, Purchases, Bank, Inventory, Financial, Assembly, Projects, Taxes, Budget, Fixed Assets, Consolidation
- Report cards 2-col grid; each: bright-blue rounded square with number badge, title text, gray star (favorite toggle) right
- Favorites (21): 029 Sale Invoices/Credits (By Customer), 034 Customer Statement, 182 Customer Performance, 243 Customer Statement (Style One), 047 Customers Balances Summary, 054 Supplier Statement, 248 Supplier Statement (Style One), 067 Suppliers Balances Summary, 068 Bank Sales Receipts, 072 Bank Balances, 080 Stock Quantity, 148 Stock Valuation, 084 Product Sale Detail (By Date), 085 Product Sale Detail (By Product), 087 Product Purchase Detail (By Product), 162 Product Performance, 174 Stock Movement, 366 Inventory Transactions Summary By Product, 127 Income Statement, 129 Balance Sheet, 135 Nominal Activities
- Bank tab (16): 068 Bank Sales Receipts, 069 Supplier Payments, 070 Bank Receipts, 071 Bank Payments, 072 Bank Balances, 073 Bank Transfers, 074 Bank Activity Summary, 075 Bank Activity, 076 Bank Reconciled Items, 077 Bank Un-Reconciled Items, 170 Bank Reconciliation, 184 Bank Activity Summary (By Type), 236 Bank Activity (By Group), 242 Bank Activity (By Project), 489 Post-Dated Cheques All, 532 Day Book - All Transactions
- One viewport shows tabs + ~21 cards with scrollbar; generous card spacing
