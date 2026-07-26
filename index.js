// Square Booking -> Meta Conversions API bridge
// Now with fbclid pass-through for precise ad attribution

const express = require("express");
const crypto = require("crypto");
const fetch = require("node-fetch");

const app = express();

app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const {
  SQUARE_ACCESS_TOKEN,
  SQUARE_WEBHOOK_SIGNATURE_KEY,
  SQUARE_API_VERSION = "2025-10-16",
  META_PIXEL_ID,
  META_ACCESS_TOKEN,
  PORT = 3000,
} = process.env;

// --- Verify webhook came from Square ---
function isValidSquareSignature(req) {
  const signature = req.headers["x-square-hmacsha256-signature"];
  const notificationUrl = `https://${req.headers.host}${req.originalUrl}`;
  const hmac = crypto.createHmac("sha256", SQUARE_WEBHOOK_SIGNATURE_KEY);
  hmac.update(notificationUrl + req.rawBody);
  const expected = hmac.digest("base64");
  return signature === expected;
}

// --- Hash customer PII for Meta ---
function sha256(value) {
  if (!value) return undefined;
  return crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

// --- Get booking details from Square ---
async function getBookingDetails(event) {
  const booking = event.data.object.booking;
  const customerId = booking.customer_id;

  if (!customerId) {
    console.log("No customer ID found - skipping");
    return null;
  }

  const customerRes = await fetch(`https://connect.squareup.com/v2/customers/${customerId}`, {
    headers: {
      "Square-Version": SQUARE_API_VERSION,
      "Authorization": `Bearer ${SQUARE_ACCESS_TOKEN}`,
    },
  });
  const customerData = await customerRes.json();
  const customer = customerData.customer;

  let value = 0;
  const variationId = booking.appointment_segments?.[0]?.service_variation_id;
  if (variationId) {
    const catalogRes = await fetch(`https://connect.squareup.com/v2/catalog/object/${variationId}`, {
      headers: {
        "Square-Version": SQUARE_API_VERSION,
        "Authorization": `Bearer ${SQUARE_ACCESS_TOKEN}`,
      },
    });
    const catalogData = await catalogRes.json();
    const priceMoney = catalogData.object?.item_variation_data?.price_money;
    if (priceMoney) value = priceMoney.amount / 100;
  }

  return { booking, customer, value };
}

// --- Send Purchase event to Meta ---
async function sendToMeta({ customer, value, fbclid }) {
  const userData = {
    em: [sha256(customer.email_address)].filter(Boolean),
    ph: [sha256(customer.phone_number)].filter(Boolean),
  };

  // If we have fbclid, include it for precise attribution
  // fbc format: fb.1.{timestamp}.{fbclid}
  if (fbclid) {
    userData.fbc = `fb.1.${Date.now()}.${fbclid}`;
    console.log("fbclid found - precise attribution enabled");
  } else {
    console.log("No fbclid - falling back to email/phone matching");
  }

  const eventData = {
    data: [
      {
        event_name: "Purchase",
        event_time: Math.floor(Date.now() / 1000),
        action_source: "system_generated",
        event_source_url: "https://barberman.com.au",
        user_data: userData,
        custom_data: {
          currency: "AUD",
          value: value,
        },
      },
    ],
  };

  const res = await fetch(
    `https://graph.facebook.com/v19.0/${META_PIXEL_ID}/events?access_token=${META_ACCESS_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(eventData),
    }
  );
  const result = await res.json();
  console.log("Meta CAPI response:", result);
  return result;
}

// --- Webhook endpoint ---
app.post("/square-webhook", async (req, res) => {
  try {
    if (!isValidSquareSignature(req)) {
      console.warn("Invalid Square signature - rejecting");
      return res.status(403).send("Invalid signature");
    }

    const event = req.body;
    console.log("Received event type:", event.type);

    if (event.type === "booking.created") {
      const details = await getBookingDetails(event);

      if (details) {
        const { customer, value } = details;

        // Try to extract fbclid from booking source URL if Square passes it through
        const bookingSource = event.data.object.booking?.source?.name || "";
        const fbclidMatch = bookingSource.match(/fbclid=([^&]+)/);
        const fbclid = fbclidMatch ? fbclidMatch[1] : null;

        await sendToMeta({ customer, value, fbclid });
        console.log("Sent Purchase event to Meta");
      }
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).send("OK");
  }
});

app.get("/", (req, res) => res.send("Square-Meta bridge is running."));

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
