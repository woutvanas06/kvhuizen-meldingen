// KV Huizen ‚Äì achtergrondtaken (draait elke 5 minuten via GitHub Actions, zie .github/workflows/kvhuizen.yml).
//
// 1. Clubwave volgen: pushmelding bij start, rust en eindstand van wedstrijden van Huizen
//    (onderwerp "team-huizen-1" enz., gelijk aan ClubAccount.topic(for:) in de app).
// 2. Live Activities bijwerken (stand op het vergrendelscherm) voor wie in de app "Volg live" aanzette.
// 3. Bevestigingsmail (via Brevo) als iemand zich inschrijft voor een kantinedienst, met agenda-bijlage.
//
// Benodigde geheimen (GitHub ‚Üí Settings ‚Üí Secrets and variables ‚Üí Actions):
//   FIREBASE_SERVICE_ACCOUNT  inhoud van het JSON-bestand van het Firebase-serviceaccount
//   BREVO_API_KEY             API-sleutel van Brevo (mag leeg: dan geen mails)
//   MAIL_FROM                 afzenderadres, bevestigd in Brevo (bijv. kantine@‚Ä¶)
//   MAIL_FROM_NAME            (optioneel) naam van de afzender, standaard "KV Huizen"
const {initializeApp, cert} = require('firebase-admin/app');
const {getFirestore, FieldValue} = require('firebase-admin/firestore');
const {getMessaging} = require('firebase-admin/messaging');
const {getAuth} = require('firebase-admin/auth');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || 'null');
if (!serviceAccount) throw new Error('FIREBASE_SERVICE_ACCOUNT ontbreekt (zie README.md).');
initializeApp({credential: cert(serviceAccount)});
const db = getFirestore();

const CLUBWAVE = 'https://www.clubwave.tv/api/Activiteit/getWedstrijden?h=false&s=0&t=';
const log = (...parts) => console.log(new Date().toISOString(), ...parts);

// ---------- Hulpfuncties (zelfde regels als in de app) ----------

function clubName(team) {
  let name = String(team).split('/')[0].trim();
  const code = /\s+(?:\d+|[JUjuFf]\d+(?:-\d+)?|MW\d*|G\d*)$/;
  while (code.test(name)) name = name.replace(code, '');
  return name || team;
}
const isHuizen = team => clubName(team).toLowerCase() === 'huizen';
const topic = team => 'team-' + String(team).toLowerCase().normalize('NFD').replace(/[ÃÄ-ÕØ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const amsterdam = (date, options) => new Intl.DateTimeFormat('nl-NL', {timeZone: 'Europe/Amsterdam', ...options}).format(date);
const todayInAmsterdam = () => new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Amsterdam'}).format(new Date());

function readMatch(item) {
  const details = item.Wedstrijd || {};
  const periods = Number(item.MaxPeriode) || 2;
  const period = Number(item.CurrentPeriode) || 1;
  const finished = Boolean(item.IsEindeWedstrijd);
  const live = Boolean(item.IsStillPlaying) && !finished;
  const periodEnd = Boolean(item.IsEindePeriode);
  const start = item.Datum ? new Date(item.Datum) : null;
  let status;
  if (finished) status = 'Afgelopen';
  else if (periodEnd && period < periods) status = periods === 2 ? 'Rust' : `Einde periode ${period}`;
  else if (live) status = item.IsPaused ? 'Gepauzeerd' : 'Live';
  else if (start && start > new Date()) status = 'Aftrap ' + amsterdam(start, {hour: '2-digit', minute: '2-digit'});
  else status = 'Nog niet begonnen';
  return {
    id: String(item.ActiviteitID),
    home: String(details.ThuisNaam || '').trim(),
    away: String(details.UitNaam || '').trim(),
    homeScore: Number(details.ScoreThuis) || 0,
    awayScore: Number(details.ScoreUit) || 0,
    period, periods, finished, live, periodEnd, status,
    clock: live ? String(item.TimeDesc || '') : '',
    periodName: periods === 2 ? (period <= 1 ? '1e helft' : '2e helft') : `Periode ${period}`,
  };
}

const scoreLine = m => `${m.home} ${m.homeScore} ‚Äì ${m.awayScore} ${m.away}`;

async function notifyTeams(match, title, body) {
  for (const team of new Set([match.home, match.away].filter(isHuizen))) {
    await getMessaging().send({
      topic: topic(team),
      notification: {title: title(team), body},
      apns: {payload: {aps: {sound: 'default'}}},
    });
    log('Melding', topic(team), '|', title(team), '|', body);
  }
}

// ---------- 1 + 2: Clubwave ----------

// ContentState van de Live Activity (namen moeten gelijk zijn aan MatchActivityAttributes.ContentState in de app).
const activityState = m => ({
  homeScore: m.homeScore, awayScore: m.awayScore, status: m.status,
  clock: m.clock, period: m.periodName, live: m.live,
});

async function updateLiveActivities(match, ended) {
  const docs = await db.collection('liveActivities').where('matchID', '==', Number(match.id)).get();
  const now = Math.floor(Date.now() / 1000);
  for (const doc of docs.docs) {
    const {token, fcmToken} = doc.data();
    if (!token || !fcmToken) continue;
    try {
      await getMessaging().send({
        token: fcmToken,
        apns: {
          liveActivityToken: token,
          headers: {'apns-priority': '10'},
          payload: {aps: {
            timestamp: now,
            event: ended ? 'end' : 'update',
            'content-state': activityState(match),
            ...(ended ? {'dismissal-date': now + 2 * 3600} : {'stale-date': now + 30 * 60}),
          }},
        },
      });
      if (ended) await doc.ref.delete();
    } catch (error) {
      log('Live Activity mislukt', doc.id, error.code || error.message);
      if (/not-registered|invalid-argument|invalid-registration/.test(error.code || '')) await doc.ref.delete();
    }
  }
}

async function clubwave() {
  const response = await fetch(CLUBWAVE, {headers: {Accept: 'application/json'}});
  if (!response.ok) throw new Error(`Clubwave antwoordt met ${response.status}`);
  const items = (await response.json())?.Data?.Wedstrijden ?? [];
  const collection = db.collection('clubwaveMatches');
  const seen = new Set();
  let busy = false; // wedstrijd van Huizen bezig of binnen 15 minuten

  for (const item of items) {
    const match = readMatch(item);
    if (!isHuizen(match.home) && !isHuizen(match.away)) continue;
    seen.add(match.id);
    const startsSoon = item.Datum && Math.abs(new Date(item.Datum) - Date.now()) < 15 * 60 * 1000;
    if (match.live || (match.periodEnd && !match.finished) || (startsSoon && !match.finished)) busy = true;
    const reference = collection.doc(match.id);
    const previous = (await reference.get()).data() || {};
    const flags = {
      notifiedStart: Boolean(previous.notifiedStart),
      notifiedHalf: Boolean(previous.notifiedHalf),
      notified: Boolean(previous.notified),
    };

    if (match.live && !flags.notifiedStart && match.homeScore + match.awayScore <= 2) {
      await notifyTeams(match, team => `${team} is begonnen`, `${match.home} ‚Äì ${match.away} is begonnen.`);
      flags.notifiedStart = true;
    }
    if (match.periodEnd && match.period < match.periods && !flags.notifiedHalf && !match.finished) {
      await notifyTeams(match, team => `Rust bij ${team}`, scoreLine(match));
      flags.notifiedHalf = true;
    }
    if (match.finished && !flags.notified) {
      await notifyTeams(match, team => `Eindstand ${team}`, scoreLine(match));
      flags.notified = true;
    }

    const state = JSON.stringify(activityState(match));
    if (state !== previous.activityState || (match.finished && !previous.activityEnded)) {
      await updateLiveActivities(match, match.finished);
    }

    await reference.set({
      ...match, ...flags,
      wasLive: Boolean(previous.wasLive || match.live),
      activityState: state,
      activityEnded: Boolean(previous.activityEnded || match.finished),
      updated: FieldValue.serverTimestamp(),
    }, {merge: true});
  }

  // Wedstrijden die live waren en in de laatste periode uit de lijst verdwijnen: als afgelopen behandelen.
  const open = await collection.where('notified', '==', false).where('wasLive', '==', true).get();
  for (const doc of open.docs) {
    if (seen.has(doc.id)) continue;
    const match = {...doc.data(), status: 'Afgelopen', live: false, clock: ''};
    if (match.period >= match.periods) await notifyTeams(match, team => `Eindstand ${team}`, scoreLine(match));
    await updateLiveActivities(match, true);
    await doc.ref.update({notified: true, activityEnded: true, updated: FieldValue.serverTimestamp()});
  }
  return busy;
}

// ---------- 3: Bevestigingsmail kantinedienst ----------

function icsFile(shift) {
  const stamp = (day, time) => day.replace(/-/g, '') + 'T' + time.replace(':', '') + '00';
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//KV Huizen//Kantine//NL', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${shift.id}@kvhuizen-app`, `DTSTAMP:${now}`,
    `DTSTART;TZID=Europe/Amsterdam:${stamp(shift.date, shift.start)}`,
    `DTEND;TZID=Europe/Amsterdam:${stamp(shift.date, shift.end)}`,
    'SUMMARY:Kantinedienst KV Huizen',
    'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', 'DESCRIPTION:Kantinedienst KV Huizen', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);

async function sendMail(to, name, shift) {
  const day = amsterdam(new Date(shift.date + 'T12:00:00Z'), {weekday: 'long', day: 'numeric', month: 'long'});
  const subject = `Bevestiging kantinedienst ${day}, ${shift.start}‚Äì${shift.end}`;
  const text = `Hoi ${name},\n\nBedankt! Je staat ingeschreven voor de kantinedienst op ${day} van ${shift.start} tot ${shift.end}.\n\n` +
    `Je krijgt in de app een herinnering de avond ervoor en een uur vooraf. Kun je toch niet? Schrijf je dan uit in de app ` +
    `(Club ‚Ä∫ Kantine), zodat iemand anders je plek kan nemen.\n\nSportieve groet,\nKV Huizen`;
  const html = `<p>Hoi ${escapeHtml(name)},</p><p>Bedankt! Je staat ingeschreven voor de <strong>kantinedienst op ${escapeHtml(day)} ` +
    `van ${escapeHtml(shift.start)} tot ${escapeHtml(shift.end)}</strong>.</p><p>Je krijgt in de app een herinnering de avond ervoor ` +
    `en een uur vooraf. Kun je toch niet? Schrijf je dan uit in de app (Club ‚Ä∫ Kantine), zodat iemand anders je plek kan nemen.</p>` +
    `<p>Sportieve groet,<br>KV Huizen</p>`;
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json'},
    body: JSON.stringify({
      sender: {email: process.env.MAIL_FROM, name: process.env.MAIL_FROM_NAME || 'KV Huizen'},
      to: [{email: to, name}],
      subject, textContent: text, htmlContent: html,
      attachment: [{name: 'kantinedienst.ics', content: Buffer.from(icsFile(shift)).toString('base64')}],
    }),
  });
  if (!response.ok) throw new Error(`Brevo ${response.status}: ${await response.text()}`);
}

async function canteenMail() {
  if (!process.env.BREVO_API_KEY || !process.env.MAIL_FROM) {
    log('Geen BREVO_API_KEY of MAIL_FROM: bevestigingsmails overgeslagen.');
    return;
  }
  const shifts = await db.collection('canteenShifts').where('date', '>=', todayInAmsterdam()).get();
  const mails = db.collection('canteenMail');
  const sent = new Map((await mails.get()).docs.map(doc => [doc.id, doc]));
  const current = new Set();

  for (const doc of shifts.docs) {
    const shift = {id: doc.id, ...doc.data()};
    for (const uid of shift.volunteers || []) {
      if (uid.startsWith('gast-')) continue; // toegevoegd door beheerder, geen account
      const key = `${doc.id}_${uid}`;
      current.add(key);
      if (sent.has(key)) continue;
      try {
        const user = await getAuth().getUser(uid);
        if (!user.email) continue;
        await sendMail(user.email, shift.names?.[uid] || user.displayName || 'lid', shift);
        await mails.doc(key).set({uid, shiftId: doc.id, sent: FieldValue.serverTimestamp()});
        log('Bevestiging verstuurd', key);
      } catch (error) {
        log('Bevestiging mislukt', key, error.message);
      }
    }
  }
  // Uitgeschreven? Dan het vinkje weghalen, zodat opnieuw inschrijven weer een mail geeft.
  for (const [key, doc] of sent) {
    const shiftDate = key.slice(0, 10);
    if (!current.has(key) || shiftDate < todayInAmsterdam()) await doc.ref.delete();
  }
}

// ---------- Start ----------

// GitHub start dit script hooguit eens per 5 minuten. Tijdens een wedstrijd van Huizen kijkt het
// daarom binnen √©√©n run elke ~45 seconden opnieuw (ongeveer 4,5 minuut lang); anders √©√©n keer.
const INTERVAL = 45 * 1000;
const RUN_LIMIT = 4.5 * 60 * 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const started = Date.now();
  let failed = false;
  for (let round = 1; ; round++) {
    let busy = false;
    try { busy = await clubwave(); } catch (error) { failed = true; log('Clubwave mislukt:', error.stack || error.message); }
    try { await canteenMail(); } catch (error) { failed = true; log('Kantinemail mislukt:', error.stack || error.message); }
    if (!busy || Date.now() - started + INTERVAL > RUN_LIMIT) {
      log(`Klaar na ${round} ronde(s)${busy ? ' (wedstrijd bezig, volgende run gaat verder)' : ''}.`);
      break;
    }
    await sleep(INTERVAL);
  }
  process.exit(failed ? 1 : 0);
})();
