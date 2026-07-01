// Square Booking -> Meta Conversions API bridge
// Listens for Square's "booking.created" webhook, fetches customer + price
// details, then sends a server-side "Purchase" event to Meta so it shows
// up as a tracked conversion from your ad campaigns.

const express = require("express");
const crypto = require("crypto");
const fetch = require("node-fetch");

const app = express();

// IMPORTANT: Square webhook signature validation needs the RAW body,
// so we capture it before JSON parsing.
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const {
  SQUARE_ACCESS_TOKEN,        // From Square Developer Dashboard
  SQUARE_WEBHOOK_SIGNATURE_KEY, // From Square Developer Dashboard > Webhooks
  SQUARE_API_VERSION = "2025-10-16",
  META_PIXEL_ID,               // Your existing Pixel ID
  META_ACCESS_TOKEN,           // From Meta Events Manager > Conversions API
  PORT = 3000,
} = process.env;

// --- Step 1: Verify the webhook really came from Square ---
function isValidSquareSignature(req) {
  const signature = req.headers["x-square-hmacsha256-signature"];
  const notificationUrl = `https://${req.headers.host}${req.originalUrl}`;
  const hmac = crypto.createHmac("sha256", SQUARE_WEBHOOK_SIGNATURE_KEY);
  hmac.update(notificationUrl + req.rawBody);
  const expected = hmac.digest("base64");
  return signature === expected;
}

// --- Step 2: Hash customer info for Meta (required, never send raw PII) ---
function sha256(value) {
  if (!value) return undefined;
  return crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

// --- Step 3: Look up full booking + customer + price details from Square ---
async function getBookingDetails(bookingId) {
  const bookingRes = await fetch(`https://connect.squareup.com/v2/bookings/${bookingId}`, {
    headers: {
      "Square-Version": SQUARE_API_VERSION,
      "Authorization": `Bearer ${SQUARE_ACCESS_TOKEN}`,
    },
  });
  const bookingData = await bookingRes.json();
  const booking = bookingData.booking;

  if (!booking || !booking.customer_id) {
    console.log("No customer ID found on booking - skipping (likely a test event)");
    return null;
  }

  const customerRes = await fetch(`https://connect.squareup.com/v2/customers/${booking.customer_id}`, {
    headers: {
      "Square-Version": SQUARE_API_VERSION,
      "Authorization": `Bearer ${SQUARE_ACCESS_TOKEN}`,
    },
  });
  const customerData = await customerRes.json();
  const customer = customerData.customer;

  // Get price from the booked service variation (catalog lookup)
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
    if (priceMoney) value = priceMoney.amount / 100; // cents -> dollars
  }

  return { booking, customer, value };
}

// --- Step 4: Send the event to Meta Conversions API ---
async function sendToMeta({ customer, value, eventSourceUrl }) {
  const eventData = {
    data: [
      {
        event_name: "Purchase",
        event_time: Math.floor(Date.now() / 1000),
        action_source: "system_generated", // server-triggered, not a browser pageview
        event_source_url: eventSourceUrl || "https://barberman.com.au",
        user_data: {
          em: [sha256(customer.email_address)].filter(Boolean),
          ph: [sha256(customer.phone_number)].filter(Boolean),
        },
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

// --- The webhook endpoint Square will call ---
app.post("/square-webhook", async (req, res) => {
  try {
    if (!isValidSquareSignature(req)) {
      console.warn("Invalid Square signature - rejecting request");
      return res.status(403).send("Invalid signature");
    }

    const event = req.body;

    if (event.type === "booking.created") {
      const bookingId = event.data.id;
      const details = await getBookingDetails(bookingId);
if (details) {
  await sendToMeta({ customer: details.customer, value: details.value });
}
      console.log(`Sent Purchase event to Meta for booking ${bookingId}, value $${value}`);
    }

    // Always respond 200 quickly so Square doesn't retry
    res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).send("OK"); // still 200 so Square doesn't keep retrying on our bug
  }
});

app.get("/", (req, res) => res.send("Square-Meta bridge is running."));

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
