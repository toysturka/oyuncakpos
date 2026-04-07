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
let html5QrCodeInstance = null;
let scannerLocked = false;
let scannerFrameRequest = null;
let quaggaActive = false;
let selectedSaleIds = new Set();
let pageTitles = {};

function isLikelyMobileDevice() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
}

const defaultState = {
  settings: {
    storeName: "OyuncakPOS Mağaza",
    storeOwner: "",
    storeAddress: "",
    storePhone: "",
    storeCurrency: "TRY",
    panelTitle: "OyuncakPOS",
    accentColor: "orange",
    density: "comfortable"
  },
  products: [],
  customers: [
    {
      id: crypto.randomUUID(),
      name: "Genel Müşteri",
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
pageTitles["sales-history"] = "Satışlar";

let state = loadState();
let toastTimer;

pageTitles = {
  dashboard: "Genel Bakış",
  sales: "Satış Ekranı",
  products: "Ürünler",
  "product-editor": "Ürün Ekle",
  inventory: "Stok Hareketi",
  customers: "Müşteriler",
  reports: "Raporlar",
  settings: "Ayarlar"
};
pageTitles["sales-history"] = "SatÄ±ÅŸlar";

pageTitles["sales-history"] = "Sat\u0131\u015flar";

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

function applyCustomizationSettings() {
  const root = document.documentElement;
  const title = state.settings.panelTitle?.trim() || "OyuncakPOS";
  const accentColor = state.settings.accentColor || "orange";
  const density = state.settings.density || "comfortable";

  const accentMap = {
    orange: { accent: "#ef6c33", accentDark: "#c4501f", accentSoft: "rgba(239, 108, 51, 0.12)" },
    blue: { accent: "#1677ff", accentDark: "#0b57c6", accentSoft: "rgba(22, 119, 255, 0.12)" },
    green: { accent: "#1f9d75", accentDark: "#11785a", accentSoft: "rgba(31, 157, 117, 0.12)" },
    red: { accent: "#d94841", accentDark: "#b52d28", accentSoft: "rgba(217, 72, 65, 0.12)" }
  };

  const selectedAccent = accentMap[accentColor] || accentMap.orange;
  root.style.setProperty("--accent", selectedAccent.accent);
  root.style.setProperty("--accent-dark", selectedAccent.accentDark);
  root.style.setProperty("--accent-soft", selectedAccent.accentSoft);
  document.body.classList.toggle("compact-density", density === "compact");

  document.querySelectorAll(".brand h1").forEach((node) => {
    node.textContent = title;
  });
}

function setAuthOverlayVisible(visible, message = "") {
  const overlay = document.querySelector("#authOverlay");
  const authMessage = document.querySelector("#authMessage");
  overlay.classList.toggle("hidden-overlay", !visible);
  authMessage.textContent = message;
}

function setScannerOverlayVisible(visible, message = "Kamerayı barkoda doğru tut.") {
  const overlay = document.querySelector("#scannerOverlay");
  const scannerMessage = document.querySelector("#scannerMessage");
  overlay.classList.toggle("hidden-overlay", !visible);
  scannerMessage.textContent = message;
}

function setProductQuickEditVisible(visible) {
  const overlay = document.querySelector("#productQuickEditOverlay");
  if (!overlay) return;
  overlay.classList.toggle("hidden-overlay", !visible);
}

function openProductQuickEdit(productId) {
  const product = getProduct(productId);
  if (!product) return showToast("Ürün bulunamadı.");

  document.querySelector("#productQuickEditId").value = product.id;
  document.querySelector("#productQuickEditTitle").textContent = product.name;
  document.querySelector("#productQuickEditName").value = product.name;
  document.querySelector("#productQuickEditRetail").value = Number(product.retailPrice || 0);
  document.querySelector("#productQuickEditWholesale").value = Number(product.wholesalePrice || 0);
  document.querySelector("#productQuickEditStock").value = Number(product.stock || 0);
  document.querySelector("#productQuickEditBarcode").value = product.barcode || "";
  setProductQuickEditVisible(true);
}

function setScannerSurface(mode) {
  const reader = document.querySelector("#scannerReader");
  const video = document.querySelector("#scannerVideo");
  if (!reader || !video) return;

  if (mode === "reader") {
    reader.classList.remove("hidden-overlay");
    video.classList.add("hidden-overlay");
    return;
  }

  if (mode === "video") {
    reader.classList.add("hidden-overlay");
    video.classList.remove("hidden-overlay");
    return;
  }

  reader.classList.add("hidden-overlay");
  video.classList.remove("hidden-overlay");
}

async function optimizeScannerTrack(track) {
  if (!track?.getCapabilities || !track?.applyConstraints) return;

  try {
    const capabilities = track.getCapabilities();
    const advanced = [];

    if (Array.isArray(capabilities.focusMode)) {
      if (capabilities.focusMode.includes("continuous")) {
        advanced.push({ focusMode: "continuous" });
      } else if (capabilities.focusMode.includes("single-shot")) {
        advanced.push({ focusMode: "single-shot" });
      }
    }

    if (typeof capabilities.zoom?.max === "number" && capabilities.zoom.max >= 1.5) {
      advanced.push({ zoom: Math.min(capabilities.zoom.max, 1.8) });
    }

    if (typeof capabilities.sharpness?.max === "number") {
      advanced.push({ sharpness: capabilities.sharpness.max });
    }

    if (advanced.length) {
      await track.applyConstraints({ advanced });
    }
  } catch (error) {
    console.error(error);
  }
}

function runNativeBarcodeLoop(video) {
  const detectFrame = async () => {
    if (!video?.videoWidth || scannerLocked || !barcodeDetectorInstance) {
      scannerFrameRequest = requestAnimationFrame(detectFrame);
      return;
    }

    try {
      const barcodes = await barcodeDetectorInstance.detect(video);
      if (barcodes.length) {
        const rawValue = barcodes[0].rawValue?.trim();
        if (rawValue) {
          scannerLocked = true;
          applyScannedBarcode(rawValue);
          if (navigator.vibrate) navigator.vibrate(60);
          void stopBarcodeScanner();
          return;
        }
      }
    } catch (error) {
      console.error(error);
    }

    scannerFrameRequest = requestAnimationFrame(detectFrame);
  };

  scannerFrameRequest = requestAnimationFrame(detectFrame);
}

async function getPreferredCameraConfig() {
  if (isLikelyMobileDevice()) {
    return { facingMode: { ideal: "environment" } };
  }

  if (window.Html5Qrcode?.getCameras) {
    try {
      const cameras = await window.Html5Qrcode.getCameras();
      if (cameras?.length) {
        const preferredCamera =
          cameras.find((camera) => /back|rear|environment/i.test(camera.label || "")) ||
          cameras[0];
        if (preferredCamera?.id) {
          return { deviceId: { exact: preferredCamera.id } };
        }
      }
    } catch (error) {
      console.error(error);
    }
  }

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter((device) => device.kind === "videoinput");
    if (videoInputs.length) {
      const preferredInput =
        videoInputs.find((device) => /back|rear|environment/i.test(device.label || "")) ||
        videoInputs[0];
      if (preferredInput?.deviceId) {
        return { deviceId: { exact: preferredInput.deviceId } };
      }
    }
  } catch (error) {
    console.error(error);
  }

  return { facingMode: "user" };
}

async function startDesktopQuagga(preferredCameraConfig) {
  if (!window.Quagga) return false;

  setScannerSurface("reader");
  const reader = document.querySelector("#scannerReader");
  if (!reader) return false;
  reader.innerHTML = "";

  const constraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    ...preferredCameraConfig
  };

  await new Promise((resolve, reject) => {
    window.Quagga.init(
      {
        inputStream: {
          type: "LiveStream",
          target: reader,
          constraints,
          area: { top: "5%", right: "5%", left: "5%", bottom: "5%" }
        },
        locator: {
          patchSize: "large",
          halfSample: false
        },
        numOfWorkers: 2,
        frequency: 20,
        decoder: {
          readers: ["ean_reader", "ean_8_reader", "code_128_reader", "upc_reader", "upc_e_reader"]
        },
        locate: true
      },
      (error) => {
        if (error) reject(error);
        else resolve();
      }
    );
  });

  window.Quagga.onDetected(handleQuaggaDetected);
  window.Quagga.start();
  quaggaActive = true;
  return true;
}

function handleQuaggaDetected(result) {
  if (scannerLocked) return;
  const rawValue = result?.codeResult?.code?.trim();
  if (!rawValue) return;
  scannerLocked = true;
  applyScannedBarcode(rawValue);
  if (navigator.vibrate) navigator.vibrate(60);
  void stopBarcodeScanner();
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
    stockCode: product.stock_code || generateStockCode(product.wholesale_price || 0),
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
    updateConnectionBadge("Cloud Girişi Gerekli");
    setAuthOverlayVisible(true, "Supabase kullanıcısıyla giriş yap.");
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
    updateConnectionBadge("Mağaza Bulunamadı");
    setAuthOverlayVisible(true, "Mağaza kaydı bulunamadı. SQL adımlarını kontrol et.");
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
    showToast("Bulut verileri yüklenemedi.");
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
      ...defaultState.settings,
      ...(state.settings || {}),
      storeName: settingsRes.data?.store_name || "OyuncakPOS Mağaza",
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

function getSaleById(saleId) {
  return state.sales.find((sale) => sale.id === saleId);
}

function formatSaleShareText(sale) {
  const lines = [
    `${state.settings.storeName || "OyuncakPOS"} satış özeti`,
    `${sale.mode === "wholesale" ? "Toptan" : "Perakende"} satış`,
    `Müşteri: ${getCustomerName(sale.customerId)}`,
    `Ödeme: ${sale.paymentMethod}`,
    `Tarih: ${formatDate(sale.createdAt)}`,
    "",
    "Ürünler:"
  ];

  sale.items.forEach((item) => {
    lines.push(`- ${item.name} x${item.quantity} / ${formatCurrency(item.price * item.quantity)}`);
  });

  lines.push("");
  lines.push(`Toplam: ${formatCurrency(sale.total)}`);
  if (sale.discount) lines.push(`İndirim: ${formatCurrency(sale.discount)}`);
  if (sale.note) lines.push(`Not: ${sale.note}`);

  return lines.join("\n");
}

function printSaleReceipt(saleId) {
  const sale = getSaleById(saleId);
  if (!sale) return showToast("Satış bulunamadı.");

  const receiptRows = sale.items
    .map(
      (item) => `
        <tr>
          <td>${escapeHtml(item.name)}</td>
          <td>${item.quantity}</td>
          <td>${formatCurrency(item.price)}</td>
          <td>${formatCurrency(item.price * item.quantity)}</td>
        </tr>
      `
    )
    .join("");

  const printWindow = window.open("", "_blank", "width=760,height=900");
  if (!printWindow) return showToast("Yazdırma penceresi açılamadı.");

  printWindow.document.write(`
    <!DOCTYPE html>
    <html lang="tr">
    <head>
      <meta charset="UTF-8">
      <title>Satış Fişi</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 24px; color: #111; }
        h2, p { margin: 0 0 8px; }
        table { width: 100%; border-collapse: collapse; margin-top: 16px; }
        th, td { border-bottom: 1px solid #ddd; padding: 10px 8px; text-align: left; }
        .summary { margin-top: 18px; display: grid; gap: 6px; }
      </style>
    </head>
    <body>
      <h2>${escapeHtml(state.settings.storeName || "OyuncakPOS")}</h2>
      <p>${sale.mode === "wholesale" ? "Toptan" : "Perakende"} satış</p>
      <p>Müşteri: ${escapeHtml(getCustomerName(sale.customerId))}</p>
      <p>Ödeme: ${escapeHtml(sale.paymentMethod)}</p>
      <p>Tarih: ${escapeHtml(formatDate(sale.createdAt))}</p>
      <table>
        <thead>
          <tr>
            <th>Ürün</th>
            <th>Adet</th>
            <th>Birim</th>
            <th>Tutar</th>
          </tr>
        </thead>
        <tbody>${receiptRows}</tbody>
      </table>
      <div class="summary">
        <strong>Toplam: ${formatCurrency(sale.total)}</strong>
        ${sale.discount ? `<span>İndirim: ${formatCurrency(sale.discount)}</span>` : ""}
        ${sale.note ? `<span>Not: ${escapeHtml(sale.note)}</span>` : ""}
      </div>
      <script>window.onload = function(){ window.print(); };</script>
    </body>
    </html>
  `);
  printWindow.document.close();
}

function shareSaleByEmail(saleId) {
  const sale = getSaleById(saleId);
  if (!sale) return showToast("Satış bulunamadı.");
  const subject = encodeURIComponent(`${state.settings.storeName || "OyuncakPOS"} satış özeti`);
  const body = encodeURIComponent(formatSaleShareText(sale));
  window.open(`mailto:?subject=${subject}&body=${body}`, "_blank");
}

function shareSaleByWhatsApp(saleId) {
  const sale = getSaleById(saleId);
  if (!sale) return showToast("Satış bulunamadı.");
  const customer = state.customers.find((item) => item.id === sale.customerId);
  const phoneDigits = String(customer?.phone || "").replace(/\D/g, "");
  const text = encodeURIComponent(formatSaleShareText(sale));
  const whatsappUrl = phoneDigits
    ? `https://wa.me/${phoneDigits}?text=${text}`
    : `https://wa.me/?text=${text}`;
  window.open(whatsappUrl, "_blank");
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function getStatus(stock, criticalStock) {
  if (stock <= 0) return { label: "Tükendi", className: "danger" };
  return { label: "Normal", className: "ok" };
}

function generateStockCode(wholesalePrice) {
  const normalizedValue = Number(String(wholesalePrice ?? "").replace(",", "."));
  const safeValue = Number.isFinite(normalizedValue) && normalizedValue >= 0 ? normalizedValue : 0;
  const priceText = Number.isInteger(safeValue)
    ? String(safeValue)
    : safeValue.toFixed(2).replace(/\.00$/, "").replace(".", "");
  return `TT-${priceText} 0004`;
}

function normalizeHeaderKey(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getExcelCell(row, aliases) {
  const entries = Object.entries(row || {});
  for (const [key, value] of entries) {
    const normalizedKey = normalizeHeaderKey(key);
    if (aliases.includes(normalizedKey)) return value;
  }
  return "";
}

function mapExcelRowToProduct(row) {
  const barcode = String(
    getExcelCell(row, ["barkod", "barcode", "urun barkodu", "urun barkod", "barkod no"])
  ).trim();

  const name = String(
    getExcelCell(row, ["urun adi", "urun adi", "urun", "urun ismi", "product name", "ad"])
  ).trim();

  const brand = String(
    getExcelCell(row, ["marka", "brand"])
  ).trim();

  const retailPrice = Number(
    String(getExcelCell(row, ["perakende", "perakende fiyat", "perakende fiyati", "satis fiyat", "retail", "retail price"]) || 0)
      .replace(",", ".")
  );

  const wholesalePrice = Number(
    String(getExcelCell(row, ["toptan", "toptan fiyat", "toptan fiyati", "alis fiyat", "wholesale", "wholesale price"]) || 0)
      .replace(",", ".")
  );

  const stock = Number(
    String(getExcelCell(row, ["stok", "stok adedi", "adet", "miktar", "quantity"]) || 0)
      .replace(",", ".")
  );

  const stockCodeFromFile = String(
    getExcelCell(row, ["stok kodu", "stok kod", "stock code", "stockcode"])
  ).trim();

  return {
    barcode,
    name,
    brand,
    retailPrice: Number.isFinite(retailPrice) ? retailPrice : 0,
    wholesalePrice: Number.isFinite(wholesalePrice) ? wholesalePrice : 0,
    stock: Number.isFinite(stock) ? stock : 0,
    stockCode: stockCodeFromFile || generateStockCode(wholesalePrice)
  };
}

function getCustomerName(customerId) {
  return state.customers.find((customer) => customer.id === customerId)?.name || "Genel Müşteri";
}

function getProduct(productId) {
  return state.products.find((product) => product.id === productId);
}

function findProductsForSaleQuery(query) {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!normalizedQuery) return [];

  return state.products.filter((product) =>
    [product.name, product.barcode, product.stockCode, product.category, product.brand]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery)
  );
}

async function updateProductValues(productId, retailPrice, wholesalePrice, stockValue) {
  const product = getProduct(productId);
  if (!product) {
    showToast("Ürün bulunamadı.");
    return false;
  }

  const retail = Number(retailPrice);
  const wholesale = Number(wholesalePrice);
  const stock = Number(stockValue);

  if (Number.isNaN(retail) || Number.isNaN(wholesale) || Number.isNaN(stock) || retail < 0 || wholesale < 0 || stock < 0) {
    showToast("Fiyat ve stok alanları geçerli olmalı.");
    return false;
  }

  product.retailPrice = retail;
  product.wholesalePrice = wholesale;
  product.stock = stock;
  try {
    await persistProductRemote(product);
  } catch (error) {
    console.error(error);
    showToast("Ürün bilgileri buluta kaydedilemedi.");
    return false;
  }
  renderAll();
  showToast(`${product.name} bilgileri güncellendi.`);
  return true;
}

async function saveAllVisiblePriceEdits() {
  const retailInputs = [...document.querySelectorAll("[data-inline-retail]")];
  let changedCount = 0;

  for (const retailInput of retailInputs) {
    const productId = retailInput.dataset.inlineRetail;
    const wholesaleInput = document.querySelector(`[data-inline-wholesale="${productId}"]`);
    const stockInput = document.querySelector(`[data-inline-stock="${productId}"]`);
    const product = getProduct(productId);
    if (!wholesaleInput || !stockInput || !product) continue;

    const retailValue = Number(retailInput.value);
    const wholesaleValue = Number(wholesaleInput.value);
    const stockValue = Number(stockInput.value);
    if (Number.isNaN(retailValue) || Number.isNaN(wholesaleValue) || Number.isNaN(stockValue) || retailValue < 0 || wholesaleValue < 0 || stockValue < 0) {
      showToast("Kayıt öncesi geçersiz fiyat veya stok alanlarını düzelt.");
      return;
    }

    if (
      retailValue !== Number(product.retailPrice) ||
      wholesaleValue !== Number(product.wholesalePrice) ||
      stockValue !== Number(product.stock)
    ) {
      product.retailPrice = retailValue;
      product.wholesalePrice = wholesaleValue;
      product.stock = stockValue;
      try {
        await persistProductRemote(product);
      } catch (error) {
        console.error(error);
        showToast("Toplu kayıt sırasında hata oldu.");
        return;
      }
      changedCount += 1;
    }
  }

  if (!changedCount) {
    showToast("Kaydedilecek değişiklik yok.");
    return;
  }

  renderAll();
  showToast(`${changedCount} ürünün fiyat ve stok bilgileri kaydedildi.`);
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
    return showToast("Bu cihaz kamerayı desteklemiyor.");
  }

  try {
    await stopBarcodeScanner();
    scannerTargetInputId = targetInputId;
    scannerMode = mode;
    scannerLocked = false;
    setScannerOverlayVisible(true);

    const preferHtml5Scanner = !isLikelyMobileDevice();
    const preferredCameraConfig = await getPreferredCameraConfig();

    if (preferHtml5Scanner) {
      try {
        const quaggaStarted = await startDesktopQuagga(preferredCameraConfig);
        if (quaggaStarted) return;
      } catch (error) {
        console.error(error);
      }
    }

    if (!preferHtml5Scanner && "BarcodeDetector" in window) {
      setScannerSurface("video");
      barcodeDetectorInstance = new window.BarcodeDetector({
        formats: ["ean_13", "ean_8", "code_128", "upc_a", "upc_e"]
      });
      scannerStream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...preferredCameraConfig,
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        },
        audio: false
      });
      const video = document.querySelector("#scannerVideo");
      video.srcObject = scannerStream;
      const [videoTrack] = scannerStream.getVideoTracks();
      await optimizeScannerTrack(videoTrack);
      runNativeBarcodeLoop(video);
      return;
    }

    setScannerSurface("reader");
    if (window.Html5Qrcode) {
      html5QrCodeInstance = new window.Html5Qrcode("scannerReader");
      const formatsToSupport = window.Html5QrcodeSupportedFormats
        ? [
            window.Html5QrcodeSupportedFormats.EAN_13,
            window.Html5QrcodeSupportedFormats.EAN_8,
            window.Html5QrcodeSupportedFormats.CODE_128,
            window.Html5QrcodeSupportedFormats.UPC_A,
            window.Html5QrcodeSupportedFormats.UPC_E
          ]
        : undefined;

      await html5QrCodeInstance.start(
        preferredCameraConfig,
        {
          fps: preferHtml5Scanner ? 20 : 30,
          qrbox: preferHtml5Scanner ? { width: 420, height: 220 } : { width: 260, height: 180 },
          aspectRatio: 1.7777778,
          disableFlip: false,
          formatsToSupport
        },
        (decodedText) => {
          const rawValue = String(decodedText || "").trim();
          if (!rawValue || scannerLocked) return;
          scannerLocked = true;
          applyScannedBarcode(rawValue);
          if (navigator.vibrate) navigator.vibrate(60);
          void stopBarcodeScanner();
        },
        () => {}
      );
      return;
    }

    setScannerOverlayVisible(false);
    showToast("Tarama desteği açılamadı. Linki yeniden yayınlayıp tekrar dene.");
  } catch (error) {
    console.error(error);
    await stopBarcodeScanner();
    showToast("Kamera açılamadı. Telefonda kamera izni verip tekrar dene.");
  }
}

async function stopBarcodeScanner() {
  scannerLocked = false;
  if (scannerFrameRequest) {
    cancelAnimationFrame(scannerFrameRequest);
    scannerFrameRequest = null;
  }
  if (scannerInterval) {
    clearInterval(scannerInterval);
    scannerInterval = null;
  }
  if (scannerStream) {
    scannerStream.getTracks().forEach((track) => track.stop());
    scannerStream = null;
  }
  if (window.Quagga && quaggaActive) {
    try {
      window.Quagga.offDetected(handleQuaggaDetected);
      window.Quagga.stop();
    } catch (error) {
      console.error(error);
    }
    quaggaActive = false;
  }
  const video = document.querySelector("#scannerVideo");
  if (video) video.srcObject = null;
  const reader = document.querySelector("#scannerReader");
  if (reader) reader.innerHTML = "";
  if (html5QrCodeInstance) {
    try {
      await html5QrCodeInstance.stop();
    } catch (error) {
      console.error(error);
    }
    try {
      await html5QrCodeInstance.clear();
    } catch (error) {
      console.error(error);
    }
    html5QrCodeInstance = null;
  }
  setScannerSurface("video");
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
    if (product) {
      showToast(`${product.name} bulundu.`);
      openProductQuickEdit(product.id);
    }
    else showToast("Bu barkodla ürün bulunamadı.");
  } else if (scannerMode === "editor") {
    const existingProduct = state.products.find((item) => item.barcode === rawValue);
    if (existingProduct) {
      document.querySelector("#productId").value = existingProduct.id;
      document.querySelector("#productName").value = existingProduct.name;
      document.querySelector("#productBarcode").value = existingProduct.barcode;
      document.querySelector("#productBrand").value = existingProduct.brand || "";
      document.querySelector("#retailPrice").value = existingProduct.retailPrice;
      document.querySelector("#wholesalePrice").value = existingProduct.wholesalePrice;
      document.querySelector("#stockQuantity").value = existingProduct.stock;
      document.querySelector("#stockCode").value = existingProduct.stockCode || generateStockCode(existingProduct.wholesalePrice);
      document.querySelector("#productImageData").value = existingProduct.image || "";
      updateProductImagePreview(existingProduct.image || "");
      updateBarcodePreview(existingProduct.barcode);
      showToast("Ürün bulundu, stok kartı açıldı.");
      return;
    }
    updateBarcodePreview(rawValue);
    showToast("Barkod alana eklendi.");
  }
}

function refreshInlinePriceChangeState() {
  const retailInputs = [...document.querySelectorAll("[data-inline-retail]")];
  retailInputs.forEach((retailInput) => {
    const productId = retailInput.dataset.inlineRetail;
    const wholesaleInput = document.querySelector(`[data-inline-wholesale="${productId}"]`);
    const stockInput = document.querySelector(`[data-inline-stock="${productId}"]`);
    const product = getProduct(productId);
    if (!wholesaleInput || !stockInput || !product) return;

    const retailChanged = Number(retailInput.value) !== Number(product.retailPrice);
    const wholesaleChanged = Number(wholesaleInput.value) !== Number(product.wholesalePrice);
    const stockChanged = Number(stockInput.value) !== Number(product.stock);
    retailInput.closest(".price-chip")?.classList.toggle("changed", retailChanged);
    wholesaleInput.closest(".price-chip")?.classList.toggle("changed", wholesaleChanged);
    stockInput.closest(".price-chip")?.classList.toggle("changed", stockChanged);
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
    return `<div class="barcode-label"><h4>${escapeHtml(product.name)}</h4><p>Yazdırma için 12 veya 13 haneli sayısal barkod gerekir.</p></div>`;
  }

  return `
    <div class="barcode-label">
      <div class="barcode-title">${escapeHtml(product.name)}</div>
      <div class="barcode-body">
        <div class="barcode-info-block">
          <div class="barcode-price-value">${formatCurrency(product.retailPrice)}</div>
        </div>
        <div class="barcode-visual">${svg}</div>
      </div>
      <div class="barcode-meta">
        <span>${product.brand ? escapeHtml(product.brand) : ""}</span>
        <strong>${Number(product.stock || 0)}</strong>
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
  const productName = document.querySelector("#productName").value.trim() || "Yeni Ürün";
  const retailPrice = Number(document.querySelector("#retailPrice").value || 0);
  const image = document.querySelector("#productImageData").value;
  const mockProduct = {
    name: productName,
    barcode: barcodeValue,
    retailPrice,
    brand: document.querySelector("#productBrand").value.trim(),
    image
  };
  preview.innerHTML = generateEan13Svg(barcodeValue)
    ? getProductLabelMarkup(mockProduct)
    : "12 veya 13 haneli barkod girdiğinde burada etiket önizlemesi oluşur.";
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
  if (isMobileViewport()) {
    closeMobileNav();
  }
}

function openMobileNav() {
  const overlay = document.querySelector("#mobileNavOverlay");
  const panel = document.querySelector("#mobileNavPanel");
  const sidebar = document.querySelector(".sidebar");
  document.body.classList.add("mobile-nav-open");
  if (sidebar && isMobileViewport()) {
    sidebar.setAttribute("aria-hidden", "true");
    sidebar.style.display = "none";
  }
  if (overlay) overlay.style.display = "block";
  if (panel) panel.style.display = "flex";
}

function closeMobileNav() {
  const overlay = document.querySelector("#mobileNavOverlay");
  const panel = document.querySelector("#mobileNavPanel");
  const sidebar = document.querySelector(".sidebar");
  document.body.classList.remove("mobile-nav-open");
  if (sidebar && isMobileViewport()) {
    sidebar.setAttribute("aria-hidden", "true");
    sidebar.style.display = "none";
  }
  if (overlay) overlay.style.display = "none";
  if (panel) panel.style.display = "none";
}

function toggleMobileNav() {
  if (document.body.classList.contains("mobile-nav-open")) closeMobileNav();
  else openMobileNav();
}

function isMobileViewport() {
  return window.matchMedia("(max-width: 1120px)").matches;
}

function syncMobileLayout() {
  const sidebar = document.querySelector(".sidebar");
  const overlay = document.querySelector("#mobileNavOverlay");
  const panel = document.querySelector("#mobileNavPanel");

  if (!sidebar || !overlay || !panel) return;

  if (isMobileViewport()) {
    sidebar.setAttribute("aria-hidden", "true");
    sidebar.style.display = "none";
    sidebar.style.visibility = "hidden";
    sidebar.style.pointerEvents = "none";

    if (!document.body.classList.contains("mobile-nav-open")) {
      overlay.style.display = "none";
      panel.style.display = "none";
    }
    return;
  }

  document.body.classList.remove("mobile-nav-open");
  sidebar.removeAttribute("aria-hidden");
  sidebar.style.display = "";
  sidebar.style.visibility = "";
  sidebar.style.pointerEvents = "";
  overlay.style.display = "";
  panel.style.display = "";
}

function renderDashboard() {
  const todaySales = state.sales.filter((sale) => {
    const saleDate = new Date(sale.createdAt);
    const now = new Date();
    return saleDate.toDateString() === now.toDateString();
  });

  const dailyRevenue = todaySales.reduce((sum, sale) => sum + sale.total, 0);
  const totalStock = state.products.reduce((sum, product) => sum + Number(product.stock), 0);
  const outOfStockCount = state.products.filter((product) => product.stock <= 0).length;

  const cards = [
    { label: "Toplam Ürün Çeşidi", value: state.products.length },
    { label: "Toplam Stok", value: totalStock },
    { label: "Bugun Ciro", value: formatCurrency(dailyRevenue) },
    { label: "Stokta Yok", value: outOfStockCount }
  ];

  document.querySelector("#dashboardStats").innerHTML = cards
    .map((card) => `<article class="stat-card"><p>${card.label}</p><strong>${card.value}</strong></article>`)
    .join("");

  document.querySelector("#miniProductCount").textContent = state.products.length;
  document.querySelector("#miniCriticalCount").textContent = outOfStockCount;
  document.querySelector("#miniSalesCount").textContent = todaySales.length;

  const criticalProducts = state.products
    .filter((product) => product.stock <= 0)
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
    : `<article class="record-card"><span class="muted">Stoğu biten ürün yok.</span></article>`;

  const activities = [
    ...state.sales.map((sale) => ({
      type: "Satış",
      label: `${sale.mode === "wholesale" ? "Toptan" : "Perakende"} satış`,
      amount: formatCurrency(sale.total),
      date: sale.createdAt
    })),
    ...state.inventoryMovements.map((movement) => ({
      type: "Stok",
      label: `${movement.type === "add" ? "Stok girişi" : "Stok çıkışı"} - ${movement.productName}`,
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
    : `<article class="record-card"><span class="muted">Henüz hareket kaydı yok.</span></article>`;
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
      label: "Toplam Ürün",
      value: state.products.length,
      detail: "Kayıtlı ürün kartı"
    },
    {
      label: "Görselli Ürün",
      value: state.products.filter((product) => Boolean(product.image)).length,
      detail: "Resim yüklenmiş kart"
    },
    {
      label: "Stokta Olan",
      value: state.products.filter((product) => product.stock > 0).length,
      detail: "Rafında bulunan ürün"
    },
    {
      label: "Stokta Yok",
      value: state.products.filter((product) => product.stock <= 0).length,
      detail: "Tükenen ürün"
    }
  ];

  summaryGrid.innerHTML = productSummaries
    .map((item) => `<article class="summary-tile"><p>${item.label}</p><strong>${item.value}</strong><span>${item.detail}</span></article>`)
    .join("");

  let filteredProducts = state.products.filter((product) => {
    const searchMatch = [product.name, product.barcode, product.stockCode, product.category, product.brand].join(" ").toLowerCase().includes(searchValue);
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
    selectedCountText.textContent = `${selectedProductIds.size} seçili`;
  }

  tbody.innerHTML = filteredProducts.length
    ? filteredProducts
        .map((product) => {
          const status = getStatus(product.stock, product.criticalStock);
          const stockRatioBase = Math.max(product.stock, 1);
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
                  <div class="catalog-price-stack stock-inline-stack">
                    <div class="price-chip inline-edit">
                      <small>Stok Adedi</small>
                      <input
                        class="inline-price-input"
                        type="number"
                        min="0"
                        step="1"
                        value="${Number(product.stock)}"
                        data-inline-stock="${product.id}"
                      >
                    </div>
                    <div class="price-chip stock-status-chip">
                      <small>Durum</small>
                      <span class="status ${status.className}">${status.label}</span>
                    </div>
                  </div>
                  <div class="stock-bar ${status.className}"><span style="width:${stockRatio}%"></span></div>
                  <span class="muted">Stok kodu: ${escapeHtml(product.stockCode || generateStockCode(product.wholesalePrice))}</span>
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
                  <button type="button" class="inline-save-btn" data-save-prices="${product.id}" aria-label="Fiyatı kaydet" title="Fiyatı kaydet">✓</button>
                </div>
              </td>
              <td>
                <div class="barcode-cell">
                  <small>Barkod</small>
                  <strong class="barcode-code">${escapeHtml(product.barcode)}</strong>
                  <span class="muted">${escapeHtml(product.stockCode || generateStockCode(product.wholesalePrice))}</span>
                </div>
              </td>
              <td>
                <div class="inline-actions catalog-actions">
                  <button type="button" data-edit-product="${product.id}">Duzenle</button>
                  <button type="button" data-print-barcode="${product.id}">Barkod Yazdır</button>
                  <button type="button" data-delete-product="${product.id}">Sil</button>
                </div>
              </td>
            </tr>
          `;
        })
        .join("")
    : `<tr><td colspan="6" class="muted">Seçili filtrelere uygun ürün bulunamadı.</td></tr>`;

  const quickList = document.querySelector("#quickProductList");
  const sharedSearchValue = (
    document.querySelector("#barcodeInput")?.value ||
    document.querySelector("#productSearchInput")?.value ||
    ""
  )
    .trim()
    .toLowerCase();
  const quickFilteredProducts = sharedSearchValue
    ? state.products.filter((product) =>
        [product.name, product.barcode, product.stockCode, product.category, product.brand]
          .join(" ")
          .toLowerCase()
          .includes(sharedSearchValue)
      )
    : state.products.slice(0, 12);

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
                <span>${escapeHtml(product.stockCode || "-")} / ${product.barcode}</span>
                <span>Stok: ${product.stock}</span>
              </div>
            </button>
          `
        )
        .join("")
    : `<article class="record-card"><span class="muted">Aramana uygun ürün bulunamadı.</span></article>`;

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
            ${customer.name !== "Genel Müşteri" ? `<button type="button" data-delete-customer="${customer.id}">Sil</button>` : ""}
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
    : `<article class="record-card"><span class="muted">Sepet boş. Barkod okutarak veya sağ listeden ürün seçerek başlayabilirsin.</span></article>`;

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
                <span class="status ${movement.type === "add" ? "ok" : "warn"}">${movement.type === "add" ? "Giriş" : "Çıkış"}</span>
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
    : `<article class="record-card"><span class="muted">Henüz stok hareketi kaydı yok.</span></article>`;
}

function renderReports() {
  const totalRevenue = state.sales.reduce((sum, sale) => sum + sale.total, 0);
  const totalWholesale = state.sales.filter((sale) => sale.mode === "wholesale").reduce((sum, sale) => sum + sale.total, 0);
  const totalRetail = state.sales.filter((sale) => sale.mode === "retail").reduce((sum, sale) => sum + sale.total, 0);
  const totalDiscount = state.sales.reduce((sum, sale) => sum + sale.discount, 0);

  const summaryCards = [
    { label: "Toplam Satış", value: state.sales.length },
    { label: "Toplam Ciro", value: formatCurrency(totalRevenue) },
    { label: "Perakende Ciro", value: formatCurrency(totalRetail) },
    { label: "Toptan Ciro", value: formatCurrency(totalWholesale) },
    { label: "Toplam İndirim", value: formatCurrency(totalDiscount) }
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
    : `<article class="record-card"><span class="muted">Rapor için henüz satış kaydı yok.</span></article>`;

  document.querySelector("#salesHistoryList").innerHTML = state.sales.length
    ? [...state.sales]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 10)
        .map(
          (sale) => `
            <article class="record-card">
              <div class="list-item-head">
                <strong>${sale.mode === "wholesale" ? "Toptan" : "Perakende"} satış</strong>
                <span>${formatCurrency(sale.total)}</span>
              </div>
              <div class="record-line muted">
                <span>${getCustomerName(sale.customerId)} / ${sale.paymentMethod}</span>
                <span>${formatDate(sale.createdAt)}</span>
              </div>
              <p class="muted">${sale.items.map((item) => `${item.name} x${item.quantity}`).join(", ")}</p>
              <div class="inline-actions">
                <button type="button" data-print-sale="${sale.id}">Yazdır</button>
                <button type="button" data-email-sale="${sale.id}">Mail Gönder</button>
                <button type="button" data-whatsapp-sale="${sale.id}">WhatsApp</button>
              </div>
            </article>
          `
        )
        .join("")
    : `<article class="record-card"><span class="muted">Henüz satış geçmişi yok.</span></article>`;
}

function renderSettings() {
  document.querySelector("#storeName").value = state.settings.storeName || "";
  document.querySelector("#storeOwner").value = state.settings.storeOwner || "";
  document.querySelector("#storeAddress").value = state.settings.storeAddress || "";
  document.querySelector("#storePhone").value = state.settings.storePhone || "";
  document.querySelector("#storeCurrency").value = state.settings.storeCurrency || "TRY";
  document.querySelector("#panelTitleSetting").value = state.settings.panelTitle || "OyuncakPOS";
  document.querySelector("#accentColorSetting").value = state.settings.accentColor || "orange";
  document.querySelector("#densitySetting").value = state.settings.density || "comfortable";
}

function renderAll() {
  applyCustomizationSettings();
  renderDashboard();
  renderProducts();
  renderCustomers();
  renderCart();
  renderInventoryMovements();
  renderReports();
  renderSalesHistoryPage();
  renderSettings();
  saveState();
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
    stock_code: product.stockCode || generateStockCode(product.wholesalePrice),
    image_url: product.image || ""
  };
  const { error } = await supabaseClient.from("products").upsert(payload);
  if (!error) return;

  if (String(error.message || "").toLowerCase().includes("stock_code")) {
    const fallbackPayload = { ...payload };
    delete fallbackPayload.stock_code;
    const fallbackResult = await supabaseClient.from("products").upsert(fallbackPayload);
    if (fallbackResult.error) throw fallbackResult.error;
    return;
  }

  throw error;
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
    product_id: item.customItem ? null : item.productId,
    name: item.name,
    barcode: item.barcode,
    quantity: item.quantity,
    price: item.price,
    mode: item.mode
  }));

  const { error: itemsError } = await supabaseClient.from("sale_items").insert(saleItems);
  if (itemsError) throw itemsError;

  for (const item of sale.items) {
    if (item.customItem) continue;
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
  document.querySelector("#stockQuantity").value = "";
  document.querySelector("#stockCode").value = generateStockCode(0);
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
  if (!product) return showToast("Ürün bulunamadı.");
  if (product.stock <= 0) return showToast("Bu ürünün stoğu bitmiş.");

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
      cartKey: `${product.id}:${mode}`,
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

function addCustomSaleItem(name, price, quantity) {
  const trimmedName = String(name || "").trim();
  const numericPrice = Number(price);
  const numericQuantity = Number(quantity);

  if (!trimmedName) return showToast("Muhtelif ürün adı gir.");
  if (!Number.isFinite(numericPrice) || numericPrice <= 0) return showToast("Muhtelif ürün için geçerli fiyat gir.");
  if (!Number.isFinite(numericQuantity) || numericQuantity <= 0) return showToast("Muhtelif ürün için adet gir.");

  const mode = document.querySelector("#saleMode").value;
  state.cart.push({
    cartKey: crypto.randomUUID(),
    productId: null,
    name: trimmedName,
    barcode: "MUHTELİF",
    quantity: numericQuantity,
    price: numericPrice,
    mode,
    customItem: true
  });

  renderCart();
  saveState();
  showToast(`${trimmedName} sepete eklendi.`);
}

async function handleProductSubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const id = formData.get("productId");
  const wholesalePrice = Number(formData.get("wholesalePrice"));
  const stockValue = formData.get("stock");
  const payload = {
    id: id || crypto.randomUUID(),
    name: formData.get("name").trim(),
    barcode: formData.get("barcode").trim(),
    category: "",
    brand: formData.get("brand").trim(),
    retailPrice: Number(formData.get("retailPrice")),
    wholesalePrice,
    stock: stockValue === "" ? 0 : Number(stockValue),
    criticalStock: 0,
    stockCode: generateStockCode(wholesalePrice),
    image: formData.get("image").trim()
  };

  const duplicate = state.products.find((product) => product.barcode === payload.barcode && product.id !== payload.id);
  if (duplicate) return showToast("Bu barkod zaten başka bir üründe kayıtlı.");

  const existingIndex = state.products.findIndex((product) => product.id === payload.id);
  try {
    await persistProductRemote(payload);
    if (existingIndex >= 0) {
      state.products[existingIndex] = payload;
      showToast("Ürün güncellendi.");
    } else {
      state.products.unshift(payload);
      showToast("Ürün kaydedildi.");
    }
  } catch (error) {
    console.error(error);
    return showToast("Ürün kaydedilemedi.");
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
      showToast("Müşteri güncellendi.");
    } else {
      state.customers.push(payload);
      showToast("Müşteri eklendi.");
    }
  } catch (error) {
    console.error(error);
    return showToast("Müşteri kaydedilemedi.");
  }

  resetCustomerForm();
  renderAll();
}

function handleSaleForm(event) {
  event.preventDefault();
  const barcode = document.querySelector("#barcodeInput").value.trim();
  if (!barcode) return showToast("Barkod alanı boş.");

  const product = state.products.find((item) => item.barcode === barcode);
  if (!product) return showToast("Bu barkoda ait ürün bulunamadı.");

  addProductToCart(product.id);
  document.querySelector("#barcodeInput").value = "";
  document.querySelector("#barcodeInput").focus();
}

function handlePriceCheck() {
  const barcode = document.querySelector("#barcodeInput").value.trim();
  if (!barcode) return showToast("Fiyat görmek için barkod gir.");
  const product = state.products.find((item) => item.barcode === barcode);
  if (!product) return showToast("Bu barkoda ait ürün bulunamadı.");
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
    if (item.customItem) continue;
    const product = getProduct(item.productId);
    if (!product || product.stock < item.quantity) {
      return showToast(`${item.name} icin yeterli stok yok.`);
    }
  }

  state.cart.forEach((item) => {
    if (item.customItem) return;
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
    return showToast("Satış buluta kaydedilemedi.");
  }

  state.sales.unshift(saleRecord);

  state.cart = [];
  document.querySelector("#completeSaleForm").reset();
  document.querySelector("#discountInput").value = 0;
  document.querySelector("#paidInput").value = 0;
  document.querySelector("#paymentMethod").value = "Nakit";
  renderAll();
  updatePaymentMethodButtons();
  showToast("Satış başarıyla tamamlandı.");
}

async function handleInventorySubmit(event) {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const productId = formData.get("productId");
  const type = formData.get("type");
  const quantity = Number(formData.get("quantity"));
  const reason = formData.get("reason").trim();
  const product = getProduct(productId);

  if (!product) return showToast("Ürün seçimi geçersiz.");
  if (type === "remove" && product.stock < quantity) return showToast("Stok çıkışı için yeterli adet yok.");

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
    storeCurrency: formData.get("storeCurrency").trim() || "TRY",
    panelTitle: formData.get("panelTitle").trim() || "OyuncakPOS",
    accentColor: formData.get("accentColor") || "orange",
    density: formData.get("density") || "comfortable"
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
      storeName: "Renkli Dükkan Oyuncak",
      storeOwner: "Burhan",
      storeAddress: "İstanbul",
      storePhone: "0555 000 00 00",
      storeCurrency: "TRY"
    },
    products: [
      {
        id: crypto.randomUUID(),
        name: "Uzaktan Kumandalı Araba",
        barcode: "869100100001",
        category: "Araçlar",
        brand: "Turbo Kids",
        retailPrice: 799.9,
        wholesalePrice: 620,
        stock: 12,
        criticalStock: 4,
        image: ""
      },
      {
        id: crypto.randomUUID(),
        name: "Yapboz 100 Parça",
        barcode: "869100100002",
        category: "Eğitici Oyuncak",
        brand: "Zeka Kutusu",
        retailPrice: 149.9,
        wholesalePrice: 100,
        stock: 40,
        criticalStock: 8,
        image: ""
      },
      {
        id: crypto.randomUUID(),
        name: "Peluş Ayı",
        barcode: "869100100003",
        category: "Peluş",
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
        name: "Genel Müşteri",
        type: "Perakende",
        phone: "",
        balance: 0,
        note: ""
      },
      {
        id: crypto.randomUUID(),
        name: "Minikler Toptan",
        type: "Toptancı",
        phone: "0532 111 22 33",
        balance: 0,
        note: "Düzenli bayi müşterisi"
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
    showToast("Demo verileri yüklendi.");
  } catch (error) {
    console.error(error);
    showToast("Demo verileri buluta yazılamadı.");
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
  showToast("Yedek dosyası indirildi.");
}

function downloadExcelTemplate() {
  if (!window.XLSX) {
    showToast("Excel şablonu oluşturulamadı.");
    return;
  }

  const templateRows = [
    {
      Barkod: "869100100001",
      "Ürün Adı": "Oyuncak Araba",
      Marka: "ToyStar",
      "Perakende Fiyat": 150,
      "Toptan Fiyat": 100,
      "Stok": 12,
      "Stok Kodu": "TT-100 0004"
    },
    {
      Barkod: "869100100002",
      "Ürün Adı": "Peluş Ayı",
      Marka: "Mutlu Kids",
      "Perakende Fiyat": 220,
      "Toptan Fiyat": 160,
      "Stok": 8,
      "Stok Kodu": "TT-160 0004"
    }
  ];

  const worksheet = window.XLSX.utils.json_to_sheet(templateRows);
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, worksheet, "Urunler");
  window.XLSX.writeFile(workbook, "oyuncakpos-excel-sablon.xlsx");
  showToast("Excel şablonu indirildi.");
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
      showToast("Yedek dosyası geri yüklendi.");
    } catch (error) {
      console.error(error);
      showToast("Dosya okunamadı.");
    }
  };
  reader.readAsText(file);
  event.target.value = "";
}

async function importExcelProducts(event) {
  const [file] = event.target.files;
  if (!file) return;
  if (!window.XLSX) {
    showToast("Excel modülü yüklenemedi.");
    event.target.value = "";
    return;
  }

  try {
    const buffer = await file.arrayBuffer();
    const workbook = window.XLSX.read(buffer, { type: "array" });
    const firstSheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[firstSheetName];
    const rows = window.XLSX.utils.sheet_to_json(sheet, { defval: "" });

    if (!rows.length) {
      showToast("Excel dosyasında ürün bulunamadı.");
      event.target.value = "";
      return;
    }

    let createdCount = 0;
    let updatedCount = 0;

    for (const row of rows) {
      const mapped = mapExcelRowToProduct(row);
      if (!mapped.barcode || !mapped.name) continue;

      const existingProduct = state.products.find((product) => product.barcode === mapped.barcode);

      if (existingProduct) {
        existingProduct.name = mapped.name || existingProduct.name;
        existingProduct.brand = mapped.brand || existingProduct.brand;
        existingProduct.retailPrice = mapped.retailPrice;
        existingProduct.wholesalePrice = mapped.wholesalePrice;
        existingProduct.stock = mapped.stock;
        existingProduct.stockCode = mapped.stockCode || generateStockCode(mapped.wholesalePrice);
        await persistProductRemote(existingProduct);
        updatedCount += 1;
      } else {
        const newProduct = {
          id: crypto.randomUUID(),
          name: mapped.name,
          barcode: mapped.barcode,
          category: "",
          brand: mapped.brand,
          retailPrice: mapped.retailPrice,
          wholesalePrice: mapped.wholesalePrice,
          stock: mapped.stock,
          criticalStock: 0,
          stockCode: mapped.stockCode || generateStockCode(mapped.wholesalePrice),
          image: ""
        };
        state.products.unshift(newProduct);
        await persistProductRemote(newProduct);
        createdCount += 1;
      }
    }

    renderAll();
    showToast(`Excel aktarıldı. Yeni: ${createdCount}, Güncellenen: ${updatedCount}`);
  } catch (error) {
    console.error(error);
    showToast("Excel dosyası okunamadı.");
  }

  event.target.value = "";
}

function printBarcodeLabel(productId) {
  const product = getProduct(productId);
  if (!product) return showToast("Ürün bulunamadı.");

  const labelMarkup = getProductLabelMarkup(product);
  if (!generateEan13Svg(product.barcode)) {
    return showToast("Barkod yazdırma için 12 veya 13 haneli sayısal barkod gerekli.");
  }

  const printWindow = window.open("", "_blank", "width=480,height=640");
  if (!printWindow) return showToast("Yazdırma penceresi açılamadı.");

  printWindow.document.write(`
    <!DOCTYPE html>
    <html lang="tr">
    <head>
      <meta charset="UTF-8">
      <title>${escapeHtml(product.name)} Barkod Etiketi</title>
      <style>
        body { margin: 0; padding: 24px; font-family: Arial, sans-serif; background: #f5f5f5; }
        .sheet { display: flex; justify-content: center; }
        .barcode-label { width: 420px; background: #fff; padding: 16px 18px; border: 1px solid #ddd; }
        .barcode-title { text-align: center; font-size: 20px; font-weight: 700; margin-bottom: 12px; }
        .barcode-body { display: grid; grid-template-columns: 1fr 1.3fr; gap: 18px; align-items: center; min-height: 120px; }
        .barcode-info-block { display: grid; gap: 8px; align-content: center; }
        .barcode-price-label { font-size: 14px; color: #555; }
        .barcode-price-value { font-size: 28px; font-weight: 700; }
        .barcode-visual { display: flex; align-items: center; justify-content: center; }
        .barcode-visual svg { width: 100%; height: auto; }
        .barcode-meta { margin-top: 10px; display: flex; justify-content: space-between; gap: 8px; font-size: 14px; font-weight: 700; }
        .barcode-meta span:empty { display: none; }
        @media print {
          body { background: #fff; padding: 0; }
          .sheet { justify-content: flex-start; }
          .barcode-label { border: 0; width: 74mm; }
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
    showToast("Yazdırılabilir barkod bulunamadı.");
    return;
  }

  const labelsMarkup = printableProducts.map((product) => `<div class="sheet">${getProductLabelMarkup(product)}</div>`).join("");
  const printWindow = window.open("", "_blank", "width=900,height=700");
  if (!printWindow) return showToast("Yazdırma penceresi açılamadı.");

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
        .barcode-label { width: 420px; background: #fff; padding: 16px 18px; border: 1px solid #ddd; }
        .barcode-title { text-align: center; font-size: 20px; font-weight: 700; margin-bottom: 12px; }
        .barcode-body { display: grid; grid-template-columns: 1fr 1.3fr; gap: 18px; align-items: center; min-height: 120px; }
        .barcode-info-block { display: grid; gap: 8px; align-content: center; }
        .barcode-price-label { font-size: 14px; color: #555; }
        .barcode-price-value { font-size: 28px; font-weight: 700; }
        .barcode-visual { display: flex; align-items: center; justify-content: center; }
        .barcode-visual svg { width: 100%; height: auto; }
        .barcode-meta { margin-top: 10px; display: flex; justify-content: space-between; gap: 8px; font-size: 14px; font-weight: 700; }
        .barcode-meta span:empty { display: none; }
        @media print {
          body { background: #fff; padding: 0; }
          .grid { grid-template-columns: repeat(2, 1fr); gap: 8mm; }
          .barcode-label { border: 0; width: 74mm; }
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
  if (!selected.length) return showToast("Toplu silme için ürün seç.");

  const selectedIds = new Set(selected.map((product) => product.id));
  try {
    for (const productId of selectedIds) {
      await deleteProductRemote(productId);
    }
  } catch (error) {
    console.error(error);
    return showToast("Toplu silme sırasında hata oldu.");
  }
  state.products = state.products.filter((product) => !selectedIds.has(product.id));
  state.cart = state.cart.filter((item) => !selectedIds.has(item.productId));
  selectedProductIds.clear();
  renderAll();
  showToast(`${selected.length} ürün silindi.`);
}

function handleBulkPrintBarcodes() {
  const selected = getSelectedProducts();
  if (!selected.length) return showToast("Barkod çıkarmak için ürün seç.");
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
  const printSaleId = event.target.dataset.printSale;
  const emailSaleId = event.target.dataset.emailSale;
  const whatsappSaleId = event.target.dataset.whatsappSale;
  const savePricesId = event.target.dataset.savePrices;
  const quickPaidValue = event.target.dataset.quickPaid;
  const paymentMethodValue = event.target.dataset.paymentMethod;
  const saleCustomerId = event.target.dataset.saleCustomer;
  const selectProductId = event.target.dataset.selectProduct;
  const saleDetailId = event.target.dataset.saleDetail;
  const scanTargetId = event.target.dataset.scanTarget;
  const scanModeValue = event.target.dataset.scanMode;

  if (editProductId) {
    const product = getProduct(editProductId);
    if (!product) return;
  document.querySelector("#productId").value = product.id;
  document.querySelector("#productName").value = product.name;
  document.querySelector("#productBarcode").value = product.barcode;
  document.querySelector("#productBrand").value = product.brand;
  document.querySelector("#retailPrice").value = product.retailPrice;
  document.querySelector("#wholesalePrice").value = product.wholesalePrice;
  document.querySelector("#stockQuantity").value = product.stock;
  document.querySelector("#stockCode").value = product.stockCode || generateStockCode(product.wholesalePrice);
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
      return showToast("Ürün silinemedi.");
    }
    state.products = state.products.filter((product) => product.id !== deleteProductId);
    state.cart = state.cart.filter((item) => item.productId !== deleteProductId);
    renderAll();
    showToast("Ürün silindi.");
  }

  if (printBarcodeId) {
    printBarcodeLabel(printBarcodeId);
  }

  if (printSaleId) {
    printSaleReceipt(printSaleId);
  }

  if (emailSaleId) {
    shareSaleByEmail(emailSaleId);
  }

  if (whatsappSaleId) {
    shareSaleByWhatsApp(whatsappSaleId);
  }

  if (savePricesId) {
    const retailInput = document.querySelector(`[data-inline-retail="${savePricesId}"]`);
    const wholesaleInput = document.querySelector(`[data-inline-wholesale="${savePricesId}"]`);
    const stockInput = document.querySelector(`[data-inline-stock="${savePricesId}"]`);
    if (!retailInput || !wholesaleInput || !stockInput) return;
    await updateProductValues(savePricesId, retailInput.value, wholesaleInput.value, stockInput.value);
  }

  if (quickPaidValue) {
    applyQuickPaidValue(quickPaidValue);
  }

  if (paymentMethodValue) {
    document.querySelector("#paymentMethod").value = paymentMethodValue;
    updatePaymentMethodButtons();
    showToast(`Ödeme tipi: ${paymentMethodValue}`);
  }

  if (saleCustomerId) {
    document.querySelector("#saleCustomer").value = saleCustomerId;
    renderCustomers();
    showToast("Müşteri seçildi.");
  }

  if (selectProductId) {
    if (event.target.checked) {
      selectedProductIds.add(selectProductId);
    } else {
      selectedProductIds.delete(selectProductId);
    }
    renderProducts();
  }

  if (saleDetailId) {
    openSaleDetail(saleDetailId);
  }

  if (scanTargetId) {
    startBarcodeScanner(scanTargetId, scanModeValue);
  }

  if (addCartId) addProductToCart(addCartId);

  if (removeCartId) {
    state.cart = state.cart.filter((item) => (item.cartKey || item.productId) !== removeCartId);
    renderCart();
    saveState();
    showToast("Ürün sepetten kaldırıldı.");
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
      return showToast("Müşteri silinemedi.");
    }
    state.customers = state.customers.filter((customer) => customer.id !== deleteCustomerId);
    renderAll();
    showToast("Müşteri silindi.");
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
    showToast("Ürün resmi yüklendi.");
  };
  reader.readAsDataURL(file);
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  if (!supabaseClient) return showToast("Bulut bağlantısı hazır değil.");

  const email = document.querySelector("#authEmail").value.trim();
  const password = document.querySelector("#authPassword").value;
  const submitButton = document.querySelector("#authSubmitBtn");
  const authMessage = document.querySelector("#authMessage");

  submitButton.disabled = true;
  authMessage.textContent = "Giriş yapılıyor...";

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
  showToast("Çıkış yapıldı.");
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
  const stockInput = document.querySelector(`[data-inline-stock="${productId}"]`);
  if (!retailInput || !wholesaleInput || !stockInput) return;
  await updateProductValues(productId, retailInput.value, wholesaleInput.value, stockInput.value);
}

function handleDocumentInput(event) {
  if (!(event.target instanceof HTMLInputElement)) return;
  if (!event.target.dataset.inlineRetail && !event.target.dataset.inlineWholesale && !event.target.dataset.inlineStock) return;
  refreshInlinePriceChangeState();
}

function bindEvents() {
  document.querySelectorAll(".nav-tab").forEach((button) => {
    button.addEventListener("click", () => {
      setView(button.dataset.view);
      if (isMobileViewport()) closeMobileNav();
    });
  });
  document.querySelectorAll(".mobile-nav-link").forEach((button) => {
    button.addEventListener("click", () => {
      setView(button.dataset.mobileView);
      closeMobileNav();
    });
  });
  document.querySelector("#mobileMenuBtn").addEventListener("click", toggleMobileNav);
  document.querySelector("#mobileMenuCloseBtn").addEventListener("click", closeMobileNav);
  document.querySelector("#mobileMenuClosePanelBtn").addEventListener("click", closeMobileNav);
  document.querySelector("#mobileNavOverlay").addEventListener("click", closeMobileNav);
  window.addEventListener("resize", () => {
    syncMobileLayout();
  });

  document.querySelector("#productForm").addEventListener("submit", handleProductSubmit);
  document.querySelector("#customerForm").addEventListener("submit", handleCustomerSubmit);
  document.querySelector("#authForm").addEventListener("submit", handleAuthSubmit);
  document.querySelector("#productQuickEditForm").addEventListener("submit", saveQuickEditProduct);
  document.querySelector("#saleForm").addEventListener("submit", handleSaleForm);
  document.querySelector("#priceCheckBtn").addEventListener("click", handlePriceCheck);
  document.querySelector("#completeSaleForm").addEventListener("submit", handleCompleteSale);
  document.querySelector("#inventoryForm").addEventListener("submit", handleInventorySubmit);
  document.querySelector("#settingsForm").addEventListener("submit", handleSettingsSubmit);
  document.querySelector("#logoutBtn").addEventListener("click", handleLogout);
  document.querySelector("#closeScannerBtn").addEventListener("click", stopBarcodeScanner);
  document.querySelector("#closeProductQuickEditBtn").addEventListener("click", () => setProductQuickEditVisible(false));
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
  document.querySelector("#retailPrice").addEventListener("input", () => updateBarcodePreview(document.querySelector("#productBarcode").value));
  document.querySelector("#productBrand").addEventListener("input", () => updateBarcodePreview(document.querySelector("#productBarcode").value));
  document.querySelector("#wholesalePrice").addEventListener("input", (event) => {
    document.querySelector("#stockCode").value = generateStockCode(event.target.value);
  });
  document.querySelector("#exportBtn").addEventListener("click", exportData);
  document.querySelector("#importFile").addEventListener("change", importData);
  document.querySelector("#excelImportFile").addEventListener("change", importExcelProducts);
  document.querySelector("#downloadExcelTemplateBtn").addEventListener("click", downloadExcelTemplate);
  document.querySelector("#downloadSampleExcelBtn")?.addEventListener("click", downloadSampleExcelTemplate);
  document.querySelector("#salesHistoryDateFrom")?.addEventListener("change", renderSalesHistoryPage);
  document.querySelector("#salesHistoryDateTo")?.addEventListener("change", renderSalesHistoryPage);
  document.querySelector("#salesHistorySearch")?.addEventListener("input", renderSalesHistoryPage);
  document.querySelector("#toggleAllSalesSelectionBtn")?.addEventListener("click", () => {
    const visibleIds = filterSalesHistory().map((sale) => sale.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedSaleIds.has(id));
    visibleIds.forEach((id) => {
      if (allSelected) {
        selectedSaleIds.delete(id);
      } else {
        selectedSaleIds.add(id);
      }
    });
    renderSalesHistoryPage();
  });
  document.querySelector("#bulkSalesPdfBtn")?.addEventListener("click", printSelectedSalesPdf);
  document.querySelector("#closeSaleDetailBtn")?.addEventListener("click", () => {
    document.querySelector("#saleDetailOverlay")?.classList.add("hidden-overlay");
  });
  document.querySelector("#removeProductImageBtn").addEventListener("click", () => {
    document.querySelector("#productImageData").value = "";
    document.querySelector("#productImageFile").value = "";
    updateProductImagePreview("");
    updateBarcodePreview(document.querySelector("#productBarcode").value);
    showToast("Ürün resmi kaldırıldı.");
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
  document.addEventListener("change", handleCartInlineChange);
  document.addEventListener("change", handleSalesHistorySelectionChange);
  document.addEventListener("keydown", handleDocumentKeydown);
  document.addEventListener("input", handleDocumentInput);
}

function enhanceSalesLayout() {
  const workspace = document.querySelector(".sales-workspace");
  const grid = document.querySelector(".sales-grid");
  const customerStrip = document.querySelector(".sales-customer-strip");
  const cartPanel = document.querySelector(".sales-cart-panel");
  const paymentPanel = document.querySelector(".sales-payment-panel");
  const productsPanel = document.querySelector(".sales-products-panel");
  const productSearchField = productsPanel?.querySelector(".field");
  const productPanelChip = productsPanel?.querySelector(".chip");
  const productPanelTitle = productsPanel?.querySelector("h3");
  const barcodeInput = document.querySelector("#barcodeInput");
  const saleFormButton = document.querySelector('#saleForm button[type="submit"]');
  const priceButton = document.querySelector("#priceCheckBtn");
  const scanButton = document.querySelector('#saleForm [data-scan-target="barcodeInput"]');

  if (!workspace || !grid || !customerStrip || !cartPanel || !paymentPanel || !productsPanel) return;

  workspace.classList.add("sales-pos-shell");
  grid.classList.add("sales-grid-pos");

  let leftColumn = grid.querySelector(".sales-left-column");
  if (!leftColumn) {
    leftColumn = document.createElement("div");
    leftColumn.className = "sales-left-column";
    grid.insertBefore(leftColumn, paymentPanel);
  }

  leftColumn.appendChild(customerStrip);
  leftColumn.appendChild(cartPanel);
  leftColumn.appendChild(productsPanel);

  cartPanel.classList.add("sales-cart-panel-pos");
  paymentPanel.classList.add("sales-payment-panel-pos");
  productsPanel.classList.add("inline-products-panel");

  if (productSearchField) productSearchField.style.display = "none";
  if (productPanelChip) productPanelChip.style.display = "none";
  if (productPanelTitle) productPanelTitle.textContent = "Arama Sonuçları";
  if (barcodeInput) barcodeInput.placeholder = "Ürün adı, stok kodu veya barkod yaz";
  if (saleFormButton) saleFormButton.textContent = "Ekle";
  if (priceButton) priceButton.textContent = "Fiyat Gör";
  if (scanButton) scanButton.textContent = "Okut";

  if (!document.querySelector("#customSaleForm")) {
    const customPanel = document.createElement("div");
    customPanel.className = "sales-custom-panel";
    customPanel.innerHTML = `
      <div class="sales-section-head">
        <h3>Muhtelif Ürün</h3>
        <span class="muted">Ad, fiyat ve adet ile ekle</span>
      </div>
      <form id="customSaleForm" class="sales-custom-form">
        <input id="customSaleName" type="text" placeholder="Muhtelif ürün adı">
        <input id="customSalePrice" type="number" min="0" step="0.01" placeholder="Fiyat">
        <input id="customSaleQuantity" type="number" min="1" step="1" value="1" placeholder="Adet">
        <button type="submit" class="primary-btn">Muhtelif Ekle</button>
      </form>
    `;
    customerStrip.insertAdjacentElement("afterend", customPanel);

    customPanel.querySelector("#customSaleForm").addEventListener("submit", (event) => {
      event.preventDefault();
      addCustomSaleItem(
        customPanel.querySelector("#customSaleName").value,
        customPanel.querySelector("#customSalePrice").value,
        customPanel.querySelector("#customSaleQuantity").value
      );
      customPanel.querySelector("#customSaleForm").reset();
      customPanel.querySelector("#customSaleQuantity").value = 1;
    });
  }
}

function initSalesSearchBehavior() {
  const barcodeInput = document.querySelector("#barcodeInput");
  if (!barcodeInput) return;

  barcodeInput.addEventListener("input", () => {
    const sideSearch = document.querySelector("#productSearchInput");
    if (sideSearch) sideSearch.value = barcodeInput.value;
    renderProducts();
  });
}

function renderCart() {
  const cartItems = document.querySelector("#cartItems");
  const itemCount = document.querySelector("#salesItemCount");
  if (!cartItems) return;

  state.cart.forEach((item) => {
    if (!item.cartKey) {
      item.cartKey = item.productId ? `${item.productId}:${item.mode}` : crypto.randomUUID();
    }
  });

  if (itemCount) {
    itemCount.textContent = `${state.cart.reduce((sum, item) => sum + item.quantity, 0)} ürün`;
  }

  cartItems.innerHTML = state.cart.length
    ? `
        <div class="sales-cart-table-head">
          <span>Ürün</span>
          <span>Miktar</span>
          <span>Fiyat</span>
          <span>Tutar</span>
          <span>Stok</span>
          <span>İşlem</span>
        </div>
        <div class="sales-cart-table-body">
          ${state.cart
            .map(
              (item) => `
                <div class="sales-cart-row">
                  <div class="sales-cart-product">
                    <strong>${item.name}</strong>
                    <span class="muted">${item.mode === "wholesale" ? "Toptan" : "Perakende"} / ${item.barcode}</span>
                  </div>
                  <input class="cart-inline-input" type="number" min="1" step="1" value="${Number(item.quantity)}" data-cart-qty="${item.cartKey}">
                  <input class="cart-inline-input" type="number" min="0" step="0.01" value="${Number(item.price)}" data-cart-price="${item.cartKey}">
                  <strong>${formatCurrency(item.price * item.quantity)}</strong>
                  ${item.productId ? `<input class="cart-inline-input stock-inline-input" type="number" min="0" step="1" value="${Number(getProduct(item.productId)?.stock || 0)}" data-cart-stock="${item.productId}">` : ""}
                  <button type="button" class="ghost-btn sales-remove-btn" data-remove-cart="${item.cartKey || item.productId}">Sil</button>
                </div>
              `
            )
            .join("")}
        </div>
      `
    : `<article class="record-card"><span class="muted">Sepet boş. Barkod okutarak veya arama alanından ürün seçerek başlayabilirsin.</span></article>`;

  recalcCart();
}

function handleSaleForm(event) {
  event.preventDefault();
  const query = document.querySelector("#barcodeInput").value.trim();
  if (!query) return showToast("Ürün adı, barkod veya stok kodu gir.");

  const exactProduct = state.products.find((item) => item.barcode === query || item.stockCode === query);
  if (exactProduct) {
    addProductToCart(exactProduct.id);
    document.querySelector("#barcodeInput").value = "";
    renderProducts();
    document.querySelector("#barcodeInput").focus();
    return;
  }

  const matches = findProductsForSaleQuery(query);
  if (!matches.length) {
    showToast("Aramana uygun ürün bulunamadı.");
    return;
  }

  if (matches.length === 1) {
    addProductToCart(matches[0].id);
    document.querySelector("#barcodeInput").value = "";
    renderProducts();
    document.querySelector("#barcodeInput").focus();
    return;
  }

  renderProducts();
  showToast("Birden fazla ürün bulundu, alttaki sonuçlardan seç.");
}

function handlePriceCheck() {
  const query = document.querySelector("#barcodeInput").value.trim();
  if (!query) return showToast("Fiyat görmek için ürün adı, barkod veya stok kodu gir.");

  const exactProduct = state.products.find((item) => item.barcode === query || item.stockCode === query);
  const matches = exactProduct ? [exactProduct] : findProductsForSaleQuery(query);
  if (!matches.length) return showToast("Aramana uygun ürün bulunamadı.");

  const product = matches[0];
  const mode = document.querySelector("#saleMode").value;
  const price = mode === "wholesale" ? product.wholesalePrice : product.retailPrice;
  showToast(`${product.name}: ${formatCurrency(price)}`);
}

async function saveQuickEditProduct(event) {
  event.preventDefault();
  const productId = document.querySelector("#productQuickEditId").value;
  const retail = document.querySelector("#productQuickEditRetail").value;
  const wholesale = document.querySelector("#productQuickEditWholesale").value;
  const stock = document.querySelector("#productQuickEditStock").value;
  const saved = await updateProductValues(productId, retail, wholesale, stock);
  if (saved) {
    setProductQuickEditVisible(false);
  }
}

function handleCartInlineChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;

  if (target.dataset.cartQty || target.dataset.cartPrice) {
    const cartKey = target.dataset.cartQty || target.dataset.cartPrice;
    const item = state.cart.find((entry) => entry.cartKey === cartKey);
    if (!item) return;

    const qtyInput = document.querySelector(`[data-cart-qty="${cartKey}"]`);
    const priceInput = document.querySelector(`[data-cart-price="${cartKey}"]`);
    const quantity = Number(qtyInput?.value || item.quantity);
    const price = Number(priceInput?.value || item.price);

    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price < 0) {
      showToast("Sepette geçerli miktar ve fiyat gir.");
      renderCart();
      return;
    }

    item.quantity = quantity;
    item.price = price;
    saveState();
    renderCart();
    return;
  }

  if (target.dataset.cartStock) {
    const product = getProduct(target.dataset.cartStock);
    const stock = Number(target.value);
    if (!product || !Number.isFinite(stock) || stock < 0) {
      showToast("Geçerli stok adedi gir.");
      renderCart();
      return;
    }
    product.stock = stock;
    persistProductRemote(product).catch((error) => console.error(error));
    saveState();
    renderAll();
  }
}

function handleSalesHistorySelectionChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (!target.dataset.selectSale) return;

  if (target.checked) {
    selectedSaleIds.add(target.dataset.selectSale);
  } else {
    selectedSaleIds.delete(target.dataset.selectSale);
  }
  renderSalesHistoryPage();
}

function ensureSalesHistoryUI() {
  if (!document.querySelector('.nav-tab[data-view="sales-history"]')) {
    const reportsTab = document.querySelector('.nav-tab[data-view="reports"]');
    reportsTab?.insertAdjacentHTML("beforebegin", '<button class="nav-tab" data-view="sales-history">Satışlar</button>');
  }

  if (!document.querySelector('.mobile-nav-link[data-mobile-view="sales-history"]')) {
    const reportsMobileTab = document.querySelector('.mobile-nav-link[data-mobile-view="reports"]');
    reportsMobileTab?.insertAdjacentHTML("beforebegin", '<button class="mobile-nav-link" data-mobile-view="sales-history" type="button">Satışlar</button>');
  }

  if (!document.querySelector("#view-sales-history")) {
    const reportsView = document.querySelector("#view-reports");
    reportsView?.insertAdjacentHTML(
      "afterend",
      `<section class="view" id="view-sales-history">
        <div class="panel">
          <div class="panel-head">
            <div>
              <h3>Satışlar</h3>
              <p class="muted">Yapılan satışları filtrele, görüntüle ve paylaş</p>
            </div>
            <div class="inline-actions">
              <button type="button" id="toggleAllSalesSelectionBtn">Tümünü Seç</button>
              <button type="button" id="bulkSalesPdfBtn">Toplu PDF</button>
            </div>
          </div>
          <div class="form-grid compact">
            <div class="field">
              <label for="salesHistoryDateFrom">Başlangıç Tarihi</label>
              <input id="salesHistoryDateFrom" type="date">
            </div>
            <div class="field">
              <label for="salesHistoryDateTo">Bitiş Tarihi</label>
              <input id="salesHistoryDateTo" type="date">
            </div>
            <div class="field span-2">
              <label for="salesHistorySearch">Ara</label>
              <input id="salesHistorySearch" type="search" placeholder="Müşteri adı, ödeme tipi veya ürün adı">
            </div>
          </div>
          <div id="salesHistoryPageList" class="list-stack"></div>
        </div>
      </section>`
    );
  }

  if (!document.querySelector("#saleDetailOverlay")) {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="saleDetailOverlay" class="auth-overlay hidden-overlay">
        <div class="auth-card">
          <div class="panel-head">
            <div>
              <p class="eyebrow">Satış Detayı</p>
              <h3 id="saleDetailTitle">Satış</h3>
            </div>
            <button type="button" id="closeSaleDetailBtn" class="ghost-btn">Kapat</button>
          </div>
          <div id="saleDetailContent" class="list-stack"></div>
        </div>
      </div>`
    );
  }
}

function openSaleDetail(saleId) {
  const sale = getSaleById(saleId);
  if (!sale) return showToast("Satış bulunamadı.");
  const overlay = document.querySelector("#saleDetailOverlay");
  const title = document.querySelector("#saleDetailTitle");
  const content = document.querySelector("#saleDetailContent");
  if (!overlay || !title || !content) return;

  title.textContent = `${sale.mode === "wholesale" ? "Toptan" : "Perakende"} satış`;
  content.innerHTML = `
    <article class="record-card">
      <div class="record-line"><strong>Müşteri</strong><span>${escapeHtml(getCustomerName(sale.customerId))}</span></div>
      <div class="record-line"><strong>Ödeme</strong><span>${escapeHtml(sale.paymentMethod)}</span></div>
      <div class="record-line"><strong>Tarih</strong><span>${escapeHtml(formatDate(sale.createdAt))}</span></div>
      <div class="record-line"><strong>Toplam</strong><strong>${formatCurrency(sale.total)}</strong></div>
      ${sale.discount ? `<div class="record-line"><strong>İndirim</strong><span>${formatCurrency(sale.discount)}</span></div>` : ""}
      ${sale.note ? `<p class="muted">${escapeHtml(sale.note)}</p>` : ""}
    </article>
    ${sale.items.map((item) => `
      <article class="record-card">
        <div class="list-item-head">
          <strong>${escapeHtml(item.name)}</strong>
          <span>${item.quantity} adet</span>
        </div>
        <div class="record-line muted">
          <span>${escapeHtml(item.barcode || "-")}</span>
          <span>${formatCurrency(item.price)}</span>
        </div>
      </article>
    `).join("")}
  `;
  overlay.classList.remove("hidden-overlay");
}

function filterSalesHistory() {
  const dateFrom = document.querySelector("#salesHistoryDateFrom")?.value;
  const dateTo = document.querySelector("#salesHistoryDateTo")?.value;
  const search = document.querySelector("#salesHistorySearch")?.value.trim().toLowerCase() || "";

  return [...state.sales]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .filter((sale) => {
      const saleDate = sale.createdAt.slice(0, 10);
      const matchesFrom = dateFrom ? saleDate >= dateFrom : true;
      const matchesTo = dateTo ? saleDate <= dateTo : true;
      const haystack = [
        getCustomerName(sale.customerId),
        sale.paymentMethod,
        sale.mode === "wholesale" ? "toptan" : "perakende",
        ...sale.items.map((item) => item.name)
      ].join(" ").toLowerCase();
      return matchesFrom && matchesTo && haystack.includes(search);
    });
}

function renderSalesHistoryPage() {
  const list = document.querySelector("#salesHistoryPageList");
  if (!list) return;
  const sales = filterSalesHistory();

  list.innerHTML = sales.length
    ? sales.map((sale) => `
      <article class="record-card">
        <div class="list-item-head">
          <label class="bulk-check-label">
            <input type="checkbox" data-select-sale="${sale.id}" ${selectedSaleIds.has(sale.id) ? "checked" : ""}>
            <strong>${sale.mode === "wholesale" ? "Toptan" : "Perakende"} satış</strong>
          </label>
          <span>${formatCurrency(sale.total)}</span>
        </div>
        <div class="record-line muted">
          <span>${escapeHtml(getCustomerName(sale.customerId))} / ${escapeHtml(sale.paymentMethod)}</span>
          <span>${escapeHtml(formatDate(sale.createdAt))}</span>
        </div>
        <p class="muted">${sale.items.map((item) => `${item.name} x${item.quantity}`).join(", ")}</p>
        <div class="inline-actions">
          <button type="button" data-sale-detail="${sale.id}">Detay</button>
          <button type="button" data-print-sale="${sale.id}">Yazdır</button>
          <button type="button" data-email-sale="${sale.id}">Mail Gönder</button>
          <button type="button" data-whatsapp-sale="${sale.id}">WhatsApp</button>
        </div>
      </article>
    `).join("")
    : `<article class="record-card"><span class="muted">Filtreye uygun satış bulunamadı.</span></article>`;
}

function printSelectedSalesPdf() {
  const sales = filterSalesHistory().filter((sale) => selectedSaleIds.has(sale.id));
  if (!sales.length) return showToast("PDF için satış seç.");
  const sections = sales.map((sale) => `
    <section style="break-inside: avoid; margin-bottom: 28px;">
      <h3>${sale.mode === "wholesale" ? "Toptan" : "Perakende"} satış - ${formatDate(sale.createdAt)}</h3>
      <p>Müşteri: ${escapeHtml(getCustomerName(sale.customerId))}</p>
      <p>Ödeme: ${escapeHtml(sale.paymentMethod)}</p>
      <p>Toplam: ${formatCurrency(sale.total)}</p>
      <ul>${sale.items.map((item) => `<li>${escapeHtml(item.name)} x${item.quantity} - ${formatCurrency(item.price * item.quantity)}</li>`).join("")}</ul>
    </section>
  `).join("");
  const printWindow = window.open("", "_blank", "width=900,height=900");
  if (!printWindow) return showToast("PDF penceresi açılamadı.");
  printWindow.document.write(`<!DOCTYPE html><html lang="tr"><head><meta charset="UTF-8"><title>Toplu Satış PDF</title><style>body{font-family:Arial,sans-serif;padding:24px;}h2,h3,p{margin:0 0 8px;}ul{margin:8px 0 0 18px;}section{border-bottom:1px solid #ddd;padding-bottom:16px;}</style></head><body><h2>${escapeHtml(state.settings.storeName || "OyuncakPOS")} - Satış Listesi</h2>${sections}<script>window.onload=function(){window.print();};</script></body></html>`);
  printWindow.document.close();
}

function downloadExcelTemplate() {
  const templateRows = [
    {
      Barkod: "869100100001",
      "Ürün Adı": "Oyuncak Araba",
      Marka: "ToyStar",
      "Perakende Fiyat": 150,
      "Toptan Fiyat": 100,
      Stok: 12,
      "Stok Kodu": "TT-100 0004"
    },
    {
      Barkod: "869100100002",
      "Ürün Adı": "Peluş Ayı",
      Marka: "Mutlu Kids",
      "Perakende Fiyat": 220,
      "Toptan Fiyat": 160,
      Stok: 8,
      "Stok Kodu": "TT-160 0004"
    }
  ];

  if (window.XLSX) {
    const worksheet = window.XLSX.utils.json_to_sheet(templateRows);
    const workbook = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(workbook, worksheet, "Urunler");
    window.XLSX.writeFile(workbook, "oyuncakpos-excel-sablon.xlsx");
    showToast("Excel şablonu indirildi.");
    return;
  }

  const headers = Object.keys(templateRows[0]);
  const rowsHtml = templateRows
    .map((row) => `<tr>${headers.map((header) => `<td>${escapeHtml(String(row[header] ?? ""))}</td>`).join("")}</tr>`)
    .join("");

  const htmlTable = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head>
  <meta charset="UTF-8">
  <meta name="ProgId" content="Excel.Sheet">
</head>
<body>
  <table>
    <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</body>
</html>`;

  const blob = new Blob(["\ufeff", htmlTable], { type: "application/vnd.ms-excel;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "oyuncakpos-excel-sablon.xls";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("Excel şablonu indirildi.");
}

function downloadSampleExcelTemplate() {
  const templateRows = [
    {
      Barkod: "869100100101",
      "Ürün Adı": "Uzaktan Kumandali Araba",
      Marka: "Speed Toys",
      "Perakende Fiyat": 750,
      "Toptan Fiyat": 500,
      Stok: 14,
      "Stok Kodu": "TT-500 0004"
    },
    {
      Barkod: "869100100102",
      "Ürün Adı": "Sesli Pelus Ayicik",
      Marka: "Mutlu Kids",
      "Perakende Fiyat": 420,
      "Toptan Fiyat": 300,
      Stok: 9,
      "Stok Kodu": "TT-300 0004"
    },
    {
      Barkod: "869100100103",
      "Ürün Adı": "Ahsap Yapboz",
      Marka: "Mini Usta",
      "Perakende Fiyat": 180,
      "Toptan Fiyat": 120,
      Stok: 25,
      "Stok Kodu": "TT-120 0004"
    }
  ];

  if (window.XLSX) {
    const worksheet = window.XLSX.utils.json_to_sheet(templateRows);
    const workbook = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(workbook, worksheet, "OrnekUrunler");
    window.XLSX.writeFile(workbook, "oyuncakpos-ornek-dolu-sablon.xlsx");
    showToast("Örnek dolu şablon indirildi.");
    return;
  }

  const headers = Object.keys(templateRows[0]);
  const rowsHtml = templateRows
    .map((row) => `<tr>${headers.map((header) => `<td>${escapeHtml(String(row[header] ?? ""))}</td>`).join("")}</tr>`)
    .join("");

  const htmlTable = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head>
  <meta charset="UTF-8">
  <meta name="ProgId" content="Excel.Sheet">
</head>
<body>
  <table>
    <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</body>
</html>`;

  const blob = new Blob(["\ufeff", htmlTable], { type: "application/vnd.ms-excel;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "oyuncakpos-ornek-dolu-sablon.xls";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("Örnek dolu şablon indirildi.");
}

async function init() {
  ensureSalesHistoryUI();
  bindEvents();
  enhanceSalesLayout();
  initSalesSearchBehavior();
  initClock();
  renderAll();
  setView(loadActiveView());
  syncMobileLayout();
  updatePaymentMethodButtons();
  refreshInlinePriceChangeState();
  document.querySelector("#stockCode").value = generateStockCode(0);
  updateBarcodePreview(document.querySelector("#productBarcode").value);
  await initSupabaseAuth();
}

init();
