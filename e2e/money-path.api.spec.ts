import { test, expect, request as baseRequest, type APIRequestContext } from "@playwright/test";

/**
 * Money-path E2E — full double-entry cycle through the real HTTP API
 * against an isolated SQLite database (see scripts/e2e-server.mjs).
 *
 * Runs with NO browser binary (pure Node HTTP via the request fixture).
 *
 * Flow:
 *   signup → customer + supplier → products → purchase bill (stock in)
 *   → sale invoice (stock out, receivable) → party ledger
 *   → partial receipt → full receipt → supplier payment
 *   → trial balance still balanced (debits == credits)
 *
 * Money is asserted in paisa strings end to end.
 */

const today = new Date().toISOString().slice(0, 10);

let api: APIRequestContext;
let customerId = "";
let supplierId = "";
let productAId = "";
let productBId = "";
let cashAccountId = "";
let saleDocId = "";
let purchaseDocId = "";

async function post(path: string, body: unknown, expectedStatus = 201) {
  const res = await api.post(path, { data: body });
  expect(res.status(), `${path} → ${await res.text()}`).toBe(expectedStatus);
  return res.json();
}

test.beforeAll(async () => {
  api = await baseRequest.newContext();
});

test.afterAll(async () => {
  await api.dispose();
});

test("signup creates company, owner and session", async () => {
  const res = await api.post("/api/auth/signup", {
    data: {
      name: "E2E Owner",
      email: `e2e-${Date.now()}@example.com`,
      password: "password123",
      companyName: "E2E Test Traders",
      businessType: "WHOLESALE",
      phone: "03001234567",
      city: "Lahore",
    },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.user.role).toBe("OWNER");
  // default cash account exists after company bootstrap
  const banks = await api.get("/api/banks");
  expect(banks.status()).toBe(200);
  const bankData = (await banks.json()).data;
  expect(bankData.length).toBeGreaterThan(0);
  cashAccountId = bankData[0].id;
});

test("create customer and supplier parties", async () => {
  const customer = await post("/api/parties", { kind: "CUSTOMER", name: "E2E Customer", phone: "03001111111" });
  customerId = customer.data.id;
  expect(customerId).toBeTruthy();
  const supplier = await post("/api/parties", { kind: "SUPPLIER", name: "E2E Supplier", phone: "03002222222" });
  supplierId = supplier.data.id;
  expect(supplierId).toBeTruthy();
});

test("create products", async () => {
  const a = await post("/api/products", {
    sku: "E2E-A", name: "E2E Product A", purchasePrice: "100.00", salePrice: "150.00", unit: "PCS",
  });
  productAId = a.data.id;
  const b = await post("/api/products", {
    sku: "E2E-B", name: "E2E Product B", purchasePrice: "200.00", salePrice: "275.50", unit: "PCS",
  });
  productBId = b.data.id;
  expect(productAId).toBeTruthy();
  expect(productBId).toBeTruthy();
});

test("purchase bill builds stock: 10xA @100 + 5xB @200 = 2000.00", async () => {
  const bill = await post("/api/purchases", {
    docType: "BILL",
    partyId: supplierId,
    date: today,
    items: [
      { productId: productAId, description: "E2E Product A", qty: "10", rate: "100.00" },
      { productId: productBId, description: "E2E Product B", qty: "5", rate: "200.00" },
    ],
  });
  purchaseDocId = bill.data.docId;
  expect(purchaseDocId).toBeTruthy();

  // stock in milli-units: 10 -> 10000, 5 -> 5000
  const res = await api.get("/api/products?perPage=50");
  expect(res.status()).toBe(200);
  const rows = (await res.json()).data as { id: string; totalQty: string }[];
  const qa = rows.find((r) => r.id === productAId)?.totalQty;
  const qb = rows.find((r) => r.id === productBId)?.totalQty;
  expect(qa).toBe("10000");
  expect(qb).toBe("5000");

  // supplier payable = -200000 paisa (credit balance: we owe the supplier)
  const ledger = await api.get(`/api/reports/party-ledger?partyId=${supplierId}`);
  expect(ledger.status()).toBe(200);
  expect((await ledger.json()).closing).toBe("-200000");
});

test("sale invoice: 2xA @150 + 1xB @275.50 - 25.50 discount = 550.00", async () => {
  const sale = await post("/api/sales", {
    docType: "INVOICE",
    partyId: customerId,
    date: today,
    discountTotal: "25.50",
    items: [
      { productId: productAId, description: "E2E Product A", qty: "2", rate: "150.00" },
      { productId: productBId, description: "E2E Product B", qty: "1", rate: "275.50" },
    ],
  });
  saleDocId = sale.data.docId;
  expect(saleDocId).toBeTruthy();

  // customer receivable = 55000 paisa
  const ledger = await api.get(`/api/reports/party-ledger?partyId=${customerId}`);
  expect(ledger.status()).toBe(200);
  expect((await ledger.json()).closing).toBe("55000");

  // stock decreased: A 10000 -> 8000, B 5000 -> 4000
  const res = await api.get("/api/products?perPage=50");
  const rows = (await res.json()).data as { id: string; totalQty: string }[];
  expect(rows.find((r) => r.id === productAId)?.totalQty).toBe("8000");
  expect(rows.find((r) => r.id === productBId)?.totalQty).toBe("4000");
});

test("partial receipt of 200.00 leaves 350.00 receivable", async () => {
  await post("/api/payments", {
    kind: "RECEIPT",
    partyId: customerId,
    bankAccountId: cashAccountId,
    date: today,
    amount: "200.00",
    method: "CASH",
    allocations: [{ docId: saleDocId, docKind: "SALES", amount: "200.00" }],
  });
  const ledger = await api.get(`/api/reports/party-ledger?partyId=${customerId}`);
  expect((await ledger.json()).closing).toBe("35000");
});

test("final receipt of 350.00 clears the receivable", async () => {
  await post("/api/payments", {
    kind: "RECEIPT",
    partyId: customerId,
    bankAccountId: cashAccountId,
    date: today,
    amount: "350.00",
    method: "CASH",
    allocations: [{ docId: saleDocId, docKind: "SALES", amount: "350.00" }],
  });
  const ledger = await api.get(`/api/reports/party-ledger?partyId=${customerId}`);
  expect((await ledger.json()).closing).toBe("0");
});

test("supplier payment of 2000.00 clears the payable", async () => {
  await post("/api/payments", {
    kind: "PAYMENT",
    partyId: supplierId,
    bankAccountId: cashAccountId,
    date: today,
    amount: "2000.00",
    method: "CASH",
    allocations: [{ docId: purchaseDocId, docKind: "PURCHASE", amount: "2000.00" }],
  });
  const ledger = await api.get(`/api/reports/party-ledger?partyId=${supplierId}`);
  expect((await ledger.json()).closing).toBe("0");
});

test("trial balance is balanced after the full cycle", async () => {
  const res = await api.get("/api/reports/trial-balance");
  expect(res.status()).toBe(200);
  const tb = await res.json();
  expect(tb.balanced).toBe(true);
  expect(tb.totalDebit).toBe(tb.totalCredit);
  expect(BigInt(tb.totalDebit) > 0n).toBe(true);
});
