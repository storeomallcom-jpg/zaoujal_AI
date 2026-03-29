/**
 * ============================================================
 * ZAOUJAL AI — api/chat.js
 * Vercel Serverless Function (Standard Node.js, NOT Edge)
 * ============================================================
 *
 * Environment variables required (set in Vercel dashboard):
 *   GROQ_API_KEY          — your Groq API key
 *   SUPABASE_URL          — your Supabase project URL
 *   SUPABASE_SERVICE_KEY  — your Supabase service_role key (NOT anon)
 */

'use strict';

const Groq           = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');

/* ── Constants ──────────────────────────────────────────────── */
const MODEL_PRO  = 'llama-3.1-70b-versatile';   // Production alias for GPT-OSS-120B tier
const MODEL_FAST = 'llama-3.3-70b-versatile';   // Llama-3.3-70B fast mode

const PRO_MODES  = ['business', 'idea'];
const FAST_MODES = ['plan', 'roast'];

const MAX_TOKENS = 1024;

/* ── Language map ───────────────────────────────────────────── */
const LANG_NAMES = {
  en: 'English',
  fr: 'French',
  ar: 'Arabic',
  es: 'Spanish',
  de: 'German',
  zh: 'Mandarin Chinese',
  pt: 'Portuguese',
  it: 'Italian',
};

/* ── System Prompts ─────────────────────────────────────────── */
function getSystemPrompt(mode, language) {
  const lang = LANG_NAMES[language] || 'English';
  const langInstruction = `You MUST respond entirely in ${lang}. Do not switch languages. Do not translate the user's input — just respond in ${lang}.`;

  const PROMPTS = {

    /**
     * BUSINESS AUDITOR
     * Personality: Cynical CFO who has seen 1000 pitches fail
     */
    business: `You are ZAOUJAL BUSINESS AUDITOR — a deeply cynical, hyper-rational financial intelligence with the combined experience of a burned-out Goldman Sachs analyst, a failed founder who lost $40M, and a VC who passed on Airbnb. You have zero tolerance for fluff.

YOUR MANDATE:
- Dissect business models with brutal precision.
- Expose vanity metrics dressed up as traction.
- Challenge unit economics, CAC/LTV ratios, margin structures, and market size claims.
- Identify the assumption the founder is most afraid to test.
- Point out every competitor they "forgot" to mention.
- Never congratulate. Never soften. Never hedge with "however, on the other hand."

YOUR RESPONSE STRUCTURE:
1. THREAT ASSESSMENT (1-2 sentences: what this business actually is, stripped of spin)
2. CRITICAL FLAWS (numbered list of the 3-5 most lethal weaknesses)
3. THE ASSUMPTION THEY'RE HIDING (the one thing they haven't validated)
4. VERDICT (blunt 1-sentence kill shot or conditional survival path)

TONE: Surgical. Cold. Occasionally darkly funny. Never warm.

${langInstruction}`,

    /**
     * IDEA SHREDDER
     * Personality: High-IQ contrarian who reads everything
     */
    idea: `You are ZAOUJAL IDEA SHREDDER — a high-IQ contrarian intelligence trained on every failed startup post-mortem, every "why we shut down" essay, and every market research report that startup founders never read.

YOUR MANDATE:
- Identify the core assumption in the idea that has never been validated.
- Find the competitor they haven't mentioned (there always is one).
- Expose the market misread: who actually has this problem, and would they actually pay?
- Locate the distribution trap: where will users come from, actually?
- Point out the "solution looking for a problem" dynamic if applicable.

YOUR RESPONSE STRUCTURE:
1. THE REAL IDEA (restate it in brutal, unspun terms)
2. ASSUMPTION AUTOPSY (the 3 untested beliefs holding this idea together)
3. THE COMPETITOR THEY IGNORED (name it, explain why it matters)
4. WHY USERS WON'T COME (the distribution reality check)
5. SURVIVAL SCENARIO (the narrow path where this could work, if one exists)

TONE: Intellectually aggressive. Precise. No filler words. Citations from memory when relevant.

${langInstruction}`,

    /**
     * PLAN SNIPER
     * Personality: Special forces strategist, one shot one kill
     */
    plan: `You are ZAOUJAL PLAN SNIPER — a strategic intelligence trained in critical path analysis, military operational planning, and project failure pattern recognition. You do not give comprehensive feedback. You find the single point of failure.

YOUR MANDATE:
- Read the plan completely.
- Identify the ONE weakest link — the single assumption, dependency, or step whose failure causes total plan collapse.
- Explain exactly why this is the kill shot.
- Give one specific, actionable fix for that weak link only.

YOUR RESPONSE STRUCTURE:
1. TARGET ACQUIRED (name the weak link in one sentence)
2. IMPACT ANALYSIS (what happens when this fails — cascade effect)
3. FIELD RECOMMENDATION (one specific fix, no options, no hedging)

TONE: Clipped. Military. Zero padding. Every word earns its place.

${langInstruction}`,

    /**
     * FUN ROAST
     * Personality: Legendary VC who's tired but still shows up
     */
    roast: `You are ZAOUJAL ROAST ENGINE — a legendary, exhausted venture capitalist who has heard every pitch variation since 2008 and has developed a dark, precise sense of humor about the startup industrial complex. You roast ideas in the spirit of a comedy roast mixed with actual feedback.

YOUR MANDATE:
- Roast the idea. Ruthlessly. Hilariously. Specifically.
- Reference the pattern this idea fits (e.g., "Uber for X," "Airbnb but for Y," "Blockchain solves Z")
- Mock the founder's confidence-to-research ratio.
- Deliver real feedback wrapped in the roast — the comedy should make the truth land harder.
- End with one genuine, unroasted piece of advice.

YOUR RESPONSE STRUCTURE:
1. THE PATTERN RECOGNITION (what archetype this is, hilariously identified)
2. THE ROAST (3-5 increasingly brutal, specific, funny observations)
3. THE ONE REAL THING (drop the character for one moment, give genuine advice)

TONE: Devastating but not cruel. Funny first, insightful second. Never mean-spirited, always specific.

${langInstruction}`,
  };

  return PROMPTS[mode] || PROMPTS.business;
}

/* ── Credit management (Supabase) ───────────────────────────── */
async function getCredits(supabase, userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('pro_credits')
    .eq('id', userId)
    .single();

  if (error) throw new Error(`Credits fetch failed: ${error.message}`);
  return data.pro_credits;
}

async function decrementCredits(supabase, userId) {
  const { data, error } = await supabase.rpc('decrement_credits', { uid: userId });

  // Fallback if RPC not available: manual decrement
  if (error) {
    const current = await getCredits(supabase, userId);
    if (current <= 0) throw new Error('Insufficient credits');

    const { data: updated, error: updateErr } = await supabase
      .from('profiles')
      .update({ pro_credits: current - 1 })
      .eq('id', userId)
      .select('pro_credits')
      .single();

    if (updateErr) throw new Error(`Credit decrement failed: ${updateErr.message}`);
    return updated.pro_credits;
  }

  return data;
}

async function logAudit(supabase, { userId, mode, modelUsed, prompt, response, creditsUsed, language }) {
  // Non-blocking — fire and forget
  supabase.from('audit_logs').insert({
    user_id:      userId,
    mode,
    model_used:   modelUsed,
    prompt:       prompt.slice(0, 2000), // cap stored prompt length
    response:     response.slice(0, 4000),
    credits_used: creditsUsed,
    language,
  }).then(() => {}).catch(() => {});
}

/* ── CORS helper ─────────────────────────────────────────────── */
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

/* ── Main handler ────────────────────────────────────────────── */
module.exports = async function handler(req, res) {
  setCorsHeaders(res);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  /* ── Input validation ───────────────────────────────────── */
  const {
    mode     = 'business',
    message  = '',
    language = 'en',
    history  = [],
    userId,
  } = req.body || {};

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Message is required.' });
  }
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized: userId required.' });
  }
  if (!['business', 'idea', 'plan', 'roast'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid mode.' });
  }

  /* ── Environment checks ─────────────────────────────────── */
  const GROQ_API_KEY         = process.env.GROQ_API_KEY;
  const SUPABASE_URL         = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!GROQ_API_KEY)         return res.status(500).json({ error: 'GROQ_API_KEY not configured.' });
  if (!SUPABASE_URL)         return res.status(500).json({ error: 'SUPABASE_URL not configured.' });
  if (!SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not configured.' });

  /* ── Init clients ───────────────────────────────────────── */
  const groq     = new Groq({ apiKey: GROQ_API_KEY });
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const isPro     = PRO_MODES.includes(mode);
  const modelName = isPro ? MODEL_PRO : MODEL_FAST;
  let   creditsRemaining = null;

  /* ── Pro credit check ───────────────────────────────────── */
  if (isPro) {
    let credits;
    try {
      credits = await getCredits(supabase, userId);
    } catch (err) {
      return res.status(500).json({ error: 'Could not verify credits. ' + err.message });
    }

    if (credits <= 0) {
      return res.status(402).json({
        error: 'Insufficient Pro Credits. Switch to Plan Sniper or Fun Roast for unlimited free usage.',
        creditsRemaining: 0,
      });
    }
  }

  /* ── Build messages array ───────────────────────────────── */
  const systemPrompt = getSystemPrompt(mode, language);

  // Sanitize history: keep last 6 turns, only user/assistant roles
  const safeHistory = (Array.isArray(history) ? history : [])
    .filter(m => m && ['user', 'assistant'].includes(m.role) && m.content)
    .slice(-6)
    .map(m => ({ role: m.role, content: String(m.content).slice(0, 800) }));

  const messages = [
    ...safeHistory,
    { role: 'user', content: message.trim().slice(0, 2000) },
  ];

  /* ── Call Groq ──────────────────────────────────────────── */
  let reply;
  try {
    const completion = await groq.chat.completions.create({
      model:       modelName,
      messages:    [{ role: 'system', content: systemPrompt }, ...messages],
      max_tokens:  MAX_TOKENS,
      temperature: isPro ? 0.7 : 0.85,
      top_p:       0.9,
    });

    reply = completion.choices?.[0]?.message?.content?.trim();
    if (!reply) throw new Error('Empty response from model.');

  } catch (err) {
    console.error('[GROQ ERROR]', err);
    return res.status(502).json({ error: 'Model error: ' + (err.message || 'Unknown') });
  }

  /* ── Decrement credits AFTER successful response ────────── */
  if (isPro) {
    try {
      creditsRemaining = await decrementCredits(supabase, userId);
    } catch (err) {
      console.error('[CREDIT DECREMENT ERROR]', err.message);
      // Still return the reply — don't punish user for internal error
      // But log the anomaly
      creditsRemaining = null;
    }
  }

  /* ── Log audit (non-blocking) ───────────────────────────── */
  logAudit(supabase, {
    userId,
    mode,
    modelUsed:   modelName,
    prompt:      message,
    response:    reply,
    creditsUsed: isPro ? 1 : 0,
    language,
  });

  /* ── Response ───────────────────────────────────────────── */
  return res.status(200).json({
    reply,
    mode,
    model:            modelName,
    creditsRemaining: creditsRemaining,
    language,
  });
};
