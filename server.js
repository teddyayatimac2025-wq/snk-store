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
    // CrÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ©er le client dans Shopify
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

// ── ONE-TIME: update Shopify theme redirect to point to this checkout ──
(function updateThemeRedirect() {
  var THEME_ID = "182586704201";
  var API_VER = SHOPIFY_API_VERSION;
  var assetUrl = "https://" + SHOPIFY_STORE_DOMAIN + "/admin/api/" + API_VER + "/themes/" + THEME_ID + "/assets.json";

  // 1) GET current theme.liquid
  var getOpts = {
    hostname: SHOPIFY_STORE_DOMAIN, port: 443,
    path: "/admin/api/" + API_VER + "/themes/" + THEME_ID + "/assets.json?asset%5Bkey%5D=layout/theme.liquid",
    method: "GET",
    headers: { "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN, "Content-Type": "application/json" }
  };

  var https2 = require("https");
  var getReq = https2.request(getOpts, function(getRes) {
    var body = "";
    getRes.on("data", function(c) { body += c; });
    getRes.on("end", function() {
      try {
        var asset = JSON.parse(body).asset;
        if (!asset || !asset.value) { console.log("[theme-update] Could not read theme.liquid"); return; }
        var liquid = asset.value;

        // Check if already updated
        if (liquid.indexOf("checkout.chezyouyou.fr") !== -1) {
          console.log("[theme-update] Theme already points to checkout.chezyouyou.fr - no update needed");
          return;
        }

        // Build the new redirect script
        var newScript = '<script>\n'
          + '(function(){\n'
          + '  var CHECKOUT_URL = "https://checkout.chezyouyou.fr";\n'
          + '  document.addEventListener("submit", function(e){\n'
          + '    var f = e.target;\n'
          + '    if(f.action && f.action.indexOf("/cart") !== -1){\n'
          + '      e.preventDefault();\n'
          + '      fetch("/cart.json").then(function(r){return r.json()}).then(function(cart){\n'
          + '        var items = cart.items.map(function(i){\n'
          + '          return {title:i.title,price:(i.final_line_price/100).toFixed(2),quantity:i.quantity,variant_id:i.variant_id,image:i.image};\n'
          + '        });\n'
          + '        var encoded = btoa(unescape(encodeURIComponent(JSON.stringify(items))));\n'
          + '        window.location.href = CHECKOUT_URL + "?cart=" + encoded;\n'
          + '      }).catch(function(err){console.error("Cart fetch error",err); f.submit();});\n'
          + '    }\n'
          + '  }, true);\n'
          + '  document.addEventListener("click", function(e){\n'
          + '    var a = e.target.closest ? e.target.closest("a[href]") : null;\n'
          + '    if(!a) return;\n'
          + '    var h = a.getAttribute("href") || "";\n'
          + '    if(h === "/checkout" || h.indexOf("/checkouts/") !== -1){\n'
          + '      e.preventDefault();\n'
          + '      fetch("/cart.json").then(function(r){return r.json()}).then(function(cart){\n'
          + '        var items = cart.items.map(function(i){\n'
          + '          return {title:i.title,price:(i.final_line_price/100).toFixed(2),quantity:i.quantity,variant_id:i.variant_id,image:i.image};\n'
          + '        });\n'
          + '        var encoded = btoa(unescape(encodeURIComponent(JSON.stringify(items))));\n'
          + '        window.location.href = CHECKOUT_URL + "?cart=" + encoded;\n'
          + '      }).catch(function(err){console.error("Cart fetch error",err); window.location.href = h;});\n'
          + '    }\n'
          + '  }, true);\n'
          + '})();\n'
          + '<\/script>';

        // Remove old neon-phoenix redirect if present
        var updated = liquid;
        var neonIdx = updated.indexOf("neon-phoenix");
        if (neonIdx !== -1) {
          // Find the script tag containing neon-phoenix
          var scriptStart = updated.lastIndexOf("<script", neonIdx);
          var scriptEnd = updated.indexOf("<\/script>", neonIdx);
          if (scriptEnd === -1) scriptEnd = updated.indexOf("</script>", neonIdx);
          if (scriptStart !== -1 && scriptEnd !== -1) {
            updated = updated.substring(0, scriptStart) + updated.substring(scriptEnd + (updated.charAt(scriptEnd+1) === '\\' ? 10 : 9));
          }
        }

        // Insert new script before </head>
        var headClose = updated.indexOf("</head>");
        if (headClose === -1) headClose = updated.indexOf("{% endcontent_for_header %}");
        if (headClose !== -1) {
          updated = updated.substring(0, headClose) + "\n" + newScript + "\n" + updated.substring(headClose);
        } else {
          // Fallback: append at end
          updated = updated + "\n" + newScript;
        }

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
    // CrÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ©er le client dans Shopify
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

// ── ONE-TIME: update Shopify theme redirect to point to this checkout ──
(function updateThemeRedirect() {
  var THEME_ID = "182586704201";
  var API_VER = SHOPIFY_API_VERSION;
  var assetUrl = "https://" + SHOPIFY_STORE_DOMAIN + "/admin/api/" + API_VER + "/themes/" + THEME_ID + "/assets.json";

  // 1) GET current theme.liquid
  var getOpts = {
    hostname: SHOPIFY_STORE_DOMAIN, port: 443,
    path: "/admin/api/" + API_VER + "/themes/" + THEME_ID + "/assets.json?asset%5Bkey%5D=layout/theme.liquid",
    method: "GET",
    headers: { "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN, "Content-Type": "application/json" }
  };

  var https2 = require("https");
  var getReq = https2.request(getOpts, function(getRes) {
    var body = "";
    getRes.on("data", function(c) { body += c; });
    getRes.on("end", function() {
      try {
        var asset = JSON.parse(body).asset;
        if (!asset || !asset.value) { console.log("[theme-update] Could not read theme.liquid"); return; }
        var liquid = asset.value;

        // Check if already updated
        if (liquid.indexOf("checkout.chezyouyou.fr") !== -1) {
          console.log("[theme-update] Theme already points to checkout.chezyouyou.fr - no update needed");
          return;
        }

        // Build the new redirect script
        var newScript = '<script>\n'
          + '(function(){\n'
          + '  var CHECKOUT_URL = "https://checkout.chezyouyou.fr";\n'
          + '  document.addEventListener("submit", function(e){\n'
          + '    var f = e.target;\n'
          + '    if(f.action && f.action.indexOf("/cart") !== -1){\n'
          + '      e.preventDefault();\n'
          + '      fetch("/cart.json").then(function(r){return r.json()}).then(function(cart){\n'
          + '        var items = cart.items.map(function(i){\n'
          + '          return {title:i.title,price:(i.final_line_price/100).toFixed(2),quantity:i.quantity,variant_id:i.variant_id,image:i.image};\n'
          + '        });\n'
          + '        var encoded = btoa(unescape(encodeURIComponent(JSON.stringify(items))));\n'
          + '        window.location.href = CHECKOUT_URL + "?cart=" + encoded;\n'
          + '      }).catch(function(err){console.error("Cart fetch error",err); f.submit();});\n'
          + '    }\n'
          + '  }, true);\n'
          + '  document.addEventListener("click", function(e){\n'
          + '    var a = e.target.closest ? e.target.closest("a[href]") : null;\n'
          + '    if(!a) return;\n'
          + '    var h = a.getAttribute("href") || "";\n'
          + '    if(h === "/checkout" || h.indexOf("/checkouts/") !== -1){\n'
          + '      e.preventDefault();\n'
          + '      fetch("/cart.json").then(function(r){return r.json()}).then(function(cart){\n'
          + '        var items = cart.items.map(function(i){\n'
          + '          return {title:i.title,price:(i.final_line_price/100).toFixed(2),quantity:i.quantity,variant_id:i.variant_id,image:i.image};\n'
          + '        });\n'
          + '        var encoded = btoa(unescape(encodeURIComponent(JSON.stringify(items))));\n'
          + '        window.location.href = CHECKOUT_URL + "?cart=" + encoded;\n'
          + '      }).catch(function(err){console.error("Cart fetch error",err); window.location.href = h;});\n'
          + '    }\n'
          + '  }, true);\n'
          + '})();\n'
          + '<\/script>';

        // Remove old neon-phoenix redirect if present
        var updated = liquid;
        var neonIdx = updated.indexOf("neon-phoenix");
        if (neonIdx !== -1) {
          // Find the script tag containing neon-phoenix
          var scriptStart = updated.lastIndexOf("<script", neonIdx);
          var scriptEnd = updated.indexOf("<\/script>", neonIdx);
          if (scriptEnd === -1) scriptEnd = updated.indexOf("</script>", neonIdx);
          if (scriptStart !== -1 && scriptEnd !== -1) {
            updated = updated.substring(0, scriptStart) + updated.substring(scriptEnd + (updated.charAt(scriptEnd+1) === '\\' ? 10 : 9));
          }
        }

        // Insert new script before </head>
        var headClose = updated.indexOf("</head>");
        if (headClose === -1) headClose = updated.indexOf("{% endcontent_for_header %}");
        if (headClose !== -1) {
          updated = updated.substring(0, headClose) + "\n" + newScript + "\n" + updated.substring(headClose);
        } else {
          // Fallback: append at end
          updated = updated + "\n" + newScript;
        }

        // 2) PUT updated theme.liquid
        var putData = JSON.stringify({ asset: { key: "layout/theme.liquid", value: updated } });
        var putOpts = {
          hostname: SHOPIFY_STORE_DOMAIN, port: 443,
          path: "/admin/api/" + API_VER + "/themes/" + THEME_ID + "/assets.json",
          method: "PUT",
          headers: {
            "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(putData)
          }
        };
        var putReq = https2.request(putOpts, function(putRes) {
          var putBody = "";
          putRes.on("data", function(c) { putBody += c; });
          putRes.on("end", function() {
            if (putRes.statusCode === 200) {
              console.log("[theme-update] SUCCESS - theme.liquid updated to redirect to checkout.chezyouyou.fr");
            } else {
              console.log("[theme-update] Failed to update theme: " + putRes.statusCode + " " + putBody.substring(0, 200));
            }
          });
        });
        putReq.on("error", function(e) { console.log("[theme-update] PUT error: " + e.message); });
        putReq.write(putData);
        putReq.end();

      } catch(err) {
        console.log("[theme-update] Error: " + err.message);
      }
    });
  });
  getReq.on("error", function(e) { console.log("[theme-update] GET error: " + e.message); });
  getReq.end();
})();
