/**
 * Build-time Freemius price fetcher (runs in `prebuild`).
 *
 * WHY: the pricing page must reflect the REAL product prices, not hand-typed
 * numbers. When the Freemius API env is present we pull the live plan pricing and
 * write `src/lib/pricing.generated.ts`; the pricing UI merges it over the typed
 * fallback. This step is intentionally NON-FATAL — any failure (no env, network,
 * auth) leaves the committed `null` in place so the build stays green and the
 * fallback launch pricing is shown.
 *
 * Env (server/build-only — never bundled):
 *   FREEMIUS_PRODUCT_ID    your Freemius product (plugin) id
 *   FREEMIUS_SECRET_KEY    product secret key (sk_...)
 *   FREEMIUS_PUBLIC_KEY    product public key (pk_...)
 *   FREEMIUS_BEARER_TOKEN  optional API bearer token (Account → API Keys);
 *                          when set, used instead of the signed request above.
 */
import { createHmac } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { BillingCycle, PlanPrice } from '../src/lib/pricing-types';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../src/lib/pricing.generated.ts');
const HOST = 'https://api.freemius.com';

/**
 * Map internal plan ids → Freemius product slug. Each internal plan is TWO
 * separate Freemius plans — e.g. "Pro Monthly" and "Pro Yearly" — since
 * Freemius models billing cadence as distinct plans, not one plan with two
 * prices. `matchesCadence` below finds each half by name/title.
 */
const PLAN_SLUG_BY_ID: Record<string, string> = { pro: 'pro' };

function matchesCadence(plan: FreemiusPlan, slug: string, cadence: BillingCycle): boolean {
  const label = (plan.title ?? plan.name ?? '').toLowerCase();
  if (!label.includes(slug)) return false;
  return cadence === 'monthly' ? /month/.test(label) : /year|annual/.test(label);
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Build a Freemius-signed request (mirrors the Freemius API SDK signing). */
function signedHeaders(
  method: string,
  resource: string,
  productId: string,
  publicKey: string,
  secretKey: string,
): Record<string, string> {
  const date = new Date().toUTCString();
  const contentType = '';
  const contentMd5 = '';
  const stringToSign = [method, contentMd5, contentType, date, resource].join('\n');
  const signature = base64Url(createHmac('sha256', secretKey).update(stringToSign).digest());
  return {
    Date: date,
    Authorization: `FS ${productId}:${publicKey}:${signature}`,
  };
}

/**
 * Auth headers for a Freemius API request. Prefers `FREEMIUS_BEARER_TOKEN`
 * (Account → API Keys) when set — simpler than the signed public/secret key
 * request and the recommended auth method going forward — falling back to
 * the signed request for existing product-key setups.
 */
function authHeaders(
  method: string,
  resource: string,
  productId: string,
  publicKey: string,
  secretKey: string,
): Record<string, string> {
  const bearerToken = process.env.FREEMIUS_BEARER_TOKEN;
  if (bearerToken) return { Authorization: `Bearer ${bearerToken}` };
  return signedHeaders(method, resource, productId, publicKey, secretKey);
}

async function fetchPlans(): Promise<string> {
  const productId = process.env.FREEMIUS_PRODUCT_ID;
  const secretKey = process.env.FREEMIUS_SECRET_KEY;
  const publicKey = process.env.FREEMIUS_PUBLIC_KEY;
  const bearerToken = process.env.FREEMIUS_BEARER_TOKEN;

  if (!productId || (!bearerToken && (!secretKey || !publicKey))) {
    return nullFile('Freemius env not set — using fallback pricing.');
  }

  try {
    // Plans (each plan carries its pricing collection).
    const resource = `/v1/products/${productId}/plans.json`;
    const res = await fetch(`${HOST}${resource}`, {
      headers: authHeaders('GET', resource, productId, publicKey ?? '', secretKey ?? ''),
    });
    if (!res.ok) return nullFile(`Freemius plans request failed (${res.status}).`);
    const data = (await res.json()) as { plans?: FreemiusPlan[] };
    const plans = data.plans ?? [];

    const out: Record<
      string,
      { price: PlanPrice | null; freemiusPlanIds?: Partial<Record<BillingCycle, string>> }
    > = {};
    for (const [internalId, slug] of Object.entries(PLAN_SLUG_BY_ID)) {
      const monthlyPlan = plans.find((p) => matchesCadence(p, slug, 'monthly'));
      const annualPlan = plans.find((p) => matchesCadence(p, slug, 'annual'));
      if (!monthlyPlan && !annualPlan) continue;

      const [monthlyPrice, annualPrice] = await Promise.all([
        monthlyPlan
          ? fetchPrice(productId, monthlyPlan.id, publicKey ?? '', secretKey ?? '')
          : null,
        annualPlan ? fetchPrice(productId, annualPlan.id, publicKey ?? '', secretKey ?? '') : null,
      ]);
      const monthly = monthlyPrice?.monthly ?? annualPrice?.monthly ?? null;
      const annual = annualPrice?.annual ?? monthlyPrice?.annual ?? null;

      out[internalId] = {
        price: monthly != null && annual != null ? { monthly, annual } : null,
        freemiusPlanIds: {
          monthly: monthlyPlan ? String(monthlyPlan.id) : undefined,
          annual: annualPlan ? String(annualPlan.id) : undefined,
        },
      };
    }

    if (Object.keys(out).length === 0) return nullFile('No matching Freemius plans found.');

    return generatedFile({ fetchedAt: new Date().toISOString(), currency: 'USD', plans: out });
  } catch (err) {
    return nullFile(`Freemius fetch error: ${(err as Error).message}`);
  }
}

async function fetchPrice(
  productId: string,
  planId: number,
  publicKey: string,
  secretKey: string,
): Promise<PlanPrice | null> {
  const resource = `/v1/products/${productId}/plans/${planId}/pricing.json`;
  const res = await fetch(`${HOST}${resource}`, {
    headers: authHeaders('GET', resource, productId, publicKey, secretKey),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { pricing?: FreemiusPricing[] };
  const rows = data.pricing ?? [];
  // FramePilot is a subscription: pull the monthly and annual amounts. A plan
  // may split them across pricing rows, so scan all rows for each cadence.
  const monthly = rows.find((r) => r.monthly_price != null)?.monthly_price ?? null;
  const annual = rows.find((r) => r.annual_price != null)?.annual_price ?? null;
  if (monthly == null && annual == null) return null;
  // If Freemius only lists one cadence, derive the other so the UI never shows a
  // gap (monthly ≈ annual/12; annual ≈ monthly*12).
  const monthlyAmount = monthly ?? (annual as number) / 12;
  const annualAmount = annual ?? (monthly as number) * 12;
  return { monthly: Math.round(monthlyAmount), annual: Math.round(annualAmount) };
}

interface FreemiusPlan {
  id: number;
  name: string;
  title?: string;
}
interface FreemiusPricing {
  price?: number | null;
  monthly_price?: number | null;
  annual_price?: number | null;
}

function nullFile(reason: string): string {
  console.warn(`[fetch-pricing] ${reason}`);
  return (
    HEADER +
    "import type { GeneratedPricing } from './pricing-types';\n\n" +
    'export const GENERATED_PRICING: GeneratedPricing | null = null;\n'
  );
}

function generatedFile(data: unknown): string {
  console.log('[fetch-pricing] Wrote live Freemius pricing.');
  return (
    HEADER +
    "import type { GeneratedPricing } from './pricing-types';\n\n" +
    `export const GENERATED_PRICING: GeneratedPricing = ${JSON.stringify(data, null, 2)};\n`
  );
}

const HEADER =
  '/* AUTO-GENERATED by scripts/fetch-pricing.ts. Do not edit by hand. */\n' +
  '/* eslint-disable */\n';

const contents = await fetchPlans();
await writeFile(OUT, contents, 'utf8');
