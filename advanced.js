(function () {
  const ADVANCED_STYLE_ID = "advanced-ui-style";
  const ADVANCED_FLAG = "advancedBound";
  const basePrintSaleReceipt = typeof printSaleReceipt === "function" ? printSaleReceipt : null;

  function injectAdvancedStyles() {
    if (document.getElementById(ADVANCED_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = ADVANCED_STYLE_ID;
    style.textContent = `
      .advanced-panel{margin-top:16px}.advanced-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.advanced-card{border:1px solid rgba(31,36,48,.08);border-radius:16px;padding:14px;background:#fff}.advanced-card strong{display:block;font-size:1.12rem;margin-top:6px}.advanced-inline{display:flex;flex-wrap:wrap;gap:10px;align-items:end}.advanced-inline .field{flex:1 1 160px}.advanced-inline .field.tight{flex:0 0 140px}.advanced-soft-box{margin-top:12px;padding:12px;border:1px dashed rgba(31,36,48,.12);border-radius:14px;background:rgba(245,247,250,.85)}.advanced-soft-box h4{margin:0 0 10px;font-size:.98rem}.advanced-muted{color:#6b7280;font-size:.92rem}.advanced-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.advanced-pill{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;background:rgba(22,119,255,.10);color:#0b57c6;font-size:.82rem}.advanced-pill.warn{background:rgba(239,108,51,.12);color:#c4501f}.ledger-list,.staff-list{display:grid;gap:10px}.ledger-item,.staff-item{border:1px solid rgba(31,36,48,.08);border-radius:14px;padding:12px;background:#fff}.bulk-price-panel{margin-top:14px;padding:14px;border-radius:16px;background:rgba(22,119,255,.05);border:1px solid rgba(22,119,255,.10)}.customer-ledger-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:12px}.sales-type-badge{padding:5px 10px;border-radius:999px;font-size:.78rem;background:rgba(31,157,117,.12);color:#11785a}.sales-type-badge.quote{background:rgba(22,119,255,.12);color:#0b57c6}.sales-type-badge.order{background:rgba(239,108,51,.12);color:#c4501f}.sales-type-badge.reservation{background:rgba(168,85,247,.12);color:#7c3aed}.sales-type-badge.cancelled,.sales-type-badge.returned{background:rgba(217,72,65,.12);color:#b52d28}.hidden-by-role{display:none!important}@media (max-width:768px){.advanced-inline{flex-direction:column;align-items:stretch}.advanced-inline .field,.advanced-inline .field.tight{flex:1 1 auto}}
    `;
    document.head.appendChild(style);
  }

  function hydrateAdvancedState() {
    state.settings = state.settings || {};
    state.settings.receiptMode = state.settings.receiptMode || "a4";
    state.settings.staffAccounts = Array.isArray(state.settings.staffAccounts) ? state.settings.staffAccounts : [];
    state.settings.defaultStaffId = state.settings.defaultStaffId || "";
    state.settings.defaultRecordType = state.settings.defaultRecordType || "sale";
    state.settings.offlineQueueEnabled = state.settings.offlineQueueEnabled !== false;
    state.syncQueue = Array.isArray(state.syncQueue) ? state.syncQueue : [];
    state.customerTransactions = Array.isArray(state.customerTransactions) ? state.customerTransactions : [];
    state.advanced = state.advanced || {};
    state.advanced.selectedCustomerId = state.advanced.selectedCustomerId || state.customers?.[0]?.id || "";
    if (!state.settings.staffAccounts.length) {
      state.settings.staffAccounts.push({ id: crypto.randomUUID(), name: state.settings.storeOwner || "Yonetici", role: "admin", pin: "" });
      state.settings.defaultStaffId = state.settings.staffAccounts[0].id;
    }
    state.products = (state.products || []).map((product) => ({ supplier: "", location: "", ...product, stockCode: product.stockCode || generateStockCode(product.wholesalePrice) }));
    state.customers = (state.customers || []).map((customer) => ({ email: "", address: "", taxNumber: "", creditLimit: 0, ...customer }));
    state.sales = (state.sales || []).map((sale) => ({ recordType: "sale", staffId: state.settings.defaultStaffId || "", status: "completed", customerImpactAmount: 0, ...sale }));
  }

  function ensureSupplierCatalog(value) {
    const name = String(value || "").trim();
    if (!name) return;
    state.suppliers = Array.isArray(state.suppliers) ? state.suppliers : [];
    if (!state.suppliers.includes(name)) state.suppliers.push(name);
  }

  function getActiveStaff() { return Array.isArray(state.settings.staffAccounts) ? state.settings.staffAccounts : []; }
  function getStaffName(staffId) { return getActiveStaff().find((staff) => staff.id === staffId)?.name || "Personel Yok"; }
  function getCurrentRole() { const activeId = state.settings.defaultStaffId || getActiveStaff()[0]?.id; return getActiveStaff().find((staff) => staff.id === activeId)?.role || "admin"; }
  function getSelectedCustomer() { const selectedId = state.advanced?.selectedCustomerId || state.customers?.[0]?.id; return state.customers.find((customer) => customer.id === selectedId) || state.customers[0] || null; }
  function recordTypeLabel(type) { if (type === "quote") return "Teklif"; if (type === "order") return "Sipariş"; if (type === "reservation") return "Rezerv"; return "Satış"; }
  function saleStatusLabel(status) { if (status === "returned") return "İade"; if (status === "cancelled") return "İptal"; if (status === "open") return "Açık"; return "Tamam"; }

  function ensureProductEditorFields() {
    const stockCodeField = document.querySelector("#stockCode")?.closest(".field");
    if (!stockCodeField || document.querySelector("#productSupplier")) return;
    stockCodeField.insertAdjacentHTML("afterend", `
      <div class="field"><label for="productSupplier">Tedarikçi</label><input id="productSupplier" name="supplier" type="text" placeholder="Firma veya tedarikçi adı"></div>
      <div class="field"><label for="productLocation">Raf / Depo Konumu</label><input id="productLocation" name="location" type="text" placeholder="Raf A3, Depo 2 gibi"></div>
    `);
  }

  function ensureCustomerFields() {
    const noteField = document.querySelector("#customerNote")?.closest(".field");
    if (!noteField || document.querySelector("#customerEmail")) return;
    noteField.insertAdjacentHTML("beforebegin", `
      <div class="field"><label for="customerEmail">E-posta</label><input id="customerEmail" name="email" type="email" placeholder="musteri@mail.com"></div>
      <div class="field"><label for="customerCreditLimit">Kredi Limiti</label><input id="customerCreditLimit" name="creditLimit" type="number" min="0" step="0.01" value="0"></div>
      <div class="field span-2"><label for="customerAddress">Adres</label><input id="customerAddress" name="address" type="text" placeholder="Teslimat veya fatura adresi"></div>
      <div class="field"><label for="customerTaxNumber">Vergi No</label><input id="customerTaxNumber" name="taxNumber" type="text" placeholder="Vergi / TC no"></div>
    `);
  }

  function ensureSalesFields() {
    const noteField = document.querySelector("#saleNote")?.closest(".field");
    if (!noteField || document.querySelector("#saleRecordType")) return;
    noteField.insertAdjacentHTML("beforebegin", `
      <div class="field"><label for="saleRecordType">Kayıt Türü</label><select id="saleRecordType" name="recordType"><option value="sale">Satış</option><option value="quote">Teklif</option><option value="order">Sipariş</option><option value="reservation">Rezerv</option></select></div>
      <div class="field"><label for="salesStaffSelect">Personel</label><select id="salesStaffSelect" name="staffId"></select></div>
    `);
  }

  function ensureBulkPricePanel() {
    const toolbar = document.querySelector("#bulkActionsBar");
    if (!toolbar || document.querySelector("#bulkPricePanel")) return;
    toolbar.insertAdjacentHTML("afterend", `
      <div id="bulkPricePanel" class="bulk-price-panel">
        <div class="advanced-inline">
          <div class="field tight"><label for="bulkPriceTarget">Hedef</label><select id="bulkPriceTarget"><option value="retail">Perakende</option><option value="wholesale">Toptan</option><option value="both">İkisi Birden</option></select></div>
          <div class="field tight"><label for="bulkPriceMode">İşlem</label><select id="bulkPriceMode"><option value="percent">Yüzde Artır / Azalt</option><option value="set">Direkt Değer Ver</option><option value="margin">Toptandan Perakende Hesapla</option></select></div>
          <div class="field"><label for="bulkPriceValue">Değer</label><input id="bulkPriceValue" type="number" step="0.01" placeholder="10, -5, 199 veya 35"></div>
          <div class="field tight"><button type="button" id="applyBulkPriceBtn" class="primary-btn">Toplu Uygula</button></div>
        </div>
        <p class="advanced-muted">Seçili ürünlere, seçim yoksa ekrandaki görünen ürünlere uygulanır.</p>
      </div>
    `);
  }

  function ensureCustomerLedgerPanel() {
    const view = document.querySelector("#view-customers .two-column");
    if (!view || document.querySelector("#customerLedgerPanel")) return;
    view.insertAdjacentHTML("beforeend", `<article class="panel" id="customerLedgerPanel"><div class="panel-head"><div><h3>Cari / Veresiye Takibi</h3><p class="muted">Seçili müşterinin hareketleri ve tahsilat işlemleri</p></div><span class="chip" id="customerLedgerChip">Hazır</span></div><div id="customerLedgerContent" class="list-stack"></div></article>`);
  }

  function ensureReportsPanel() {
    const view = document.querySelector("#view-reports");
    if (!view || document.querySelector("#advancedReportsPanel")) return;
    view.insertAdjacentHTML("beforeend", `<div id="advancedReportsPanel" class="panel advanced-panel"><div class="panel-head"><div><h3>Gelişmiş Raporlar</h3><p class="muted">Cari, personel, tedarikçi ve kayıt türü özetleri</p></div></div><div id="advancedReportsContent"></div></div>`);
  }

  function ensureSettingsPanel() {
    const grid = document.querySelector("#view-settings .panel-grid");
    if (!grid || document.querySelector("#advancedSettingsPanel")) return;
    grid.insertAdjacentHTML("beforeend", `
      <article class="panel" id="advancedSettingsPanel">
        <div class="panel-head"><div><h3>Özelleştirme ve Yetki</h3><p class="muted">Fiş modu, personel, çevrimdışı kuyruk ve rol ayarları</p></div></div>
        <div class="advanced-soft-box"><h4>Fiş ve Senkron</h4><div class="advanced-inline"><div class="field tight"><label for="receiptModeSetting">Fiş Modu</label><select id="receiptModeSetting"><option value="a4">A4 Bilgi Fişi</option><option value="thermal">80mm Termal Fiş</option></select></div><div class="field tight"><label for="syncQueueCount">Bekleyen Senkron</label><input id="syncQueueCount" type="text" readonly></div><div class="field tight"><button type="button" id="syncQueueNowBtn" class="ghost-btn">Şimdi Senkronla</button></div></div></div>
        <div class="advanced-soft-box"><h4>Personel Hesapları</h4><div class="advanced-inline"><div class="field"><label for="staffNameInput">Ad Soyad</label><input id="staffNameInput" type="text" placeholder="Personel adı"></div><div class="field tight"><label for="staffRoleInput">Rol</label><select id="staffRoleInput"><option value="cashier">Kasiyer</option><option value="manager">Yönetici</option><option value="admin">Admin</option></select></div><div class="field"><label for="staffPinInput">PIN</label><input id="staffPinInput" type="text" placeholder="İsteğe bağlı kısa PIN"></div><div class="field tight"><button type="button" id="addStaffBtn" class="primary-btn">Personel Ekle</button></div></div><div id="staffList" class="staff-list" style="margin-top:12px;"></div></div>
      </article>
    `);
  }

  function ensureAdvancedUI() {
    ensureProductEditorFields(); ensureCustomerFields(); ensureSalesFields(); ensureBulkPricePanel(); ensureCustomerLedgerPanel(); ensureReportsPanel(); ensureSettingsPanel();
  }

  function fillProductForm(product) {
    if (!product) return;
    document.querySelector("#productId").value = product.id || "";
    document.querySelector("#productName").value = product.name || "";
    document.querySelector("#productBarcode").value = product.barcode || "";
    document.querySelector("#productBrand").value = product.brand || "";
    document.querySelector("#retailPrice").value = Number(product.retailPrice || 0);
    document.querySelector("#wholesalePrice").value = Number(product.wholesalePrice || 0);
    document.querySelector("#stockQuantity").value = Number(product.stock || 0);
    document.querySelector("#stockCode").value = product.stockCode || generateStockCode(product.wholesalePrice);
    if (document.querySelector("#productSupplier")) document.querySelector("#productSupplier").value = product.supplier || "";
    if (document.querySelector("#productLocation")) document.querySelector("#productLocation").value = product.location || "";
    if (typeof updateProductImagePreview === "function") updateProductImagePreview(product.image || "");
    if (typeof updateBarcodePreview === "function") updateBarcodePreview(product.barcode || "");
    setView("product-editor");
  }

  function maybeOpenExistingProduct(barcodeValue) {
    const barcode = String(barcodeValue || "").trim();
    if (!barcode) return false;
    const currentId = document.querySelector("#productId")?.value;
    const existing = state.products.find((product) => product.barcode === barcode && product.id !== currentId);
    if (!existing) return false;
    fillProductForm(existing);
    if (typeof openProductQuickEdit === "function") openProductQuickEdit(existing.id);
    showToast("Ürün bulundu, stok kartı açıldı.");
    return true;
  }

  function ensureCustomerTransaction(customerId, type, amount, note, saleId = "") {
    const customer = state.customers.find((entry) => entry.id === customerId);
    if (!customer) return;
    const numericAmount = Number(amount || 0);
    customer.balance = Number(customer.balance || 0) + numericAmount;
    state.customerTransactions.unshift({ id: crypto.randomUUID(), customerId, type, amount: numericAmount, note: note || "", saleId, createdAt: new Date().toISOString() });
  }

  function getCustomerTransactions(customerId) {
    return state.customerTransactions.filter((entry) => entry.customerId === customerId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  function queueOfflineAction(type, payload) {
    if (state.settings.offlineQueueEnabled === false) return;
    state.syncQueue.unshift({ id: crypto.randomUUID(), type, payload, createdAt: new Date().toISOString() });
    saveState();
  }

  async function syncOfflineQueue() {
    if (!navigator.onLine || !shouldUseCloud() || !state.syncQueue.length) return;
    const remaining = [];
    for (const job of [...state.syncQueue].reverse()) {
      try {
        if (job.type === "product") await persistProductRemote(job.payload);
        if (job.type === "customer") await persistCustomerRemote(job.payload);
        if (job.type === "settings") await persistSettingsRemote();
        if (job.type === "inventory") await persistInventoryMovementRemote(job.payload.movement, job.payload.productStock);
        if (job.type === "sale") await completeSaleRemote(job.payload);
      } catch (error) {
        console.error(error);
        remaining.unshift(job);
      }
    }
    state.syncQueue = remaining;
    saveState();
    renderAdvancedSettingsUI();
  }

  async function persistOrQueue(type, payload, remoteFn) {
    if (!shouldUseCloud()) return true;
    if (!navigator.onLine) { queueOfflineAction(type, payload); return false; }
    try { await remoteFn(payload); return true; }
    catch (error) {
      console.error(error);
      if (!navigator.onLine || String(error?.message || "").toLowerCase().includes("fetch")) { queueOfflineAction(type, payload); return false; }
      throw error;
    }
  }

  async function advancedProductSubmit(event) {
    if (!event.target.matches("#productForm")) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const formData = new FormData(event.currentTarget);
    const id = formData.get("productId") || crypto.randomUUID();
    const wholesalePrice = Number(formData.get("wholesalePrice") || 0);
    const stockValue = formData.get("stock");
    const payload = { id, name: String(formData.get("name") || "").trim(), barcode: String(formData.get("barcode") || "").trim(), category: "", brand: String(formData.get("brand") || "").trim(), retailPrice: Number(formData.get("retailPrice") || 0), wholesalePrice, stock: stockValue === "" ? 0 : Number(stockValue || 0), criticalStock: 0, stockCode: generateStockCode(wholesalePrice), image: String(formData.get("image") || "").trim(), supplier: String(formData.get("supplier") || "").trim(), location: String(formData.get("location") || "").trim() };
    const duplicate = state.products.find((product) => product.barcode === payload.barcode && product.id !== payload.id);
    if (duplicate) { fillProductForm(duplicate); return showToast("Bu barkod zaten kayıtlı. Ürün kartı açıldı."); }
    const existingIndex = state.products.findIndex((product) => product.id === payload.id);
    ensureSupplierCatalog(payload.supplier);
    try {
      await persistOrQueue("product", payload, persistProductRemote);
      if (existingIndex >= 0) { state.products[existingIndex] = { ...state.products[existingIndex], ...payload }; showToast("Ürün güncellendi."); }
      else { state.products.unshift(payload); showToast("Ürün kaydedildi."); }
    } catch (error) { console.error(error); return showToast("Ürün kaydedilemedi."); }
    resetProductForm();
    if (document.querySelector("#productSupplier")) document.querySelector("#productSupplier").value = "";
    if (document.querySelector("#productLocation")) document.querySelector("#productLocation").value = "";
    renderAll();
  }

  async function advancedCustomerSubmit(event) {
    if (!event.target.matches("#customerForm")) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const formData = new FormData(event.currentTarget);
    const id = formData.get("customerId") || crypto.randomUUID();
    const payload = { id, name: String(formData.get("name") || "").trim(), type: String(formData.get("type") || "Perakende"), phone: String(formData.get("phone") || "").trim(), balance: Number(formData.get("balance") || 0), note: String(formData.get("note") || "").trim(), email: String(formData.get("email") || "").trim(), address: String(formData.get("address") || "").trim(), taxNumber: String(formData.get("taxNumber") || "").trim(), creditLimit: Number(formData.get("creditLimit") || 0) };
    const index = state.customers.findIndex((customer) => customer.id === payload.id);
    try {
      await persistOrQueue("customer", payload, persistCustomerRemote);
      if (index >= 0) { state.customers[index] = { ...state.customers[index], ...payload }; showToast("Müşteri güncellendi."); }
      else { state.customers.push(payload); showToast("Müşteri eklendi."); }
    } catch (error) { console.error(error); return showToast("Müşteri kaydedilemedi."); }
    state.advanced.selectedCustomerId = payload.id;
    resetCustomerForm();
    ["#customerEmail", "#customerAddress", "#customerTaxNumber"].forEach((selector) => { if (document.querySelector(selector)) document.querySelector(selector).value = ""; });
    if (document.querySelector("#customerCreditLimit")) document.querySelector("#customerCreditLimit").value = 0;
    renderAll();
  }

  async function advancedCompleteSale(event) {
    if (!event.target.matches("#completeSaleForm")) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!state.cart.length) return showToast("Sepet boş.");
    const discount = Number(document.querySelector("#discountInput")?.value || 0);
    const paymentMethod = document.querySelector("#paymentMethod")?.value || "Nakit";
    const customerId = document.querySelector("#saleCustomer")?.value || state.customers[0]?.id || "";
    const note = String(document.querySelector("#saleNote")?.value || "").trim();
    const paidAmount = Number(document.querySelector("#paidInput")?.value || 0);
    const subtotal = state.cart.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
    const total = Math.max(subtotal - discount, 0);
    const changeDue = Math.max(paidAmount - total, 0);
    const mode = document.querySelector("#saleMode")?.value || "retail";
    const recordType = document.querySelector("#saleRecordType")?.value || "sale";
    const staffId = document.querySelector("#salesStaffSelect")?.value || state.settings.defaultStaffId || "";
    const requiresStockDrop = recordType === "sale";
    for (const item of state.cart) {
      if (item.customItem || !requiresStockDrop) continue;
      const product = getProduct(item.productId);
      if (!product || Number(product.stock || 0) < Number(item.quantity || 0)) return showToast(`${item.name} için yeterli stok yok.`);
    }
    if (requiresStockDrop) {
      state.cart.forEach((item) => { if (!item.customItem) { const product = getProduct(item.productId); if (product) product.stock -= Number(item.quantity || 0); } });
    }
    const outstanding = Math.max(total - paidAmount, 0);
    const saleRecord = { id: crypto.randomUUID(), customerId, mode, discount, paymentMethod, paidAmount, changeDue, note, subtotal, total, createdAt: new Date().toISOString(), items: state.cart.map((item) => ({ ...item })), recordType, staffId, status: recordType === "sale" ? "completed" : "open", customerImpactAmount: (paymentMethod === "Veresiye" || outstanding > 0) ? outstanding : 0 };
    try { await persistOrQueue("sale", saleRecord, completeSaleRemote); }
    catch (error) { console.error(error); return showToast("Kayıt tamamlanamadı."); }
    if (saleRecord.customerImpactAmount > 0) ensureCustomerTransaction(customerId, "sale", saleRecord.customerImpactAmount, `${recordTypeLabel(recordType)} kaydı`, saleRecord.id);
    state.sales.unshift(saleRecord); state.cart = [];
    document.querySelector("#completeSaleForm")?.reset(); document.querySelector("#discountInput").value = 0; document.querySelector("#paidInput").value = 0; document.querySelector("#paymentMethod").value = "Nakit";
    renderAll(); if (typeof updatePaymentMethodButtons === "function") updatePaymentMethodButtons();
    showToast(`${recordTypeLabel(recordType)} kaydedildi.`);
  }

  async function advancedInventorySubmit(event) {
    if (!event.target.matches("#inventoryForm")) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const formData = new FormData(event.currentTarget);
    const productId = formData.get("productId"); const type = formData.get("type"); const quantity = Number(formData.get("quantity") || 0); const reason = String(formData.get("reason") || "").trim();
    const product = getProduct(productId);
    if (!product) return showToast("Ürün seçimi geçersiz.");
    if (type === "remove" && Number(product.stock || 0) < quantity) return showToast("Stok çıkışı için yeterli adet yok.");
    product.stock += type === "add" ? quantity : -quantity;
    const movement = { id: crypto.randomUUID(), productId, productName: product.name, type, quantity, reason, createdAt: new Date().toISOString() };
    try { await persistOrQueue("inventory", { movement, productStock: product.stock }, ({ movement, productStock }) => persistInventoryMovementRemote(movement, productStock)); state.inventoryMovements.unshift(movement); }
    catch (error) { console.error(error); return showToast("Stok hareketi kaydedilemedi."); }
    event.currentTarget.reset(); document.querySelector("#inventoryQuantity").value = 1; renderAll(); showToast("Stok hareketi kaydedildi.");
  }

  async function advancedSettingsSubmit(event) {
    if (!event.target.matches("#settingsForm")) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const formData = new FormData(event.currentTarget);
    state.settings = { ...state.settings, storeName: String(formData.get("storeName") || "").trim(), storeOwner: String(formData.get("storeOwner") || "").trim(), storeAddress: String(formData.get("storeAddress") || "").trim(), storePhone: String(formData.get("storePhone") || "").trim(), storeCurrency: String(formData.get("storeCurrency") || "TRY").trim() || "TRY", panelTitle: String(formData.get("panelTitle") || "OyuncakPOS").trim() || "OyuncakPOS", accentColor: formData.get("accentColor") || "orange", density: formData.get("density") || "comfortable", receiptMode: document.querySelector("#receiptModeSetting")?.value || state.settings.receiptMode || "a4" };
    try { await persistOrQueue("settings", { ...state.settings }, persistSettingsRemote); renderAll(); showToast("Ayarlar kaydedildi."); }
    catch (error) { console.error(error); showToast("Ayarlar kaydedilemedi."); }
  }

  function reverseSaleRecord(saleId, reverseType) {
    const sale = getSaleById(saleId); if (!sale) return showToast("Kayıt bulunamadı.");
    if (sale.status === "returned" || sale.status === "cancelled") return showToast("Bu kayıt zaten kapatılmış.");
    const shouldRestock = sale.recordType === "sale" && sale.status === "completed";
    if (shouldRestock) {
      sale.items.forEach((item) => {
        if (item.customItem) return;
        const product = getProduct(item.productId); if (!product) return;
        product.stock = Number(product.stock || 0) + Number(item.quantity || 0);
        state.inventoryMovements.unshift({ id: crypto.randomUUID(), productId: product.id, productName: product.name, type: "add", quantity: Number(item.quantity || 0), reason: reverseType === "returned" ? "Satış iadesi" : "Satış iptali", createdAt: new Date().toISOString() });
      });
    }
    if (sale.customerImpactAmount > 0) ensureCustomerTransaction(sale.customerId, "payment", -Math.abs(sale.customerImpactAmount), reverseType === "returned" ? "Satış iadesi" : "Satış iptali", sale.id);
    sale.status = reverseType; sale.reversedAt = new Date().toISOString(); saveState(); renderAll(); showToast(reverseType === "returned" ? "Satış iade edildi." : "Satış iptal edildi.");
  }

  function applyBulkPriceUpdate() {
    const target = document.querySelector("#bulkPriceTarget")?.value || "retail";
    const mode = document.querySelector("#bulkPriceMode")?.value || "percent";
    const value = Number(document.querySelector("#bulkPriceValue")?.value || 0);
    const targetIds = selectedProductIds.size ? [...selectedProductIds] : [...document.querySelectorAll("[data-select-product]")].map((input) => input.dataset.selectProduct);
    if (!targetIds.length) return showToast("Toplu işlem için ürün seç veya listeyi filtrele.");
    if (!Number.isFinite(value)) return showToast("Toplu fiyat değeri gir.");
    const applyValue = (current, baseWholesale) => mode === "set" ? value : mode === "margin" ? baseWholesale + (baseWholesale * value / 100) : current + (current * value / 100);
    targetIds.forEach((productId) => {
      const product = getProduct(productId); if (!product) return;
      if (target === "retail" || target === "both") product.retailPrice = Number(applyValue(Number(product.retailPrice || 0), Number(product.wholesalePrice || 0)).toFixed(2));
      if (target === "wholesale" || target === "both") { product.wholesalePrice = Number(applyValue(Number(product.wholesalePrice || 0), Number(product.wholesalePrice || 0)).toFixed(2)); product.stockCode = generateStockCode(product.wholesalePrice); }
      persistProductRemote(product).catch((error) => { console.error(error); queueOfflineAction("product", product); });
    });
    saveState(); renderAll(); showToast("Toplu fiyat güncelleme uygulandı.");
  }

  renderAdvancedSalesUI = function () {
    ensureAdvancedUI();
    const staffSelect = document.querySelector("#salesStaffSelect");
    if (staffSelect) { staffSelect.innerHTML = getActiveStaff().map((staff) => `<option value="${staff.id}">${escapeHtml(staff.name)} - ${escapeHtml(staff.role)}</option>`).join(""); staffSelect.value = state.settings.defaultStaffId || getActiveStaff()[0]?.id || ""; }
    const typeSelect = document.querySelector("#saleRecordType"); if (typeSelect) typeSelect.value = state.settings.defaultRecordType || "sale";
    const barcodeField = document.querySelector("#productBarcode");
    if (barcodeField && !barcodeField.dataset.advancedLookupBound) { barcodeField.dataset.advancedLookupBound = "1"; barcodeField.addEventListener("change", () => maybeOpenExistingProduct(barcodeField.value)); barcodeField.addEventListener("blur", () => maybeOpenExistingProduct(barcodeField.value)); }
  };

  renderAdvancedCustomerUI = function () {
    ensureAdvancedUI();
    const selectedCustomer = getSelectedCustomer();
    document.querySelectorAll("#customerList .customer-card").forEach((card, index) => {
      const customer = state.customers[index]; if (!customer || card.querySelector("[data-open-ledger]")) return;
      card.querySelector(".inline-actions")?.insertAdjacentHTML("beforeend", `<button type="button" data-open-ledger="${customer.id}">Cari</button>`);
    });
    const ledgerContent = document.querySelector("#customerLedgerContent"); const chip = document.querySelector("#customerLedgerChip");
    if (!ledgerContent || !selectedCustomer) return;
    const txs = getCustomerTransactions(selectedCustomer.id); const totalDebt = Math.max(Number(selectedCustomer.balance || 0), 0); const limitLeft = Math.max(Number(selectedCustomer.creditLimit || 0) - totalDebt, 0);
    if (chip) chip.textContent = selectedCustomer.name;
    ledgerContent.innerHTML = `<div class="customer-ledger-summary"><div class="advanced-card"><span class="advanced-muted">Güncel Bakiye</span><strong>${formatCurrency(selectedCustomer.balance || 0)}</strong></div><div class="advanced-card"><span class="advanced-muted">Kredi Limiti</span><strong>${formatCurrency(selectedCustomer.creditLimit || 0)}</strong></div><div class="advanced-card"><span class="advanced-muted">Kalan Limit</span><strong>${formatCurrency(limitLeft)}</strong></div></div><div class="advanced-soft-box"><h4>Tahsilat / Ödeme Gir</h4><div class="advanced-inline"><div class="field"><label for="ledgerPaymentAmount">Tutar</label><input id="ledgerPaymentAmount" type="number" min="0" step="0.01" placeholder="Tahsilat tutarı"></div><div class="field"><label for="ledgerPaymentNote">Not</label><input id="ledgerPaymentNote" type="text" placeholder="Açıklama"></div><div class="field tight"><button type="button" id="saveLedgerPaymentBtn" class="primary-btn">Tahsilat Kaydet</button></div></div></div><div class="advanced-soft-box"><h4>Son Hareketler</h4><div class="ledger-list">${txs.length ? txs.slice(0, 12).map((tx) => `<article class="ledger-item"><div class="list-item-head"><strong>${escapeHtml(tx.note || "Cari hareket")}</strong><span class="advanced-pill ${Number(tx.amount) > 0 ? "warn" : ""}">${Number(tx.amount) > 0 ? "+" : ""}${formatCurrency(tx.amount)}</span></div><div class="record-line muted"><span>${escapeHtml(formatDate(tx.createdAt))}</span><span>${escapeHtml(tx.type)}</span></div></article>`).join("") : '<article class="ledger-item"><span class="advanced-muted">Henüz cari hareket yok.</span></article>'}</div></div>`;
  };

  renderAdvancedReportsUI = function () {
    ensureAdvancedUI();
    const host = document.querySelector("#advancedReportsContent"); if (!host) return;
    const completedSales = state.sales.filter((sale) => sale.recordType === "sale" && sale.status === "completed");
    const totalReceivables = state.customers.reduce((sum, customer) => sum + Math.max(Number(customer.balance || 0), 0), 0);
    const lowStockCount = state.products.filter((product) => Number(product.stock || 0) <= 0).length;
    const counts = { quote: 0, order: 0, reservation: 0 }; state.sales.forEach((sale) => { if (counts[sale.recordType] !== undefined) counts[sale.recordType] += 1; });
    const brandTotals = {}; const supplierTotals = {}; const staffTotals = {};
    completedSales.forEach((sale) => { staffTotals[getStaffName(sale.staffId)] = (staffTotals[getStaffName(sale.staffId)] || 0) + Number(sale.total || 0); sale.items.forEach((item) => { const product = item.customItem ? null : getProduct(item.productId); if (product?.brand) brandTotals[product.brand] = (brandTotals[product.brand] || 0) + Number(item.quantity || 0); if (product?.supplier) supplierTotals[product.supplier] = (supplierTotals[product.supplier] || 0) + Number(item.quantity || 0); }); });
    const toList = (mapObject, suffix = "") => Object.entries(mapObject).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([label, value]) => `<article class="advanced-card"><span class="advanced-muted">${escapeHtml(label)}</span><strong>${suffix === "currency" ? formatCurrency(value) : `${value}${suffix}`}</strong></article>`).join("") || '<article class="advanced-card"><span class="advanced-muted">Henüz veri yok.</span></article>';
    host.innerHTML = `<div class="advanced-grid"><div class="advanced-card"><span class="advanced-muted">Toplam Cari Alacak</span><strong>${formatCurrency(totalReceivables)}</strong></div><div class="advanced-card"><span class="advanced-muted">Tükenen Ürün</span><strong>${lowStockCount}</strong></div><div class="advanced-card"><span class="advanced-muted">Teklif Sayısı</span><strong>${counts.quote}</strong></div><div class="advanced-card"><span class="advanced-muted">Sipariş Sayısı</span><strong>${counts.order}</strong></div><div class="advanced-card"><span class="advanced-muted">Rezerv Sayısı</span><strong>${counts.reservation}</strong></div></div><div class="advanced-grid" style="margin-top:14px;"><div class="advanced-soft-box"><h4>Personel Satışları</h4><div class="advanced-grid">${toList(staffTotals, "currency")}</div></div><div class="advanced-soft-box"><h4>Marka Hareketi</h4><div class="advanced-grid">${toList(brandTotals, " adet")}</div></div></div><div class="advanced-soft-box" style="margin-top:14px;"><h4>Tedarikçi Hareketi</h4><div class="advanced-grid">${toList(supplierTotals, " adet")}</div></div>`;
  };

  renderAdvancedSettingsUI = function () {
    ensureAdvancedUI();
    if (document.querySelector("#receiptModeSetting")) document.querySelector("#receiptModeSetting").value = state.settings.receiptMode || "a4";
    if (document.querySelector("#syncQueueCount")) document.querySelector("#syncQueueCount").value = `${state.syncQueue.length} bekliyor`;
    const staffList = document.querySelector("#staffList"); if (!staffList) return;
    staffList.innerHTML = getActiveStaff().map((staff) => `<article class="staff-item"><div class="list-item-head"><strong>${escapeHtml(staff.name)}</strong><span class="chip">${escapeHtml(staff.role)}</span></div><div class="record-line muted"><span>${staff.id === state.settings.defaultStaffId ? "Aktif varsayılan" : "Kayıtlı personel"}</span><span>${staff.pin ? `PIN: ${escapeHtml(staff.pin)}` : "PIN yok"}</span></div><div class="inline-actions"><button type="button" data-use-staff="${staff.id}">Aktif Yap</button>${getActiveStaff().length > 1 ? `<button type="button" data-delete-staff="${staff.id}">Sil</button>` : ""}</div></article>`).join("");
  };

  renderAdvancedRoleGating = function () {
    const hideForCashier = getCurrentRole() === "cashier";
    document.querySelectorAll("[data-delete-product], #bulkDeleteProductsBtn, #bulkDeleteProductsMenuBtn").forEach((node) => node.classList.toggle("hidden-by-role", hideForCashier));
    const settingsViewBtn = document.querySelector('.nav-tab[data-view="settings"]'); if (settingsViewBtn) settingsViewBtn.classList.toggle("hidden-by-role", hideForCashier);
  };

  function renderAdvancedSalesHistoryPage() {
    const list = document.querySelector("#salesHistoryPageList"); if (!list) return;
    const sales = filterSalesHistory();
    list.innerHTML = sales.length ? sales.map((sale) => `<article class="record-card"><div class="list-item-head"><label class="bulk-check-label"><input type="checkbox" data-select-sale="${sale.id}" ${selectedSaleIds.has(sale.id) ? "checked" : ""}><strong>${recordTypeLabel(sale.recordType || "sale")}</strong></label><div class="advanced-actions"><span class="sales-type-badge ${(sale.recordType || "sale")} ${(sale.status || "completed")}">${saleStatusLabel(sale.status || "completed")}</span><span>${formatCurrency(sale.total)}</span></div></div><div class="record-line muted"><span>${escapeHtml(getCustomerName(sale.customerId))} / ${escapeHtml(sale.paymentMethod)}</span><span>${escapeHtml(formatDate(sale.createdAt))}</span></div><div class="record-line muted"><span>Personel: ${escapeHtml(getStaffName(sale.staffId))}</span><span>${sale.customerImpactAmount ? `Açık Hesap: ${formatCurrency(sale.customerImpactAmount)}` : "Kapalı"}</span></div><p class="muted">${sale.items.map((item) => `${item.name} x${item.quantity}`).join(", ")}</p><div class="inline-actions"><button type="button" data-sale-detail="${sale.id}">Detay</button><button type="button" data-print-sale="${sale.id}">Yazdır</button><button type="button" data-email-sale="${sale.id}">Mail Gönder</button><button type="button" data-whatsapp-sale="${sale.id}">WhatsApp</button>${(sale.status || "completed") === "completed" ? `<button type="button" data-return-sale="${sale.id}">İade</button><button type="button" data-cancel-sale="${sale.id}">İptal</button>` : ""}</div></article>`).join("") : '<article class="record-card"><span class="muted">Filtreye uygun kayıt bulunamadı.</span></article>';
  }

  function printThermalReceipt(saleId) {
    const sale = getSaleById(saleId); if (!sale) return showToast("Kayıt bulunamadı.");
    const customer = state.customers.find((item) => item.id === sale.customerId); const printWindow = window.open("", "_blank", "width=420,height=900"); if (!printWindow) return showToast("Yazdırma penceresi açılamadı.");
    const items = sale.items.map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${Number(item.quantity || 0)}</td><td style="text-align:right;">${formatCurrency(item.price * item.quantity)}</td></tr>`).join("");
    printWindow.document.write(`<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><title>Termal Fiş</title><style>body{font-family:Arial,sans-serif;margin:0;padding:10px;color:#111}.receipt-thermal{width:78mm;margin:0 auto;font-size:12px}.line{border-top:1px dashed #111;margin:8px 0}table{width:100%;border-collapse:collapse}td,th{padding:4px 0;text-align:left;vertical-align:top}.tot{display:flex;justify-content:space-between;margin-top:4px;font-weight:700}</style></head><body><div class="receipt-thermal"><h2>${escapeHtml(state.settings.storeName || "OyuncakPOS")}</h2><p>${recordTypeLabel(sale.recordType || "sale")} / ${sale.mode === "wholesale" ? "Toptan" : "Perakende"}</p><p>${escapeHtml(formatDate(sale.createdAt))}</p><p>Müşteri: ${escapeHtml(customer?.name || "Genel Müşteri")}</p><div class="line"></div><table><thead><tr><th>Ürün</th><th>Adet</th><th style="text-align:right;">Tutar</th></tr></thead><tbody>${items}</tbody></table><div class="line"></div><div class="tot"><span>Toplam</span><span>${formatCurrency(sale.total)}</span></div>${sale.discount ? `<div class="tot"><span>İndirim</span><span>${formatCurrency(sale.discount)}</span></div>` : ""}${sale.customerImpactAmount ? `<div class="tot"><span>Açık Hesap</span><span>${formatCurrency(sale.customerImpactAmount)}</span></div>` : ""}${sale.note ? `<div class="line"></div><p>Not: ${escapeHtml(sale.note)}</p>` : ""}</div><script>window.onload=function(){window.print();};</script></body></html>`);
    printWindow.document.close();
  }

  printSaleReceipt = function (saleId) { return (state.settings.receiptMode || "a4") === "thermal" ? printThermalReceipt(saleId) : (basePrintSaleReceipt ? basePrintSaleReceipt(saleId) : undefined); };
  renderSalesHistoryPage = renderAdvancedSalesHistoryPage;

  function bindAdvancedEvents() {
    if (document.body.dataset[ADVANCED_FLAG]) return;
    document.body.dataset[ADVANCED_FLAG] = "1";
    document.addEventListener("submit", advancedProductSubmit, true);
    document.addEventListener("submit", advancedCustomerSubmit, true);
    document.addEventListener("submit", advancedCompleteSale, true);
    document.addEventListener("submit", advancedInventorySubmit, true);
    document.addEventListener("submit", advancedSettingsSubmit, true);

    document.addEventListener("click", (event) => {
      const target = event.target.closest("button");
      if (!target) return;
      if (target.id === "applyBulkPriceBtn") applyBulkPriceUpdate();
      if (target.id === "saveLedgerPaymentBtn") {
        const customer = getSelectedCustomer(); if (!customer) return showToast("Müşteri seç.");
        const amount = Number(document.querySelector("#ledgerPaymentAmount")?.value || 0); const note = String(document.querySelector("#ledgerPaymentNote")?.value || "Tahsilat").trim();
        if (!Number.isFinite(amount) || amount <= 0) return showToast("Tahsilat tutarı gir.");
        ensureCustomerTransaction(customer.id, "payment", -Math.abs(amount), note); persistCustomerRemote(customer).catch((error) => { console.error(error); queueOfflineAction("customer", customer); });
        document.querySelector("#ledgerPaymentAmount").value = ""; document.querySelector("#ledgerPaymentNote").value = ""; renderAll(); showToast("Tahsilat kaydedildi.");
      }
      if (target.id === "addStaffBtn") {
        const name = String(document.querySelector("#staffNameInput")?.value || "").trim(); const role = document.querySelector("#staffRoleInput")?.value || "cashier"; const pin = String(document.querySelector("#staffPinInput")?.value || "").trim();
        if (!name) return showToast("Personel adı gir.");
        state.settings.staffAccounts.push({ id: crypto.randomUUID(), name, role, pin }); document.querySelector("#staffNameInput").value = ""; document.querySelector("#staffPinInput").value = ""; saveState(); renderAll(); showToast("Personel eklendi.");
      }
      if (target.id === "syncQueueNowBtn") syncOfflineQueue().then(() => showToast("Senkron denemesi tamamlandı.")).catch((error) => { console.error(error); showToast("Senkron sırasında sorun oluştu."); });
      if (target.dataset.openLedger) { state.advanced.selectedCustomerId = target.dataset.openLedger; renderAdvancedCustomerUI(); }
      if (target.dataset.useStaff) { state.settings.defaultStaffId = target.dataset.useStaff; saveState(); renderAll(); showToast("Aktif personel değiştirildi."); }
      if (target.dataset.deleteStaff) { state.settings.staffAccounts = state.settings.staffAccounts.filter((staff) => staff.id !== target.dataset.deleteStaff); if (!state.settings.staffAccounts.find((staff) => staff.id === state.settings.defaultStaffId)) state.settings.defaultStaffId = state.settings.staffAccounts[0]?.id || ""; saveState(); renderAll(); showToast("Personel silindi."); }
      if (target.dataset.returnSale) reverseSaleRecord(target.dataset.returnSale, "returned");
      if (target.dataset.cancelSale) reverseSaleRecord(target.dataset.cancelSale, "cancelled");
    });

    document.addEventListener("click", (event) => {
      const editCustomerBtn = event.target.closest("[data-edit-customer]"); if (!editCustomerBtn) return;
      const customer = state.customers.find((entry) => entry.id === editCustomerBtn.dataset.editCustomer); if (!customer) return;
      state.advanced.selectedCustomerId = customer.id;
      if (document.querySelector("#customerEmail")) document.querySelector("#customerEmail").value = customer.email || "";
      if (document.querySelector("#customerAddress")) document.querySelector("#customerAddress").value = customer.address || "";
      if (document.querySelector("#customerTaxNumber")) document.querySelector("#customerTaxNumber").value = customer.taxNumber || "";
      if (document.querySelector("#customerCreditLimit")) document.querySelector("#customerCreditLimit").value = Number(customer.creditLimit || 0);
      renderAdvancedCustomerUI();
    }, true);

    window.addEventListener("online", () => { syncOfflineQueue().catch((error) => console.error(error)); });
  }

  injectAdvancedStyles();
  hydrateAdvancedState();
  ensureAdvancedUI();
  bindAdvancedEvents();
  renderAll();
  syncOfflineQueue().catch((error) => console.error(error));
})();
