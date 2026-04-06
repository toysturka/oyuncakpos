const STORAGE_KEY = "oyuncakpos-data-v1";
const VIEW_STORAGE_KEY = "oyuncakpos-active-view";
let selectedProductIds = new Set();
let supabaseClient = null;
let activeStoreId = null;
let activeUser = null;
let isCloudMode = false;
let scannerStream = null;
let scannerInterval = null;
let scannerTargetInputId = null;
let scannerMode = null;
let barcodeDetectorInstance = null;

const defaultState = {
  settings: {
    storeName: "OyuncakPOS Magaza",
    storeOwner: "",
    storeAddress: "",
    storePhone: "",
    storeCurrency: "TRY"
  },
  products: [],
  customers: [
    {
      id: crypto.randomUUID(),
      name: "Genel Musteri",
      type: "Perakende",
      phone: "",
      balance: 0,
      note: ""
    }
  ],
  sales: [],
  inventoryMovements: [],
  cart: []
};

let state = loadState();
let toastTimer;

const pageTitles = {
  dashboard: "Genel Bakis",
  sales: "Satis Ekrani",
  products: "Urunler",
  "product-editor": "Urun Ekle",
  inventory: "Stok Hareketi",
  customers: "Musteriler",
  reports: "Raporlar",
  settings: "Ayarlar"
};

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved) return structuredClone(defaultState);
    return {
      ...structuredClone(defaultState),
      ...saved,
      settings: { ...defaultState.settings, ...(saved.settings || {}) },
      cart: saved.cart || []
    };
  } catch (error) {
    console.error(error);
    return structuredClone(defaultState);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function saveActiveView(viewName) {
  localStorage.setItem(VIEW_STORAGE_KEY, viewName);
}

function loadActiveView() {
  return localStorage.getItem(VIEW_STORAGE_KEY) || "dashboard";
}

function hasCloudConfig() {
  return Boolean(window.APP_CONFIG?.supabaseUrl && window.APP_CONFIG?.supabaseAnonKey && window.supabase?.createClient);
}

function shouldUseCloud() {
  return Boolean(isCloudMode && supabaseClient && activeStoreId && activeUser);
}

function updateConnectionBadge(label, isOnline = false) {
  const badge = document.querySelector("#connectionBadge");
  const logoutButton = document.querySelector("#logoutBtn");
  if (!badge) return;
  badge.textContent = label;
  badge.style.background = isOnline ? "rgba(31, 157, 117, 0.14)" : "rgba(31, 36, 48, 0.08)";
  badge.style.color = isOnline ? "#1f9d75" : "#6a7280";
  if (logoutButton) logoutButton.hidden = !isOnline;
}

function setAuthOverlayVisible(visible, message = "") {
  const overlay = document.querySelector("#authOverlay");
  const authMessage = document.querySelector("#authMessage");
  overlay.classList.toggle("hidden-overlay", !visible);
  authMessage.textContent = message;
}

function setScannerOverlayVisible(visible, message = "Kamerayi barkoda dogru tut.") {
  const overlay = document.querySelector("#scannerOverlay");
  const scannerMessage = document.querySelector("#scannerMessage");
  overlay.classList.toggle("hidden-overlay", !visible);
  scannerMessage.textContent = message;
}

function mapRemoteProduct(product) {
  return {
    id: product.id,
    name: product.name,
    barcode: product.barcode,
    category: product.category || "",
    brand: product.brand || "",
    retailPrice: Number(product.retail_price || 0),
    wholesalePrice: Number(product.wholesale_price || 0),
    stock: Number(product.stock || 0),
    criticalStock: Number(product.critical_stock || 0),
    image: product.image_url || ""
  };
}

function mapRemoteCustomer(customer) {
  return {
    id: customer.id,
    name: customer.name,
    type: customer.type,
    phone: customer.phone || "",
    balance: Number(customer.balance || 0),
    note: customer.note || ""
  };
}

async function initSupabaseAuth() {
  if (!hasCloudConfig()) {
    updateConnectionBadge("Yerel Mod");
    return;
  }

  supabaseClient = window.supabase.createClient(window.APP_CONFIG.supabaseUrl, window.APP_CONFIG.supabaseAnonKey);

  const { data: sessionData } = await supabaseClient.auth.getSession();
  await bootstrapCloudSession(sessionData.session);

  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    await bootstrapCloudSession(session);
  });
}

async function bootstrapCloudSession(session) {
  if (!session?.user) {
    isCloudMode = false;
    activeUser = null;
    activeStoreId = null;
    updateConnectionBadge("Cloud Girisi Gerekli");
    setAuthOverlayVisible(true, "Supabase kullaniciyla giris yap.");
    return;
  }

  activeUser = session.user;
  updateConnectionBadge("Cloud Baglaniyor...");

  const { data: store, error: storeError } = await supabaseClient
    .from("stores")
    .select("id,name,slug")
    .eq("slug", window.APP_CONFIG.storeSlug)
    .maybeSingle();

  if (storeError || !store) {
    isCloudMode = false;
    activeStoreId = null;
    updateConnectionBadge("Magaza Bulunamadi");
    setAuthOverlayVisible(true, "Magaza kaydi bulunamadi. SQL adimlarini kontrol et.");
    return;
  }

  activeStoreId = store.id;
  isCloudMode = true;
  setAuthOverlayVisible(false);
  updateConnectionBadge(`Cloud: ${store.name}`, true);
  await loadRemoteState();
}

async function loadRemoteState() {
  if (!shouldUseCloud()) return;

  const [settingsRes, productsRes, customersRes, salesRes, saleItemsRes, inventoryRes] = await Promise.all([
    supabaseClient.from("store_settings").select("*").eq("store_id", activeStoreId).maybeSingle(),
    supabaseClient.from("products").select("*").eq("store_id", activeStoreId).order("created_at", { ascending: false }),
    supabaseClient.from("customers").select("*").eq("store_id", activeStoreId).order("created_at", { ascending: true }),
    supabaseClient.from("sales").select("*").eq("store_id", activeStoreId).order("created_at", { ascending: false }),
    supabaseClient.from("sale_items").select("*"),
    supabaseClient.from("inventory_movements").select("*").eq("store_id", activeStoreId).order("created_at", { ascending: false })
  ]);

  if (settingsRes.error || productsRes.error || customersRes.error || salesRes.error || saleItemsRes.error || inventoryRes.error) {
    console.error(settingsRes.error || productsRes.error || customersRes.error || salesRes.error || saleItemsRes.error || inventoryRes.error);
    showToast("Bulut verileri yuklenemedi.");
    return;
  }

  const itemsBySaleId = {};
  saleItemsRes.data.forEach((item) => {
    if (!itemsBySaleId[item.sale_id]) itemsBySaleId[item.sale_id] = [];
    itemsBySaleId[item.sale_id].push({
      productId: item.product_id,
      name: item.name,
      barcode: item.barcode,
      quantity: Number(item.quantity || 0),
      price: Number(item.price || 0),
      mode: item.mode
    });
  });

  state = {
    settings: {
      storeName: settingsRes.data?.store_name || "OyuncakPOS Magaza",
      storeOwner: settingsRes.data?.store_owner || "",
      storeAddress: settingsRes.data?.store_address || "",
      storePhone: settingsRes.data?.store_phone || "",
      storeCurrency: settingsRes.data?.store_currency || "TRY"
    },
    products: productsRes.data.map(mapRemoteProduct),
    customers: customersRes.data.map(mapRemoteCustomer),
    sales: salesRes.data.map((sale) => ({
      id: sale.id,
      customerId: sale.customer_id,
      mode: sale.mode,
      discount: Number(sale.discount || 0),
      paymentMethod: sale.payment_method,
      paidAmount: Number(sale.paid_amount || 0),
      changeDue: Number(sale.change_due || 0),
      note: sale.note || "",
      subtotal: Number(sale.subtotal || 0),
      total: Number(sale.total || 0),
      createdAt: sale.created_at,
      items: itemsBySaleId[sale.id] || []
    })),
    inventoryMovements: inventoryRes.data.map((movement) => ({
      id: movement.id,
      productId: movement.product_id,
      productName: movement.product_name,
      type: movement.type,
      quantity: Number(movement.quantity || 0),
      reason: movement.reason || "",
      createdAt: movement.created_at
    })),
    cart: []
  };

  renderAll();
}

function formatCurrency(value) {
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: state.settings.storeCurrency || "TRY",
    maximumFractionDigits: 2
  }).format(Number(value || 0));
}

function formatDate(value) {
  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function getStatus(stock, criticalStock) {
  if (stock <= 0) return { label: "Tukendi", className: "danger" };
  if (stock <= criticalStock) return { label: "Kritik", className: "warn" };
  return { label: "Normal", className: "ok" };
}

function getCustomerName(customerId) {
  return state.customers.find((customer) => customer.id === customerId)?.name || "Genel Musteri";
}

function getProduct(productId) {
  return state.products.find((product) => product.id === productId);
}

async function updateProductPrices(productId, retailPrice, wholesalePrice) {
  const product = getProduct(productId);
  if (!product) {
    showToast("Urun bulunamadi.");
    return false;
  }

  const retail = Number(retailPrice);
  const wholesale = Number(wholesalePrice);

  if (Number.isNaN(retail) || Number.isNaN(wholesale) || retail < 0 || wholesale < 0) {
    showToast("Fiyatlar gecerli bir sayi olmali.");
    return false;
  }

  product.retailPrice = retail;
  product.wholesalePrice = wholesale;
  try {
    await persistProductRemote(product);
  } catch (error) {
    console.error(error);
    showToast("Fiyatlar buluta kaydedilemedi.");
    return false;
  }
  renderAll();
  showToast(`${product.name} fiyatlari guncellendi.`);
  return true;
}

async function saveAllVisiblePriceEdits() {
  const retailInputs = [...document.querySelectorAll("[data-inline-retail]")];
  let changedCount = 0;

  for (const retailInput of retailInputs) {
    const productId = retailInput.dataset.inlineRetail;
    const wholesaleInput = document.querySelector(`[data-inline-wholesale="${productId}"]`);
    const product = getProduct(productId);
    if (!wholesaleInput || !product) continue;

    const retailValue = Number(retailInput.value);
    const wholesaleValue = Number(wholesaleInput.value);
    if (Number.isNaN(retailValue) || Number.isNaN(wholesaleValue) || retailValue < 0 || wholesaleValue < 0) {
      showToast("Kayit oncesi gecersiz fiyatlari duzelt.");
      return;
    }

    if (retailValue !== Number(product.retailPrice) || wholesaleValue !== Number(product.wholesalePrice)) {
      product.retailPrice = retailValue;
      product.wholesalePrice = wholesaleValue;
      try {
        await persistProductRemote(product);
      } catch (error) {
        console.error(error);
        showToast("Toplu fiyat kaydi sirasinda hata oldu.");
        return;
      }
      changedCount += 1;
    }
  }

  if (!changedCount) {
    showToast("Kaydedilecek fiyat degisikligi yok.");
    return;
  }

  renderAll();
  showToast(`${changedCount} urunun fiyatlari kaydedildi.`);
}

function getSelectedProducts() {
  return state.products.filter((product) => selectedProductIds.has(product.id));
}

function syncSelectedProductsWithState() {
  const validIds = new Set(state.products.map((product) => product.id));
  selectedProductIds = new Set([...selectedProductIds].filter((id) => validIds.has(id)));
}

async function startBarcodeScanner(targetInputId, mode) {
  if (!("mediaDevices" in navigator) || !navigator.mediaDevices.getUserMedia) {
    return showToast("Bu cihaz kamerayi desteklemiyor.");
  }

  if (!("BarcodeDetector" in window)) {
    return showToast("Bu tarayicida barkod tarama desteklenmiyor. Telefonunda Chrome veya Safari ile https uzerinden ac.");
  }

  try {
    scannerTargetInputId = targetInputId;
    scannerMode = mode;
    barcodeDetectorInstance = new window.BarcodeDetector({
      formats: ["ean_13", "ean_8", "code_128", "upc_a", "upc_e"]
    });
    scannerStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });
    const video = document.querySelector("#scannerVideo");
    video.srcObject = scannerStream;
    setScannerOverlayVisible(true);

    scannerInterval = setInterval(async () => {
      if (!video.videoWidth) return;
      try {
        const barcodes = await barcodeDetectorInstance.detect(video);
        if (!barcodes.length) return;
        const rawValue = barcodes[0].rawValue?.trim();
        if (!rawValue) return;
        stopBarcodeScanner();
        applyScannedBarcode(rawValue);
      } catch (error) {
        console.error(error);
      }
    }, 500);
  } catch (error) {
    console.error(error);
    setScannerOverlayVisible(false);
    showToast("Kamera acilamadi. Telefonunda kamera izni ver.");
  }
}

function stopBarcodeScanner() {
  if (scannerInterval) {
    clearInterval(scannerInterval);
    scannerInterval = null;
  }
  if (scannerStream) {
    scannerStream.getTracks().forEach((track) => track.stop());
    scannerStream = null;
  }
  const video = document.querySelector("#scannerVideo");
  if (video) video.srcObject = null;
  setScannerOverlayVisible(false);
}

function applyScannedBarcode(rawValue) {
  const input = document.querySelector(`#${scannerTargetInputId}`);
  if (!input) return;
  input.value = rawValue;

  if (scannerMode === "sale-add") {
    document.querySelector("#saleForm").requestSubmit();
  } else if (scannerMode === "search") {
    renderProducts();
    const product = state.products.find((item) => item.barcode === rawValue);
    if (product) showToast(`${product.name} bulundu.`);
    else showToast("Bu barkodla urun bulunamadi.");
  } else if (scannerMode === "editor") {
    updateBarcodePreview(rawValue);
    showToast("Barkod alana eklendi.");
  }
}

function refreshInlinePriceChangeState() {
  const retailInputs = [...document.querySelectorAll("[data-inline-retail]")];
  retailInputs.forEach((retailInput) => {
    const productId = retailInput.dataset.inlineRetail;
    const wholesaleInput = document.querySelector(`[data-inline-wholesale="${productId}"]`);
    const product = getProduct(productId);
    if (!wholesaleInput || !product) return;

    const retailChanged = Number(retailInput.value) !== Number(product.retailPrice);
    const wholesaleChanged = Number(wholesaleInput.value) !== Number(product.wholesalePrice);
    retailInput.closest(".price-chip")?.classList.toggle("changed", retailChanged);
    wholesaleInput.closest(".price-chip")?.classList.toggle("changed", wholesaleChanged);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeBarcode(barcode) {
  return String(barcode || "").replace(/\D/g, "");
}

function computeEan13Checksum(firstTwelveDigits) {
  const digits = firstTwelveDigits.split("").map(Number);
  const sum = digits.reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 1 : 3), 0);
  return String((10 - (sum % 10)) % 10);
}

function getPrintableEan13(barcode) {
  const digits = normalizeBarcode(barcode);
  if (digits.length === 12) return digits + computeEan13Checksum(digits);
  if (digits.length === 13) {
    const checksum = computeEan13Checksum(digits.slice(0, 12));
    return checksum === digits[12] ? digits : null;
  }
  return null;
}

function generateEan13Svg(barcode) {
  const value = getPrintableEan13(barcode);
  if (!value) return "";

  const parityMap = {
    0: "LLLLLL",
    1: "LLGLGG",
    2: "LLGGLG",
    3: "LLGGGL",
    4: "LGLLGG",
    5: "LGGLLG",
    6: "LGGGLL",
    7: "LGLGLG",
    8: "LGLGGL",
    9: "LGGLGL"
  };

  const encodings = {
    L: ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"],
    G: ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"],
    R: ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"]
  };

  const leftParity = parityMap[value[0]];
  let bits = "101";
  for (let i = 1; i <= 6; i += 1) {
    bits += encodings[leftParity[i - 1]][Number(value[i])];
  }
  bits += "01010";
  for (let i = 7; i <= 12; i += 1) {
    bits += encodings.R[Number(value[i])];
  }
  bits += "101";

  const moduleWidth = 2;
  const width = bits.length * moduleWidth;
  const height = 92;
  let bars = "";

  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i] === "1") {
      const isGuard = i < 3 || (i >= 45 && i < 50) || i >= bits.length - 3;
      const barHeight = isGuard ? height : height - 10;
      bars += `<rect x="${i * moduleWidth}" y="0" width="${moduleWidth}" height="${barHeight}" fill="#111"></rect>`;
    }
  }

  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height + 22}" width="${width}" height="${height + 22}" role="img" aria-label="EAN-13 barcode ${value}">
      <rect width="${width}" height="${height + 22}" fill="#fff"></rect>
      ${bars}
      <text x="0" y="${height + 18}" font-size="16" font-family="Arial, sans-serif" fill="#111">${value[0]}</text>
      <text x="${moduleWidth * 14}" y="${height + 18}" font-size="16" font-family="Arial, sans-serif" fill="#111">${value.slice(1, 7)}</text>
      <text x="${moduleWidth * 58}" y="${height + 18}" font-size="16" font-family="Arial, sans-serif" fill="#111">${value.slice(7)}</text>
    </svg>
  `;
}

function getProductLabelMarkup(product) {
  const svg = generateEan13Svg(product.barcode);
  if (!svg) {
    return `<div class="barcode-label"><h4>${escapeHtml(product.name)}</h4><p>Yazdirma icin 12 veya 13 haneli sayisal barkod gerekir.</p></div>`;
  }

  return `
    <div class="barcode-label">
      <h4>${escapeHtml(product.name)}</h4>
      ${product.image ? `<img class="product-thumb" src="${product.image}" alt="${escapeHtml(product.name)}">` : ""}
      ${svg}
      <div class="barcode-meta">
        <span>${escapeHtml(product.category || "Kategori yok")}</span>
        <strong>${formatCurrency(product.retailPrice)}</strong>
      </div>
    </div>
  `;
}

function updateProductImagePreview(imageData) {
  const preview = document.querySelector("#productImagePreview");
  const removeButton = document.querySelector("#removeProductImageBtn");
  if (imageData) {
    preview.src = imageData;
    preview.classList.remove("hidden-preview");
    removeButton.classList.remove("hidden-preview");
  } else {
    preview.removeAttribute("src");
    preview.classList.add("hidden-preview");
    removeButton.classList.add("hidden-preview");
  }
}

function updateBarcodePreview(barcodeValue) {
  const preview = document.querySelector("#productBarcodePreview");
  const productName = document.querySelector("#productName").value.trim() || "Yeni Urun";
  const retailPrice = Number(document.querySelector("#retailPrice").value || 0);
  const image = document.querySelector("#productImageData").value;
  const mockProduct = {
    name: productName,
    barcode: barcodeValue,
    retailPrice,
    category: document.querySelector("#productCategory").value.trim(),
    image
  };
  preview.innerHTML = generateEan13Svg(barcodeValue)
    ? getProductLabelMarkup(mockProduct)
    : "12 veya 13 haneli barkod girdiginde burada etiket onizlemesi olusur.";
}

function recalcCart() {
  const discount = Number(document.querySelector("#discountInput")?.value || 0);
  const paidAmount = Number(document.querySelector("#paidInput")?.value || 0);
  const subtotal = state.cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const total = Math.max(subtotal - discount, 0);
  const changeDue = Math.max(paidAmount - total, 0);

  document.querySelector("#subtotalValue").textContent = formatCurrency(subtotal);
  document.querySelector("#discountValue").textContent = formatCurrency(discount);
  document.querySelector("#grandTotalValue").textContent = formatCurrency(total);
  const topTotal = document.querySelector("#grandTotalTopValue");
  const paidDisplay = document.querySelector("#paidValueDisplay");
  const changeDisplay = document.querySelector("#changeDueValue");
  if (topTotal) topTotal.textContent = formatCurrency(total);
  if (paidDisplay) paidDisplay.textContent = formatCurrency(paidAmount);
  if (changeDisplay) changeDisplay.textContent = formatCurrency(changeDue);
}

function setView(viewName) {
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  document.querySelectorAll(".nav-tab").forEach((button) => button.classList.remove("active"));

  document.querySelector(`#view-${viewName}`).classList.add("active");
  document.querySelector(`.nav-tab[data-view="${viewName}"]`).classList.add("active");
  document.querySelector("#pageTitle").textContent = pageTitles[viewName];
  saveActiveView(viewName);
}

function renderDashboard() {
  const todaySales = state.sales.filter((sale) => {
    const saleDate = new Date(sale.createdAt);
    const now = new Date();
    return saleDate.toDateString() === now.toDateString();
  });

  const dailyRevenue = todaySales.reduce((sum, sale) => sum + sale.total, 0);
  const totalStock = state.products.reduce((sum, product) => sum + Number(product.stock), 0);
  const criticalCount = state.products.filter((product) => product.stock <= product.criticalStock).length;

  const cards = [
    { label: "Toplam Urun Cesidi", value: state.products.length },
    { label: "Toplam Stok", value: totalStock },
    { label: "Bugun Ciro", value: formatCurrency(dailyRevenue) },
    { label: "Kritik Stok", value: criticalCount }
  ];

  document.querySelector("#dashboardStats").innerHTML = cards
    .map((card) => `<article class="stat-card"><p>${card.label}</p><strong>${card.value}</strong></article>`)
    .join("");

  document.querySelector("#miniProductCount").textContent = state.products.length;
  document.querySelector("#miniCriticalCount").textContent = criticalCount;
  document.querySelector("#miniSalesCount").textContent = todaySales.length;

  const criticalProducts = state.products
    .filter((product) => product.stock <= product.criticalStock)
    .sort((a, b) => a.stock - b.stock);

  document.querySelector("#criticalStockList").innerHTML = criticalProducts.length
    ? criticalProducts
        .map((product) => {
          const status = getStatus(product.stock, product.criticalStock);
          return `
            <article class="record-card">
              <div class="list-item-head">
                <strong>${product.name}</strong>
                <span class="status ${status.className}">${status.label}</span>
              </div>
              <div class="record-line muted">
                <span>Barkod: ${product.barcode}</span>
                <span>Stok: ${product.stock}</span>
              </div>
            </article>
          `;
        })
        .join("")
    : `<article class="record-card"><span class="muted">Kritik stokta urun yok.</span></article>`;

  const activities = [
    ...state.sales.map((sale) => ({
      type: "Satis",
      label: `${sale.mode === "wholesale" ? "Toptan" : "Perakende"} satis`,
      amount: formatCurrency(sale.total),
      date: sale.createdAt
    })),
    ...state.inventoryMovements.map((movement) => ({
      type: "Stok",
      label: `${movement.type === "add" ? "Stok girisi" : "Stok cikisi"} - ${movement.productName}`,
      amount: `${movement.type === "add" ? "+" : "-"}${movement.quantity}`,
      date: movement.createdAt
    }))
  ]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 6);

  document.querySelector("#recentActivities").innerHTML = activities.length
    ? activities
        .map(
          (activity) => `
            <article class="record-card">
              <div class="list-item-head">
                <strong>${activity.type}</strong>
                <span class="muted">${formatDate(activity.date)}</span>
              </div>
              <div class="record-line">
                <span>${activity.label}</span>
                <strong>${activity.amount}</strong>
              </div>
            </article>
          `
        )
        .join("")
    : `<article class="record-card"><span class="muted">Henuz hareket kaydi yok.</span></article>`;
}

function renderProducts() {
  syncSelectedProductsWithState();
  const tbody = document.querySelector("#productTableBody");
  const summaryGrid = document.querySelector("#productSummaryGrid");
  const catalogSearchValue = document.querySelector("#catalogSearchInput")?.value.trim().toLowerCase() || "";
  const fallbackSearch = document.querySelector("#productSearchInput")?.value.trim().toLowerCase() || "";
  const searchValue = catalogSearchValue || fallbackSearch;
  const categoryFilter = document.querySelector("#catalogCategoryFilter")?.value || "all";
  const statusFilter = document.querySelector("#catalogStatusFilter")?.value || "all";
  const sortValue = document.querySelector("#catalogSort")?.value || "name-asc";

  const categories = [...new Set(state.products.map((product) => product.category?.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "tr"));
  const categorySelect = document.querySelector("#catalogCategoryFilter");
  const previousCategory = categorySelect.value || "all";
  categorySelect.innerHTML = `<option value="all">Tum kategoriler</option>${categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("")}`;
  categorySelect.value = categories.includes(previousCategory) ? previousCategory : "all";

  const productSummaries = [
    {
      label: "Toplam Urun",
      value: state.products.length,
      detail: "Kayitli urun karti"
    },
    {
      label: "Gorselli Urun",
      value: state.products.filter((product) => Boolean(product.image)).length,
      detail: "Resim yuklenmis kart"
    },
    {
      label: "Kritik Stok",
      value: state.products.filter((product) => product.stock > 0 && product.stock <= product.criticalStock).length,
      detail: "Yenileme bekleyen urun"
    },
    {
      label: "Stokta Yok",
      value: state.products.filter((product) => product.stock <= 0).length,
      detail: "Tukenen urun"
    }
  ];

  summaryGrid.innerHTML = productSummaries
    .map((item) => `<article class="summary-tile"><p>${item.label}</p><strong>${item.value}</strong><span>${item.detail}</span></article>`)
    .join("");

  let filteredProducts = state.products.filter((product) => {
    const searchMatch = [product.name, product.barcode, product.category, product.brand].join(" ").toLowerCase().includes(searchValue);
    const productStatus = getStatus(product.stock, product.criticalStock).className;
    const categoryMatch = categoryFilter === "all" ? true : (product.category || "") === categoryFilter;
    const statusMatch = statusFilter === "all" ? true : productStatus === statusFilter;
    return searchMatch && categoryMatch && statusMatch;
  });

  filteredProducts = filteredProducts.sort((a, b) => {
    switch (sortValue) {
      case "stock-asc":
        return a.stock - b.stock;
      case "stock-desc":
        return b.stock - a.stock;
      case "retail-asc":
        return a.retailPrice - b.retailPrice;
      case "retail-desc":
        return b.retailPrice - a.retailPrice;
      default:
        return a.name.localeCompare(b.name, "tr");
    }
  });

  document.querySelector("#productCountChip").textContent = `${filteredProducts.length} kayit`;
  const selectedVisibleCount = filteredProducts.filter((product) => selectedProductIds.has(product.id)).length;
  const selectAllCheckbox = document.querySelector("#selectAllProducts");
  const selectedCountText = document.querySelector("#selectedProductsCount");
  if (selectAllCheckbox) {
    selectAllCheckbox.checked = filteredProducts.length > 0 && selectedVisibleCount === filteredProducts.length;
    selectAllCheckbox.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < filteredProducts.length;
  }
  if (selectedCountText) {
    selectedCountText.textContent = `${selectedProductIds.size} secili`;
  }

  tbody.innerHTML = filteredProducts.length
    ? filteredProducts
        .map((product) => {
          const status = getStatus(product.stock, product.criticalStock);
          const stockRatioBase = Math.max(product.stock, product.criticalStock || 1, 1);
          const stockRatio = Math.max(8, Math.min(100, (product.stock / stockRatioBase) * 100));
          return `
            <tr>
              <td class="select-cell">
                <input
                  type="checkbox"
                  class="row-select-checkbox"
                  data-select-product="${product.id}"
                  ${selectedProductIds.has(product.id) ? "checked" : ""}
                >
              </td>
              <td>
                <div class="catalog-product">
                  ${product.image ? `<img src="${product.image}" alt="${escapeHtml(product.name)}">` : `<div class="catalog-product-placeholder">${escapeHtml((product.name || "?").slice(0, 1).toUpperCase())}</div>`}
                  <div>
                    <h4>${escapeHtml(product.name)}</h4>
                    <div class="catalog-meta">
                      <span>${escapeHtml(product.category || "Kategorisiz")}</span>
                      <span>${escapeHtml(product.brand || "Markasiz")}</span>
                    </div>
                  </div>
                </div>
              </td>
              <td>
                <div class="stock-cell">
                  <div class="stock-value-line">
                    <span>${product.stock} adet</span>
                    <span class="status ${status.className}">${status.label}</span>
                  </div>
                  <div class="stock-bar ${status.className}"><span style="width:${stockRatio}%"></span></div>
                  <span class="muted">Kritik esik: ${product.criticalStock}</span>
                </div>
              </td>
              <td>
                <div class="catalog-price-stack">
                  <div class="price-chip inline-edit">
                    <small>Perakende</small>
                    <input
                      class="inline-price-input"
                      type="number"
                      min="0"
                      step="0.01"
                      value="${Number(product.retailPrice)}"
                      data-inline-retail="${product.id}"
                    >
                  </div>
                  <div class="price-chip inline-edit">
                    <small>Toptan</small>
                    <input
                      class="inline-price-input"
                      type="number"
                      min="0"
                      step="0.01"
                      value="${Number(product.wholesalePrice)}"
                      data-inline-wholesale="${product.id}"
                    >
                  </div>
                  <button type="button" class="inline-save-btn" data-save-prices="${product.id}" aria-label="Fiyati kaydet" title="Fiyati kaydet">✓</button>
                </div>
              </td>
              <td>
                <div class="barcode-cell">
                  <small>Barkod</small>
                  <strong class="barcode-code">${escapeHtml(product.barcode)}</strong>
                  <span class="muted">${product.image ? "Resimli kart" : "Standart kart"}</span>
                </div>
              </td>
              <td>
                <div class="inline-actions catalog-actions">
                  <button type="button" data-edit-product="${product.id}">Duzenle</button>
                  <button type="button" data-print-barcode="${product.id}">Barkod Yazdir</button>
                  <button type="button" data-delete-product="${product.id}">Sil</button>
                </div>
              </td>
            </tr>
          `;
        })
        .join("")
    : `<tr><td colspan="6" class="muted">Secili filtrelere uygun urun bulunamadi.</td></tr>`;

  const quickList = document.querySelector("#quickProductList");
  const quickSearchValue = document.querySelector("#productSearchInput").value.trim().toLowerCase();
  const quickFilteredProducts = state.products.filter((product) =>
    [product.name, product.barcode, product.category, product.brand].join(" ").toLowerCase().includes(quickSearchValue)
  );

  quickList.innerHTML = quickFilteredProducts.length
    ? quickFilteredProducts
        .map(
          (product) => `
            <button class="product-pick" type="button" data-add-cart="${product.id}">
              <div class="list-item-head">
                <strong>${product.name}</strong>
                <span>${formatCurrency(product.retailPrice)}</span>
              </div>
              ${product.image ? `<img class="product-thumb" src="${product.image}" alt="${escapeHtml(product.name)}">` : ""}
              <div class="record-line muted">
                <span>${product.barcode}</span>
                <span>Stok: ${product.stock}</span>
              </div>
            </button>
          `
        )
        .join("")
    : `<article class="record-card"><span class="muted">Aramana uygun urun bulunamadi.</span></article>`;

  const inventorySelect = document.querySelector("#inventoryProduct");
  inventorySelect.innerHTML = state.products
    .map((product) => `<option value="${product.id}">${product.name} (${product.stock})</option>`)
    .join("");
}

function renderCustomers() {
  const customerSelect = document.querySelector("#saleCustomer");
  customerSelect.innerHTML = state.customers
    .map((customer) => `<option value="${customer.id}">${customer.name} - ${customer.type}</option>`)
    .join("");

  const quickCustomerList = document.querySelector("#saleCustomerQuickList");
  if (quickCustomerList) {
    const selectedCustomerId = customerSelect.value;
    quickCustomerList.innerHTML = state.customers
      .slice(0, 6)
      .map(
        (customer) => `
          <button
            type="button"
            class="customer-quick-tab ${customer.id === selectedCustomerId ? "active" : ""}"
            data-sale-customer="${customer.id}"
          >
            ${escapeHtml(customer.name)} (${formatCurrency(customer.balance)})
          </button>
        `
      )
      .join("");
  }

  document.querySelector("#customerList").innerHTML = state.customers
    .map(
      (customer) => `
        <article class="customer-card">
          <div class="list-item-head">
            <strong>${customer.name}</strong>
            <span class="chip">${customer.type}</span>
          </div>
          <div class="record-line muted">
            <span>${customer.phone || "Telefon yok"}</span>
            <span>Bakiye: ${formatCurrency(customer.balance)}</span>
          </div>
          <p class="muted">${customer.note || "Not yok"}</p>
          <div class="inline-actions">
            <button type="button" data-edit-customer="${customer.id}">Duzenle</button>
            ${customer.name !== "Genel Musteri" ? `<button type="button" data-delete-customer="${customer.id}">Sil</button>` : ""}
          </div>
        </article>
      `
    )
    .join("");
}

function renderCart() {
  const cartItems = document.querySelector("#cartItems");
  cartItems.innerHTML = state.cart.length
    ? state.cart
        .map(
          (item) => `
            <article class="record-card">
              <div class="list-item-head">
                <strong>${item.name}</strong>
                <button type="button" class="ghost-btn" data-remove-cart="${item.productId}">Kaldir</button>
              </div>
              <div class="record-line muted">
                <span>${item.mode === "wholesale" ? "Toptan" : "Perakende"} x ${item.quantity}</span>
                <span>Birim: ${formatCurrency(item.price)}</span>
              </div>
              <div class="record-line">
                <span>Barkod: ${item.barcode}</span>
                <strong>${formatCurrency(item.price * item.quantity)}</strong>
              </div>
            </article>
          `
        )
        .join("")
    : `<article class="record-card"><span class="muted">Sepet bos. Barkod okutarak veya sag listeden urun secerek baslayabilirsin.</span></article>`;

  recalcCart();
}

function updatePaymentMethodButtons() {
  const currentMethod = document.querySelector("#paymentMethod")?.value;
  document.querySelectorAll(".payment-method-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.paymentMethod === currentMethod);
  });
}

function renderInventoryMovements() {
  const list = document.querySelector("#inventoryMovementsList");
  list.innerHTML = state.inventoryMovements.length
    ? [...state.inventoryMovements]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 10)
        .map(
          (movement) => `
            <article class="record-card">
              <div class="list-item-head">
                <strong>${movement.productName}</strong>
                <span class="status ${movement.type === "add" ? "ok" : "warn"}">${movement.type === "add" ? "Giris" : "Cikis"}</span>
              </div>
              <div class="record-line muted">
                <span>Miktar: ${movement.quantity}</span>
                <span>${formatDate(movement.createdAt)}</span>
              </div>
              <p class="muted">${movement.reason || "Aciklama yok"}</p>
            </article>
          `
        )
        .join("")
    : `<article class="record-card"><span class="muted">Henuz stok hareketi kaydi yok.</span></article>`;
}

function renderReports() {
  const totalRevenue = state.sales.reduce((sum, sale) => sum + sale.total, 0);
  const totalWholesale = state.sales.filter((sale) => sale.mode === "wholesale").reduce((sum, sale) => sum + sale.total, 0);
  const totalRetail = state.sales.filter((sale) => sale.mode === "retail").reduce((sum, sale) => sum + sale.total, 0);
  const totalDiscount = state.sales.reduce((sum, sale) => sum + sale.discount, 0);

  const summaryCards = [
    { label: "Toplam Satis", value: state.sales.length },
    { label: "Toplam Ciro", value: formatCurrency(totalRevenue) },
    { label: "Perakende Ciro", value: formatCurrency(totalRetail) },
    { label: "Toptan Ciro", value: formatCurrency(totalWholesale) },
    { label: "Toplam Indirim", value: formatCurrency(totalDiscount) }
  ];

  document.querySelector("#salesSummaryCards").innerHTML = summaryCards
    .map((card) => `<article class="stat-card"><p>${card.label}</p><strong>${card.value}</strong></article>`)
    .join("");

  const topProductsMap = {};
  state.sales.forEach((sale) => {
    sale.items.forEach((item) => {
      if (!topProductsMap[item.productId]) {
        topProductsMap[item.productId] = { name: item.name, quantity: 0, revenue: 0 };
      }
      topProductsMap[item.productId].quantity += item.quantity;
      topProductsMap[item.productId].revenue += item.price * item.quantity;
    });
  });

  const topProducts = Object.values(topProductsMap)
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 5);

  document.querySelector("#topProductsList").innerHTML = topProducts.length
    ? topProducts
        .map(
          (product) => `
            <article class="record-card">
              <div class="list-item-head">
                <strong>${product.name}</strong>
                <span>${product.quantity} adet</span>
              </div>
              <span class="muted">${formatCurrency(product.revenue)}</span>
            </article>
          `
        )
        .join("")
    : `<article class="record-card"><span class="muted">Rapor icin henuz satis kaydi yok.</span></article>`;

  document.querySelector("#salesHistoryList").innerHTML = state.sales.length
    ? [...state.sales]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 10)
        .map(
          (sale) => `
            <article class="record-card">
              <div class="list-item-head">
                <strong>${sale.mode === "wholesale" ? "Toptan" : "Perakende"} satis</strong>
                <span>${formatCurrency(sale.total)}</span>
              </div>
              <div class="record-line muted">
                <span>${getCustomerName(sale.customerId)} / ${sale.paymentMethod}</span>
                <span>${formatDate(sale.createdAt)}</span>
              </div>
              <p class="muted">${sale.items.map((item) => `${item.name} x${item.quantity}`).join(", ")}</p>
            </article>
          `
        )
        .join("")
    : `<article class="record-card"><span class="muted">Henuz satis gecmisi yok.</span></article>`;
}

function renderSettings() {
  document.querySelector("#storeName").value = state.settings.storeName || "";
  document.querySelector("#storeOwner").value = state.settings.storeOwner || "";
  document.querySelector("#storeAddress").value = state.settings.storeAddress || "";
  document.querySelector("#storePhone").value = state.settings.storePhone || "";
  document.querySelector("#storeCurrency").value = state.settings.storeCurrency || "TRY";
}

function renderAll() {
  renderDashboard();
  renderProducts();
  renderCustomers();
  renderCart();
  renderInventoryMovements();
  renderReports();
  renderSettings();
  if (!shouldUseCloud()) saveState();
}

async function persistSettingsRemote() {
  if (!shouldUseCloud()) return;
  const payload = {
    store_id: activeStoreId,
    store_name: state.settings.storeName,
    store_owner: state.settings.storeOwner,
    store_address: state.settings.storeAddress,
    store_phone: state.settings.storePhone,
    store_currency: state.settings.storeCurrency
  };
  const { error } = await supabaseClient.from("store_settings").upsert(payload, { onConflict: "store_id" });
  if (error) throw error;
}

async function persistProductRemote(product) {
  if (!shouldUseCloud()) return;
  const payload = {
    id: product.id,
    store_id: activeStoreId,
    name: product.name,
    barcode: product.barcode,
    category: product.category,
    brand: product.brand,
    retail_price: product.retailPrice,
    wholesale_price: product.wholesalePrice,
    stock: product.stock,
    critical_stock: product.criticalStock,
    image_url: product.image || ""
  };
  const { error } = await supabaseClient.from("products").upsert(payload);
  if (error) throw error;
}

async function persistCustomerRemote(customer) {
  if (!shouldUseCloud()) return;
  const payload = {
    id: customer.id,
    store_id: activeStoreId,
    name: customer.name,
    type: customer.type,
    phone: customer.phone,
    balance: customer.balance,
    note: customer.note
  };
  const { error } = await supabaseClient.from("customers").upsert(payload);
  if (error) throw error;
}

async function deleteProductRemote(productId) {
  if (!shouldUseCloud()) return;
  const { error } = await supabaseClient.from("products").delete().eq("id", productId).eq("store_id", activeStoreId);
  if (error) throw error;
}

async function deleteCustomerRemote(customerId) {
  if (!shouldUseCloud()) return;
  const { error } = await supabaseClient.from("customers").delete().eq("id", customerId).eq("store_id", activeStoreId);
  if (error) throw error;
}

async function completeSaleRemote(sale) {
  if (!shouldUseCloud()) return;
  const { data: saleRow, error: saleError } = await supabaseClient
    .from("sales")
    .insert({
      id: sale.id,
      store_id: activeStoreId,
      customer_id: sale.customerId,
      mode: sale.mode,
      discount: sale.discount,
      payment_method: sale.paymentMethod,
      paid_amount: sale.paidAmount || 0,
      change_due: sale.changeDue || 0,
      note: sale.note,
      subtotal: sale.subtotal,
      total: sale.total,
      created_at: sale.createdAt
    })
    .select("id")
    .single();

  if (saleError) throw saleError;

  const saleItems = sale.items.map((item) => ({
    sale_id: saleRow.id,
    product_id: item.productId,
    name: item.name,
    barcode: item.barcode,
    quantity: item.quantity,
    price: item.price,
    mode: item.mode
  }));

  const { error: itemsError } = await supabaseClient.from("sale_items").insert(saleItems);
  if (itemsError) throw itemsError;

  for (const item of sale.items) {
    const product = getProduct(item.productId);
    if (!product) continue;
    const { error: productError } = await supabaseClient
      .from("products")
      .update({ stock: product.stock })
      .eq("id", item.productId)
      .eq("store_id", activeStoreId);
    if (productError) throw productError;
  }
}

async function persistInventoryMovementRemote(movement, productStock) {
  if (!shouldUseCloud()) return;
  const { error: movementError } = await supabaseClient.from("inventory_movements").insert({
    id: movement.id,
    store_id: activeStoreId,
    product_id: movement.productId,
    product_name: movement.productName,
    type: movement.type,
    quantity: movement.quantity,
    reason: movement.reason,
    created_at: movement.createdAt
  });
  if (movementError) throw movementError;

  const { error: productError } = await supabaseClient
    .from("products")
    .update({ stock: productStock })
    .eq("id", movement.productId)
    .eq("store_id", activeStoreId);
  if (productError) throw productError;
}

function resetProductForm() {
  document.querySelector("#productForm").reset();
  document.querySelector("#productId").value = "";
  document.querySelector("#productImageData").value = "";
  document.querySelector("#productImageFile").value = "";
  document.querySelector("#criticalStock").value = 5;
  updateProductImagePreview("");
  updateBarcodePreview("");
}

function resetCustomerForm() {
  document.querySelector("#customerForm").reset();
  document.querySelector("#customerId").value = "";
  document.querySelector("#customerBalance").value = 0;
}

function applyQuickPaidValue(action) {
  const paidInput = document.querySelector("#paidInput");
  const current = Number(paidInput.value || 0);
  const discount = Number(document.querySelector("#discountInput")?.value || 0);
  const subtotal = state.cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const total = Math.max(subtotal - discount, 0);

  if (action === "add-20") {
    paidInput.value = (current + 20).toFixed(2);
  } else if (action === "sub-20") {
    paidInput.value = Math.max(current - 20, 0).toFixed(2);
  } else if (action === "total") {
    paidInput.value = total.toFixed(2);
  } else {
    paidInput.value = Number(action).toFixed(2);
  }

  recalcCart();
}

function addProductToCart(productId) {
  const product = getProduct(productId);
  if (!product) return showToast("Urun bulunamadi.");
  if (product.stock <= 0) return showToast("Bu urunun stogu bitmis.");

  const mode = document.querySelector("#saleMode").value;
  const price = mode === "wholesale" ? Number(product.wholesalePrice) : Number(product.retailPrice);
  const existing = state.cart.find((item) => item.productId === product.id && item.mode === mode);

  const reservedQuantity = state.cart
    .filter((item) => item.productId === product.id)
    .reduce((sum, item) => sum + item.quantity, 0);

  if (reservedQuantity >= product.stock) {
    return showToast("Sepetteki miktar mevcut stoktan fazla olamaz.");
  }

  if (existing) {
    existing.quantity += 1;
  } else {
    state.cart.push({
      productId: product.id,
      name: product.name,
      barcode: product.barcode,
      quantity: 1,
      price,
      mode
    });
  }

  renderCart();
  saveState();
  showToast(`${product.name} sepete eklendi.`);
}

async function handleProductSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const id = formData.get("productId");
  const payload = {
    id: id || crypto.randomUUID(),
    name: formData.get("name").trim(),
    barcode: formData.get("barcode").trim(),
    category: formData.get("category").trim(),
    brand: formData.get("brand").trim(),
    retailPrice: Number(formData.get("retailPrice")),
    wholesalePrice: Number(formData.get("wholesalePrice")),
    stock: Number(formData.get("stock")),
    criticalStock: Number(formData.get("criticalStock")),
    image: formData.get("image").trim()
  };

  const duplicate = state.products.find((product) => product.barcode === payload.barcode && product.id !== payload.id);
  if (duplicate) return showToast("Bu barkod zaten baska bir urunde kayitli.");

  const existingIndex = state.products.findIndex((product) => product.id === payload.id);
  try {
    await persistProductRemote(payload);
    if (existingIndex >= 0) {
      state.products[existingIndex] = payload;
      showToast("Urun guncellendi.");
    } else {
      state.products.unshift(payload);
      showToast("Urun kaydedildi.");
    }
  } catch (error) {
    console.error(error);
    return showToast("Urun kaydedilemedi.");
  }

  resetProductForm();
  renderAll();
}

async function handleCustomerSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const id = formData.get("customerId");
  const payload = {
    id: id || crypto.randomUUID(),
    name: formData.get("name").trim(),
    type: formData.get("type"),
    phone: formData.get("phone").trim(),
    balance: Number(formData.get("balance")),
    note: formData.get("note").trim()
  };

  const index = state.customers.findIndex((customer) => customer.id === payload.id);
  try {
    await persistCustomerRemote(payload);
    if (index >= 0) {
      state.customers[index] = payload;
      showToast("Musteri guncellendi.");
    } else {
      state.customers.push(payload);
      showToast("Musteri eklendi.");
    }
  } catch (error) {
    console.error(error);
    return showToast("Musteri kaydedilemedi.");
  }

  resetCustomerForm();
  renderAll();
}

function handleSaleForm(event) {
  event.preventDefault();
  const barcode = document.querySelector("#barcodeInput").value.trim();
  if (!barcode) return showToast("Barkod alani bos.");

  const product = state.products.find((item) => item.barcode === barcode);
  if (!product) return showToast("Bu barkoda ait urun bulunamadi.");

  addProductToCart(product.id);
  document.querySelector("#barcodeInput").value = "";
  document.querySelector("#barcodeInput").focus();
}

function handlePriceCheck() {
  const barcode = document.querySelector("#barcodeInput").value.trim();
  if (!barcode) return showToast("Fiyat gormek icin barkod gir.");
  const product = state.products.find((item) => item.barcode === barcode);
  if (!product) return showToast("Bu barkoda ait urun bulunamadi.");
  const mode = document.querySelector("#saleMode").value;
  const price = mode === "wholesale" ? product.wholesalePrice : product.retailPrice;
  showToast(`${product.name}: ${formatCurrency(price)}`);
}

async function handleCompleteSale(event) {
  event.preventDefault();
  if (!state.cart.length) return showToast("Sepet bos.");

  const discount = Number(document.querySelector("#discountInput").value || 0);
  const paymentMethod = document.querySelector("#paymentMethod").value;
  const customerId = document.querySelector("#saleCustomer").value;
  const note = document.querySelector("#saleNote").value.trim();
  const paidAmount = Number(document.querySelector("#paidInput").value || 0);
  const subtotal = state.cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const total = Math.max(subtotal - discount, 0);
  const changeDue = Math.max(paidAmount - total, 0);
  const mode = document.querySelector("#saleMode").value;

  for (const item of state.cart) {
    const product = getProduct(item.productId);
    if (!product || product.stock < item.quantity) {
      return showToast(`${item.name} icin yeterli stok yok.`);
    }
  }

  state.cart.forEach((item) => {
    const product = getProduct(item.productId);
    product.stock -= item.quantity;
  });

  const saleRecord = {
    id: crypto.randomUUID(),
    customerId,
    mode,
    discount,
    paymentMethod,
    paidAmount,
    changeDue,
    note,
    subtotal,
    total,
    createdAt: new Date().toISOString(),
    items: state.cart.map((item) => ({ ...item }))
  };

  try {
    await completeSaleRemote(saleRecord);
  } catch (error) {
    console.error(error);
    return showToast("Satis buluta kaydedilemedi.");
  }

  state.sales.unshift(saleRecord);

  state.cart = [];
  document.querySelector("#completeSaleForm").reset();
  document.querySelector("#discountInput").value = 0;
  document.querySelector("#paidInput").value = 0;
  document.querySelector("#paymentMethod").value = "Nakit";
  renderAll();
  updatePaymentMethodButtons();
  showToast("Satis basariyla tamamlandi.");
}

async function handleInventorySubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const productId = formData.get("productId");
  const type = formData.get("type");
  const quantity = Number(formData.get("quantity"));
  const reason = formData.get("reason").trim();
  const product = getProduct(productId);

  if (!product) return showToast("Urun secimi gecersiz.");
  if (type === "remove" && product.stock < quantity) return showToast("Stok cikisi icin yeterli adet yok.");

  product.stock += type === "add" ? quantity : -quantity;
  const movement = {
    id: crypto.randomUUID(),
    productId,
    productName: product.name,
    type,
    quantity,
    reason,
    createdAt: new Date().toISOString()
  };

  try {
    await persistInventoryMovementRemote(movement, product.stock);
  } catch (error) {
    console.error(error);
    return showToast("Stok hareketi buluta kaydedilemedi.");
  }

  state.inventoryMovements.unshift(movement);

  event.currentTarget.reset();
  document.querySelector("#inventoryQuantity").value = 1;
  renderAll();
  showToast("Stok hareketi kaydedildi.");
}

async function handleSettingsSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  state.settings = {
    storeName: formData.get("storeName").trim(),
    storeOwner: formData.get("storeOwner").trim(),
    storeAddress: formData.get("storeAddress").trim(),
    storePhone: formData.get("storePhone").trim(),
    storeCurrency: formData.get("storeCurrency").trim() || "TRY"
  };
  try {
    await persistSettingsRemote();
    renderAll();
    showToast("Ayarlar kaydedildi.");
  } catch (error) {
    console.error(error);
    showToast("Ayarlar buluta kaydedilemedi.");
  }
}

async function handleSeedDemo() {
  state = {
    settings: {
      storeName: "Renkli Dukkan Oyuncak",
      storeOwner: "Burhan",
      storeAddress: "Istanbul",
      storePhone: "0555 000 00 00",
      storeCurrency: "TRY"
    },
    products: [
      {
        id: crypto.randomUUID(),
        name: "Uzaktan Kumandali Araba",
        barcode: "869100100001",
        category: "Araclar",
        brand: "Turbo Kids",
        retailPrice: 799.9,
        wholesalePrice: 620,
        stock: 12,
        criticalStock: 4,
        image: ""
      },
      {
        id: crypto.randomUUID(),
        name: "Yapboz 100 Parca",
        barcode: "869100100002",
        category: "Egitici Oyuncak",
        brand: "Zeka Kutusu",
        retailPrice: 149.9,
        wholesalePrice: 100,
        stock: 40,
        criticalStock: 8,
        image: ""
      },
      {
        id: crypto.randomUUID(),
        name: "Pelus Ayi",
        barcode: "869100100003",
        category: "Pelus",
        brand: "SoftWorld",
        retailPrice: 299.9,
        wholesalePrice: 210,
        stock: 5,
        criticalStock: 5,
        image: ""
      }
    ],
    customers: [
      {
        id: crypto.randomUUID(),
        name: "Genel Musteri",
        type: "Perakende",
        phone: "",
        balance: 0,
        note: ""
      },
      {
        id: crypto.randomUUID(),
        name: "Minikler Toptan",
        type: "Toptanci",
        phone: "0532 111 22 33",
        balance: 0,
        note: "Duzenli bayi musterisi"
      }
    ],
    sales: [],
    inventoryMovements: [],
    cart: []
  };

  try {
    if (shouldUseCloud()) {
      await persistSettingsRemote();
      for (const customer of state.customers) await persistCustomerRemote(customer);
      for (const product of state.products) await persistProductRemote(product);
    }
    renderAll();
    showToast("Demo verileri yuklendi.");
  } catch (error) {
    console.error(error);
    showToast("Demo verileri buluta yazilamadi.");
  }
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `oyuncakpos-yedek-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("Yedek dosyasi indirildi.");
}

function importData(event) {
  const [file] = event.target.files;
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      state = {
        ...structuredClone(defaultState),
        ...parsed,
        settings: { ...defaultState.settings, ...(parsed.settings || {}) }
      };
      renderAll();
      showToast("Yedek dosyasi geri yuklendi.");
    } catch (error) {
      console.error(error);
      showToast("Dosya okunamadi.");
    }
  };
  reader.readAsText(file);
  event.target.value = "";
}

function printBarcodeLabel(productId) {
  const product = getProduct(productId);
  if (!product) return showToast("Urun bulunamadi.");

  const labelMarkup = getProductLabelMarkup(product);
  if (!generateEan13Svg(product.barcode)) {
    return showToast("Barkod yazdirma icin 12 veya 13 haneli sayisal barkod gerekli.");
  }

  const printWindow = window.open("", "_blank", "width=480,height=640");
  if (!printWindow) return showToast("Yazdirma penceresi acilamadi.");

  printWindow.document.write(`
    <!DOCTYPE html>
    <html lang="tr">
    <head>
      <meta charset="UTF-8">
      <title>${escapeHtml(product.name)} Barkod Etiketi</title>
      <style>
        body { margin: 0; padding: 24px; font-family: Arial, sans-serif; background: #f5f5f5; }
        .sheet { display: flex; justify-content: center; }
        .barcode-label { width: 320px; background: #fff; padding: 14px; border: 1px solid #ddd; }
        .barcode-label h4 { margin: 0 0 8px; font-size: 18px; }
        .barcode-label img { width: 64px; height: 64px; object-fit: cover; border-radius: 8px; margin-bottom: 8px; }
        .barcode-meta { margin-top: 8px; display: flex; justify-content: space-between; font-size: 13px; }
        @media print {
          body { background: #fff; padding: 0; }
          .sheet { justify-content: flex-start; }
          .barcode-label { border: 0; width: 58mm; }
        }
      </style>
    </head>
    <body>
      <div class="sheet">${labelMarkup}</div>
      <script>
        window.onload = function() {
          window.print();
        };
      </script>
    </body>
    </html>
  `);
  printWindow.document.close();
}

function printMultipleBarcodeLabels(products) {
  const printableProducts = products.filter((product) => generateEan13Svg(product.barcode));
  if (!printableProducts.length) {
    showToast("Yazdirilabilir barkod bulunamadi.");
    return;
  }

  const labelsMarkup = printableProducts.map((product) => `<div class="sheet">${getProductLabelMarkup(product)}</div>`).join("");
  const printWindow = window.open("", "_blank", "width=900,height=700");
  if (!printWindow) return showToast("Yazdirma penceresi acilamadi.");

  printWindow.document.write(`
    <!DOCTYPE html>
    <html lang="tr">
    <head>
      <meta charset="UTF-8">
      <title>Toplu Barkod Etiketleri</title>
      <style>
        body { margin: 0; padding: 24px; font-family: Arial, sans-serif; background: #f5f5f5; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
        .sheet { display: flex; justify-content: center; }
        .barcode-label { width: 320px; background: #fff; padding: 14px; border: 1px solid #ddd; }
        .barcode-label h4 { margin: 0 0 8px; font-size: 18px; }
        .barcode-label img { width: 64px; height: 64px; object-fit: cover; border-radius: 8px; margin-bottom: 8px; }
        .barcode-meta { margin-top: 8px; display: flex; justify-content: space-between; font-size: 13px; }
        @media print {
          body { background: #fff; padding: 0; }
          .grid { grid-template-columns: repeat(2, 1fr); gap: 8mm; }
          .barcode-label { border: 0; width: 58mm; }
        }
      </style>
    </head>
    <body>
      <div class="grid">${labelsMarkup}</div>
      <script>
        window.onload = function() { window.print(); };
      </script>
    </body>
    </html>
  `);
  printWindow.document.close();
}

async function handleBulkDeleteProducts() {
  const selected = getSelectedProducts();
  if (!selected.length) return showToast("Toplu silme icin urun sec.");

  const selectedIds = new Set(selected.map((product) => product.id));
  try {
    for (const productId of selectedIds) {
      await deleteProductRemote(productId);
    }
  } catch (error) {
    console.error(error);
    return showToast("Toplu silme sirasinda hata oldu.");
  }
  state.products = state.products.filter((product) => !selectedIds.has(product.id));
  state.cart = state.cart.filter((item) => !selectedIds.has(item.productId));
  selectedProductIds.clear();
  renderAll();
  showToast(`${selected.length} urun silindi.`);
}

function handleBulkPrintBarcodes() {
  const selected = getSelectedProducts();
  if (!selected.length) return showToast("Barkod cikarmak icin urun sec.");
  printMultipleBarcodeLabels(selected);
}

async function handleDocumentClick(event) {
  const editProductId = event.target.dataset.editProduct;
  const deleteProductId = event.target.dataset.deleteProduct;
  const addCartId = event.target.dataset.addCart;
  const removeCartId = event.target.dataset.removeCart;
  const editCustomerId = event.target.dataset.editCustomer;
  const deleteCustomerId = event.target.dataset.deleteCustomer;
  const printBarcodeId = event.target.dataset.printBarcode;
  const savePricesId = event.target.dataset.savePrices;
  const quickPaidValue = event.target.dataset.quickPaid;
  const paymentMethodValue = event.target.dataset.paymentMethod;
  const saleCustomerId = event.target.dataset.saleCustomer;
  const selectProductId = event.target.dataset.selectProduct;
  const scanTargetId = event.target.dataset.scanTarget;
  const scanModeValue = event.target.dataset.scanMode;

  if (editProductId) {
    const product = getProduct(editProductId);
    if (!product) return;
    document.querySelector("#productId").value = product.id;
    document.querySelector("#productName").value = product.name;
    document.querySelector("#productBarcode").value = product.barcode;
    document.querySelector("#productCategory").value = product.category;
    document.querySelector("#productBrand").value = product.brand;
    document.querySelector("#retailPrice").value = product.retailPrice;
    document.querySelector("#wholesalePrice").value = product.wholesalePrice;
    document.querySelector("#stockQuantity").value = product.stock;
    document.querySelector("#criticalStock").value = product.criticalStock;
    document.querySelector("#productImageData").value = product.image || "";
    document.querySelector("#productImageFile").value = "";
    updateProductImagePreview(product.image || "");
    updateBarcodePreview(product.barcode);
    setView("product-editor");
  }

  if (deleteProductId) {
    try {
      await deleteProductRemote(deleteProductId);
    } catch (error) {
      console.error(error);
      return showToast("Urun silinemedi.");
    }
    state.products = state.products.filter((product) => product.id !== deleteProductId);
    state.cart = state.cart.filter((item) => item.productId !== deleteProductId);
    renderAll();
    showToast("Urun silindi.");
  }

  if (printBarcodeId) {
    printBarcodeLabel(printBarcodeId);
  }

  if (savePricesId) {
    const retailInput = document.querySelector(`[data-inline-retail="${savePricesId}"]`);
    const wholesaleInput = document.querySelector(`[data-inline-wholesale="${savePricesId}"]`);
    if (!retailInput || !wholesaleInput) return;
    await updateProductPrices(savePricesId, retailInput.value, wholesaleInput.value);
  }

  if (quickPaidValue) {
    applyQuickPaidValue(quickPaidValue);
  }

  if (paymentMethodValue) {
    document.querySelector("#paymentMethod").value = paymentMethodValue;
    updatePaymentMethodButtons();
    showToast(`Odeme tipi: ${paymentMethodValue}`);
  }

  if (saleCustomerId) {
    document.querySelector("#saleCustomer").value = saleCustomerId;
    renderCustomers();
    showToast("Musteri secildi.");
  }

  if (selectProductId) {
    if (event.target.checked) {
      selectedProductIds.add(selectProductId);
    } else {
      selectedProductIds.delete(selectProductId);
    }
    renderProducts();
  }

  if (scanTargetId) {
    startBarcodeScanner(scanTargetId, scanModeValue);
  }

  if (addCartId) addProductToCart(addCartId);

  if (removeCartId) {
    state.cart = state.cart.filter((item) => item.productId !== removeCartId);
    renderCart();
    saveState();
    showToast("Urun sepetten kaldirildi.");
  }

  if (editCustomerId) {
    const customer = state.customers.find((item) => item.id === editCustomerId);
    if (!customer) return;
    document.querySelector("#customerId").value = customer.id;
    document.querySelector("#customerName").value = customer.name;
    document.querySelector("#customerType").value = customer.type;
    document.querySelector("#customerPhone").value = customer.phone;
    document.querySelector("#customerBalance").value = customer.balance;
    document.querySelector("#customerNote").value = customer.note;
    setView("customers");
  }

  if (deleteCustomerId) {
    try {
      await deleteCustomerRemote(deleteCustomerId);
    } catch (error) {
      console.error(error);
      return showToast("Musteri silinemedi.");
    }
    state.customers = state.customers.filter((customer) => customer.id !== deleteCustomerId);
    renderAll();
    showToast("Musteri silindi.");
  }
}

function initClock() {
  const now = new Date();
  document.querySelector("#todayDate").textContent = new Intl.DateTimeFormat("tr-TR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(now);

  const updateClock = () => {
    document.querySelector("#liveClock").textContent = new Intl.DateTimeFormat("tr-TR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date());
  };

  updateClock();
  setInterval(updateClock, 1000);
}

function handleProductImageChange(event) {
  const [file] = event.target.files;
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const imageData = String(reader.result || "");
    document.querySelector("#productImageData").value = imageData;
    updateProductImagePreview(imageData);
    updateBarcodePreview(document.querySelector("#productBarcode").value);
    showToast("Urun resmi yuklendi.");
  };
  reader.readAsDataURL(file);
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  if (!supabaseClient) return showToast("Bulut baglantisi hazir degil.");

  const email = document.querySelector("#authEmail").value.trim();
  const password = document.querySelector("#authPassword").value;
  const submitButton = document.querySelector("#authSubmitBtn");
  const authMessage = document.querySelector("#authMessage");

  submitButton.disabled = true;
  authMessage.textContent = "Giris yapiliyor...";

  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  submitButton.disabled = false;

  if (error) {
    authMessage.textContent = error.message;
    return;
  }

  authMessage.textContent = "";
}

async function handleLogout() {
  if (!supabaseClient) return;
  await supabaseClient.auth.signOut();
  showToast("Cikis yapildi.");
}

async function handleDocumentKeydown(event) {
  if (event.key !== "Enter") return;
  if (!(event.target instanceof HTMLInputElement)) return;

  const retailProductId = event.target.dataset.inlineRetail;
  const wholesaleProductId = event.target.dataset.inlineWholesale;
  const productId = retailProductId || wholesaleProductId;
  if (!productId) return;

  event.preventDefault();
  const retailInput = document.querySelector(`[data-inline-retail="${productId}"]`);
  const wholesaleInput = document.querySelector(`[data-inline-wholesale="${productId}"]`);
  if (!retailInput || !wholesaleInput) return;
  await updateProductPrices(productId, retailInput.value, wholesaleInput.value);
}

function handleDocumentInput(event) {
  if (!(event.target instanceof HTMLInputElement)) return;
  if (!event.target.dataset.inlineRetail && !event.target.dataset.inlineWholesale) return;
  refreshInlinePriceChangeState();
}

function bindEvents() {
  document.querySelectorAll(".nav-tab").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });

  document.querySelector("#productForm").addEventListener("submit", handleProductSubmit);
  document.querySelector("#customerForm").addEventListener("submit", handleCustomerSubmit);
  document.querySelector("#authForm").addEventListener("submit", handleAuthSubmit);
  document.querySelector("#saleForm").addEventListener("submit", handleSaleForm);
  document.querySelector("#priceCheckBtn").addEventListener("click", handlePriceCheck);
  document.querySelector("#completeSaleForm").addEventListener("submit", handleCompleteSale);
  document.querySelector("#inventoryForm").addEventListener("submit", handleInventorySubmit);
  document.querySelector("#settingsForm").addEventListener("submit", handleSettingsSubmit);
  document.querySelector("#logoutBtn").addEventListener("click", handleLogout);
  document.querySelector("#closeScannerBtn").addEventListener("click", stopBarcodeScanner);
  document.querySelector("#saleCustomer").addEventListener("change", renderCustomers);
  document.querySelector("#openProductEditorBtn").addEventListener("click", () => {
    resetProductForm();
    setView("product-editor");
  });
  document.querySelector("#selectAllProducts").addEventListener("change", (event) => {
    const checked = event.target.checked;
    const visibleIds = [...document.querySelectorAll("[data-select-product]")].map((input) => input.dataset.selectProduct);
    visibleIds.forEach((id) => {
      if (checked) {
        selectedProductIds.add(id);
      } else {
        selectedProductIds.delete(id);
      }
    });
    renderProducts();
  });
  document.querySelector("#bulkDeleteProductsBtn").addEventListener("click", handleBulkDeleteProducts);
  document.querySelector("#bulkPrintBarcodesBtn").addEventListener("click", handleBulkPrintBarcodes);
  document.querySelector("#saveAllPricesBtn").addEventListener("click", saveAllVisiblePriceEdits);
  document.querySelector("#productSearchInput").addEventListener("input", renderProducts);
  document.querySelector("#catalogSearchInput").addEventListener("input", renderProducts);
  document.querySelector("#catalogCategoryFilter").addEventListener("change", renderProducts);
  document.querySelector("#catalogStatusFilter").addEventListener("change", renderProducts);
  document.querySelector("#catalogSort").addEventListener("change", renderProducts);
  document.querySelector("#discountInput").addEventListener("input", recalcCart);
  document.querySelector("#paidInput").addEventListener("input", recalcCart);
  document.querySelector("#paymentMethod").addEventListener("change", updatePaymentMethodButtons);
  document.querySelector("#productImageFile").addEventListener("change", handleProductImageChange);
  document.querySelector("#productBarcode").addEventListener("input", (event) => updateBarcodePreview(event.target.value));
  document.querySelector("#productName").addEventListener("input", () => updateBarcodePreview(document.querySelector("#productBarcode").value));
  document.querySelector("#productCategory").addEventListener("input", () => updateBarcodePreview(document.querySelector("#productBarcode").value));
  document.querySelector("#retailPrice").addEventListener("input", () => updateBarcodePreview(document.querySelector("#productBarcode").value));
  document.querySelector("#seedDemoBtn").addEventListener("click", handleSeedDemo);
  document.querySelector("#exportBtn").addEventListener("click", exportData);
  document.querySelector("#importFile").addEventListener("change", importData);
  document.querySelector("#removeProductImageBtn").addEventListener("click", () => {
    document.querySelector("#productImageData").value = "";
    document.querySelector("#productImageFile").value = "";
    updateProductImagePreview("");
    updateBarcodePreview(document.querySelector("#productBarcode").value);
    showToast("Urun resmi kaldirildi.");
  });
  document.querySelector("#clearCartBtn").addEventListener("click", () => {
    state.cart = [];
    document.querySelector("#paidInput").value = 0;
    renderCart();
    saveState();
    showToast("Sepet temizlendi.");
  });
  document.querySelector("#resetProductBtn").addEventListener("click", resetProductForm);
  document.querySelector("#resetCustomerBtn").addEventListener("click", resetCustomerForm);
  document.addEventListener("click", handleDocumentClick);
  document.addEventListener("keydown", handleDocumentKeydown);
  document.addEventListener("input", handleDocumentInput);
}

async function init() {
  bindEvents();
  initClock();
  renderAll();
  setView(loadActiveView());
  updatePaymentMethodButtons();
  refreshInlinePriceChangeState();
  updateBarcodePreview(document.querySelector("#productBarcode").value);
  await initSupabaseAuth();
}

init();
