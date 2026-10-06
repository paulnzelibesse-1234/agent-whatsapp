require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 3000;
const DELAI_MS = (parseFloat(process.env.DELAI_MINUTES) || 2) * 60 * 1000;
const PHONE_NUMBER_ID = process.env.KAPSO_PHONE_NUMBER_ID;
const KAPSO_API_KEY = process.env.KAPSO_API_KEY;
const SECRET = process.env.KAPSO_WEBHOOK_SECRET || '';
const MODELE = process.env.MODELE || 'claude-sonnet-5-5';
const PRENOM = process.env.MON_PRENOM || 'mon propriétaire';
const IGNORER = new Set((process.env.IGNORER || '').split(',').map((s) => s.trim()).filter(Boolean));

const PERSONA = `Tu es l'assistant IA de ${PRENOM} sur WhatsApp. ${PRENOM} est occupé en ce moment.
Règles :
- Réponds dans la langue du contact (souvent le français), court, chaleureux et naturel, comme un vrai message WhatsApp.
- Dans ta première réponse d'une conversation, précise que tu es l'assistant IA de ${PRENOM} et qu'il répondra dès que possible.
- Ne prends aucun engagement à sa place (rendez-vous, argent, promesses) : dis que tu lui transmets.
- Ne donne aucune information personnelle sur ${PRENOM}.
- Si c'est urgent, conseille d'appeler directement.`;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const conversations = new Map(); // numéro -> { nom, historique, minuteur }
const dejaVus = new Set();
let actif = true;

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

function conv(tel) {
  if (!conversations.has(tel)) conversations.set(tel, { nom: '', historique: [], minuteur: null });
  return conversations.get(tel);
}

function ajouter(c, role, texte) {
  c.historique.push({ role, content: texte });
  if (c.historique.length > 30) c.historique.shift();
}

function signatureValide(req) {
  if (!SECRET) return true;
  const recue = (req.get('X-Webhook-Signature') || '').replace(/^sha256=/, '');
  const attendue = crypto.createHmac('sha256', SECRET).update(req.rawBody || '').digest('hex');
  return recue === attendue;
}

// Webhook appelé par Kapso
app.post('/webhook', (req, res) => {
  if (!signatureValide(req)) { console.warn('⛔ Signature invalide'); return res.sendStatus(401); }
  res.sendStatus(200); // on répond vite à Kapso, le traitement continue

  const cle = req.get('X-Idempotency-Key');
  if (cle) {
    if (dejaVus.has(cle)) return;
    dejaVus.add(cle);
    if (dejaVus.size > 5000) dejaVus.clear();
  }
  const evenement = req.get('X-Webhook-Event') || req.body.type;
  const items = req.body.batch ? req.body.data : [req.body];
  for (const item of items) {
    try { traiter(evenement, item); } catch (e) { console.error('Erreur traitement :', e.message); }
  }
});

function traiter(evenement, p) {
  const msg = p.message;
  if (!msg) return;
  const tel = (p.conversation && p.conversation.phone_number) || msg.from || msg.to;
  if (!tel || IGNORER.has(tel)) return;

  const c = conv(tel);
  if (p.conversation && p.conversation.contact_name) c.nom = p.conversation.contact_name;
  const texte = (msg.kapso && msg.kapso.content) || (msg.text && msg.text.body) || `[${msg.type}]`;

  if (evenement === 'whatsapp.message.received') {
    if (msg.type === 'reaction') return;
    ajouter(c, 'user', texte);
    if (!actif) return;
    clearTimeout(c.minuteur);
    c.minuteur = setTimeout(() => repondre(tel), DELAI_MS);
    console.log(`📩 ${c.nom || tel} : "${texte}" → réponse auto dans ${DELAI_MS / 60000} min si tu ne réponds pas`);
  }

  if (evenement === 'whatsapp.message.sent' && msg.kapso && msg.kapso.origin === 'business_app') {
    // C'est TOI qui as répondu depuis WhatsApp Business → l'agent se retire
    if (c.minuteur) console.log(`👤 Tu as répondu à ${c.nom || tel}, l'agent n'intervient pas.`);
    clearTimeout(c.minuteur);
    c.minuteur = null;
    ajouter(c, 'assistant', texte);
  }
}

async function repondre(tel) {
  const c = conv(tel);
  c.minuteur = null;
  if (!actif) return;
  try {
    // Fusionne les messages consécutifs du même rôle (exigé par l'API)
    const messages = [];
    for (const m of c.historique) {
      const dernier = messages[messages.length - 1];
      if (dernier && dernier.role === m.role) dernier.content += '\n' + m.content;
      else messages.push({ ...m });
    }
    while (messages.length && messages[0].role === 'assistant') messages.shift();
    if (!messages.length || messages[messages.length - 1].role !== 'user') return;

    const res = await anthropic.messages.create({
      model: MODELE,
      max_tokens: 400,
      system: `${PERSONA}\nTu parles avec : ${c.nom || 'un contact'}.`,
      messages,
    });
    const reponse = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!reponse) return;

    await envoyer(tel, reponse);
    ajouter(c, 'assistant', reponse);
    console.log(`🤖 Réponse envoyée à ${c.nom || tel} : ${reponse}`);
  } catch (e) {
    console.error('Erreur réponse IA :', e.message);
  }
}

async function envoyer(to, body) {
  const r = await fetch(`https://api.kapso.ai/meta/whatsapp/v24.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'X-API-Key': KAPSO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } }),
  });
  if (!r.ok) throw new Error(`Kapso ${r.status} : ${await r.text()}`);
}

// Pause / reprise depuis ton navigateur
app.get('/pause', (req, res) => {
  if (req.query.cle !== process.env.ADMIN_TOKEN) return res.sendStatus(403);
  actif = false;
  conversations.forEach((c) => { clearTimeout(c.minuteur); c.minuteur = null; });
  res.send('🔴 Agent en pause');
});
app.get('/reprendre', (req, res) => {
  if (req.query.cle !== process.env.ADMIN_TOKEN) return res.sendStatus(403);
  actif = true;
  res.send('🟢 Agent actif');
});
app.get('/', (_req, res) => res.send(`Agent WhatsApp ${actif ? '🟢 actif' : '🔴 en pause'}`));

app.listen(PORT, () => console.log(`✅ Serveur lancé sur le port ${PORT}`));
