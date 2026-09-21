// Plumbing for the scripts only. Talks to the services over HTTP, following the contracts. No SQL here.
export const ORDERING = process.env.ORDERING_URL ?? "http://localhost:3001";
export const PRODUCTION = process.env.PRODUCTION_URL ?? "http://localhost:3002";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function call(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// Prints PASS/FAIL per step; done() sets the exit code.
export function checker() {
  let failed = 0;
  return {
    check(name, ok, detail) {
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
      if (!ok) {
        failed++;
        if (detail !== undefined) console.log(`      ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
      }
      return ok;
    },
    done() {
      console.log(failed ? `\n${failed} check(s) FAILED` : "\nALL PASSED");
      process.exitCode = failed ? 1 : 0;
    },
  };
}

// Opens a demo batch through the ordering API (quota in grams, 100000 IDR per kg).
export async function seedBatch(quotaGrams = 3000, beanName = "Toraja Sapan") {
  const closesAt = new Date(Date.now() + 7 * 86400000).toISOString();
  return call("POST", `${ORDERING}/batches`, { beanName, roastLevel: "medium", quotaGrams, pricePerKgIdr: 100000, closesAt });
}

export const placeOrder = (batchId, packSizeGrams = 1000, buyerName = "Buyer") =>
  call("POST", `${ORDERING}/batches/${batchId}/orders`, {
    buyerName,
    buyerContact: `${buyerName.toLowerCase()}@example.com`,
    shippingAddress: "Jl. Contoh No. 1, Jakarta",
    packSizeGrams,
    grind: "medium",
    quantity: 1,
  });
