// ============================================================
// SNK STORE - Serveur Node.js SANS dÃ©pendances externes
// Fonctionne avec Node.js 18+ (fetch intÃ©grÃ©)
// ============================================================

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// Charger les variables d'environnement depuis .env
// ============================================================
function loadEnv() {
  try {
    const envPath = path.join(__dirname, ".env");
    const envContent = fs.readFileSync(envPath, "utf8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (e) {
    console.warn("Fichier .env non trouvÃ©, utilisation des variables d'environnement systÃ¨me.");
  }
}
loadEnv();

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PORT = process.env.PORT || 8080;

// Shopify Storefront API
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || "ketj31-fg.myshopify.com";
const SHOPIFY_STOREFRONT_TOKEN = process.env.SHOPIFY_STOREFRONT_TOKEN || "e4acaad2c247368ad594caae4c64643d";
const SHOPIFY_API_VERSION = "2024-10";
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || "";
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || "8517ef85c305a78b3067ee8d8a98697c";
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || "";

// Sandbox ou Production
// MODE LIVE ACTIVÃ
const PAYPAL_BASE_URL = "https://api-m.paypal.com";

// ============================================================
// PAYPAL API : Obtenir un Access Token
// ============================================================
async function getPayPalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");

  const response = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`PayPal Auth Error: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

// ============================================================
// PAYPAL API : CrÃ©er une commande
// ============================================================
async function createOrder(cartItems) {
  const accessToken = await getPayPalAccessToken();

  // Calculer le total
  const total = cartItems.reduce((sum, item) => sum + item.price * item.qty, 0);

  const orderPayload = {
    intent: "CAPTURE",
    purchase_units: [
      {
        description: "Commande SNK Store",
        amount: {
          currency_code: "EUR",
          value: total.toFixed(2),
          breakdown: {
            item_total: {
              currency_code: "EUR",
              value: total.toFixed(2),
            },
          },
        },
        items: cartItems.map((item) => ({
          name: `${item.name} (Taille ${item.size})`,
          unit_amount: {
            currency_code: "EUR",
            value: item.price.toFixed(2),
          },
          quantity: item.qty.toString(),
          category: "PHYSICAL_GOODS",
        })),
      },
    ],
  };

  const response = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(orderPayload),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`PayPal Create Order Error: ${JSON.stringify(data)}`);
  }

  console.log(`â Commande crÃ©Ã©e: ${data.id}`);
  return data;
}

// ============================================================
// PAYPAL API : Capturer le paiement
// ============================================================
async function captureOrder(orderID) {
  const accessToken = await getPayPalAccessToken();

  const response = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders/${orderID}/capture`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`PayPal Capture Error: ${JSON.stringify(data)}`);
  }

  console.log(`ð° Paiement capturÃ©: ${data.id} - Status: ${data.status}`);
  return data;
}

// ============================================================
// SHOPIFY STOREFRONT API : RequÃªte GraphQL
// ============================================================
async function shopifyStorefrontQuery(query, variables = {}) {
  const response = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": SHOPIFY_STOREFRONT_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const data = await response.json();
  if (data.errors) {
    console.error("Shopify Storefront Error:", JSON.stringify(data.errors));
    throw new Error(`Shopify Error: ${data.errors[0].message}`);
  }
  return data.data;
}

// ============================================================
// SHOPIFY : RÃ©cupÃ©rer les produits
// ============================================================
async function getProducts(first = 20) {
  const query = `
    query GetProducts($first: Int!) {
      products(first: $first) {
        edges {
          node {
            id
            title
            description
            handle
            productType
            tags
            images(first: 5) {
              edges {
                node {
                  url
                  altText
                  width
                  height
                }
              }
            }
            variants(first: 10) {
              edges {
                node {
                  id
                  title
                  price {
                    amount
                    currencyCode
                  }
                  compareAtPrice {
                    amount
                    currencyCode
                  }
                  availableForSale
                  selectedOptions {
                    name
                    value
                  }
                }
              }
            }
            priceRange {
              minVariantPrice {
                amount
                currencyCode
              }
              maxVariantPrice {
                amount
                currencyCode
              }
            }
          }
        }
      }
    }
  `;
  return shopifyStorefrontQuery(query, { first });
}

// ============================================================
// SHOPIFY : RÃ©cupÃ©rer un produit par handle
// ============================================================
async function getProductByHandle(handle) {
  const query = `
    query GetProductByHandle($handle: String!) {
      product(handle: $handle) {
        id
        title
        description
        descriptionHtml
        handle
        productType
        tags
        images(first: 10) {
          edges {
            node {
              url
              altText
              width
              height
            }
          }
        }
        variants(first: 20) {
          edges {
            node {
              id
              title
              price {
                amount
                currencyCode
              }
              compareAtPrice {
                amount
                currencyCode
              }
              availableForSale
              selectedOptions {
                name
                value
              }
            }
          }
        }
        priceRange {
          minVariantPrice {
            amount
            currencyCode
          }
        }
      }
    }
  `;
  return shopifyStorefrontQuery(query, { handle });
}

// ============================================================
// MIME types pour servir les fichiers statiques
// ============================================================
const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// ============================================================
// Lire le body d'une requÃªte POST
// ============================================================
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}


// ============================================================
// SHOPIFY ADMIN API : Creer une commande dans Shopify
// ============================================================
async function createShopifyOrder(paypalCapture, cartItems) {
  if (!SHOPIFY_ADMIN_TOKEN) {
    console.log("SHOPIFY_ADMIN_TOKEN non configure - commande non creee dans Shopify");
    return null;
  }
  try {
    const lineItems = cartItems.map(item => ({
      title: item.name || item.title || "Produit",
      quantity: item.quantity || 1,
      price: String(item.price || item.unit_amount || "0.00")
    }));
    const captureInfo = paypalCapture.purchase_units && paypalCapture.purchase_units[0] && paypalCapture.purchase_units[0].payments && paypalCapture.purchase_units[0].payments.captures && paypalCapture.purchase_units[0].payments.captures[0];
    const captureAmount = captureInfo ? captureInfo.amount.value : "0.00";
    const orderData = {
      order: {
        line_items: lineItems,
        financial_status: "paid",
        currency: "EUR",
        tags: "paypal,headless",
        note: "Commande PayPal #" + (paypalCapture.id || ""),
        transactions: [{
          kind: "capture",
          status: "success",
          amount: captureAmount,
          gateway: "paypal"
        }]
      }
    };
    const shipping = paypalCapture.purchase_units && paypalCapture.purchase_units[0] && paypalCapture.purchase_units[0].shipping;
    if (shipping) {
      const fullName = (shipping.name && shipping.name.full_name) || "";
      const parts = fullName.split(" ");
      orderData.order.shipping_address = {
        first_name: parts[0] || "",
        last_name: parts.slice(1).join(" ") || "",
        address1: (shipping.address && shipping.address.address_line_1) || "",
        address2: (shipping.address && shipping.address.address_line_2) || "",
        city: (shipping.address && shipping.address.admin_area_2) || "",
        province: (shipping.address && shipping.address.admin_area_1) || "",
        zip: (shipping.address && shipping.address.postal_code) || "",
        country_code: (shipping.address && shipping.address.country_code) || "FR"
      };
    }
    const payerEmail = paypalCapture.payer && paypalCapture.payer.email_address;
    if (payerEmail) {
      orderData.order.email = payerEmail;
    }
    const url = "https://" + SHOPIFY_STORE_DOMAIN + "/admin/api/" + SHOPIFY_API_VERSION + "/orders.json";
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
      body: JSON.stringify(orderData)
    });
    const result = await response.json();
    if (response.ok) {
      console.log("Commande Shopify creee: #" + ((result.order && result.order.order_number) || (result.order && result.order.id)));
    } else {
      console.error("Erreur creation commande Shopify:", JSON.stringify(result));
    }
    return result;
  } catch (error) {
    console.error("Erreur creation commande Shopify:", error.message);
    return null;
  }
}

// ============================================================
// SERVEUR HTTP
// ============================================================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS headers (utile pour le dev)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // ---- OAuth Shopify Admin API ----
      if (url.pathname === "/auth") {
        const scopes = "write_orders,read_orders,write_inventory,read_inventory,read_products";
        const redirectUri = (process.env.RENDER_EXTERNAL_URL || "https://snk-store.onrender.com") + "/auth/callback";
        const authUrl = "https://" + SHOPIFY_STORE_DOMAIN + "/admin/oauth/authorize?client_id=" + SHOPIFY_CLIENT_ID + "&scope=" + scopes + "&redirect_uri=" + encodeURIComponent(redirectUri);
        res.writeHead(302, { "Location": authUrl });
        res.end();
        return;
      }

      if (url.pathname.startsWith("/auth/callback")) {
        const params = url.searchParams;
        const code = params.get("code");
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("Erreur: pas de code");
          return;
        }
        try {
          const tokenResp = await fetch("https://" + SHOPIFY_STORE_DOMAIN + "/admin/oauth/access_token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, code: code })
          });
          const tokenData = await tokenResp.json();
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<h1>Token obtenu avec succes!</h1><p>Ajoutez cette variable d environnement sur Render.com:</p><pre>SHOPIFY_ADMIN_TOKEN=" + (tokenData.access_token || "ERREUR") + "</pre><p>Scopes: " + (tokenData.scope || "N/A") + "</p>");
        } catch(err) {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end("<h1>Erreur</h1><pre>" + err.message + "</pre>");
        }
        return;
      }

      // ---- API: Config (fournir le Client ID au frontend) ----
    if (url.pathname === "/api/config" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ clientId: PAYPAL_CLIENT_ID }));
      return;
    }

    // ---- API: RÃ©cupÃ©rer les produits Shopify ----
    if (url.pathname === "/api/products" && req.method === "GET") {
      const data = await getProducts();
      const products = data.products.edges.map((edge) => {
        const p = edge.node;
        return {
          id: p.id,
          title: p.title,
          description: p.description,
          handle: p.handle,
          productType: p.productType,
          tags: p.tags,
          images: p.images.edges.map((img) => img.node),
          variants: p.variants.edges.map((v) => ({
            id: v.node.id,
            title: v.node.title,
            price: v.node.price,
            compareAtPrice: v.node.compareAtPrice,
            availableForSale: v.node.availableForSale,
            options: v.node.selectedOptions,
          })),
          price: p.priceRange.minVariantPrice,
        };
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ products }));
      return;
    }

    // ---- API: RÃ©cupÃ©rer un produit par handle ----
    const productMatch = url.pathname.match(/^\/api\/products\/([^/]+)$/);
    if (productMatch && req.method === "GET") {
      const handle = productMatch[1];
      const data = await getProductByHandle(handle);
      if (!data.product) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Produit non trouvÃ©" }));
        return;
      }
      const p = data.product;
      const product = {
        id: p.id,
        title: p.title,
        description: p.description,
        descriptionHtml: p.descriptionHtml,
        handle: p.handle,
        productType: p.productType,
        tags: p.tags,
        images: p.images.edges.map((img) => img.node),
        variants: p.variants.edges.map((v) => ({
          id: v.node.id,
          title: v.node.title,
          price: v.node.price,
          compareAtPrice: v.node.compareAtPrice,
          availableForSale: v.node.availableForSale,
          options: v.node.selectedOptions,
        })),
        price: p.priceRange.minVariantPrice,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ product }));
      return;
    }

    // ---- API: CrÃ©er une commande PayPal ----
    if (url.pathname === "/api/orders" && req.method === "POST") {
      const body = await readBody(req);
      const result = await createOrder(body.cart);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // ---- API: Capturer le paiement ----
    const captureMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/capture$/);
    if (captureMatch && req.method === "POST") {
      const orderID = captureMatch[1];
      const result = await captureOrder(orderID);

        // Creer la commande dans Shopify apres capture PayPal reussie
        try {
          const cData = JSON.parse(JSON.stringify(captureData || data));
          if (cData && (cData.status === "COMPLETED" || (cData.purchase_units))) {
            const cartForShopify = body.cart || body.items || [];
            createShopifyOrder(cData, cartForShopify).catch(function(err) { console.error("Shopify order err:", err); });
          }
        } catch(shopifyErr) { console.error("Shopify sync error:", shopifyErr); }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // ---- Fichiers statiques ----
    let filePath = path.join(__dirname, "src", url.pathname === "/" ? "index.html" : url.pathname);

    // Si le fichier n'existe pas, servir index.html (SPA fallback)
    if (!fs.existsSync(filePath)) {
      filePath = path.join(__dirname, "src", "index.html");
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const content = fs.readFileSync(filePath);

    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch (error) {
    console.error("â Erreur:", error.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(PORT, () => {
  console.log(`
ââââââââââââââââââââââââââââââââââââââââââââââââ
â                                              â
â   ð  SNK Store est lancÃ© !                 â
â                                              â
â   â http://localhost:${PORT}/                  â
â                                              â
â   Mode: ${PAYPAL_BASE_URL.includes("sandbox") ? "SANDBOX (test)" : "PRODUCTION (live)"}                  â
â                                              â
ââââââââââââââââââââââââââââââââââââââââââââââââ
  `);
});
