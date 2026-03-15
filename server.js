// =============================================
// SNK STORE - Checkout Service Standalone
// PayPal + Shopify Admin API
// =============================================

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Config -----
const PORT = process.env.PORT || 3000;
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "";
const PAYPAL_BASE = "https://api-m.paypal.com";

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || "ketj31-fg.myshopify.com";
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || "";
const SHOPIFY_API_VERSION = "2024-01";

// Domaines autorises pour CORS (ton site Shopify + custom domain)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

// ---- Helpers CORS -----
function getCorsHeaders(req) {
  const origin = req.headers.origin || "";
  // En dev, on autorise tout. En prod, verifie la liste
  const allowedOrigin = ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true"
  };
}

// ---- PayPal Auth -----
async function getPayPalAccessToken() {
  const auth = Buffer.from(PAYPAL_CLIENT_ID + ":" + PAYPAL_CLIENT_SECRET).toString("base64");
  const res = await fetch(PAYPAL_BASE + "/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + auth,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });
  const data = await res.json();
  return data.access_token;
}

// ---- PayPal: Creer une commande -----
async function createPayPalOrder(cart) {
  const token = await getPayPalAccessToken();

  // Calculer le total du panier
  let total = 0;
  const items = [];
  for (const item of cart) {
    const price = parseFloat(item.price) || 0;
    const qty = parseInt(item.quantity) || 1;
    total += price * qty;
    items.push({
      name: item.name || item.title || "Produit",
      unit_amount: { currency_code: "EUR", value: price.toFixed(2) },
      quantity: String(qty)
    });
  }

  const orderPayload = {
    intent: "CAPTURE",
    purchase_units: [{
      amount: {
        currency_code: "EUR",
        value: total.toFixed(2),
        breakdown: {
          item_total: { currency_code: "EUR", value: total.toFixed(2) }
        }
      },
      items: items
    }]
  };

  const res = await fetch(PAYPAL_BASE + "/v2/checkout/orders", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(orderPayload)
  });
  return await res.json();
}

// ---- PayPal: Capturer le paiement -----
async function capturePayPalOrder(orderID) {
  const token = await getPayPalAccessToken();
  const res = await fetch(PAYPAL_BASE + "/v2/checkout/orders/" + orderID + "/capture", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json"
    }
  });
  return await res.json();
}

// ---- Shopify: Creer la commande -----
async function createShopifyOrder(paypalCapture, cartItems, customerData) {
  if (!SHOPIFY_ADMIN_TOKEN) {
    console.log("SHOPIFY_ADMIN_TOKEN non configure - commande non creee dans Shopify");
    return null;
  }

  try {
    const lineItems = cartItems.map(function(item) {
      return {
        title: item.name || item.title || "Produit",
        quantity: parseInt(item.quantity) || 1,
        price: String(parseFloat(item.price) || 0)
      };
    });

    // Montant total depuis PayPal
    let captureAmount = "0.00";
    try {
      captureAmount = paypalCapture.purchase_units[0].payments.captures[0].amount.value;
    } catch(e) {
      try { captureAmount = paypalCapture.purchase_units[0].amount.value; } catch(e2) {}
    }

    // Info client depuis le formulaire checkout (prioritaire) ou PayPal (fallback)
    let shipping = null;
    let email = null;
    let phone = null;

    if (customerData && customerData.firstName) {
      // Infos du formulaire checkout
      shipping = {
        first_name: customerData.firstName || "",
        last_name: customerData.lastName || "",
        address1: customerData.address1 || "",
        address2: customerData.address2 || "",
        city: customerData.city || "",
        zip: customerData.zip || "",
        country_code: customerData.country || "FR",
        phone: customerData.phone || ""
      };
      email = customerData.email || null;
      phone = customerData.phone || null;
    } else {
      // Fallback: infos PayPal
      try {
        const pu = paypalCapture.purchase_units[0];
        if (pu.shipping && pu.shipping.address) {
          const addr = pu.shipping.address;
          const nameParts = (pu.shipping.name && pu.shipping.name.full_name) ? pu.shipping.name.full_name.split(" ") : ["Client"];
          shipping = {
            first_name: nameParts[0] || "Client",
            last_name: nameParts.slice(1).join(" ") || "",
            address1: addr.address_line_1 || "",
            address2: addr.address_line_2 || "",
            city: addr.admin_area_2 || "",
            province: addr.admin_area_1 || "",
            zip: addr.postal_code || "",
            country_code: addr.country_code || "FR"
          };
        }
      } catch(e) {}
      try {
        email = paypalCapture.payer && paypalCapture.payer.email_address;
      } catch(e) {}
    }

    const orderData = {
      order: {
        line_items: lineItems,
        financial_status: "paid",
        currency: "EUR",
        tags: "paypal,checkout-service",
        note: "Commande PayPal #" + (paypalCapture.id || ""),
        transactions: [{
          kind: "capture",
          status: "success",
          amount: captureAmount,
          gateway: "paypal"
        }]
      }
    };

    if (shipping) {
      orderData.order.shipping_address = shipping;
      // Copier aussi en billing_address
      orderData.order.billing_address = shipping;
    }
    if (email) orderData.order.email = email;
    if (phone) orderData.order.phone = phone;
    // Créer le client dans Shopify
    if (email || (customerData && customerData.firstName)) {
      orderData.order.customer = {
        first_name: (customerData && customerData.firstName) || "",
        last_name: (customerData && customerData.lastName) || "",
        email: email || ""
      };
      if (phone) orderData.order.customer.phone = phone;
    }

    const shopifyUrl = "https://" + SHOPIFY_STORE_DOMAIN + "/admin/api/" + SHOPIFY_API_VERSION + "/orders.json";
    const response = await fetch(shopifyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN
      },
      body: JSON.stringify(orderData)
    });

    const result = await response.json();
    if (result.errors) {
      console.error("Shopify order errors:", JSON.stringify(result.errors));
    } else {
      console.log("Commande Shopify creee: #" + (result.order && result.order.order_number));
    }
    return result;
  } catch(err) {
    console.error("Erreur creation commande Shopify:", err);
    throw err;
  }
}

// ---- Lire le body d'une requete -----
function readBody(req) {
  return new Promise(function(resolve, reject) {
    let data = "";
    req.on("data", function(chunk) { data += chunk; });
    req.on("end", function() {
      try { resolve(JSON.parse(data)); }
      catch(e) { resolve({}); }
    });
    req.on("error", reject);
  });
}

// =============================================
// SERVEUR HTTP
// =============================================
const server = http.createServer(async function(req, res) {
  const url = new URL(req.url, "http://localhost");
  const corsHeaders = getCorsHeaders(req);

  // ---- Preflight CORS -----
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  try {
    // ---- API: Config PayPal (client ID pour le front) -----
    if (url.pathname === "/api/config" && req.method === "GET") {
      res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify({ clientId: PAYPAL_CLIENT_ID }));
      return;
    }

    // ---- API: Creer commande PayPal -----
    if (url.pathname === "/api/orders" && req.method === "POST") {
      const body = await readBody(req);
      const cart = body.cart || body.items || [];
      if (!cart.length) {
        res.writeHead(400, { ...corsHeaders, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Panier vide" }));
        return;
      }
      const result = await createPayPalOrder(cart);
      res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // ---- API: Capturer le paiement -----
    const captureMatch = url.pathname.match(/^\/api\/orders\/([^\/]+)\/capture$/);
    if (captureMatch && req.method === "POST") {
      const orderID = captureMatch[1];
      const body = await readBody(req);
      const result = await capturePayPalOrder(orderID);

      // Creer la commande dans Shopify apres capture PayPal reussie
      try {
        if (result && (result.status === "COMPLETED" || result.purchase_units)) {
          const cartForShopify = body.cart || body.items || [];
          const customerForShopify = body.customer || {};
          createShopifyOrder(result, cartForShopify, customerForShopify).catch(function(err) {
            console.error("Shopify order err:", err);
          });
        }
      } catch(shopifyErr) {
        console.error("Shopify sync error:", shopifyErr);
      }

      res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // ---- Page checkout -----
    if (url.pathname === "/" || url.pathname === "/checkout") {
      const checkoutPath = path.join(__dirname, "src", "checkout.html");
      if (fs.existsSync(checkoutPath)) {
        const html = fs.readFileSync(checkoutPath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
    }

    // ---- Health check -----
    if (url.pathname === "/health") {
      res.writeHead(200, { ...corsHeaders, "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "checkout" }));
      return;
    }

    // ---- 404 -----
    res.writeHead(404, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));

  } catch(err) {
    console.error("Server error:", err);
    res.writeHead(500, { ...corsHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
});

server.listen(PORT, function() {
  console.log("Checkout service running on port " + PORT);
});
