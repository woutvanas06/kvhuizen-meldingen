# KV Huizen – meldingen en bevestigingsmails

Dit script draait elke 5 minuten gratis op GitHub en doet drie dingen voor de KV Huizen-app:

1. **Meldingen** bij de start, de rust en de eindstand van wedstrijden van Huizen (Clubwave). Alleen voor wie dat team een ster heeft gegeven en meldingen aan heeft.
2. **Live Activities**: de stand op het vergrendelscherm, ook als de app dicht is.
3. **Bevestigingsmail** (met agenda-bijlage) als iemand zich inschrijft voor een kantinedienst.

Er staan geen wachtwoorden of sleutels in deze bestanden. Die zet je als *Secrets* in GitHub (stap 3 en 4).

---

## 1. Repository maken

1. Maak een gratis account op <https://github.com> en log in.
2. Klik rechtsboven op **+ → New repository**.
   - **Repository name:** `kvhuizen-meldingen`
   - Kies **Public**. Dan zijn de GitHub Actions-minuten onbeperkt gratis. Bij *Private* krijg je 2.000 minuten per maand, en dat is te weinig voor elke 5 minuten.
   - Klik op **Create repository**.

## 2. Bestanden uploaden

1. Klik in de nieuwe repository op **uploading an existing file** (of **Add file → Upload files**).
2. Sleep deze vier bestanden uit de map `server` erin: `worker.js`, `package.json`, `privacy.html`, `README.md`. Klik op **Commit changes**.
3. De planning staat in een verborgen map en moet je apart aanmaken. Klik op **Add file → Create new file**.
   - Typ als naam precies: `.github/workflows/kvhuizen.yml`
   - Plak de inhoud van het bestand `server/.github/workflows/kvhuizen.yml`.
   - Klik op **Commit changes**.

## 3. Sleutel van Firebase toevoegen

1. Open <https://console.firebase.google.com/project/kvhuizen/settings/serviceaccounts/adminsdk>.
2. Klik op **Nieuwe privésleutel genereren** (*Generate new private key*). Er wordt een `.json`-bestand gedownload. **Deel dit bestand nooit**, want het geeft volledige toegang tot de database.
3. Ga in GitHub naar de repository → **Settings → Secrets and variables → Actions → New repository secret**.
   - **Name:** `FIREBASE_SERVICE_ACCOUNT`
   - **Secret:** open het `.json`-bestand met TextEdit en plak de **hele inhoud**.
   - Klik op **Add secret**.
4. Gooi het `.json`-bestand daarna weg uit Downloads. Een nieuwe sleutel maken kan altijd.

## 4. Brevo voor de bevestigingsmails

1. Maak een gratis account op <https://www.brevo.com>. Je kunt tot 300 mails per dag versturen.
2. Ga naar **Senders, Domains & Dedicated IPs → Senders → Add a sender**. Vul het afzenderadres in, bijvoorbeeld het mailadres van de kantinecommissie, en bevestig het via de mail die je krijgt.
3. Ga naar **SMTP & API → API Keys → Generate a new API key** en kopieer de sleutel.
4. Voeg in GitHub (Settings → Secrets and variables → Actions) drie secrets toe:
   - `BREVO_API_KEY`: de API-sleutel
   - `MAIL_FROM`: het bevestigde afzenderadres
   - `MAIL_FROM_NAME`: bijvoorbeeld `KV Huizen Kantine`

**Leden die inloggen met Apple** hebben vaak een verborgen adres (`…@privaterelay.appleid.com`). Daar komt de mail alleen aan als je het afzenderadres aanmeldt bij Apple:

1. Ga naar <https://developer.apple.com/account/resources/services/list>.
2. Kies **Sign in with Apple for Email Communication → Configure**.
3. Voeg het afzenderadres (`MAIL_FROM`) toe.

## 5. Testen

1. Ga in GitHub naar het tabblad **Actions**. Klik op **I understand… enable them** als GitHub daarom vraagt.
2. Kies links **KV Huizen meldingen** en klik op **Run workflow**.
3. Na ongeveer een halve minuut zie je een groen vinkje. Klik erop voor het logboek: daarin staat wat er gedaan is, bijvoorbeeld *Bevestiging verstuurd*.

Daarna draait het vanzelf elke 5 minuten. GitHub kan een run soms een paar minuten later starten. Krijg je een mail van GitHub dat de planning gepauzeerd is (na 60 dagen zonder wijzigingen in de repository)? Klik dan in **Actions** op **Enable workflow**.

## 6. Privacyverklaring online (voor de App Store)

1. Ga in GitHub naar **Settings → Pages**.
2. Kies bij **Branch** voor `main` en `/ (root)` en klik op **Save**.
3. Na een minuut staat de privacyverklaring op `https://<jouw-gebruikersnaam>.github.io/kvhuizen-meldingen/privacy.html`. Dat adres vul je in App Store Connect in bij **Privacybeleid-URL**.
